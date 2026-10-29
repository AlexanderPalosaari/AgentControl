import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { claudeConfigFile, createTrust, trustKey } from '../lib/trust.js';

// Always a temporary config file: these tests must never touch the person's real ~/.claude.json.
let dir, file, root;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-trust-'));
  file = join(dir, '.claude.json');
  root = join(dir, 'data', 'worktrees');
  await mkdir(join(root, 'c-1', 'repo'), { recursive: true });
});
after(() => rm(dir, { recursive: true, force: true }));

const read = () => JSON.parse(readFileSync(file, 'utf8'));

test('marks a worktree trusted, keeps everything else, and backs the config up once', async () => {
  await writeFile(file, JSON.stringify({ numStartups: 7, projects: { 'C:/code/other': { hasTrustDialogAccepted: false, history: ['x'] } } }));
  const trust = createTrust({ root, file });
  const wt = join(root, 'c-1', 'repo');
  await trust([wt]);
  const key = trustKey(realpathSync.native(wt)); // the long path, as claude sees its folder (no 8.3 names)
  const config = read();
  assert.equal(config.projects[key].hasTrustDialogAccepted, true);
  assert.match(key, /^[^\\]+$/, 'forward slashes, as Claude Code writes the key');
  assert.deepEqual(config.projects['C:/code/other'], { hasTrustDialogAccepted: false, history: ['x'] }, 'other folders untouched');
  assert.equal(config.numStartups, 7);
  assert.deepEqual(JSON.parse(readFileSync(`${file}.agentcontrol-backup`, 'utf8')).projects['C:/code/other'].history, ['x']);

  await writeFile(`${file}.agentcontrol-backup`, 'first backup');
  await trust([join(root, 'c-2', 'repo')]);
  assert.equal(readFileSync(`${file}.agentcontrol-backup`, 'utf8'), 'first backup', 'the backup is the state before the first change');
});

test('refuses any folder outside the worktrees', async () => {
  const trust = createTrust({ root, file });
  await assert.rejects(trust([join(dir, 'elsewhere')]), /not an AgentControl worktree/);
  await assert.rejects(trust([join(root, '..', 'cards')]), /not an AgentControl worktree/);
  await assert.rejects(trust([root]), /not an AgentControl worktree/, 'not the worktrees folder itself either');
});

test('does nothing without a Claude Code config, or when the folder is already trusted', async () => {
  await createTrust({ root, file: join(dir, 'missing.json') })([join(root, 'c-1', 'repo')]);
  assert.ok(!existsSync(join(dir, 'missing.json')));
  const before_ = readFileSync(file, 'utf8');
  await createTrust({ root, file })([join(root, 'c-1', 'repo')]);
  assert.equal(readFileSync(file, 'utf8'), before_);
});

test('the config lives where Claude Code keeps it', () => {
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: 'X:/cfg' }), join('X:/cfg', '.claude.json'));
});
