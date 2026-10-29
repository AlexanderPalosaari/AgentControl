import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NotFoundError, ValidationError } from './cards.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { git } from './git.js';
import { addUsage, usageFromResult } from './usage.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const BLOCKED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const OVERVIEW_MAX = 7000; // what every agent gets inline; the rest is read from the area notes on demand
const AREA_MAX = 12000;
const CONTRACTS_MAX = 6000;

const REPO_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string', description: 'Markdown, at most about 5000 characters, read by every coding agent before it works here: what the product does, stack and versions, architecture, the main modules with their folders and files, entry points, how to build / test / run (exact commands), conventions (naming, error handling, patterns to copy), gotchas and traps, and the glossary of domain terms. Name real paths. A table of the areas ends it.' },
    areas: {
      type: 'array', maxItems: 14,
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'lowercase letters, digits and dashes, e.g. "orders-api"' },
          title: { type: 'string' },
          content: { type: 'string', description: 'Markdown notes for one area an agent may need in depth: its files and what each does, data flow, important functions, invariants, how it is tested, known problems.' },
        },
        required: ['slug', 'title', 'content'],
      },
    },
    removedAreas: { type: 'array', items: { type: 'string' }, description: 'Update only: slugs of earlier areas that no longer exist.' },
  },
  required: ['overview', 'areas'],
};

const CONTRACTS_SCHEMA = {
  type: 'object',
  properties: { contracts: { type: 'string', description: 'Markdown: how the repositories talk to each other. Which calls, events or files of one repository hit which endpoints, handlers or schemas of another (name both sides with paths), shared types and where they are defined, versioning and auth between them, and which kinds of change must move several repositories together.' } },
  required: ['contracts'],
};

const REPO_PROMPT = [
  'You study one existing code repository and write down what a coding agent needs to know to work in it quickly and safely. Your notes are the project\'s memory: they are given to every agent before it starts, so they must be accurate, specific and compact.',
  'You never change anything. Read the code for real: the build files, the entry points, the main modules, the tests, the README. Do not guess; say "unclear" where the code does not say.',
  'Prefer facts an agent cannot cheaply see from one file: how the parts fit together, where a kind of change belongs, which command really runs the tests, what looks reusable, what is a trap. Name paths and symbols.',
  'Write in the language of the README or comments (default English). Your final reply must be the structured output and nothing else.',
].join('\n');

const CONTRACTS_PROMPT = [
  'You study how several repositories of one product fit together, so that a person (or a planner) can tell which repositories a change touches and what the quickest sound solution is.',
  'You never change anything. You get a summary of each repository; verify the connections in the code (API clients and the endpoints they call, shared types, message formats, config) before you write them down. Name both sides with paths.',
  'Write in the language of the summaries. Your final reply must be the structured output and nothing else.',
].join('\n');

const slugOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n\n[cut: too long]` : s);
const round = (n) => Math.round(n * 1e4) / 1e4;

/**
 * Each existing project (added from a folder, or over several repositories) can be explored: read-only agents study
 * its code and write a map the project remembers (data/projects/<name>/map/): MAP.md, which every agent of the
 * project gets inline, `areas/*.md` they read when they work in that area, and map.json (when it was made, at which
 * commit of each repository, and what it cost). Re-exploring after the code moved only studies what changed.
 */
export function createExplorer({ dataDir, claude, model = null, effort = null, ledger = null, log = () => {} }) {
  const projectsDir = join(dataDir, 'projects');
  const dirOf = (name) => join(projectsDir, name, 'map');
  const running = new Set();
  const activity = new Map();
  const inFlight = new Set();

  async function project(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new NotFoundError(`Project ${name} not found`);
    const p = await readJson(join(projectsDir, name, 'project.json'), null);
    if (!p) throw new NotFoundError(`Project ${name} not found`);
    return p;
  }
  const membersOf = (p) => (p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }]);
  const loadMeta = async (name) => {
    const meta = await readJson(join(dirOf(name), 'map.json'), null);
    if (meta?.state === 'running' && !running.has(name)) return { ...meta, state: meta.exploredAt ? 'ready' : 'error', error: 'Tutkiminen keskeytyi, kun AgentControl käynnistettiin uudelleen. Käynnistä se uudelleen.' };
    return meta;
  };

  const head = (path) => git(['rev-parse', 'HEAD'], path).catch(() => null);
  const branchOf = (path) => git(['symbolic-ref', '--short', 'HEAD'], path).catch(() => 'HEAD');
  /** Commits made since the repository was explored; null when that commit is gone (history rewritten). */
  async function behind(path, sha) {
    if (!sha) return null;
    const n = await git(['rev-list', '--count', `${sha}..HEAD`], path).catch(() => null);
    return n == null ? null : Number(n);
  }

  /** What the page shows: the state, when it was explored and how far each repository has moved since. */
  async function get(name) {
    const p = await project(name);
    const meta = await loadMeta(name);
    const repos = await Promise.all(membersOf(p).map(async (m) => {
      const known = meta?.repos?.find((r) => r.name === m.name);
      return { name: m.name, path: m.path, sha: known?.sha ?? null, branch: known?.branch ?? null, behind: meta?.exploredAt ? await behind(m.path, known?.sha) : null, explored: Boolean(known) };
    }));
    const text = existsSync(join(dirOf(name), 'MAP.md')) ? await readFile(join(dirOf(name), 'MAP.md'), 'utf8') : '';
    return {
      project: name, state: meta?.state ?? 'none', exploredAt: meta?.exploredAt ?? null, error: meta?.error ?? null, cost: meta?.cost ?? 0,
      activity: activity.get(name) ?? null, repos, text, dir: dirOf(name),
      stale: repos.some((r) => !r.explored || r.behind == null || r.behind > 0),
    };
  }

  async function runJson({ args, cwd, prompt, name }) {
    const onEvent = (event) => {
      if (event.type !== 'assistant') return;
      for (const b of event.message?.content ?? []) {
        if (b.type === 'tool_use' && b.name !== 'StructuredOutput') {
          const first = Object.values(b.input ?? {}).find((v) => typeof v === 'string') ?? '';
          activity.set(name, `${b.name}: ${first.slice(0, 120)}`);
        }
      }
    };
    const result = await claude.run({ args, cwd, prompt, onEvent });
    const out = result.structured_output;
    if (result.is_error || !out || typeof out !== 'object') throw new Error(result.result || `claude returned no structured output (${result.subtype ?? 'unknown'})`);
    return { out, result };
  }

  function baseArgs(p, schema, system) {
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(schema),
      '--permission-mode', 'plan',
      '--allowedTools', ...READ_ONLY_TOOLS,
      '--disallowedTools', ...BLOCKED_TOOLS,
      '--append-system-prompt', system,
    ];
    const useModel = p.model ?? model;
    const useEffort = p.effort ?? effort;
    if (useModel) args.push('--model', useModel);
    if (useEffort) args.push('--effort', useEffort);
    return args;
  }

  async function readAreas(name) {
    const dir = join(dirOf(name), 'areas');
    const out = new Map();
    for (const f of await readdir(dir).catch(() => [])) {
      if (!f.endsWith('.md')) continue;
      out.set(f.slice(0, -3), (await readFile(join(dir, f), 'utf8')).trim());
    }
    return out;
  }

  /**
   * Studies the repositories that are new or have moved (all of them with `full`) in parallel, then, when the
   * project has several, how they connect. Writes the map only when everything succeeded: a failed run keeps the old one.
   */
  async function explore(name, full) {
    const p = await project(name);
    const meta = (await loadMeta(name)) ?? {};
    const members = membersOf(p);
    const known = new Map((meta.repos ?? []).map((r) => [r.name, r]));
    const heads = new Map(await Promise.all(members.map(async (m) => [m.name, await head(m.path)])));
    for (const m of members) if (!heads.get(m.name)) throw new ValidationError(`${m.path} has no commits to explore`);
    const todo = members.filter((m) => full || !known.has(m.name) || known.get(m.name).sha !== heads.get(m.name));
    if (!todo.length) return;

    let cost = 0;
    let usage = meta.usage;
    const notes = new Map(); // repo -> { overview, areas: Map(slug -> {title, content}) }
    const oldAreas = await readAreas(name);
    const oldOverviews = new Map(Object.entries(meta.overviews ?? {}));

    await Promise.all(todo.map(async (m) => {
      const prior = !full && known.has(m.name) && oldOverviews.has(m.name) ? known.get(m.name) : null;
      let prompt = [`Repository "${m.name}" at ${m.path}. Branch ${await branchOf(m.path)}, commit ${heads.get(m.name)}.`];
      if (prior) {
        const changed = await git(['diff', '--name-status', `${prior.sha}..HEAD`], m.path).catch(() => '');
        const history = await git(['log', '--oneline', '-n', '40', `${prior.sha}..HEAD`], m.path).catch(() => '');
        prompt.push(
          'You explored it before; update your notes. Your previous overview follows, then what changed since. Read the changed code and everything the changes touch, keep what is still true, correct what is not.',
          `\n## Previous overview\n\n${oldOverviews.get(m.name)}`,
          `\n## Existing areas\n\n${[...oldAreas.keys()].filter((k) => k.startsWith(`${m.name}--`)).map((k) => `- ${k.slice(m.name.length + 2)}`).join('\n') || '(none)'}`,
          `\n## Commits since\n\n${history || '(unknown)'}`,
          `\n## Changed files\n\n${changed.split('\n').slice(0, 300).join('\n') || '(unknown)'}`,
          '\nReturn the full updated overview, only the areas that changed or are new (full content each), and `removedAreas` for slugs that are gone.',
        );
      } else {
        prompt.push('Explore it and write the overview and the area notes.');
      }
      const { out, result } = await runJson({ args: baseArgs(p, REPO_SCHEMA, REPO_PROMPT), cwd: m.path, prompt: prompt.join('\n'), name });
      cost += result.total_cost_usd ?? 0;
      usage = addUsage(usage, usageFromResult(result));
      ledger?.record('explore', usageFromResult(result), { project: name });
      const overview = String(out.overview ?? '').trim();
      if (!overview) throw new Error(`The explorer returned an empty overview for ${m.name}`);
      const areas = new Map();
      for (const a of Array.isArray(out.areas) ? out.areas : []) {
        const slug = slugOf(a?.slug || a?.title);
        if (SLUG_RE.test(slug) && String(a.content ?? '').trim()) areas.set(slug, { title: String(a.title ?? slug).trim().slice(0, 120), content: cut(String(a.content).trim(), AREA_MAX) });
      }
      const removed = prior ? new Set((Array.isArray(out.removedAreas) ? out.removedAreas : []).map(slugOf)) : null;
      notes.set(m.name, { overview: cut(overview, OVERVIEW_MAX), areas, removed, prior: Boolean(prior) });
    }));

    // Overviews of every repository (the ones not studied this time keep the old text), then how they connect.
    const overviews = Object.fromEntries(members.map((m) => [m.name, notes.get(m.name)?.overview ?? oldOverviews.get(m.name) ?? '']));
    let contracts = meta.contracts ?? '';
    if (members.length > 1) {
      const prompt = [
        `Project "${name}" has ${members.length} repositories:`,
        ...members.map((m) => `- ${m.name}: ${m.path}`),
        ...members.map((m) => `\n## ${m.name}\n\n${overviews[m.name]}`),
        meta.contracts && !full ? `\n## Previous notes on how they connect (verify and update)\n\n${meta.contracts}` : '',
        '\nVerify how they connect in the code and write the notes.',
      ].filter(Boolean).join('\n');
      const args = baseArgs(p, CONTRACTS_SCHEMA, CONTRACTS_PROMPT);
      for (const m of members.slice(1)) args.push('--add-dir', m.path);
      const { out, result } = await runJson({ args, cwd: members[0].path, prompt, name });
      cost += result.total_cost_usd ?? 0;
      usage = addUsage(usage, usageFromResult(result));
      ledger?.record('explore', usageFromResult(result), { project: name });
      contracts = cut(String(out.contracts ?? '').trim(), CONTRACTS_MAX);
    }

    // Everything succeeded: now write.
    const dir = dirOf(name);
    const areasDir = join(dir, 'areas');
    await mkdir(areasDir, { recursive: true });
    const allAreas = new Map([...oldAreas].filter(([k]) => members.some((m) => k.startsWith(`${m.name}--`))));
    const titles = new Map(Object.entries(meta.areaTitles ?? {}));
    for (const [repo, n] of notes) {
      if (!n.prior) for (const k of [...allAreas.keys()]) if (k.startsWith(`${repo}--`)) { allAreas.delete(k); titles.delete(k); }
      for (const slug of n.removed ?? []) { allAreas.delete(`${repo}--${slug}`); titles.delete(`${repo}--${slug}`); }
      for (const [slug, a] of n.areas) { allAreas.set(`${repo}--${slug}`, a.content); titles.set(`${repo}--${slug}`, a.title); }
    }
    for (const f of await readdir(areasDir).catch(() => [])) if (!allAreas.has(f.replace(/\.md$/, ''))) await rm(join(areasDir, f), { force: true });
    for (const [k, content] of allAreas) await writeFile(join(areasDir, `${k}.md`), `${content}\n`, 'utf8');

    const exploredAt = new Date().toISOString();
    const reposMeta = await Promise.all(members.map(async (m) => ({ name: m.name, path: m.path, sha: notes.has(m.name) ? heads.get(m.name) : known.get(m.name)?.sha ?? heads.get(m.name), branch: await branchOf(m.path) })));
    const map = [
      `# Code map: ${name}`,
      `Explored ${exploredAt.slice(0, 10)}. ${reposMeta.map((r) => `${r.name}@${r.sha.slice(0, 8)}`).join(', ')}. Written by a read-only explorer from the code: trust the code over this map where they disagree.`,
      ...members.map((m) => `\n## Repository ${m.name} (${m.path})\n\n${overviews[m.name]}`),
      contracts ? `\n## How the repositories connect\n\n${contracts}` : '',
      allAreas.size ? `\n## Detailed notes\n\nRead these when you work in the area (${join(dir, 'areas')}):\n${[...allAreas.keys()].sort().map((k) => `- ${k}.md: ${titles.get(k) ?? k}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    await writeFile(join(dir, 'MAP.md'), `${map}\n`, 'utf8');
    await writeJsonAtomic(join(dir, 'map.json'), {
      state: 'ready', exploredAt, error: null, repos: reposMeta, overviews, contracts, areaTitles: Object.fromEntries(titles),
      cost: round((meta.cost ?? 0) + cost), usage,
    });
    log('explore', `${name}: koodikartta ${todo.length === members.length ? 'tehty' : 'päivitetty'} (${todo.map((m) => m.name).join(', ')}, ${allAreas.size} aluetta)`, { project: name });
  }

  /**
   * Starts exploring in the background. `full` studies everything again; by default only repositories that are new
   * or have new commits since the last time are studied.
   */
  async function start(name, { full = false } = {}) {
    const p = await project(name);
    if (!p.imported) throw new ValidationError('Exploring is for projects added from existing code; a new project has none yet');
    if (running.has(name)) throw new ValidationError('The project is already being explored');
    for (const m of membersOf(p)) if (!existsSync(m.path)) throw new ValidationError(`Folder not found: ${m.path}`);
    const meta = (await loadMeta(name)) ?? {};
    running.add(name); // no await since the check above, so two clicks cannot both start
    try {
      await mkdir(dirOf(name), { recursive: true });
      await writeJsonAtomic(join(dirOf(name), 'map.json'), { ...meta, state: 'running', error: null });
    } catch (e) {
      running.delete(name);
      throw e;
    }
    log('explore', `${name}: koodin tutkiminen alkoi${full ? ' (kaikki uudelleen)' : ''}`, { project: name });
    const done = explore(name, full === true)
      .catch(async (e) => {
        log('explore', `${name}: tutkiminen epäonnistui: ${e.message}`, { project: name, level: 'error' });
        const old = (await readJson(join(dirOf(name), 'map.json'), null)) ?? {};
        await writeJsonAtomic(join(dirOf(name), 'map.json'), { ...old, state: old.exploredAt ? 'ready' : 'error', error: e.message }).catch(() => {});
      })
      .then(async () => { // nothing to study (up to date) leaves the state as it was
        const cur = await readJson(join(dirOf(name), 'map.json'), null);
        if (cur?.state === 'running') await writeJsonAtomic(join(dirOf(name), 'map.json'), { ...cur, state: cur.exploredAt ? 'ready' : 'none' });
      })
      .finally(() => { running.delete(name); activity.delete(name); inFlight.delete(done); });
    inFlight.add(done);
    return get(name);
  }

  /** The text agents get about a project's code: the map, and where the area notes are. Null when there is none. */
  async function mapOf(name) {
    const meta = await readJson(join(dirOf(name), 'map.json'), null);
    if (!meta?.exploredAt || !existsSync(join(dirOf(name), 'MAP.md'))) return null;
    return { text: await readFile(join(dirOf(name), 'MAP.md'), 'utf8'), dir: dirOf(name), areasDir: join(dirOf(name), 'areas') };
  }

  /**
   * The maps of the projects whose code a card works in: the project of the card's first repository, and projects over
   * several repositories that include it. `section` is ready to put in a prompt; `dirs` are the folders to allow reading.
   */
  async function contextFor(repo) {
    if (typeof repo !== 'string') return null;
    const found = [];
    for (const name of await readdir(projectsDir).catch(() => [])) {
      const p = await readJson(join(projectsDir, name, 'project.json'), null).catch(() => null);
      if (!p || !(p.name === repo || p.workspaceRepos?.some((r) => r.name === repo))) continue;
      const map = await mapOf(name).catch(() => null);
      if (map) found.push(map);
    }
    if (!found.length) return null;
    return {
      section: `## Code map of this project\n\nWritten earlier by an explorer that read the code; it can lag behind the code, so check what you rely on.\n\n${found.map((m) => m.text).join('\n\n')}`,
      dirs: found.map((m) => m.areasDir).filter((d) => existsSync(d)),
    };
  }

  const settled = async () => { while (inFlight.size) await Promise.all([...inFlight]); };

  return { get, start, mapOf, contextFor, settled };
}
