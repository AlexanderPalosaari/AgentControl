import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ValidationError } from './cards.js';

export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where a repository name lives on disk: under the repos root, or, for a project added from an existing folder,
 * wherever that folder is. Everything that opens a card's repository goes through `path`.
 */
export function createRepos({ reposRoot, dataDir }) {
  const root = resolve(reposRoot);
  const added = new Map(); // name -> folder of a project that was added from outside the repos root

  if (dataDir) try { // projects added before this start
    const dir = join(dataDir, 'projects');
    for (const name of readdirSync(dir)) {
      try {
        const p = JSON.parse(readFileSync(join(dir, name, 'project.json'), 'utf8'));
        if (p.imported && p.name === name && typeof p.path === 'string') added.set(name, p.path);
        if (p.name === name) for (const r of p.workspaceRepos ?? []) if (typeof r?.name === 'string' && typeof r.path === 'string') added.set(r.name, r.path); // a project over several repositories
      } catch { /* not a project folder, or unreadable: the projects list reports it */ }
    }
  } catch { /* no projects yet */ }

  function path(name) {
    if (typeof name !== 'string' || !REPO_NAME_RE.test(name)) throw new ValidationError(`Invalid repo name: ${name}`);
    if (added.has(name)) return added.get(name);
    const p = resolve(root, name);
    if (!p.startsWith(root + sep)) throw new ValidationError(`Invalid repo name: ${name}`);
    return p;
  }

  return {
    path,
    names: () => [...added.keys()],
    add: (name, folder) => { added.set(name, folder); },
    remove: (name) => { added.delete(name); },
  };
}
