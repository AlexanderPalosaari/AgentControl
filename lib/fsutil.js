import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes JSON via a temp file + rename so readers never see a half-written file.
 * Windows refuses to replace a file while a reader has it open (EPERM), and the page polls these files, so a
 * rename can land in such a moment. The lock is brief: try again a few times.
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(tmp, file);
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, 10 * attempt));
    }
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}
