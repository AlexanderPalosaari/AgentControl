import { existsSync, realpathSync } from 'node:fs';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Claude Code's global config, where it records which folders the person trusts. */
export const claudeConfigFile = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');

/** The key Claude Code uses for a folder: forward slashes, as it writes them itself (e.g. "C:/code/maestropro"). */
export const trustKey = (folder) => resolve(folder).replaceAll('\\', '/');

/**
 * Marks AgentControl's own agent worktrees as trusted in Claude Code, so `claude --bg` starts there without the
 * interactive trust prompt (which it otherwise demands for every new folder). Only folders inside `root` (the
 * worktrees folder) are ever marked; the config is backed up once before the first change and written atomically.
 */
export function createTrust({ root, file = claudeConfigFile() }) {
  const base = resolve(root) + sep;
  let backedUp = false;

  return async function trust(folders) {
    const keys = folders.map((f) => {
      const inside = (resolve(f) + sep).startsWith(base) && resolve(f) + sep !== base; // below the worktrees folder, never it
      if (!inside) throw new Error(`Refusing to trust ${f}: not an AgentControl worktree`);
      return trustKey(existsSync(f) ? realpathSync.native(f) : f); // the folder as claude sees it when started there
    });
    if (!existsSync(file)) return; // no Claude Code config yet: nothing to mark, and claude will ask as usual
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.projects ??= {};
    const missing = keys.filter((k) => config.projects[k]?.hasTrustDialogAccepted !== true);
    if (!missing.length) return;
    if (!backedUp) {
      const backup = `${file}.agentcontrol-backup`;
      if (!existsSync(backup)) await copyFile(file, backup);
      backedUp = true;
    }
    for (const k of missing) config.projects[k] = { ...config.projects[k], hasTrustDialogAccepted: true };
    const tmp = `${file}.agentcontrol-tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, file);
  };
}
