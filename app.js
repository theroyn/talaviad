'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- small persisted settings (per phone) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const positions = store.get('pos', {});          // id -> {t, d, at}
let bookmarks = store.get('bm', []);             // [{key, id, t, note, at}]
let noMusic = store.get('nomusic', true);
let speed = store.get('speed', 1);
let autoNext = store.get('auto', true);

// ---------- formatting ----------
const fmtDate = d => { const [y, m, dd] = d.split('-'); return `${+dd}.${+m}.${y}`; };
const weekday = d => new Date(d + 'T12:00').toLocaleDateString('he-IL', { weekday: 'long' });
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const fmtMB = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
const typeLabel = t => t === 'full' ? 'תוכנית מלאה' : 'קטע';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.hidden = true, 2400);
}

// ---------- data ----------
let eps = [], byId = {}, byDate = new Map(), dates = [];
let AUDIO = '', IMAGE = '';

async function loadData() {
  const data = await (await fetch('episodes.json')).json();
  AUDIO = data.audio; IMAGE = data.image;
  eps = data.episodes.map(([id, date, type, title, url, nomusic, image]) => ({
    id, date, type: type ? 'clip' : 'full', title, url, nomusic, image,
    s: `${title} ${fmtDate(date)} ${date}`.toLowerCase(),
  }));
  byId = Object.fromEntries(eps.map(e => [e.id, e]));
  // per day: full show first, then the clips in broadcast order (the list is newest-first)
  for (let i = eps.length - 1; i >= 0; i--) {
    const e = eps[i];
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  for (const list of byDate.values()) list.sort((a, b) => (a.type === 'full' ? 0 : 1) - (b.type === 'full' ? 0 : 1));
  dates = [...byDate.keys()].sort();
}

const imgOf = e => e && e.image ? (e.image.startsWith('http') ? e.image : IMAGE + e.image) : 'icon-192.png';
const audioOf = e => AUDIO + (noMusic && e.nomusic ? e.nomusic : e.url);
document.addEventListener('error', ev => {
  if (ev.target.tagName === 'IMG' && !ev.target.src.endsWith('icon-192.png')) ev.target.src = 'icon-192.png';
}, true);

// ---------- offline storage (IndexedDB) ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('talaviad', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('files', { keyPath: 'id' });   // {id, blob}
    r.result.createObjectStore('meta', { keyPath: 'id' });    // {id, size, savedAt}
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
function idb(stores, mode, fn) {
  return dbp.then(db => new Promise((res, rej) => {
    const tx = db.transaction(stores, mode);
    const out = fn(...[].concat(stores).map(s => tx.objectStore(s)));
    tx.oncomplete = () => res(out && 'result' in out ? out.result : out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
const saved = new Map();       // id -> {size, savedAt}
const downloading = new Map(); // id -> {received, total, ctrl}

async function loadSaved() {
  try {
    const metas = await idb('meta', 'readonly', m => m.getAll());
    metas.forEach(m => saved.set(m.id, m));
  } catch { /* storage unavailable: offline saving just won't work */ }
}

async function saveOffline(id) {
  if (saved.has(id) || downloading.has(id)) return;
  const e = byId[id];
  const d = { received: 0, total: 0, ctrl: new AbortController() };
  downloading.set(id, d);
  refreshSave(id);
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    const r = await fetch(audioOf(e), { signal: d.ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    d.total = +r.headers.get('content-length') || 0;
    const reader = r.body.getReader();
    const chunks = [];
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      d.received += value.length;
      if (Date.now() - last > 250) { last = Date.now(); refreshSave(id); }
    }
    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    const meta = { id, size: blob.size, savedAt: Date.now() };
    await idb(['files', 'meta'], 'readwrite', (f, m) => { f.put({ id, blob }); m.put(meta); });
    saved.set(id, meta);
    toast('נשמר לטלפון. אפשר להאזין גם בלי אינטרנט');
  } catch (err) {
    if (err.name !== 'AbortError') toast('השמירה נכשלה. בדקו את החיבור ונסו שוב');
  } finally {
    downloading.delete(id);
    refreshSave(id);
    if (route.page === 'saved') renderSaved();
  }
}

async function removeSaved(id) {
  await idb(['files', 'meta'], 'readwrite', (f, m) => { f.delete(id); m.delete(id); });
  saved.delete(id);
  refreshSave(id);
  renderSaved();
}

async function savedBlobUrl(id) {
  const rec = await idb('files', 'readonly', f => f.get(id));
  return rec ? URL.createObjectURL(rec.blob) : null;
}

const dlIcon = '<svg viewBox="0 0 24 24" class="ic"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>';
const okIcon = '<svg viewBox="0 0 24 24" class="ic"><path d="M5 12.5 10 17 19 7"/></svg>';
function ring(p) {
  const c = 2 * Math.PI * 10;
  return `<svg viewBox="0 0 26 26" class="ring"><circle class="bg" cx="13" cy="13" r="10"/><circle class="fg" cx="13" cy="13" r="10" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}"/></svg>`;
}
function saveBtnInner(id) {
  if (saved.has(id)) return okIcon;
  const d = downloading.get(id);
  if (d) return ring(d.total ? d.received / d.total : 0.05);
  return dlIcon;
}
function refreshSave(id) {
  $$(`[data-save="${id}"]`).forEach(b => {
    b.innerHTML = saveBtnInner(id);
    b.classList.toggle('on', saved.has(id));
    b.setAttribute('aria-label', saved.has(id) ? 'שמור בטלפון' : downloading.has(id) ? 'מוריד… (לחיצה לביטול)' : 'שמירה לטלפון');
  });
  if (id === currentId) renderPlayerButtons();
  $$(`.row[data-id="${id}"] .saved-tag`).forEach(t => t.hidden = !saved.has(id));
  if (route.page === 'saved' && downloading.has(id)) updateSavedProgress(id);
}
function onSaveClick(id) {
  if (saved.has(id)) { toast('הפרק כבר שמור. אפשר למחוק אותו בלשונית "שמורים"'); return; }
  const d = downloading.get(id);
  if (d) { d.ctrl.abort(); toast('ההורדה בוטלה'); return; }
  saveOffline(id);
}

// ---------- rows ----------
const playIcon = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

function progressOf(id) {
  const p = positions[id];
  return p && p.d ? Math.min(1, p.t / p.d) : 0;
}

function rowHtml(e, { open = 'day' } = {}) {
  const pct = progressOf(e.id);
  const playing = e.id === currentId;
  return `<li class="row${playing ? ' playing' : ''}" data-id="${e.id}" data-open="${open}">
    <img class="thumb" loading="lazy" src="${esc(imgOf(e))}" alt="">
    <div class="rowmain">
      <div class="rt">${esc(e.title)}</div>
      <div class="rm">
        <span>${weekday(e.date)}, ${fmtDate(e.date)}</span>
        <span class="tag ${e.type}">${typeLabel(e.type)}</span>
        <span class="tag ok saved-tag"${saved.has(e.id) ? '' : ' hidden'}>✓ בטלפון</span>
        ${pct >= 0.95 ? '<span class="tag">הושמע</span>' : ''}
      </div>
    </div>
    <div class="acts">
      <button class="iconbtn${saved.has(e.id) ? ' on' : ''}" data-save="${e.id}" aria-label="שמירה לטלפון">${saveBtnInner(e.id)}</button>
      <button class="iconbtn playmini" data-play="${e.id}" aria-label="נגן">${playing && !audio.paused ? pauseIcon : playIcon}</button>
    </div>
    ${pct > 0.02 && pct < 0.95 ? `<i class="rowbar" style="width:${pct * 100}%"></i>` : ''}
  </li>`;
}

function refreshRow(id) {
  const e = byId[id]; if (!e) return;
  $$(`.row[data-id="${id}"]`).forEach(li => {
    const tmp = document.createElement('ul');
    tmp.innerHTML = rowHtml(e, { open: li.dataset.open });
    li.replaceWith(tmp.firstElementChild);
  });
}

// one click handler for every list of episodes
document.addEventListener('click', ev => {
  if (ev.target.closest('[data-del], [data-bm-edit]')) return;   // handled below
  const saveBtn = ev.target.closest('[data-save]');
  if (saveBtn) { onSaveClick(saveBtn.dataset.save); return; }
  const playBtn = ev.target.closest('[data-play]');
  if (playBtn) { const id = playBtn.dataset.play; id === currentId ? togglePlay() : play(id); return; }
  const row = ev.target.closest('.row[data-open]');
  if (row) {
    const e = byId[row.dataset.id];
    if (row.dataset.open === 'day') go(`#day/${e.date}/${e.id}`);
    else e.id === currentId ? openPlayer() : play(e.id);
  }
  const card = ev.target.closest('.card-ep');
  if (card) {
    if (card.dataset.day) go(`#day/${card.dataset.day}`);
    else play(card.dataset.id);
  }
});

// ---------- routing ----------
const route = { page: 'home' };
const titles = { home: 'טל ואביעד', archive: 'ארכיון', bookmarks: 'סימניות', saved: 'שמורים בטלפון', day: '' };
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

function render() {
  const [page, a, b] = (location.hash.slice(1) || 'home').split('/');
  route.page = titles[page] !== undefined ? page : 'home';
  $$('.page').forEach(p => p.hidden = p.id !== `page-${route.page}`);
  $$('.tabs a').forEach(t => t.classList.toggle('on', t.dataset.tab === route.page));
  $('#pageTitle').textContent = titles[route.page];
  if (route.page === 'home') renderHome();
  if (route.page === 'archive') renderArchive(false);
  if (route.page === 'bookmarks') renderBookmarks();
  if (route.page === 'saved') renderSaved();
  if (route.page === 'day') renderDay(a, b);
  if (route.page !== 'day') window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { closePlayer(true); render(); });

// ---------- home ----------
function greeting() {
  const h = new Date().getHours();
  return h >= 5 && h < 12 ? 'בוקר טוב' : h < 17 && h >= 12 ? 'צהריים טובים' : h >= 17 && h < 21 ? 'ערב טוב' : 'לילה טוב';
}

function onThisDay() {
  const now = new Date();
  const out = [];
  for (let y = 2023; y >= 2011; y--) {
    for (let k = 0; k <= 3; k++) {
      const hit = [0, k, -k].map(off => {
        const d = new Date(y, now.getMonth(), now.getDate() + off, 12);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }).find(d => (byDate.get(d) || []).some(e => e.type === 'full'));
      if (hit) { out.push({ date: hit, exact: k === 0 && hit.slice(5) === dates0(now), years: now.getFullYear() - y }); break; }
    }
  }
  return out;
}
const dates0 = d => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function renderHome() {
  $('#greeting').textContent = greeting();
  const otd = onThisDay();
  $('#otdTitle').textContent = otd.some(o => o.exact) ? 'היום, לפני כמה שנים' : 'השבוע, לפני כמה שנים';
  $('#otdBlock').hidden = !otd.length;
  $('#otd').innerHTML = otd.map(o => {
    const full = byDate.get(o.date).find(e => e.type === 'full');
    const clips = byDate.get(o.date).length - 1;
    return `<button class="card-ep" data-day="${o.date}">
      <img loading="lazy" src="${esc(imgOf(full))}" alt="">
      <div class="cb">
        <span class="years">לפני ${o.years} שנים${o.exact ? '' : ' (בערך)'}</span>
        <div class="ct">${esc(full.title)}</div>
        <div class="cm">${weekday(o.date)}${clips > 0 ? ` · ${clips} קטעים` : ''}</div>
      </div>
    </button>`;
  }).join('');

  const cont = Object.entries(positions)
    .filter(([id, p]) => byId[id] && p.d && p.t > 30 && p.t / p.d < 0.95)
    .sort((a, b) => b[1].at - a[1].at).slice(0, 10);
  $('#contBlock').hidden = !cont.length;
  $('#cont').innerHTML = cont.map(([id, p]) => {
    const e = byId[id];
    return `<button class="card-ep" data-id="${id}">
      <img loading="lazy" src="${esc(imgOf(e))}" alt="">
      <div class="cb">
        <div class="ct">${esc(e.title)}</div>
        <div class="cm">נותרו ${Math.max(1, Math.round((p.d - p.t) / 60))} דק׳</div>
        <div class="bar"><i style="width:${p.t / p.d * 100}%"></i></div>
      </div>
    </button>`;
  }).join('');

  const recent = bookmarks.slice().sort((a, b) => b.at - a.at).slice(0, 3);
  $('#homeBmBlock').hidden = !recent.length;
  $('#homeBm').innerHTML = recent.map(bmRowHtml).join('');
}

// ---------- archive ----------
const f = { q: '', type: 'all', year: '' };
let filtered = [], shown = 0;
const PAGE = 50;

function renderArchive(refilter = true) {
  if (refilter || !filtered.length) {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = eps.filter(e =>
      (f.type === 'all' || e.type === f.type) && (!f.year || e.date.startsWith(f.year)) && terms.every(t => e.s.includes(t)));
    $('#count').textContent = `${filtered.length.toLocaleString()} פרקים`;
    $('#list').innerHTML = filtered.length ? '' : '<li class="empty">לא נמצא. נסו מילה אחרת או תאריך כמו 6.1.11</li>';
    shown = 0;
    moreArchive();
  }
}
function moreArchive() {
  if (shown >= filtered.length) return;
  $('#list').insertAdjacentHTML('beforeend', filtered.slice(shown, shown + PAGE).map(e => rowHtml(e)).join(''));
  shown += PAGE;
}
new IntersectionObserver(es => { if (es[0].isIntersecting && route.page === 'archive') moreArchive(); }, { rootMargin: '800px' })
  .observe($('#sentinel'));
let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = e.target.value.trim(); renderArchive(); }, 200); });
$('#typeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#typeSeg button').forEach(x => x.classList.toggle('on', x === b));
  f.type = b.dataset.v; renderArchive();
});
$('#year').addEventListener('change', e => { f.year = e.target.value; renderArchive(); });

// ---------- day view ----------
function renderDay(date, focusId) {
  let list = byDate.get(date);
  if (!list) { go('#archive'); return; }
  const full = list.find(e => e.type === 'full');
  const clips = list.filter(e => e.type === 'clip');
  $('#pageTitle').textContent = fmtDate(date);
  $('#dayImg').src = imgOf(full || list[0]);
  $('#dayDate').textContent = `${weekday(date)}, ${fmtDate(date)}`;
  $('#daySub').textContent = [full ? 'תוכנית מלאה' : '', clips.length ? `${clips.length} קטעים` : ''].filter(Boolean).join(' ו־');
  $('#dayPlayAll').hidden = !full && !clips.length;
  $('#dayPlayAll').lastChild.textContent = full ? ' נגן את התוכנית' : ' נגן את הקטעים';
  $('#dayPlayAll').onclick = () => play((full || clips[0]).id);
  $('#dayList').innerHTML = list.map(e => rowHtml(e, { open: 'play' })).join('');
  const i = dates.indexOf(date);
  $('#dayPrev').disabled = i <= 0;
  $('#dayNext').disabled = i >= dates.length - 1;
  $('#dayPrev').onclick = () => go(`#day/${dates[i - 1]}`);
  $('#dayNext').onclick = () => go(`#day/${dates[i + 1]}`);
  if (focusId) {
    const li = $(`#dayList .row[data-id="${focusId}"]`);
    if (li) { li.classList.add('hl'); li.scrollIntoView({ block: 'center' }); }
  } else window.scrollTo(0, 0);
}

// ---------- bookmarks ----------
function seedBookmarks() {
  if (store.get('bmSeeded', false)) return;
  const kate = (byDate.get('2011-01-06') || []).find(e => e.type === 'full');
  if (kate) bookmarks.push({ key: 'seed', id: kate.id, t: 3363, note: "הצ'חלות, הכרכרה וגללי הסוסים (הקטע שחיפשנו)", at: Date.now() });
  store.set('bm', bookmarks);
  store.set('bmSeeded', true);
}

function bmRowHtml(b) {
  const e = byId[b.id]; if (!e) return '';
  return `<li class="row bm" data-bm="${b.key}">
    <img class="thumb" loading="lazy" src="${esc(imgOf(e))}" alt="">
    <div class="rowmain">
      <div class="rt">${esc(e.title)}</div>
      <div class="rm"><span class="ts">${fmtTime(b.t)}</span><span>${fmtDate(e.date)}</span></div>
      ${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}
    </div>
    <div class="acts">
      <button class="iconbtn" data-bm-edit="${b.key}" aria-label="עריכה"><svg viewBox="0 0 24 24" class="ic"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
    </div>
  </li>`;
}
function renderBookmarks() {
  const list = bookmarks.slice().sort((a, b) => b.at - a.at);
  $('#bmList').innerHTML = list.length ? list.map(bmRowHtml).join('') : '';
}
document.addEventListener('click', ev => {
  const edit = ev.target.closest('[data-bm-edit]');
  if (edit) { openBmDialog(bookmarks.find(b => b.key === edit.dataset.bmEdit)); return; }
  const row = ev.target.closest('.row.bm');
  if (row) {
    const b = bookmarks.find(x => x.key === row.dataset.bm);
    if (b) { play(b.id, Math.max(0, b.t - 2)); openPlayer(); }
  }
});

let bmEditing = null;
function openBmDialog(existing) {
  bmEditing = existing || null;
  const id = existing ? existing.id : currentId;
  const t = existing ? existing.t : audio.currentTime;
  const e = byId[id];
  $('#bmDialogTitle').textContent = existing ? 'עריכת סימנייה' : 'סימנייה חדשה';
  $('#bmDialogWhere').textContent = `${e.title} · ${fmtTime(t)}`;
  $('#bmNote').value = existing ? existing.note : '';
  $('#bmCancel').textContent = existing ? 'מחיקה' : 'ביטול';
  $('#bmCancel').className = existing ? 'btn danger' : 'btn ghost';
  $('#bmDialog').hidden = false;
  $('#bmDialog').dataset.t = t;
  $('#bmDialog').dataset.id = id;
  setTimeout(() => $('#bmNote').focus(), 50);
}
$('#bmSave').addEventListener('click', () => {
  const note = $('#bmNote').value.trim();
  if (bmEditing) bmEditing.note = note;
  else bookmarks.push({ key: String(Date.now()), id: $('#bmDialog').dataset.id, t: +$('#bmDialog').dataset.t, note, at: Date.now() });
  store.set('bm', bookmarks);
  $('#bmDialog').hidden = true;
  toast(bmEditing ? 'הסימנייה עודכנה' : 'הסימנייה נשמרה');
  renderMarks();
  if (route.page === 'bookmarks') renderBookmarks();
  if (route.page === 'home') renderHome();
});
$('#bmCancel').addEventListener('click', () => {
  if (bmEditing && confirm('למחוק את הסימנייה?')) {
    bookmarks = bookmarks.filter(b => b !== bmEditing);
    store.set('bm', bookmarks);
    renderMarks();
    if (route.page === 'bookmarks') renderBookmarks();
    if (route.page === 'home') renderHome();
  }
  $('#bmDialog').hidden = true;
});
$('#bmDialog').addEventListener('click', e => { if (e.target.id === 'bmDialog') $('#bmDialog').hidden = true; });

// ---------- saved ----------
async function renderSaved() {
  const items = [...saved.values()].sort((a, b) => b.savedAt - a.savedAt);
  const total = items.reduce((s, m) => s + m.size, 0);
  let free = '';
  try {
    const est = await navigator.storage.estimate();
    if (est.quota) free = ` · פנוי לשמירה: כ־${fmtMB(Math.max(0, est.quota - est.usage))}`;
  } catch {}
  $('#storage').innerHTML = items.length || downloading.size
    ? `<b>${items.length} פרקים</b> שמורים בטלפון (${fmtMB(total)})<div class="hint" style="margin:4px 0 0">${free.slice(3)}</div>`
    : '<b>אין עדיין פרקים שמורים</b><div class="hint" style="margin:4px 0 0">לחצו על כפתור ההורדה ליד פרק כדי לשמור אותו להאזנה בלי אינטרנט.</div>';
  const rows = [...downloading.keys()].map(id => savedRowHtml(id, true)).concat(items.map(m => savedRowHtml(m.id, false)));
  $('#savedList').innerHTML = rows.join('');
}
function savedRowHtml(id, inProgress) {
  const e = byId[id]; if (!e) return '';
  const m = saved.get(id);
  const d = downloading.get(id);
  const info = inProgress
    ? `<span class="dlp" data-dlp="${id}">${d && d.total ? Math.round(d.received / d.total * 100) : 0}% · מוריד…</span>`
    : `<span>${fmtMB(m.size)}</span>`;
  return `<li class="row" data-id="${id}" data-open="play">
    <img class="thumb" loading="lazy" src="${esc(imgOf(e))}" alt="">
    <div class="rowmain">
      <div class="rt">${esc(e.title)}</div>
      <div class="rm"><span>${fmtDate(e.date)}</span>${info}</div>
    </div>
    <div class="acts">
      ${inProgress
        ? `<button class="iconbtn" data-save="${id}" aria-label="ביטול">${saveBtnInner(id)}</button>`
        : `<button class="iconbtn" data-del="${id}" aria-label="מחיקה מהטלפון"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`}
    </div>
  </li>`;
}
function updateSavedProgress(id) {
  const d = downloading.get(id);
  const el = $(`[data-dlp="${id}"]`);
  if (el && d) el.textContent = `${d.total ? Math.round(d.received / d.total * 100) : 0}% · מוריד…`;
  else if (!el) renderSaved();
}
document.addEventListener('click', ev => {
  const del = ev.target.closest('[data-del]');
  if (del && confirm('למחוק את הפרק מהטלפון? (אפשר לשמור שוב בכל עת)')) removeSaved(del.dataset.del);
});
$('#prefNoMusic').checked = noMusic;
$('#prefNoMusic').addEventListener('change', e => { noMusic = e.target.checked; store.set('nomusic', noMusic); });

// ---------- player ----------
const audio = $('#audio');
let currentId = null, blobUrl = null, lastSave = 0;

async function play(id, at) {
  const e = byId[id]; if (!e) return;
  const prev = currentId;
  currentId = id;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  let src = null;
  if (saved.has(id)) { try { src = blobUrl = await savedBlobUrl(id); } catch {} }
  if (!src) {
    if (!navigator.onLine) { toast('אין חיבור לאינטרנט, והפרק לא שמור בטלפון'); currentId = prev; return; }
    src = audioOf(e);
  }
  audio.src = src;
  audio.playbackRate = speed;
  const p = positions[id];
  const startAt = at !== undefined ? at : (p && p.d && p.t / p.d < 0.95 ? Math.max(0, p.t - 3) : 0);
  audio.addEventListener('loadedmetadata', () => { if (startAt) audio.currentTime = startAt; }, { once: true });
  audio.play().catch(() => {});
  document.body.classList.add('has-mini');
  $('#mini').hidden = false;
  $('#miniImg').src = $('#pImg').src = imgOf(e);
  $('#miniTitle').textContent = $('#pTitle').textContent = e.title;
  $('#pDate').textContent = `${typeLabel(e.type)} · ${weekday(e.date)}, ${fmtDate(e.date)}`;
  renderPlayerButtons();
  renderMarks();
  renderUpNext();
  if (prev) refreshRow(prev);
  refreshRow(id);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: e.title, artist: 'טל ואביעד', album: `eco99fm · ${fmtDate(e.date)}`,
      artwork: [{ src: imgOf(e), sizes: '512x512' }],
    });
  }
}

function nextOf(e) {
  // same kind of episode: next clip of the day, or the next day's full show / clips
  const day = byDate.get(e.date);
  const sameDay = day.filter(x => x.type === e.type);
  const i = sameDay.indexOf(e);
  if (i >= 0 && i < sameDay.length - 1) return sameDay[i + 1];
  for (let j = dates.indexOf(e.date) + 1; j < dates.length; j++) {
    const n = byDate.get(dates[j]).find(x => x.type === e.type);
    if (n) return n;
  }
  return null;
}

function togglePlay() { if (!audio.src) return; audio.paused ? audio.play() : audio.pause(); }
function skip(s) { audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + s)); }

function savePos(force) {
  if (!currentId || !audio.duration || !isFinite(audio.duration)) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  positions[currentId] = { t: audio.currentTime, d: audio.duration, at: now };
  store.set('pos', positions);
}

function renderPlayerButtons() {
  if (!currentId) return;
  const id = currentId;
  const d = downloading.get(id);
  $('#pSave').innerHTML = saved.has(id) ? `${okIcon} שמור בטלפון`
    : d ? `${ring(d.total ? d.received / d.total : 0.05)} ${d.total ? Math.round(d.received / d.total * 100) : 0}%`
    : `${dlIcon} שמירה לטלפון`;
  $('#pSave').classList.toggle('on', saved.has(id));
  $('#pAuto').textContent = autoNext ? 'ניגון אוטומטי: פועל' : 'ניגון אוטומטי: כבוי';
  $('#pAuto').classList.toggle('on', autoNext);
  $('#pSpeed').textContent = `×${speed}`;
}
function renderMarks() {
  const dur = audio.duration;
  if (!currentId || !dur || !isFinite(dur)) { $('#marks').innerHTML = ''; return; }
  $('#marks').innerHTML = bookmarks.filter(b => b.id === currentId)
    .map(b => `<i style="left:${Math.min(100, b.t / dur * 100)}%"></i>`).join('');
}
function renderUpNext() {
  const e = byId[currentId];
  const n = e && autoNext ? nextOf(e) : null;
  $('#upNext').innerHTML = n ? `הבא בתור: <b>${esc(n.title)}</b>` : '';
}

const syncPlayIcons = () => {
  const icon = audio.paused ? playIcon : pauseIcon;
  $('#miniPlay').innerHTML = icon;
  $('#pPlay').innerHTML = icon;
  if (currentId) refreshRow(currentId);
};
syncPlayIcons();

$('#miniPlay').addEventListener('click', togglePlay);
$('#pPlay').addEventListener('click', togglePlay);
$('#back15').addEventListener('click', () => skip(-15));
$('#fwd30').addEventListener('click', () => skip(30));
$('#pSpeed').addEventListener('click', () => {
  const opts = [1, 1.25, 1.5, 1.75, 2];
  speed = opts[(opts.indexOf(speed) + 1) % opts.length];
  audio.playbackRate = speed; store.set('speed', speed);
  renderPlayerButtons();
});
$('#pAuto').addEventListener('click', () => { autoNext = !autoNext; store.set('auto', autoNext); renderPlayerButtons(); renderUpNext(); });
$('#pSave').addEventListener('click', () => currentId && onSaveClick(currentId));
$('#pBookmark').addEventListener('click', () => currentId && openBmDialog());
$('#pDate').addEventListener('click', () => {
  const e = byId[currentId];
  closePlayer(true);   // reuse the player's history entry for the day page
  history.replaceState(null, '', `#day/${e.date}/${e.id}`);
  render();
});

let seeking = false;
$('#seek').addEventListener('input', () => { seeking = true; $('#tCur').textContent = fmtTime($('#seek').value / 1000 * audio.duration); });
$('#seek').addEventListener('change', () => { audio.currentTime = $('#seek').value / 1000 * audio.duration; seeking = false; });

audio.addEventListener('timeupdate', () => {
  if (!audio.duration || !isFinite(audio.duration)) return;
  const p = audio.currentTime / audio.duration;
  $('#miniProg').style.width = `${p * 100}%`;
  if (!seeking) { $('#seek').value = p * 1000; $('#tCur').textContent = fmtTime(audio.currentTime); }
  savePos(false);
});
audio.addEventListener('durationchange', () => { $('#tDur').textContent = fmtTime(audio.duration); renderMarks(); });
audio.addEventListener('play', syncPlayIcons);
audio.addEventListener('pause', () => { syncPlayIcons(); savePos(true); });
audio.addEventListener('ended', () => {
  savePos(true);
  const n = autoNext && nextOf(byId[currentId]);
  if (n) { toast(`ממשיכים: ${n.title}`); play(n.id, 0); }
});
audio.addEventListener('error', () => { if (audio.src) toast('לא הצלחנו לנגן את הפרק'); });
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(true); });

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('seekbackward', () => skip(-15));
  ms.setActionHandler('seekforward', () => skip(30));
  try { ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; }); } catch {}
  ms.setActionHandler('nexttrack', () => { const n = currentId && nextOf(byId[currentId]); if (n) play(n.id, 0); });
}

// full-screen player: the phone's back button closes it
const sheetOpen = () => !$('#player').hidden;
function openPlayer() {
  if (!currentId || sheetOpen()) return;
  $('#player').hidden = false;
  document.body.style.overflow = 'hidden';
  history.pushState({ sheet: 1 }, '');
  renderMarks();
}
function closePlayer(fromHistory) {
  if (!sheetOpen()) return;
  $('#player').hidden = true;
  document.body.style.overflow = '';
  if (!fromHistory && history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => { if (sheetOpen()) closePlayer(true); });
$('#mini').addEventListener('click', e => { if (!e.target.closest('#miniPlay')) openPlayer(); });
$('#playerClose').addEventListener('click', () => closePlayer());

// ---------- start ----------
(async () => {
  await Promise.all([loadData(), loadSaved()]);
  const years = [...new Set(eps.map(e => e.date.slice(0, 4)))].sort().reverse();
  $('#year').innerHTML = '<option value="">כל השנים</option>' + years.map(y => `<option>${y}</option>`).join('');
  seedBookmarks();
  render();
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
