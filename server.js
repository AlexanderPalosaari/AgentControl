import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AFTER_KINDS, ConfirmationError, MANUAL_MOVES, MergeConflictError, NotFoundError, STATUSES, PRIORITIES, ValidationError, canMove, createCardStore } from './lib/cards.js';
import { createClaude } from './lib/claude.js';
import { createRefiner } from './lib/refine.js';
import { createAgents } from './lib/agents.js';
import { createRunner } from './lib/runs.js';
import { createAzCliToken, createAzdo } from './lib/azdo.js';
import { createPublisher } from './lib/prs.js';
import { createGithub, createGithubToken } from './lib/github.js';
import { createProjects } from './lib/projects.js';
import { createExplorer } from './lib/explore.js';
import { createAuditor } from './lib/audit.js';
import { createRepos } from './lib/repos.js';
import { EFFORTS, MODEL_ALIASES } from './lib/models.js';
import { createOrchestrator } from './lib/orchestrator.js';
import { MAX_CANVAS_BODY, createSandbox } from './lib/sandbox.js';
import { MAX_IMAGE, createAttachments } from './lib/attachments.js';
import { createNextSteps, createPhases } from './lib/next.js';
import { createTrust } from './lib/trust.js';
import { createTranscriptReader, createUsageLedger } from './lib/usage.js';
import { createJournal } from './lib/events.js';
import { createReviewer } from './lib/review.js';
import { createVoiceInterpreter } from './lib/voice.js';
import { createStt, decodeSamples } from './lib/stt.js';
import { EXIT_LOCKED, LockedError, acquireLock } from './lib/lock.js';
import { createRetention } from './lib/retention.js';
import { writeJsonAtomic } from './lib/fsutil.js';

const root = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const COOKIE = 'ac_token';
const MAX_BODY = 1_000_000;
const LOGIN_CODE_MS = 10 * 60_000;
const MAX_AUDIO = 16_000 * 30 * 4; // 30 s of 16 kHz float32
const MAX_SHARE = Math.ceil(MAX_IMAGE * 1.4) + 10_000; // a sandbox drawing: a PNG as base64 in JSON

export function createApp({ dataDir, token, archiveDays = 30, claude = createClaude(), reposRoot = dirname(root), model = null, effort = null, runner: runnerOptions = {}, reviewer = null, azdo = createAzdo({ getToken: createAzCliToken() }), github = createGithub({ getToken: createGithubToken() }), publisher: publisherOptions = {}, voice: voiceOptions = {}, orchestrator: orchestratorOptions = {}, sandbox: sandboxOptions = {}, stt = createStt({ cacheDir: join(dataDir, 'models') }), transcripts = null }) {
  // On disk, so the log and the conversation survive restarts.
  // A command that fails every few seconds (e.g. `claude agents` broken by an update) is logged once, then counted.
  const journal = createJournal(join(dataDir, 'events.jsonl'), { collapseMs: 10 * 60_000 });
  const chatLog = createJournal(join(dataDir, 'chat.jsonl'));
  const log = (kind, text, extra = {}) => journal.add({ kind, text, ...extra });
  const ledger = createUsageLedger(dataDir); // every token spent, by what and for which card or project
  const store = createCardStore(dataDir, { log });
  const repos = createRepos({ reposRoot, dataDir }); // where each repository name lives: under reposRoot, or in a folder added as a project
  const explorer = createExplorer({ dataDir, claude, model, effort, ledger, log }); // the code map of each existing project, which its agents get
  const projects = createProjects({ dataDir, reposRoot, repos, store, claude, github, model, effort, ledger, log, mapOf: explorer.mapOf });
  const auditor = createAuditor({ dataDir, claude, projects, store, model, effort, ledger, log }); // the vulnerability audit of the projects that turned it on
  const voice = createVoiceInterpreter({ claude, logFile: join(dataDir, 'voice-fallbacks.jsonl'), ledger, ...voiceOptions });
  const attachments = createAttachments({ store });
  // A card works in its first repository, and that repository's project (if it is one) chooses the model and effort.
  const projectSettings = (card) => projects.settingsFor(card.repos[0]);
  const projectContext = (card) => explorer.contextFor(card.repos[0]);
  const refiner = createRefiner({ store, claude, reposRoot, repos, model, effort, projectSettings, projectContext, attachments, ledger, log });
  const runner = createRunner({ store, agents: createAgents({ claude }), dataDir, reposRoot, repos, refiner, reviewer, attachments, projectSettings, projectContext, ledger, transcripts, log, ...runnerOptions });
  // Limits saved from the Settings page win over the startup values (environment variables).
  const settingsFile = join(dataDir, 'settings.json');
  try { runner.setLimits(JSON.parse(readFileSync(settingsFile, 'utf8')).runner ?? {}); } catch { /* nothing saved, or unreadable: keep the startup values */ }
  const publisher = createPublisher({ store, azdo, reposRoot, repos, log, ...publisherOptions });
  const retention = createRetention({ store, days: archiveDays, log });
  const nextSteps = createNextSteps({ store, refiner, runner, projects, publisher });
  const phases = createPhases({ store, refiner, runner, projects });
  // The orchestrator's board tools call this server back, so they need the address it ends up listening on.
  const orchestrator = createOrchestrator({ claude, dataDir, token, ledger, log, getBaseUrl: () => `http://127.0.0.1:${server.address().port}`, ...orchestratorOptions });
  // Each project's brainstorming chat and drawing canvas.
  const sandbox = createSandbox({ claude, dataDir, projects, explorer, store, attachments, ledger, log, ...sandboxOptions });

  const tokenOk = (given) => {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const cookieToken = (req) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };

  // One-time sign-in codes: the address the app prints carries one of these instead of the long-lived token, so the
  // token does not end up in browser history or a copied terminal line. A code works once and for ten minutes.
  const logins = new Map(); // code -> expiry (ms)
  const newLoginCode = () => {
    for (const [c, exp] of logins) if (exp < Date.now()) logins.delete(c);
    const code = randomBytes(18).toString('base64url');
    logins.set(code, Date.now() + LOGIN_CODE_MS);
    return code;
  };
  const takeLoginCode = (given) => {
    const exp = typeof given === 'string' ? logins.get(given) : undefined;
    logins.delete(given);
    return exp !== undefined && exp >= Date.now();
  };

  const server = createServer(async (req, res) => {
    try {
      // Reject foreign Host headers (DNS rebinding protection).
      const hostName = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (hostName !== '127.0.0.1' && hostName !== 'localhost') return send(res, 403, { error: 'forbidden host' });

      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/' && (url.searchParams.has('token') || url.searchParams.has('login'))) {
        const ok = url.searchParams.has('login') ? takeLoginCode(url.searchParams.get('login')) : tokenOk(url.searchParams.get('token'));
        if (!ok) return send(res, 401, { error: 'unauthorized' });
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          Location: '/',
        });
        return res.end();
      }

      if (!tokenOk(cookieToken(req))) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/') {
        const html = await readFile(join(root, 'public', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      // The page's own files: the two shared modules, the style sheet and the scripts under /js (a fixed name shape, no paths).
      const asset = req.method === 'GET' && url.pathname.match(/^\/(?:voice\.js|mic\.js|style\.css|js\/[a-z-]+\.js)$/);
      if (asset) {
        const file = await readFile(join(root, 'public', url.pathname)).catch(() => null);
        if (!file) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(file);
      }

      if (url.pathname === '/api/voice/interpret' && req.method === 'POST') {
        return send(res, 200, await voice.interpret(await readJson(req)));
      }

      if (url.pathname === '/api/transcribe' && req.method === 'POST') {
        let samples;
        try { samples = decodeSamples(await readRaw(req, MAX_AUDIO)); } catch (e) { throw new ValidationError(e.message); }
        return send(res, 200, { text: await stt.transcribe(samples) });
      }

      if (url.pathname === '/api/meta' && req.method === 'GET') {
        return send(res, 200, { statuses: STATUSES, priorities: PRIORITIES, moves: MANUAL_MOVES, afterKinds: AFTER_KINDS, models: MODEL_ALIASES, efforts: EFFORTS, reposRoot });
      }

      if (url.pathname === '/api/repos' && req.method === 'GET') return send(res, 200, await listRepos(reposRoot, repos));
      if (url.pathname === '/api/next' && req.method === 'GET') return send(res, 200, await nextSteps.list());
      if (url.pathname === '/api/phases' && req.method === 'GET') return send(res, 200, await phases.list());

      if (url.pathname === '/api/usage' && req.method === 'GET') return send(res, 200, await ledger.summary({ days: limitParam(url, 14) }));

      if (url.pathname === '/api/events' && req.method === 'GET') return send(res, 200, await journal.tail(limitParam(url, 300)));
      if (url.pathname === '/api/events/stream' && req.method === 'GET') return streamJournal(req, res, limitParam(url, 300));
      if (url.pathname === '/api/chat') {
        if (req.method === 'GET') return send(res, 200, await chatLog.tail(limitParam(url, 200)));
        if (req.method === 'POST') {
          const { who, text, error } = await readJson(req);
          if (!['me', 'bot'].includes(who) || typeof text !== 'string' || !text.trim()) throw new ValidationError('who (me|bot) and text are required');
          return send(res, 201, chatLog.add({ who, text, error: error === true }));
        }
      }

      if (url.pathname === '/api/orchestrator') {
        if (req.method === 'GET') return send(res, 200, await orchestrator.status());
        if (req.method === 'POST') return send(res, 200, await orchestrator.send(await readJson(req)));
      }
      if (url.pathname === '/api/orchestrator/reset' && req.method === 'POST') return send(res, 200, await orchestrator.reset());

      const sb = url.pathname.match(/^\/api\/sandbox\/([^/]+)(?:\/(chat|canvas|share|reset|card|image\/(canvas-\d+\.png)))?$/);
      if (sb) {
        let name = '';
        try { name = decodeURIComponent(sb[1]); } catch { /* malformed: not found below */ }
        const action = sb[3] ? 'image' : sb[2];
        if (!action && req.method === 'GET') return send(res, 200, await sandbox.getState(name));
        if (action === 'chat' && req.method === 'POST') return send(res, 200, await sandbox.send(name, await readJson(req)));
        if (action === 'canvas' && req.method === 'PUT') return send(res, 200, await sandbox.saveCanvas(name, await readJson(req, MAX_CANVAS_BODY)));
        if (action === 'canvas' && req.method === 'DELETE') return send(res, 200, await sandbox.clearCanvas(name));
        if (action === 'share' && req.method === 'POST') return send(res, 200, await sandbox.share(name, await readJson(req, MAX_SHARE)));
        if (action === 'reset' && req.method === 'POST') return send(res, 200, await sandbox.reset(name));
        if (action === 'card' && req.method === 'POST') return send(res, 201, await sandbox.createCard(name, await readJson(req)));
        if (action === 'image' && req.method === 'GET') {
          const data = await sandbox.readImage(name, sb[3]);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(data);
        }
      }

      if (url.pathname === '/api/projects') {
        if (req.method === 'GET') return send(res, 200, await withActiveAgents(await projects.list()));
        if (req.method === 'POST') return send(res, 201, await projects.create(await readJson(req)));
      }

      if (url.pathname === '/api/projects/existing' && req.method === 'POST') return send(res, 201, await projects.addExisting(await readJson(req)));

      const pj = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(source-control|settings|plan|tasks|delete|map|explore|audit|audit\/run|audit\/ticket|commits|branches|hidden))?$/);
      if (pj) {
        let name = '';
        try { name = decodeURIComponent(pj[1]); } catch { /* malformed: not found below */ }
        if (!pj[2] && req.method === 'GET') return send(res, 200, await projects.get(name));
        if (pj[2] === 'source-control' && req.method === 'POST') return send(res, 200, await projects.setSourceControl(name, await readJson(req)));
        if (pj[2] === 'settings' && req.method === 'POST') return send(res, 200, await projects.setSettings(name, await readJson(req)));
        if (pj[2] === 'plan' && req.method === 'POST') return send(res, 202, await projects.plan(name, await readJson(req)));
        if (pj[2] === 'tasks' && req.method === 'POST') return send(res, 201, await projects.createTasks(name, await readJson(req)));
        if (pj[2] === 'map' && req.method === 'GET') return send(res, 200, await explorer.get(name));
        if (pj[2] === 'explore' && req.method === 'POST') return send(res, 202, await explorer.start(name, { full: (await readJson(req)).full === true }));
        if (pj[2] === 'commits' && req.method === 'GET') return send(res, 200, url.searchParams.has('sha') ? await projects.commitDetails(name, url.searchParams.get('sha')) : await projects.recentCommits(name));
        if (pj[2] === 'hidden' && req.method === 'POST') return send(res, 200, await projects.setHidden(name, await readJson(req)));
        if (pj[2] === 'branches' && req.method === 'POST') return send(res, 200, await projects.switchBranch(name, await readJson(req)));
        if (pj[2] === 'branches' && req.method === 'GET') return send(res, 200, await projects.branches(name, { fetch: url.searchParams.get('fetch') === '1' }));
        if (pj[2] === 'audit' && req.method === 'GET') return send(res, 200, await auditor.get(name));
        if (pj[2] === 'audit' && req.method === 'POST') { await projects.setAudit(name, await readJson(req)); return send(res, 200, await auditor.get(name)); }
        if (pj[2] === 'audit/run' && req.method === 'POST') return send(res, 202, await auditor.start(name));
        if (pj[2] === 'audit/ticket' && req.method === 'POST') return send(res, 201, await auditor.ticket(name, String((await readJson(req)).finding ?? '')));
        if (pj[2] === 'delete' && req.method === 'POST') return send(res, 200, await projects.remove(name, { deleteFolder: (await readJson(req)).deleteFolder === true }));
      }

      if (url.pathname === '/api/cards') {
        if (req.method === 'GET') { // the cards of hidden projects are marked, so the page shows them only where asked
          const [cards, hidden] = await Promise.all([store.list(), projects.hiddenCards()]);
          return send(res, 200, cards.map((c) => (hidden(c) ? { ...c, hidden: true } : c)));
        }
        if (req.method === 'POST') return send(res, 201, await store.create(await readJson(req)));
      }

      const m = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
      if (m) {
        if (req.method === 'GET') return send(res, 200, await store.get(m[1]));
        if (req.method === 'PATCH') {
          const patch = await readJson(req);
          if ('status' in patch) {
            const { status: from } = await store.get(m[1]);
            if (!canMove(from, patch.status)) throw new ValidationError(`A card cannot be moved from ${from} to ${patch.status} by hand`);
          }
          return send(res, 200, await store.update(m[1], patch));
        }
      }

      if (url.pathname === '/api/dispatcher') {
        if (req.method === 'POST') runner.setEnabled((await readJson(req)).enabled);
        return send(res, 200, await runner.status());
      }

      if (url.pathname === '/api/settings') {
        if (req.method === 'POST') {
          const cfg = runner.setLimits(await readJson(req));
          await writeJsonAtomic(settingsFile, { runner: cfg });
          log('app', `Asetukset: päiväraja ${cfg.dayLimit}, yöraja ${cfg.nightLimit}, yö ${cfg.nightStart}–${cfg.nightEnd}`);
        }
        return send(res, 200, { runner: { ...await runner.status(), ...runner.limits() }, reviewEnabled: Boolean(reviewer), archiveDays, reposRoot });
      }

      const am = url.pathname.match(/^\/api\/cards\/([^/]+)\/attachments(?:\/([^/]+))?$/);
      if (am) {
        const [, id, name] = am;
        if (!name && req.method === 'GET') return send(res, 200, (await attachments.list(id)).map((a) => ({ name: a.name, url: `/api/cards/${id}/attachments/${a.name}` })));
        if (!name && req.method === 'POST') return send(res, 201, await attachments.add(id, req.headers['content-type'], await readRaw(req, MAX_IMAGE)));
        if (name && req.method === 'GET') {
          const { data, contentType } = await attachments.read(id, name);
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(data);
        }
      }

      const dm = url.pathname.match(/^\/api\/cards\/([^/]+)\/diff$/);
      if (dm && req.method === 'GET') return send(res, 200, await runner.diff(dm[1]));

      const pr = url.pathname.match(/^\/api\/cards\/([^/]+)\/pr$/);
      if (pr && req.method === 'POST') return send(res, 200, await publisher.publish(pr[1]));

      const mg = url.pathname.match(/^\/api\/cards\/([^/]+)\/merge$/);
      if (mg && req.method === 'POST') return send(res, 200, await publisher.mergeLocal(mg[1]));

      const rc = url.pathname.match(/^\/api\/cards\/([^/]+)\/resolve-conflicts$/);
      if (rc && req.method === 'POST') return send(res, 202, await runner.resolveConflicts(rc[1]));

      const run = url.pathname.match(/^\/api\/cards\/([^/]+)\/run(?:\/(answer|stop|retry|attach))?$/);
      if (run) {
        const [, id, action] = run;
        if (!action && req.method === 'GET') return send(res, 200, { ...await runner.details(id), prs: await publisher.get(id), localMerge: await publisher.canMergeLocal(id) });
        if (action === 'attach' && req.method === 'POST') return send(res, 200, await runner.attach(id));
        if (action && req.method === 'POST') {
          const out = action === 'answer' ? await runner.answer(id, await readJson(req)) : action === 'stop' ? await runner.stop(id) : await runner.retry(id);
          return send(res, 202, out);
        }
      }

      const r = url.pathname.match(/^\/api\/cards\/([^/]+)\/(refine|live)(?:\/(start|answer|retry|approve))?$/);
      if (r) {
        const [, id, area, action] = r;
        if (area === 'refine' && !action && req.method === 'GET') return send(res, 200, await refiner.get(id));
        if (area === 'live' && req.method === 'GET') return streamLive(req, res, id);
        if (area === 'refine' && action && req.method === 'POST') {
          if (action === 'approve') return send(res, 200, await refiner.approve(id, await readJson(req)));
          const body = action === 'answer' || action === 'start' ? await readJson(req) : undefined;
          const out = action === 'start' ? await refiner.start(id, { confirmed: body.confirmed === true }) : action === 'retry' ? await refiner.retry(id) : await refiner.answer(id, body);
          return send(res, 202, out);
        }
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof MergeConflictError) return send(res, 400, { error: e.message, conflict: true, files: e.files });
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      if (e instanceof ConfirmationError) return send(res, 409, { error: e.message, confirm: true, ...e.details });
      if (e instanceof NotFoundError) return send(res, 404, { error: e.message });
      if (e.expose) return send(res, 502, { error: e.message }); // git / Azure DevOps / az failures: the message is what the person needs
      console.error(e);
      send(res, 500, { error: 'internal error' });
    }
  });

  /**
   * How many agents work on each project right now: implementation agents (running cards), refiners mid-turn,
   * and the project's own planner. Counted over the cards that work in the project's repository.
   */
  async function withActiveAgents(list) {
    const cards = await store.list();
    return Promise.all(list.map(async (p) => {
      const names = [p.name, ...(p.workspaceRepos ?? []).map((r) => r.name)];
      const mine = cards.filter((c) => c.repos.some((r) => names.includes(r)) && !c.project);
      let activeAgents = mine.filter((c) => c.status === 'running').length + (p.step === 'planning' ? 1 : 0);
      for (const c of mine.filter((x) => x.status === 'refining')) {
        if ((await refiner.get(c.id).catch(() => null))?.state === 'running') activeAgents++;
      }
      return { ...p, activeAgents };
    }));
  }

  /** The event log as server-sent events: the last `backlog` entries, then live ones. */
  async function streamJournal(req, res, backlog) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const write = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    const early = []; // entries that arrive while the backlog is read
    let ready = false;
    const unsubscribe = journal.subscribe((e) => (ready ? write(e) : early.push(e)));
    const past = await journal.tail(backlog);
    const seen = new Set(past.map((e) => `${e.t}|${e.text}`));
    for (const e of [...past, ...early.filter((x) => !seen.has(`${x.t}|${x.text}`))]) write(e);
    ready = true;
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
  }

  async function streamLive(req, res, id) {
    await store.get(id); // 404 for unknown cards
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const write = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    for (const entry of await refiner.liveTail(id)) write(entry);
    const unsubscribe = refiner.subscribe(id, write);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
  }

  server.store = store;
  server.refiner = refiner;
  server.runner = runner;
  server.stt = stt;
  server.publisher = publisher;
  server.projects = projects;
  server.explorer = explorer;
  server.auditor = auditor;
  server.repos = repos;
  server.orchestrator = orchestrator;
  server.sandbox = sandbox;
  server.log = log;
  server.ledger = ledger;
  server.newLoginCode = newLoginCode;
  server.journal = journal;
  server.retention = retention;
  server.on('close', () => { runner.shutdown(); publisher.shutdown(); stt.close?.(); });
  return server;
}

/** Names of the git repositories directly under the repos root, plus projects added from other folders (what a card's `repos` can refer to). */
async function listRepos(reposRoot, repos) {
  const entries = await readdir(reposRoot, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => e.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.name) && existsSync(join(reposRoot, e.name, '.git')))
    .map((e) => e.name);
  for (const name of repos.names()) if (!names.includes(name) && existsSync(join(repos.path(name), '.git'))) names.push(name);
  return names.sort((a, b) => a.localeCompare(b));
}

/** `?limit=` as a whole number in 1..1000, else the fallback. */
function limitParam(url, fallback) {
  const n = Number(url.searchParams.get('limit'));
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readRaw(req, max) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new ValidationError('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, max = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new ValidationError('body too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new ValidationError('body must be a JSON object');
  }
}

async function loadToken(dataDir) {
  const file = join(dataDir, 'token.txt');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const token = randomBytes(24).toString('hex');
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, token, 'utf8');
  return token;
}

/** AGENTCONTROL_DAY_LIMIT, _NIGHT_LIMIT, _NIGHT ("22-7"), _AGENT_MODEL, _AGENT_EFFORT, _AGENT_TOOLS (comma-separated), _AGENT_PERMISSION_MODE (default auto), _DISPATCH=0 to start paused. */
function runnerEnv(env) {
  const opts = { model: env.AGENTCONTROL_AGENT_MODEL ?? null, effort: env.AGENTCONTROL_AGENT_EFFORT ?? null };
  if (env.AGENTCONTROL_DAY_LIMIT) opts.dayLimit = Number(env.AGENTCONTROL_DAY_LIMIT);
  if (env.AGENTCONTROL_NIGHT_LIMIT) opts.nightLimit = Number(env.AGENTCONTROL_NIGHT_LIMIT);
  const night = env.AGENTCONTROL_NIGHT?.match(/^(\d{1,2})-(\d{1,2})$/);
  if (night) Object.assign(opts, { nightStart: Number(night[1]), nightEnd: Number(night[2]) });
  if (env.AGENTCONTROL_AGENT_PERMISSION_MODE) opts.permissionMode = env.AGENTCONTROL_AGENT_PERMISSION_MODE;
  if (env.AGENTCONTROL_AGENT_TOOLS) opts.allowedTools = env.AGENTCONTROL_AGENT_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.AGENTCONTROL_DISPATCH === '0') opts.enabled = false;
  return opts;
}

/** AGENTCONTROL_REVIEW = off | low | medium | high (default medium); AGENTCONTROL_SECURITY_REVIEW=1 adds /security-review; _REVIEW_MODEL, _REVIEW_EFFORT. */
function reviewerEnv(env) {
  const level = env.AGENTCONTROL_REVIEW ?? 'medium';
  if (level === 'off') return null;
  return createReviewer({
    claude: createClaude(), level, security: env.AGENTCONTROL_SECURITY_REVIEW === '1',
    model: env.AGENTCONTROL_REVIEW_MODEL ?? null, effort: env.AGENTCONTROL_REVIEW_EFFORT ?? null,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.AGENTCONTROL_DATA ?? join(root, 'data');
  const port = Number(process.env.PORT ?? 4310);
  // One instance per data folder; checked before anything starts dispatching.
  try {
    const release = acquireLock(join(dataDir, 'agentcontrol.lock'));
    process.on('exit', release);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  } catch (e) {
    if (!(e instanceof LockedError)) throw e;
    console.error(e.message);
    process.exit(EXIT_LOCKED);
  }
  const token = await loadToken(dataDir);
  const app = createApp({
    dataDir,
    token,
    archiveDays: process.env.AGENTCONTROL_ARCHIVE_DAYS === undefined ? 30 : Number(process.env.AGENTCONTROL_ARCHIVE_DAYS),
    reposRoot: process.env.AGENTCONTROL_REPOS_ROOT ?? dirname(root),
    model: process.env.AGENTCONTROL_REFINE_MODEL ?? null,
    effort: process.env.AGENTCONTROL_REFINE_EFFORT ?? null,
    // Agent worktrees are marked trusted in Claude Code's config, or `claude --bg` refuses to start in them.
    transcripts: createTranscriptReader(), // background agents report their token use only in their transcripts
    runner: { ...runnerEnv(process.env), trust: createTrust({ root: join(dataDir, 'worktrees') }) },
    reviewer: reviewerEnv(process.env),
    voice: { model: process.env.AGENTCONTROL_VOICE_MODEL ?? 'haiku', effort: process.env.AGENTCONTROL_VOICE_EFFORT ?? null },
    orchestrator: { model: process.env.AGENTCONTROL_ORCHESTRATOR_MODEL ?? 'sonnet', effort: process.env.AGENTCONTROL_ORCHESTRATOR_EFFORT ?? null },
    sandbox: { model: process.env.AGENTCONTROL_SANDBOX_MODEL ?? 'sonnet', effort: process.env.AGENTCONTROL_SANDBOX_EFFORT ?? null },
  });
  // Errors printed anywhere in the app also go to the event log, where the person can see them.
  const printError = console.error.bind(console);
  console.error = (...args) => {
    printError(...args);
    try { app.log('error', args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '), { level: 'error' }); } catch { /* never fail on logging */ }
  };
  app.listen(port, HOST, () => {
    console.log(`AgentControl: http://${HOST}:${port}/?login=${app.newLoginCode()}`); // one-time, see newLoginCode
    app.log('app', 'AgentControl käynnistyi');
    app.refiner.resumeInterrupted().catch((e) => console.error('resumeInterrupted:', e.message));
    app.projects.syncCards().catch((e) => console.error('project cards:', e.message));
    app.runner.start();
    app.stt.warm(); // load the speech model in the background so the first command is not slow
    app.publisher.start();
    const sweep = () => app.retention.sweep().catch((e) => console.error('retention:', e.message));
    sweep();
    setInterval(sweep, 6 * 3600_000).unref();
    const audits = () => app.auditor.tick().catch((e) => console.error('audit:', e.message));
    audits();
    setInterval(audits, 60_000).unref(); // intervals are in minutes, so once a minute is exact enough
  });
  // A port taken by something else would otherwise leave the process running with nothing to serve.
  app.on('error', (e) => { console.error(`listen ${HOST}:${port}: ${e.message}`); process.exit(1); });
}
