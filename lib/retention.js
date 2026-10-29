import { readdir, rm } from 'node:fs/promises';

const DAY_MS = 86_400_000;

/**
 * Archived cards keep their card, run, report and review files for good, but their live stream (the refiner's
 * play-by-play, the bulkiest file) is deleted `days` after the card was last changed. 0 turns this off.
 * Nothing else is touched, and never a card outside the archive.
 */
export function createRetention({ store, days = 30, log = () => {}, now = () => Date.now() }) {
  async function sweep() {
    if (!(days > 0)) return { cards: 0 };
    const cutoff = now() - days * DAY_MS;
    let cards = 0;
    for (const card of await store.list()) {
      if (card.status !== 'archive' || Date.parse(card.updatedAt) > cutoff) continue;
      const names = (await readdir(store.dir(card.id)).catch(() => [])).filter((n) => /^live(\.1)?\.jsonl$/.test(n));
      if (!names.length) continue;
      for (const n of names) await rm(`${store.dir(card.id)}/${n}`, { force: true });
      cards++;
    }
    if (cards) log('app', `Siivous: ${cards} arkistoidun kortin live-loki poistettu (yli ${days} pv vanhoja)`);
    return { cards };
  }
  return { sweep };
}
