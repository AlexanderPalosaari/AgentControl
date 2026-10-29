// Voice command logic with no DOM access, so it runs in the browser and under `node --test`.
//
// A transcript turns into an *action* ({ action: 'new_card' } or { action: 'set_title', text: '...' }).
// Fast regex rules cover the common commands; anything they miss goes to the server, where an LLM picks
// an action from the same vocabulary (see lib/voice.js). The browser performs the action.

export const PRIORITY_VALUES = ['low', 'normal', 'high'];

/** Detail-dialog actions that are a click on a button; the regex is matched against the button text. */
export const DETAIL_BUTTONS = {
  start_refine: /^Aloita tarkennus$/,
  send_answers: /^Lähetä vastaukset$/,
  start_work: /^Start work/,
  send_answer: /^Lähetä vastaus$/,
  stop: /^Pysäytä$/,
  retry: /^Yritä uudelleen/,
  create_pr: /^Luo pull request/,
  merge_local: /^Hyväksy työ projektiin$/,
};

const canClick = (ctx, name) => (ctx.buttons ? ctx.buttons.some((b) => DETAIL_BUTTONS[name].test(b)) : true);
const dispatcherKnown = (ctx) => ctx.dispatcher != null;

const ALL = ['main', 'dialog', 'detail', 'project'];

/** Columns a card can be moved to by hand (the server still checks the move from the card's current column). */
export const MOVE_STATUSES = ['inbox', 'refining', 'ready', 'review', 'done', 'archive'];

/**
 * Everything the command field and voice control can do. `where` is the UI state the action makes sense in
 * ('project' = a project dialog is open), `when` an optional extra check against the live context, `desc`
 * what the LLM is told.
 */
export const ACTIONS = {
  new_card: { where: ['main', 'detail'], desc: 'Open the new-card dialog.' },
  open_card: { where: ['main', 'detail'], desc: 'Open a card. Set "id" to the id of the best-matching card from the list.' },
  move_card: { where: ['main', 'detail'], when: (c) => (c.cards ?? []).length > 0, desc: `Move a card to another column by hand, e.g. archive it or mark it done. Set "id" to the card and "status" to one of ${MOVE_STATUSES.join(', ')}.` },
  new_project: { where: ['main', 'detail', 'project'], desc: 'Create a new project: a new git repository for new software. Set "name" if they gave one (letters, digits, ".", "_" or "-"; use "-" for spaces), "source" to "github" or "local" only if they said where the code should live, and "owner" if they named a GitHub user or organization. Missing details are asked afterwards.' },
  open_project: { where: ['main', 'detail', 'project'], when: (c) => (c.projects ?? []).length > 0, desc: 'Open a project. Set "name" to the best-matching project from the list.' },
  delete_project: { where: ['main', 'detail', 'project'], when: (c) => (c.projects ?? []).length > 0, desc: 'Delete a project (the person confirms in a popup). Set "name" to the project from the list.' },
  close: { where: ['dialog', 'detail', 'project'], desc: 'Close the open dialog without saving.' },
  refresh: { where: ALL, desc: 'Reload the board.' },
  pause_dispatch: { where: ALL, when: (c) => c.dispatcher?.enabled === true, desc: 'Pause the agent dispatcher (no new agents start).' },
  resume_dispatch: { where: ALL, when: (c) => dispatcherKnown(c) && c.dispatcher.enabled === false, desc: 'Resume the agent dispatcher.' },
  help: { where: ALL, desc: 'Show the list of voice commands.' },
  stop_listening: { where: ALL, desc: 'Turn voice control off.' },
  quiet: { where: ALL, desc: 'Stop the spoken reply that is being read aloud.' },

  submit: { where: ['dialog'], desc: 'Create the card from the dialog.' },
  set_title: { where: ['dialog'], desc: 'Set the card title. Set "text" to the title only.' },
  append_brief: { where: ['dialog'], desc: 'Add text to the card description. Set "text" to the description text only.' },
  dictate_brief: { where: ['dialog'], desc: 'Start dictation: everything said next is added to the description until the person says "valmis". Use when they want to dictate the description but gave no text yet.' },
  set_repos: { where: ['dialog'], desc: 'Set the repositories. Set "names" to the repo names.' },
  set_priority: { where: ['dialog'], desc: 'Set the priority. Set "value" to low, normal or high.' },

  start_refine: { where: ['detail'], when: (c) => canClick(c, 'start_refine'), desc: 'Start refining the card (the AI reads the code and asks questions).' },
  send_answers: { where: ['detail'], when: (c) => canClick(c, 'send_answers'), desc: 'Send the answers to the refiner\'s questions.' },
  start_work: { where: ['detail'], when: (c) => canClick(c, 'start_work'), desc: 'Approve the plan and start the implementation work.' },
  set_answer: { where: ['detail'], when: (c) => c.hasAnswerBox === true, desc: 'Write a reply to the running agent\'s question. Set "text" to the reply only.' },
  dictate_answer: { where: ['detail'], when: (c) => c.hasAnswerBox === true, desc: 'Start dictation: everything said next is added to the reply for the agent until the person says "valmis". Use when they want to dictate the reply but gave no text yet.' },
  send_answer: { where: ['detail'], when: (c) => canClick(c, 'send_answer'), desc: 'Send the written reply to the agent.' },
  stop: { where: ['detail'], when: (c) => canClick(c, 'stop'), desc: 'Stop the running agent.' },
  retry: { where: ['detail'], when: (c) => canClick(c, 'retry'), desc: 'Retry after an error.' },
  create_pr: { where: ['detail'], when: (c) => canClick(c, 'create_pr'), desc: 'Create the pull request.' },
  merge_local: { where: ['detail'], when: (c) => canClick(c, 'merge_local'), desc: 'Accept the finished work into the project (a popup asks the person to confirm). For projects that are not on Azure DevOps, where no pull request is possible.' },
  read_question: { where: ['detail'], desc: 'Read the agent\'s or the refiner\'s open questions aloud.' },

  describe_project: { where: ['project'], when: (c) => c.project?.step === 'describe', desc: 'Describe the open project and start planning it. Set "text" to the description.' },
  plan_feedback: { where: ['project'], when: (c) => c.project?.step === 'review', desc: 'Ask for changes to the open project\'s plan. Set "text" to the change request.' },
  create_tasks: { where: ['project'], when: (c) => c.project?.step === 'review', desc: 'Accept the project plan and create its tasks as cards.' },
  publish_github: { where: ['project'], when: (c) => c.project?.local === true && c.project?.step !== 'planning', desc: 'Move the open local project to GitHub. Set "owner" if they named a GitHub user or organization.' },
  retry_github: { where: ['project'], when: (c) => c.project?.step === 'remote', desc: 'Retry creating or pushing the project\'s GitHub repository.' },
  keep_local: { where: ['project'], when: (c) => c.project?.step === 'remote', desc: 'Give up on GitHub and keep the project as a local repository.' },
};

/** Names of the actions that make sense right now. */
export function availableActions(ctx = {}) {
  const state = ctx.state ?? 'main';
  return Object.entries(ACTIONS)
    .filter(([, def]) => def.where.includes(state) && (!def.when || def.when(ctx)))
    .map(([name]) => name);
}

/** Short Finnish status text for an action (shown, and spoken). */
export function describe(a, ctx = {}) {
  switch (a.action) {
    case 'new_card': return 'uusi kortti';
    case 'open_card': return `kortti: ${a.title ?? ctx.cards?.find((c) => c.id === a.id)?.title ?? ''}`.trim();
    case 'close': return 'ikkuna suljettu';
    case 'refresh': return 'päivitetty';
    case 'pause_dispatch': return 'ajo tauolla';
    case 'resume_dispatch': return 'ajo jatkuu';
    case 'help': return 'komennot';
    case 'stop_listening': return 'puheohjaus pois';
    case 'quiet': return 'hiljaa';
    case 'noop': return a.label ?? '';
    case 'submit': return 'kortti luotu';
    case 'set_title': return 'otsikko asetettu';
    case 'append_brief': return 'kuvaukseen lisätty';
    case 'dictate_brief': return 'sanelu: kuvaus (sano "valmis" lopuksi)';
    case 'dictate_answer': return 'sanelu: vastaus (sano "valmis" lopuksi)';
    case 'set_repos': return 'repo asetettu';
    case 'set_priority': return `prioriteetti ${a.value}`;
    case 'start_refine': return 'tarkennus aloitettu';
    case 'send_answers': return 'vastaukset lähetetty';
    case 'start_work': return 'työ aloitettu';
    case 'set_answer': return 'vastaus kirjoitettu (sano "lähetä vastaus")';
    case 'send_answer': return 'vastaus lähetetty';
    case 'stop': return 'pysäytys (vahvista ikkunassa)';
    case 'retry': return 'yritetään uudelleen';
    case 'create_pr': return 'pull request (vahvista ikkunassa)';
    case 'merge_local': return 'työn hyväksyminen projektiin (vahvista ikkunassa)';
    case 'read_question': return 'luetaan kysymys';
    case 'move_card': return `kortti ${a.title ?? ctx.cards?.find((c) => c.id === a.id)?.title ?? ''} → ${a.status}`;
    case 'new_project': return a.name ? `uusi projekti ${a.name}` : 'uusi projekti';
    case 'open_project': return `projekti ${a.name}`;
    case 'delete_project': return `poistetaanko ${a.name}? (vahvista ikkunassa)`;
    case 'describe_project': return 'kuvaus annettu, suunnitellaan';
    case 'plan_feedback': return 'muutospyyntö lähetetty';
    case 'create_tasks': return 'kortit luodaan';
    case 'publish_github': return 'viedään GitHubiin';
    case 'retry_github': return 'GitHub: yritetään uudelleen';
    case 'keep_local': return 'jatketaan paikallisena';
    default: return '';
  }
}

// ---- wake word ----

/** Edit distance between two short strings. */
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// "agentti" as speech recognition tends to hear it.
const WAKE_VARIANTS = new Set(['agentti', 'agentit', 'agentin', 'agenti', 'agentii', 'ajentti', 'ajenti', 'agenttii', 'ajentit']);
// The first word (after an optional greeting). \p{L} stands in for \w, which only knows ASCII.
const LEAD_WORD_RE = /^\s*(?:(?:hei|moi|okei|ok)[\s,]+)?([\p{L}\p{N}]+)[\s,.:!?-]*/iu;

// A near miss counts, but only by replacing or dropping a letter, never by adding one: "agenttiä" is a different word.
const isWakeWord = (w) => WAKE_VARIANTS.has(w) || (w.length >= 6 && w.length <= 7 && editDistance(w, 'agentti') <= 1);

/** "Agentti, lisää kortti" -> { woke: true, rest: 'lisää kortti' }. */
export function stripWakeWord(raw) {
  const m = LEAD_WORD_RE.exec(raw);
  return m && isWakeWord(m[1].toLowerCase()) ? { woke: true, rest: raw.slice(m[0].length).trim() } : { woke: false, rest: raw.trim() };
}

// ---- dictation ----

/** Ends dictation mode: "valmis", "sanelu valmis", "lopeta sanelu". */
export function isDictationEnd(raw) {
  return /^(?:(?:ok|okei|no)\s+)?(?:valmis|loppu|sanelu valmis|lopeta sanelu|se oli kaikki|tässä kaikki)$/u.test(
    String(raw ?? '').toLowerCase().replace(/[.,!?;:"']/g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Lets speech through only after the wake word. Once woken (or after each accepted command) the gate stays
 * open for `windowMs`, so a follow-up like "otsikko korjaa bugi" does not need the wake word again.
 */
export function createWakeGate({ windowMs = 10_000, now = Date.now } = {}) {
  let openUntil = 0;
  const isOpen = () => now() < openUntil;
  return {
    isOpen,
    touch() { openUntil = now() + windowMs; },
    /** Whether `raw` would pass, without opening the gate (for showing interim text). */
    peek: (raw) => stripWakeWord(raw).woke || isOpen(),
    /** The command text to run, '' for a bare wake word, or null when the speech should be ignored. */
    accept(raw) {
      const { woke, rest } = stripWakeWord(raw);
      if (!woke && !isOpen()) return null;
      openUntil = now() + windowMs;
      return rest;
    },
  };
}

// ---- command matching ----

// JavaScript's \b only knows ASCII letters, so it never matches next to ä/ö. `has` rewrites \b into a
// Unicode-aware word boundary before testing.
const WORD_EDGE = '(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))';
const uniCache = new Map();
function uni(re) {
  if (!uniCache.has(re.source)) uniCache.set(re.source, new RegExp(re.source.replace(/\\b/g, WORD_EDGE), `${re.flags}u`));
  return uniCache.get(re.source);
}
const has = (re, t) => uni(re).test(t);

const FILLER = /\b(ole hyvä|kiitos|voisitko|voitko|voisit|haluan|haluaisin|tarvitsen|pitäisi|pitää|nyt|vielä|sitten|ihan|vaan|vain|sellainen|jokin|joku|mulle|minulle|meille|tähän|tänne|että|ok|okei|hei|moi)\b/g;
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const clean = (raw) => raw.toLowerCase().replace(/[.,!?;:"']/g, ' ').replace(uni(FILLER), ' ').replace(/\s+/g, ' ').trim();
const PRIORITY_WORDS = [[/matala|vähäinen|ei kiire/, 'low'], [/normaali|tavallinen|keskitasoinen/, 'normal'], [/korkea|tärkeä|kiireellinen|kiire/, 'high']];
const FIELD_LEAD = '(?:anna |aseta |laita |kirjoita |lisää )?';
const FIELD_GLUE = '(?:\\s+(?:on|olkoon|laita|aseta|se|seuraava))*';
const fieldRe = (name) => new RegExp(`^${FIELD_LEAD}${name}${FIELD_GLUE}\\s+(.+)$`, 'i');

const NEW_VERBS = /\b(uusi|uuden|uutta|lisää|lisätä|luo|luoda|tee|tehdä|perusta|perustaa|aloita)\b.*\bkort/;
const IS_NEW_CARD = (t) => has(NEW_VERBS, t);

const act = (action, extra = {}) => ({ action, ...extra });

// Each rule gets (x = raw text, t = cleaned lower-case text, ctx) and returns an action or a falsy value.
const ANYWHERE = [
  (x, t) => has(/\b(lopeta|sammuta|keskeytä|poista)\b.*\b(kuuntelu\w*|puheohjaus\w*|mikrofoni\w*)\b|\bpuheohjaus pois\b/, t) && act('stop_listening'),
  (x, t) => words(t) <= 2 && has(/\b(hiljaa|vaikene|riittää|ole hiljaa)\b/, t) && act('quiet'),
];

const DICTATE_VERB = '(?:sanele|sanelen|sanelisin|dikteeraa|kirjoita|lisää)';

const DIALOG = [
  (x, t) => words(t) <= 4 && has(new RegExp(`^(?:${DICTATE_VERB} )?(?:kuvaus\\w*|selite\\w*)$`), t) && act('dictate_brief'),
  (x, t) => words(t) <= 5 && has(/\b(luo|luoda|tallenna|valmis|valmista|lähetä|tehty|hyväksy)\b/, t) && act('submit'),
  (x, t) => IS_NEW_CARD(t) && words(t) <= 5 && act('noop', { label: 'kortti-ikkuna on jo auki' }),
  (x) => { const m = x.match(fieldRe('otsik\\w*')); return m && act('set_title', { text: m[1] }); },
  (x) => { const m = x.match(fieldRe('(?:kuvaus|kuvauksen|kuvaukseksi|kuvausta|kuvauksena|selite|tehtävä)')); return m && act('append_brief', { text: m[1] }); },
  (x) => {
    const m = x.match(fieldRe('repo\\w*'));
    return m && act('set_repos', { names: m[1].split(/\s*,\s*|\s+ja\s+|\s+/).filter(Boolean) });
  },
  (x, t) => {
    if (!has(/prioriteett|kiire|tärkeä/, t)) return false;
    const hit = PRIORITY_WORDS.find(([re]) => re.test(t));
    return hit && act('set_priority', { value: hit[1] });
  },
];

const DETAIL = [
  (x, t, ctx) => words(t) <= 4 && has(new RegExp(`^${DICTATE_VERB} (?:vastaus\\w*|vastaa)$`), t) && ctx.hasAnswerBox !== false && act('dictate_answer'),
  (x, t, ctx) => has(/\b(lue|kerro|toista)\b.*\bkysymy\w*|\bmitä\b.*\bkysy\w*/, t) && act('read_question'),
  (x, t, ctx) => has(/\b(aloita|käynnistä|tee|aja|suorita|laita)\b.*\btarkenn/, t) && canClick(ctx, 'start_refine') && act('start_refine'),
  (x, t, ctx) => has(/\b(lähetä|vastaa)\b.*\bvastauks/, t) && canClick(ctx, 'send_answers') && act('send_answers'),
  (x, t, ctx) => has(/start work|\b(aloita|käynnistä|laita|anna)\b.*\b(työ\w*|toteutus\w*|toteutu\w*|ajoon|käyntiin)\b/, t) && !has(/\bajo\b|\bajoa\b/, t)
    && canClick(ctx, 'start_work') && act('start_work'),
  (x, t, ctx) => {
    const m = x.match(/^(?:vastaa|vastaus|vastaan)\s+(.+)$/i);
    return m && ctx.hasAnswerBox !== false && act('set_answer', { text: m[1] });
  },
  (x, t, ctx) => (has(/\blähetä\b.*\bvastaus\b/, t) || t === 'lähetä') && canClick(ctx, 'send_answer') && act('send_answer'),
  (x, t, ctx) => has(/\b(pysäytä|lopeta|keskeytä|seis)\b/, t) && !has(/\b(ajo|ajot|ajon|kaikki|dispatcher)\b/, t) && canClick(ctx, 'stop') && act('stop'),
  (x, t, ctx) => (has(/\b(yritä|kokeile)\b.*\b(uudelleen|uudestaan|uusiksi)\b|\bjatka\b.*\b(agentti|työtä|tehtävää)\b/, t) || t === 'jatka')
    && canClick(ctx, 'retry') && act('retry'),
  (x, t, ctx) => has(/\b(hyväksy|hyväksyn|yhdistä|merge)\b.*\b(työ\w*|muutokset|projektiin|mainiin)\b/, t) && canClick(ctx, 'merge_local') && act('merge_local'),
  (x, t, ctx) => has(/pull[ -]?request|\bpr\b/, t) && has(/\b(luo|luoda|tee|tehdä|lisää|avaa)\b/, t) && canClick(ctx, 'create_pr') && act('create_pr'),
];

const CLOSE = (x, t, ctx) => words(t) <= 4 && has(/\b(sulje|sulkea|peruuta|poistu|takaisin|piilota)\b/, t) && ctx.state !== 'main' && act('close');

const onlyOne = (list) => (list.length === 1 ? list[0] : undefined);

/**
 * Does the spoken word `w` match some word of the title despite a mishearing or a different inflection
 * ("kirjautumisessa" / "kirjautuminen")? Needs a shared stem of 5+ letters, or a small edit distance for longer words.
 */
function fuzzyInTitle(w, title) {
  if (w.length < 4) return false;
  return title.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((tw) => {
    if (tw.length < 4) return false;
    let p = 0;
    while (p < w.length && p < tw.length && w[p] === tw[p]) p++;
    return p >= 5 || editDistance(w, tw) <= Math.floor(Math.min(w.length, tw.length) / 5);
  });
}

/** The card whose title contains every word, or the one card that matches them loosely. */
function findCard(want, cards) {
  if (!want.length) return undefined;
  return cards.find((c) => want.every((w) => c.title.toLowerCase().includes(w)))
    ?? onlyOne(cards.filter((c) => want.every((w) => fuzzyInTitle(w, c.title))));
}

// ---- projects ----

/** "Tilauspörssi 2" -> "Tilaussporssi-2": what a project (folder and repository) may be called. */
export function toProjectName(raw) {
  return String(raw ?? '').trim().replace(/^["'“”]+|["'“”.]+$/g, '')
    .replace(/[äå]/g, 'a').replace(/[ÄÅ]/g, 'A').replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 100);
}

const NAME_STOP = /^(github\w*|paikalli\w*|lokaali\w*|nimel\w*|nimi|jonka|joka|johon|ja|on|for|repo\w*)$/i;
/** The project name in "perusta projekti nimeltä rs3ai" / "uusi projekti rs3ai" / "projektin nimi on rs3ai". */
export function projectNameFrom(x) {
  const m = x.match(/(?:^|\s)nimel(?:tä|tään)\s+([\p{L}\p{N}"'“][\p{L}\p{N}._-]*)/iu)
    ?? x.match(/(?:^|\s)nimi(?:\s+on)?\s+([\p{L}\p{N}"'“][\p{L}\p{N}._-]*)/iu)
    ?? x.match(/(?:^|\s)projekti(?:n)?\s+([\p{L}\p{N}"'“][\p{L}\p{N}._-]*)/iu);
  if (!m || NAME_STOP.test(m[1])) return undefined;
  return toProjectName(m[1]) || undefined;
}

/** Where the person wants the code: 'github', 'local', or undefined when they did not say. */
export function sourceFrom(raw) {
  const t = String(raw ?? '').toLowerCase();
  if (/git\s?hub|gitti/.test(t)) return 'github';
  if (/paikalli|lokaali|local|tälle koneelle|omalle koneelle|koneelle/.test(t)) return 'local';
  return undefined;
}

/** A GitHub owner named in the sentence ("organisaatioon acme", "käyttäjälle me"). */
export function ownerFrom(x) {
  const m = x.match(/(?:organisaatio\w*|omistaja\w*|käyttäjä\w*|tilille|tilin)\s+([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/i);
  return m ? m[1] : undefined;
}

/** A yes to "create the cards?": "ok", "luo kortit", "hyväksyn". */
// "luo kortit" / "tee kortteja": plural, so "lisää kortti" (one new card) is never read as accepting a plan.
const TASK_CARDS = /\b(luo|tee|lisää)\b.*\b(kortit|kortteja|korteiksi)\b/;
const plain = (raw) => String(raw ?? '').toLowerCase().replace(/[.,!?;:"']/g, ' ').replace(/\s+/g, ' ').trim();

export function isApproval(raw) {
  const t = plain(raw);
  return /^(kyllä|joo|juu|ok|okei|hyvä|sopii|näyttää hyvältä|hyväksy\w*|luo ne|tee ne)$/u.test(t) || has(TASK_CARDS, t);
}

/** Ends a follow-up question without answering it. */
export function isCancel(raw) {
  return /^(peruuta|peru|ohita|unohda|ei mitään|lopeta|stop)$/u.test(plain(raw));
}

const PROJECT = [
  (x, t, ctx) => ctx.project?.step === 'review' && (has(TASK_CARDS, t) || has(/^(hyväksy\w*|näyttää hyvältä)\b/, t)) && act('create_tasks'),
  (x, t, ctx) => {
    const m = x.match(/^(?:kuvaus|kuvaile|kuvauksena|projekti on)\s*[:,-]?\s+([\s\S]+)$/i);
    return m && ctx.project?.step === 'describe' && act('describe_project', { text: m[1].trim() });
  },
  (x, t, ctx) => {
    const m = x.match(/^(?:muutos|muuta|muutospyyntö|palaute|korjaa suunnitelma\w*)\s*[:,-]?\s+([\s\S]+)$/i);
    return m && ctx.project?.step === 'review' && act('plan_feedback', { text: m[1].trim() });
  },
  (x, t, ctx) => ctx.project?.local && ctx.project.step !== 'planning' && has(/git ?hub/, t) && has(/\b(vie|siirrä|julkaise|luo|lisää|pushaa|laita)\b/, t)
    && act('publish_github', ownerFrom(x) ? { owner: ownerFrom(x) } : {}),
  (x, t, ctx) => ctx.project?.step === 'remote' && has(/\b(yritä|kokeile)\b.*\b(uudelleen|uudestaan|uusiksi)\b/, t) && act('retry_github'),
  (x, t, ctx) => ctx.project?.step === 'remote' && has(/\b(jatka|pidä|jätä)\b.*\bpaikalli/, t) && act('keep_local'),
];

// The last word of "siirrä <kortti> <minne>" (or the verb itself: "arkistoi").
const MOVE_WORDS = [[/^(inbox\w*|alkuun)$/, 'inbox'], [/^arkisto\w*$/, 'archive'], [/^(valmii\w*|done\w*|tehdyksi|tehdyiksi)$/, 'done'],
  [/^(katselmo\w*|review\w*)$/, 'review'], [/^(tarkenn\w*|refining\w*)$/, 'refining'], [/^(ready\w*|jonoon)$/, 'ready']];

const GLOBAL = [
  (x, t) => has(/\bprojekt\w*/, t) && has(/\b(uusi|uus|uuden|uutta|lisää|luo|luoda|tee|tehdä|perusta|perustaa|perustetaan|aloita|aloitetaan)\b/, t)
    && !has(/\b(avaa|näytä)\b/, t)
    && act('new_project', Object.fromEntries(Object.entries({ name: projectNameFrom(x), source: sourceFrom(t), owner: ownerFrom(x) }).filter(([, v]) => v))),
  (x, t, ctx) => {
    const m = t.match(/^(?:avaa|näytä|mene|siirry|katso|valitse)\s+projekt\w*\s*(.*)$/);
    if (!m) return false;
    const list = ctx.projects ?? [];
    const want = m[1].replace(/\s+/g, '-');
    const hit = want ? list.find((p) => p.name.toLowerCase() === want) ?? onlyOne(list.filter((p) => p.name.toLowerCase().includes(want))) : onlyOne(list);
    return hit && act('open_project', { name: hit.name });
  },
  (x, t, ctx) => {
    // "poista (projekti) taalla on yksi puolesta": only a name on the project list counts, so "poista kuva" is not caught.
    const m = t.match(/^(?:poista|tuhoa)\s+(.*)$/);
    if (!m) return false;
    const list = ctx.projects ?? [];
    const want = toProjectName(m[1].split(' ').filter((w) => !/^(projekti\w*|tämä|tää|tuo|se|sen)$/.test(w)).join(' ')).toLowerCase();
    const hit = want ? list.find((p) => p.name.toLowerCase() === want) : ctx.project && has(/\bprojekt/, t) ? list.find((p) => p.name === ctx.project.name) : null;
    return hit && act('delete_project', { name: hit.name });
  },
  (x, t, ctx) => {
    const m = t.match(/^(arkistoi|siirrä|merkitse|palauta)\s+(.+)$/);
    if (!m) return false;
    let rest = m[2].split(' ');
    let status = m[1] === 'arkistoi' ? 'archive' : null;
    const hit = MOVE_WORDS.find(([re]) => re.test(rest.at(-1)));
    if (hit) { status = hit[1]; rest = rest.slice(0, -1); }
    const card = status && findCard(rest.filter((w) => !/^(kortti\w*|kortin|korttia|se|sen)$/.test(w)), ctx.cards ?? []);
    return card && act('move_card', { id: card.id, title: card.title, status });
  },
  (x, t) => IS_NEW_CARD(t) && words(t) <= 6 && act('new_card'),
  (x, t, ctx) => {
    const m = t.match(/^(?:avaa|näytä|mene|siirry|katso|valitse|etsi)\s+(?:kortti\w*|kortin|korttia)?\s*(.*)$/);
    if (!m || !m[1] || has(/\b(uusi|uuden|uutta)\b/, t)) return false;
    const want = m[1].split(' ').filter((w) => w && !/^(se|sen|jossa|lukee|nimeltä|nimeltään)$/.test(w));
    const hit = findCard(want, ctx.cards ?? []);
    return hit && act('open_card', { id: hit.id, title: hit.title });
  },
  (x, t, ctx) => (has(/\b(tauota|tauko|tauolle)\b/, t) || has(/\b(pysäytä|keskeytä|lopeta)\b.*\b(ajo|ajot|ajon|agentit|dispatcher)\b/, t))
    && ctx.dispatcher?.enabled && act('pause_dispatch'),
  (x, t, ctx) => has(/\b(jatka|käynnistä|aloita)\b.*\b(ajo|ajoa|ajon|ajot|agentit|dispatcher)\b/, t)
    && ctx.dispatcher && !ctx.dispatcher.enabled && act('resume_dispatch'),
  (x, t) => words(t) <= 3 && has(/\b(päivitä|virkistä|lataa)\b/, t) && act('refresh'),
  (x, t) => has(/\b(komennot|apua|ohje\w*|mitä voin sanoa)\b/, t) && act('help'),
];

/**
 * Fast, offline interpretation. Returns an action, or null when no rule matches (then ask the server).
 * ctx: { state: 'main'|'dialog'|'detail'|'project', cards: [{id, title}], dispatcher: {enabled}|null,
 *        buttons?: string[] (enabled buttons of the detail dialog), hasAnswerBox?: boolean,
 *        projects?: [{name, step}], project?: {name, step, local} (the open project) }
 * A rule's action counts only where it is available, so e.g. "lisää kortti" does nothing in a project dialog.
 */
export function interpret(raw, ctx = {}) {
  const x = String(raw ?? '').trim().replace(/[.!?,]+$/, '');
  const t = clean(x);
  if (!t) return null;
  const c = { state: 'main', ...ctx };
  const allowed = new Set(availableActions(c));
  const groups = [ANYWHERE];
  if (c.state === 'dialog') groups.push(DIALOG);
  else if (c.state === 'detail') groups.push(DETAIL);
  else if (c.state === 'project') groups.push(PROJECT);
  groups.push([CLOSE], GLOBAL);
  for (const group of groups) {
    for (const rule of group) {
      const a = rule(x, t, c);
      if (a && (a.action === 'noop' || allowed.has(a.action))) return a;
    }
  }
  return null;
}

export const VOICE_HELP = [
  'Kirjoita komentokenttään tai puhu: puheessa aloita sanomalla "agentti" (herätesana), esim. "agentti, lisää kortti". Komennon jälkeen voit jatkaa 10 sekuntia ilman herätesanaa.',
  'Lyhyet komennot (alla) toimivat heti. Kaikki muu menee ohjaajalle: globaalille agentille, joka muistaa keskustelun ja ohjaa taulua, esim. "luo kortit A ja B, B odottaa A:n suunnitelmaa, ja aloita A:n tarkennus". Jokainen kortti on oma agenttinsa omalla kontekstillaan. "uusi keskustelu" nollaa ohjaajan muistin.',
  'Kun kysyn jotain, seuraava viesti on vastaus (ohita: "peruuta").',
  'Aina: lisää kortti · avaa kortti <otsikon osa> · arkistoi <kortti> · siirrä <kortti> valmiiksi/inboxiin · tauota · jatka ajoa · päivitä · sulje/peruuta · hiljaa · lopeta kuuntelu · komennot',
  'Projektit: perusta projekti nimeltä <nimi> (lisää "githubiin" tai "paikallisesti") · avaa projekti <nimi>. Kysyn kuvauksen, teen suunnitelman ja kortit.',
  'Projektin ikkunassa: kuvaus … · muutos … · luo kortit · vie githubiin · yritä uudelleen · jatka paikallisena',
  'Uuden kortin ikkunassa: otsikko … · kuvaus … · repo <nimi> · prioriteetti matala/normaali/korkea · luo · "sanele kuvaus" (puhu vapaasti, lopuksi "valmis")',
  'Kortin ikkunassa: aloita tarkennus · lue kysymys · lähetä vastaukset · aloita työ · vastaa … · sanele vastaus · lähetä vastaus · pysäytä · yritä uudelleen · luo pull request',
].join('\n');
