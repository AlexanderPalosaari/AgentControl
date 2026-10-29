import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationError } from './cards.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { git } from './git.js';
import { addUsage, usageFromResult } from './usage.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const BLOCKED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
// Read-only, plus the one command that asks a package registry about known vulnerabilities (it runs none of the project's code).
const AUDIT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(npm audit:*)', 'Bash(git log:*)', 'Bash(git ls-files:*)'];
const FINDINGS_MAX = 60;

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three sentences: what was checked and the overall security state of the project.' },
    findings: {
      type: 'array',
      description: 'Only real vulnerabilities you verified in the code or in the dependency data. Empty when there are none.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          category: { type: 'string', enum: ['code', 'dependency', 'secret', 'config'], description: 'code: a flaw in the project\'s own code (injection, auth, path traversal, XSS...); dependency: a package with a known vulnerability; secret: a credential or key in the repository; config: an unsafe setting or deployment file.' },
          repo: { type: 'string', description: 'Name of the repository the finding is in' },
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string', description: 'One line' },
          description: { type: 'string', description: 'What is wrong and how it could be exploited, concretely' },
          fix: { type: 'string', description: 'The quickest sound way to fix it' },
        },
        required: ['severity', 'category', 'title', 'description'],
      },
    },
  },
  required: ['summary', 'findings'],
};

const SYSTEM_PROMPT = [
  'You audit an existing software project for security vulnerabilities, as a scheduled, non-interactive check inside an automated pipeline. Do not write plan files, do not ask for approval and never change anything.',
  'Look for: injection (SQL, command, template), broken authentication or authorization, path traversal, unsafe deserialization, XSS and other output-encoding flaws, SSRF, insecure crypto and randomness, secrets committed to the repository, unsafe configuration or deployment files, and dependencies with known vulnerabilities (read the manifests and lock files; run `npm audit` where a package-lock.json exists).',
  'Report only what you verified by reading the code or the audit output; name the file and line. Rate severity by how easily it can be exploited and what it exposes. No style remarks, no hypothetical hardening advice without a concrete weakness.',
  'Write in the language of the README or comments (default English). Your final reply must be the structured output and nothing else.',
].join('\n');

const round = (n) => Math.round(n * 1e4) / 1e4;
const text = (v, max) => String(v ?? '').trim().slice(0, max);

/** Keeps well-formed findings, worst first. */
function normalize(findings) {
  if (!Array.isArray(findings)) return [];
  return findings
    .filter((f) => f && typeof f === 'object' && text(f.title, 300))
    .map((f) => ({
      severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium',
      category: ['code', 'dependency', 'secret', 'config'].includes(f.category) ? f.category : 'code',
      repo: text(f.repo, 100), file: text(f.file, 300), line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
      title: text(f.title, 300), description: text(f.description, 3000), fix: text(f.fix, 2000),
    }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .slice(0, FINDINGS_MAX);
}

const counts = (findings) => Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));

/** A finding's id: the same weakness found again by a later audit keeps it, so its card is still known. */
const findingId = (f) => createHash('sha1').update([f.repo, f.file, f.title].join('\n')).digest('hex').slice(0, 12);

const SEVERITY_FI = { critical: 'kriittinen', high: 'korkea', medium: 'keskitaso', low: 'matala' };
const PRIORITY_OF = { critical: 'high', high: 'high', medium: 'normal', low: 'low' };

/** The brief of the card made from a finding: everything the refiner and the coding agent need, with no link back here. */
function ticketBrief(f, checkedAt) {
  const where = f.file ? `${f.repo ? `${f.repo}: ` : ''}${f.file}${f.line ? `:${f.line}` : ''}` : '';
  return [
    `Haavoittuvuustarkastuksen löydös (vakavuus: ${SEVERITY_FI[f.severity]}, tyyppi: ${f.category})${checkedAt ? `, tarkastettu ${checkedAt.slice(0, 10)}` : ''}.`,
    where && `Sijainti: ${where}`,
    f.description,
    f.fix && `Korjausehdotus: ${f.fix}`,
    'Hyväksymisehto: haavoittuvuus on korjattu, ja testi osoittaa, ettei sitä voi enää hyödyntää.',
  ].filter(Boolean).join('\n\n');
}

/**
 * The vulnerability audit of a project: a read-only agent reads its code and dependencies and writes the findings
 * (data/projects/<name>/audit/audit.json). Each project chooses whether it is audited by itself and how often
 * (`audit: { enabled, everyMin }` in project.json); `tick` starts the audits that are due, and one can be started by hand.
 * Findings are only reported: nothing is changed in the repository. A finding can be turned into a card on the board
 * (`ticket`), which is remembered in audit.json by the finding's id.
 */
export function createAuditor({ dataDir, claude, projects, store = null, model = null, effort = null, ledger = null, log = () => {}, now = () => Date.now() }) {
  const dirOf = (name) => join(dataDir, 'projects', name, 'audit');
  const fileOf = (name) => join(dirOf(name), 'audit.json');
  const running = new Set();
  const activity = new Map();
  const inFlight = new Set();
  const ticketing = new Set(); // finding ids whose card is being made, so a double click makes one

  const membersOf = (p) => (p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }]);

  async function loadMeta(name) {
    const meta = await readJson(fileOf(name), null);
    if (meta?.state === 'running' && !running.has(name)) return { ...meta, state: meta.checkedAt ? 'ready' : 'error', error: 'Tarkastus keskeytyi, kun AgentControl käynnistettiin uudelleen.' };
    return meta;
  }

  /** The settings and the latest result of a project's audit. */
  async function get(name) {
    const p = await projects.get(name);
    const meta = (await loadMeta(name)) ?? {};
    const last = meta.startedAt ? Date.parse(meta.startedAt) : null;
    const findings = await Promise.all((meta.findings ?? []).map(async (f) => {
      const id = findingId(f);
      const card = meta.tickets?.[id] ? await store?.get(meta.tickets[id]).catch(() => null) : null; // a deleted card can be made again
      return { ...f, id, card: card ? { id: card.id, status: card.status } : null };
    }));
    return {
      project: name, enabled: p.audit.enabled, everyMin: p.audit.everyMin,
      state: meta.state ?? 'none', startedAt: meta.startedAt ?? null, checkedAt: meta.checkedAt ?? null, error: meta.error ?? null,
      summary: meta.summary ?? '', findings, counts: meta.counts ?? counts([]), cost: meta.cost ?? 0,
      activity: activity.get(name) ?? null,
      nextAt: p.audit.enabled && !running.has(name) ? new Date(last == null ? now() : last + p.audit.everyMin * 60_000).toISOString() : null,
    };
  }

  async function audit(name) {
    const p = await projects.get(name);
    const members = membersOf(p);
    const heads = await Promise.all(members.map((m) => git(['rev-parse', 'HEAD'], m.path).catch(() => null)));
    members.forEach((m, i) => { if (!heads[i]) throw new ValidationError(`${m.path} has no commits to audit`); });

    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(AUDIT_SCHEMA),
      '--allowedTools', ...AUDIT_TOOLS,
      '--disallowedTools', ...BLOCKED_TOOLS,
      '--append-system-prompt', SYSTEM_PROMPT,
    ];
    if (p.model ?? model) args.push('--model', p.model ?? model);
    if (p.effort ?? effort) args.push('--effort', p.effort ?? effort);
    for (const m of members.slice(1)) args.push('--add-dir', m.path);
    const prompt = [
      `Project "${name}". Audit ${members.length > 1 ? 'these repositories' : 'this repository'}:`,
      ...members.map((m, i) => `- ${m.name} at ${m.path}, commit ${heads[i]}`),
      '\nRead the code and the dependencies and report the vulnerabilities you can verify.',
    ].join('\n');

    const onEvent = (event) => {
      if (event.type !== 'assistant') return;
      for (const b of event.message?.content ?? []) {
        if (b.type === 'tool_use' && b.name !== 'StructuredOutput') {
          const first = Object.values(b.input ?? {}).find((v) => typeof v === 'string') ?? '';
          activity.set(name, `${b.name}: ${first.slice(0, 120)}`);
        }
      }
    };
    const result = await claude.run({ args, cwd: members[0].path, prompt, onEvent });
    const out = result.structured_output;
    if (result.is_error || !out || !Array.isArray(out.findings)) throw new Error(result.result || `the audit returned no structured output (${result.subtype ?? 'unknown'})`);
    const usage = usageFromResult(result);
    ledger?.record('audit', usage, { project: name });

    const findings = normalize(out.findings);
    const old = (await readJson(fileOf(name), null)) ?? {};
    const checkedAt = new Date(now()).toISOString();
    await writeJsonAtomic(fileOf(name), {
      ...old, state: 'ready', checkedAt, error: null, summary: text(out.summary, 2000), findings, counts: counts(findings),
      commits: Object.fromEntries(members.map((m, i) => [m.name, heads[i]])),
      cost: round((old.cost ?? 0) + (result.total_cost_usd ?? 0)), usage: addUsage(old.usage, usage),
    });
    const c = counts(findings);
    const worst = c.critical + c.high;
    log('audit', `${name}: haavoittuvuustarkastus: ${findings.length ? `${findings.length} löydöstä (${SEVERITIES.map((s) => `${c[s]} ${s}`).join(', ')})` : 'ei löydöksiä'}`, { project: name, ...(worst ? { level: 'warn' } : {}) });
  }

  /** Starts an audit in the background; refused while one runs for the project. */
  async function start(name) {
    const p = await projects.get(name);
    for (const m of membersOf(p)) if (!existsSync(m.path)) throw new ValidationError(`Folder not found: ${m.path}`);
    if (running.has(name)) throw new ValidationError('The project is already being audited');
    running.add(name); // no await since the check above, so two clicks cannot both start
    const old = (await readJson(fileOf(name), null).catch(() => null)) ?? {};
    try {
      await mkdir(dirOf(name), { recursive: true });
      await writeJsonAtomic(fileOf(name), { ...old, state: 'running', startedAt: new Date(now()).toISOString(), error: null });
    } catch (e) {
      running.delete(name);
      throw e;
    }
    log('audit', `${name}: haavoittuvuustarkastus alkoi`, { project: name });
    const done = audit(name)
      .catch(async (e) => {
        log('audit', `${name}: tarkastus epäonnistui: ${e.message}`, { project: name, level: 'error' });
        const cur = (await readJson(fileOf(name), null)) ?? {};
        await writeJsonAtomic(fileOf(name), { ...cur, state: cur.checkedAt ? 'ready' : 'error', error: e.message }).catch(() => {});
      })
      .finally(() => { running.delete(name); activity.delete(name); inFlight.delete(done); });
    inFlight.add(done);
    return get(name);
  }

  /** Starts the audits that are due: enabled projects whose last start is longer ago than their interval. */
  async function tick() {
    for (const p of await projects.list()) {
      if (!p.audit.enabled || running.has(p.name)) continue;
      const meta = await readJson(fileOf(p.name), null).catch(() => null);
      const last = meta?.startedAt ? Date.parse(meta.startedAt) : null;
      if (last != null && now() - last < p.audit.everyMin * 60_000) continue; // a failed run waits for the next interval too
      await start(p.name).catch((e) => log('audit', `${p.name}: tarkastusta ei voitu aloittaa: ${e.message}`, { project: p.name, level: 'error' }));
    }
  }

  /**
   * Makes a card in the inbox from finding `id` of the latest audit: the finding's text as the brief, its repository
   * (all of the project's when it names none) and a priority from its severity. A finding that already has a card is refused.
   */
  async function ticket(name, id) {
    if (!store) throw new Error('no card store');
    const p = await projects.get(name);
    if (ticketing.has(id)) throw new ValidationError('The card is already being made');
    const current = await get(name);
    const f = current.findings.find((x) => x.id === id);
    if (!f) throw new ValidationError('No such finding in the latest audit');
    if (f.card) throw new ValidationError(`The finding already has a card (${f.card.id})`);
    ticketing.add(id);
    try {
      const members = membersOf(p).map((m) => m.name);
      const card = await store.create({
        title: `Tietoturva: ${f.title}`.slice(0, 300),
        brief: ticketBrief(f, current.checkedAt),
        repos: p.workspace ? (members.includes(f.repo) ? [f.repo] : members) : [p.name],
        priority: PRIORITY_OF[f.severity],
      });
      const meta = (await readJson(fileOf(name), null)) ?? {};
      await writeJsonAtomic(fileOf(name), { ...meta, tickets: { ...meta.tickets, [id]: card.id } });
      log('audit', `${name}: löydöksestä tehtiin kortti: ${f.title}`, { project: name, card: card.id });
    } finally {
      ticketing.delete(id);
    }
    return get(name);
  }

  const settled = async () => { while (inFlight.size) await Promise.all([...inFlight]); };

  return { get, start, tick, ticket, settled };
}
