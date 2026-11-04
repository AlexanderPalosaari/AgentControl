// What is going on right now that stopping AgentControl would touch, for the desktop app's "quit anyway?" warning.

/**
 * What happens to a piece of work when the server stops:
 *   continues: an implementation agent runs on in Claude Code's background service and is watched again at the next start;
 *   resumes:   it is started again (from the beginning) at the next start: a refinement turn, an automatic review;
 *   lost:      it is cut off, and the person starts it again: project planning, exploring, an audit, a chat reply,
 *              a pull request or merge half done.
 */
export const ON_STOP = ['continues', 'resumes', 'lost'];

/**
 * `activity()` lists the running work as { items: [{ what, title, onStop }], queued } (`queued` = ready cards the
 * dispatcher would start, which do not start while AgentControl is closed). Each module tells what it has in flight
 * with its own `busy()`.
 */
export function createActivity({ store, runner, refiner, projects, explorer, auditor, orchestrator, sandbox, publisher }) {
  return async function activity() {
    const cards = await store.list();
    const title = (id) => cards.find((c) => c.id === id)?.title ?? id;
    const items = [];
    for (const c of cards.filter((x) => x.status === 'running')) {
      const run = await runner.run(c.id).catch(() => null);
      items.push(run?.state === 'reviewing' ? { what: 'Katselmointi', title: c.title, onStop: 'resumes' } : { what: 'Toteutus', title: c.title, onStop: 'continues' });
    }
    for (const id of refiner.busy()) items.push({ what: 'Tarkennus', title: title(id), onStop: 'resumes' });
    for (const name of projects.busy()) items.push({ what: 'Projektin suunnittelu', title: name, onStop: 'lost' });
    for (const name of explorer.busy()) items.push({ what: 'Koodin tutkiminen', title: name, onStop: 'lost' });
    for (const name of auditor.busy()) items.push({ what: 'Haavoittuvuustarkastus', title: name, onStop: 'lost' });
    if (orchestrator.busy()) items.push({ what: 'Ohjaajan vastaus', title: '', onStop: 'lost' });
    for (const name of sandbox.busy()) items.push({ what: 'Sandboxin vastaus', title: name, onStop: 'lost' });
    for (const id of publisher.busy()) items.push({ what: 'Pull request tai yhdistäminen', title: title(id), onStop: 'lost' });
    const queue = await runner.queue();
    return { items, queued: queue.enabled ? queue.order.length : 0 };
  };
}

const HEADINGS = {
  lost: 'Keskeytyy, ja se pitää aloittaa itse uudelleen:',
  resumes: 'Alkaa alusta, kun AgentControl käynnistetään uudelleen:',
  continues: 'Jatkuu taustalla, mutta kysymykset ja valmistuminen näkyvät vasta, kun AgentControl käynnistetään uudelleen:',
};

/** The warning for quitting while work runs ({ message, detail }), or null when nothing would be affected. */
export function quitWarning({ items = [], queued = 0 } = {}) {
  if (!items.length && !queued) return null;
  const parts = ON_STOP.slice().reverse()
    .map((kind) => [kind, items.filter((i) => i.onStop === kind)])
    .filter(([, list]) => list.length)
    .map(([kind, list]) => [HEADINGS[kind], ...list.map((i) => `• ${i.what}${i.title ? `: ${i.title}` : ''}`)].join('\n'));
  if (queued) parts.push(`${queued === 1 ? '1 kortti odottaa' : `${queued} korttia odottaa`} vuoroaan, eikä käynnisty, kun AgentControl on kiinni.`);
  const n = items.length;
  return {
    message: n ? `${n === 1 ? '1 työ on' : `${n} työtä on`} käynnissä. Lopetetaanko AgentControl silti?` : 'Kortteja on jonossa. Lopetetaanko AgentControl silti?',
    detail: parts.join('\n\n'),
  };
}
