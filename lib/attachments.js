import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NotFoundError, ValidationError } from './cards.js';

export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const CONTENT_TYPE = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([type, ext]) => [ext, type]));
const NAME_RE = /^kuva-[a-z0-9]+\.(png|jpg|gif|webp)$/;
export const MAX_IMAGE = 10 * 1024 * 1024;

// The first bytes of each format, so a file is stored only if it is the image it claims to be.
const MAGIC = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * Images pasted into a card, kept in its folder (cards/<id>/attachments) where the card's refiner and
 * implementation agent can read them.
 */
export function createAttachments({ store }) {
  const dir = (id) => join(store.dir(id), 'attachments');

  async function add(id, contentType, data) {
    await store.get(id);
    const ext = IMAGE_TYPES[String(contentType ?? '').split(';')[0].trim().toLowerCase()];
    if (!ext) throw new ValidationError(`Only images can be attached (${Object.keys(IMAGE_TYPES).join(', ')})`);
    if (!data.length) throw new ValidationError('The image is empty');
    if (!MAGIC[ext](data)) throw new ValidationError(`The data is not a ${ext.toUpperCase()} image`);
    const name = `kuva-${Date.now().toString(36)}${randomBytes(2).toString('hex')}.${ext}`;
    await mkdir(dir(id), { recursive: true });
    await writeFile(join(dir(id), name), data);
    return { name, size: data.length };
  }

  async function list(id) {
    await store.get(id);
    const names = await readdir(dir(id)).catch(() => []);
    return names.filter((n) => NAME_RE.test(n)).sort().map((name) => ({ name, path: join(dir(id), name) }));
  }

  async function read(id, name) {
    await store.get(id);
    if (!NAME_RE.test(name)) throw new NotFoundError(`Attachment ${name} not found`);
    try {
      return { data: await readFile(join(dir(id), name)), contentType: CONTENT_TYPE[name.split('.').pop()] };
    } catch (e) {
      if (e.code === 'ENOENT') throw new NotFoundError(`Attachment ${name} not found`);
      throw e;
    }
  }

  return { add, list, read, dir };
}

/** The prompt section that points an agent at the card's images, or '' when there are none. */
export function imagesSection(images) {
  if (!images.length) return '';
  return ['\n## Attached images', 'The person attached these images to the card (screenshots, designs, error messages). Look at each with the Read tool before you start:',
    ...images.map((i) => `- ${i.path}`)].join('\n');
}
