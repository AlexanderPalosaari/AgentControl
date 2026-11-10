import { addUsage, usageFromResult } from './usage.js';

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three sentences: what was reviewed and the overall verdict' },
    findings: {
      type: 'array',
      description: 'Only real, verified problems. Empty when the change is fine.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          summary: { type: 'string' },
          failure_scenario: { type: 'string', description: 'Concrete input or state that goes wrong, and what happens' },
        },
        required: ['file', 'summary', 'failure_scenario'],
      },
    },
  },
  required: ['summary', 'findings'],
};

const MIN_PROSE_REVIEW = 200;
const CONVERT_PROMPT = 'Convert the code review below into the structured output. Keep every finding as written (file, line, severity if stated, a one-sentence summary and the failure scenario); add nothing and drop nothing. If it reports no problems, return an empty findings list. Do not use any tools.';

const SYSTEM_PROMPT = [
  'This is a non-interactive review inside an automated pipeline. Do not write plan files, do not ask for approval and do not change anything.',
  'Your final reply must be the structured output and nothing else.',
].join('\n');

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git merge-base:*)'];

/**
 * Runs Claude Code's /code-review (and optionally /security-review) over a worktree's branch,
 * headless, and returns the findings as structured data.
 */
/**
 * Keeps the review on the card's own change. Without it a branch name given as the target reads as "review this
 * branch" and the reviewer goes through everything the base branch holds over main (other cards' work included).
 */
export function scopePrompt({ base, since }) {
  if (!since) return `Review only the changes this branch makes on top of ${base} (git diff ${base}...HEAD). Do not review or report code that is already in ${base}.`;
  return [
    `Review only this branch's own change: git diff ${since}..HEAD (the branch meets its base ${base} at ${since}).`,
    `Everything at or before ${since} is already in ${base}: other work, not this change. Do not review it, and report nothing in code this diff does not touch.`,
  ].join('\n');
}

export function createReviewer({ claude, level = 'medium', security = false, model = null, effort = null }) {
  function call(prompt, cwd, tools, scope = '') {
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(REVIEW_SCHEMA),
      ...(tools.length ? ['--allowedTools', ...tools] : []),
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
      '--append-system-prompt', scope ? `${SYSTEM_PROMPT}\n${scope}` : SYSTEM_PROMPT,
    ];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return claude.run({ args, cwd, prompt });
  }

  const structured = (result) => (Array.isArray(result.structured_output?.findings) ? result.structured_output : null);

  async function one(prompt, cwd, scope) {
    let result = await call(prompt, cwd, READ_ONLY_TOOLS, scope);
    let cost = result.total_cost_usd ?? 0;
    let usage = usageFromResult(result);
    let out = structured(result);
    // The reviewer sometimes writes the findings as prose instead of the structured output; it did the work, so convert the text rather than discard it.
    const prose = String(result.result ?? '').trim();
    if (!out && prose.length >= MIN_PROSE_REVIEW) {
      const converted = await call(`${CONVERT_PROMPT}\n\n<review>\n${prose}\n</review>`, cwd, []).catch(() => null);
      if (converted) {
        out = structured(converted);
        cost += converted.total_cost_usd ?? 0;
        usage = addUsage(usage, usageFromResult(converted));
        if (out) result = { ...result, is_error: false };
      }
    }
    if (result.is_error || !out) {
      throw new Error(result.result || `the review returned no structured output (${result.subtype ?? 'unknown'})`);
    }
    return { summary: String(out.summary ?? ''), findings: out.findings, cost, usage };
  }

  /**
   * `base` is the ref the branch was forked from, e.g. origin/angular-22; `since` is the commit where the branch
   * meets it. The review covers `since..HEAD` only, never the base branch's own history.
   */
  async function review({ cwd, base, since = null }) {
    const scope = scopePrompt({ base, since });
    const code = await one(`/code-review ${level} ${since ? `${since}..HEAD` : `${base}...HEAD`}`, cwd, scope);
    const findings = code.findings.map((f) => ({ ...f, source: 'code-review' }));
    let { summary, cost, usage } = code;
    if (security) {
      const sec = await one('/security-review', cwd, scope);
      findings.push(...sec.findings.map((f) => ({ ...f, source: 'security-review' })));
      summary += `\nSecurity: ${sec.summary}`;
      cost += sec.cost;
      usage = addUsage(usage, sec.usage);
    }
    return { summary, findings, cost, usage };
  }

  return { review };
}

/** Findings worth a fix round: everything except low severity (unrated counts). Low ones stay in review.md for the human. */
export const actionableFindings = (findings) => findings.filter((f) => f.severity !== 'low');

/** The text sent to the implementing agent when the review found something. */
export function fixRequest(findings) {
  const items = findings.map((f, i) => [
    `${i + 1}. [${f.severity ?? 'unrated'}] ${f.repo ? `${f.repo}: ` : ''}${f.file}${f.line ? `:${f.line}` : ''}: ${f.summary}`,
    `   What goes wrong: ${f.failure_scenario}`,
  ].join('\n'));
  return [
    'An automatic code review of your branch found these possible problems.',
    'Check each one against the code. Fix the real ones and skip false positives. Run the tests, commit the fixes,',
    'and write a NEW report.md last that says which findings you fixed and which you rejected, and why.',
    'This is the only fix round, so make it count.',
    '',
    ...items,
  ].join('\n');
}

/** Body of the report's "## Verification" section, or null when there is none. */
function verificationSection(report) {
  const lines = String(report ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s*Verification\b/i.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** A line that leaves a check to a person ("käyttäjä testaa käsin", "to be tested manually") instead of running it. */
const HANDED_TO_PERSON = /\b(käsin|manuaalisesti|manuaalinen|manually|by hand)\b|\b(käyttäjä|ihminen|henkilö|the user|the person|a person|a human|someone)\s+(testaa|tarkistaa|kokeilee|tekee|tests?|checks?|verif|will|should|needs|must)/i;

/** Deterministic check that the agent's report accounts for its verification (tested, or skipped with a reason). */
export function verificationFinding(report) {
  const body = verificationSection(report);
  const lines = (body ?? '').split('\n').map((l) => l.replace(/[*_`]/g, ''));
  const problem = body === null ? 'report.md has no "## Verification" section'
    : body.length < 30 ? 'the Verification section of report.md is empty or too thin'
    : lines.some((l) => /skipped\s*:?\s*(not needed|n\/a|none|-)?\s*$/i.test(l)) ? 'a check is marked Skipped without a concrete reason'
    : lines.some((l) => !/^\s*[-*\d.]*\s*tested\s*:/i.test(l) && HANDED_TO_PERSON.test(l)) ? 'a check is left to a person to do by hand instead of being run'
    : null;
  if (!problem) return null;
  return {
    file: 'report.md', severity: 'medium', source: 'verification',
    summary: `${problem}.`,
    failure_scenario: 'The feature may never have been exercised through its API or in the browser, and nobody can tell. List per check either "Tested:" (what you ran and saw) or "Skipped:" (a concrete reason specific to this change), then run the missing checks if they apply.',
  };
}

export function reviewMarkdown(review) {
  const head = `# Automatic review\n\n${review.summary || '(no summary)'}\n`;
  if (review.error) return `${head}\n**The review itself failed:** ${review.error}\n`;
  if (!review.findings.length) return `${head}\nNo findings.\n`;
  return `${head}\n${review.findings.map((f, i) =>
    `## ${i + 1}. [${f.severity ?? 'unrated'}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.summary}\n\n${f.failure_scenario}\n`).join('\n')}`;
}
