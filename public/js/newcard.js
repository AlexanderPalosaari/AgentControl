'use strict';
// the new-card dialog and pasted images.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

const dlg = document.getElementById('dlg');
// Repo chips: the text field stays the source of truth (so typing and voice still work); chips toggle names in it.
const reposInput = document.getElementById('f-repos');
const repoNames = () => reposInput.value.split(',').map((s) => s.trim()).filter(Boolean);
function paintRepoChips() {
  const chosen = new Set(repoNames());
  for (const b of document.querySelectorAll('#repo-list button')) b.classList.toggle('on', chosen.has(b.textContent));
}
async function loadRepoChips() {
  const box = document.getElementById('repo-list');
  try {
    const names = await api('/api/repos');
    box.replaceChildren(...names.map((n) => {
      const b = el('button', { type: 'button', textContent: n });
      b.addEventListener('click', () => {
        const chosen = repoNames();
        reposInput.value = (chosen.includes(n) ? chosen.filter((x) => x !== n) : [...chosen, n]).join(', ');
        paintRepoChips();
      });
      return b;
    }));
    paintRepoChips();
  } catch { box.replaceChildren(); } // the text field still works
}
reposInput.addEventListener('input', paintRepoChips);

document.getElementById('new').addEventListener('click', () => {
  loadRepoChips();
  const prio = document.getElementById('f-priority');
  prio.replaceChildren(...meta.priorities.map((p) => el('option', { value: p, textContent: PRIO[p], selected: p === 'normal' })));
  const after = document.getElementById('f-after');
  after.replaceChildren(el('option', { value: '', textContent: '(ei riippuvuutta)' }),
    ...cards.filter((c) => c.status !== 'archive').map((c) => el('option', { value: c.id, textContent: c.title })));
  document.getElementById('error').textContent = '';
  draftImages = [];
  paintDraftImages();
  dlg.showModal();
});

// ---- pasted images (Ctrl+V): stored with the card, where its agents can read them ----
function pastedImages(ev) {
  return [...(ev.clipboardData?.items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
}
async function uploadImage(cardId, blob) {
  const res = await fetch(`/api/cards/${cardId}/attachments`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
// A paste with text too (e.g. from a document) still pastes the text; the images are taken as well.
const takeImages = (ev) => { const images = pastedImages(ev); if (images.length && !ev.clipboardData.types.includes('text/plain')) ev.preventDefault(); return images; };

let draftImages = []; // pasted into the new-card form; uploaded once the card exists
function paintDraftImages() {
  document.getElementById('f-images').replaceChildren(...draftImages.map((blob, i) => {
    const img = el('img', { src: URL.createObjectURL(blob), alt: `Kuva ${i + 1}` });
    img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
    const remove = el('button', { type: 'button', textContent: '×', title: 'Poista kuva' });
    remove.addEventListener('click', () => { draftImages.splice(i, 1); paintDraftImages(); });
    return el('span', {}, img, remove);
  }));
}
dlg.addEventListener('paste', (ev) => {
  const images = takeImages(ev);
  if (!images.length) return;
  draftImages.push(...images);
  paintDraftImages();
});
document.getElementById('cancel').addEventListener('click', () => dlg.close());
document.getElementById('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const card = await api('/api/cards', { method: 'POST', body: {
      title: document.getElementById('f-title').value,
      brief: document.getElementById('f-brief').value,
      repos: document.getElementById('f-repos').value.split(',').map((s) => s.trim()).filter(Boolean),
      priority: document.getElementById('f-priority').value,
      after: document.getElementById('f-after').value || null,
      afterKind: document.getElementById('f-after-kind').value,
    } });
    const images = draftImages;
    draftImages = [];
    paintDraftImages();
    for (const blob of images) await uploadImage(card.id, blob).catch((e) => toast(`Kuvaa ei tallennettu: ${e.message}`));
    document.getElementById('form').reset();
    paintRepoChips();
    dlg.close();
    await refresh(true);
  } catch (e) { document.getElementById('error').textContent = e.message; }
});
