import { authToken, encKey, accountId, encryptText, encryptBytes, decryptText, decryptBytes } from '/crypto.js';
import * as db from '/db.js';

const $ = (s) => document.querySelector(s);

// --- Réglages du comportement ----------------------------------------------

const ENVS_KEY = 'clipsync.envs';
const ACTIVE_KEY = 'clipsync.env';

// Purge automatique : tout ce qui a plus de 23 h 59 disparaît. Les favoris,
// jamais — c'est leur seule raison d'exister.
const PURGE_MS = 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
const MAX_FAV = 50;

// Place que l'historique s'autorise sur l'appareil. Au-delà, les octets des
// éléments les plus anciens (hors favoris) sont libérés : la fiche reste, le
// fichier redevient téléchargeable depuis le relais tant qu'il y est.
const BLOB_CAP = 300 * 1024 * 1024;

// Une image se pré-charge pour afficher sa vignette ; au-delà de cette taille
// on attend que l'utilisateur la demande.
const AUTO_IMG_MAX = 12 * 1024 * 1024;

const MAX_FILE = 100 * 1024 * 1024;
const SWIPE_TRIGGER = 88;

// --- Environnements ---------------------------------------------------------
// Un environnement = une phrase de couplage + son historique. On peut en avoir
// plusieurs (perso, boulot) et basculer de l'un à l'autre sans les mélanger.

const rand = (n) => Math.random().toString(36).slice(2, 2 + n);
const uid = () => Date.now().toString(36) + '-' + rand(6);

function detectDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  // iPadOS se déclare « Macintosh » : seul le tactile le trahit.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android' : 'Tablette Android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return 'Navigateur';
}

function detectPlatform() {
  const n = detectDeviceName();
  if (n === 'iPhone' || n === 'iPad') return 'ios';
  if (n.startsWith('Android') || n === 'Tablette Android') return 'android';
  if (n === 'Mac') return 'mac';
  if (n === 'PC Windows') return 'windows';
  return 'web';
}

function newEnv(name, phrase = '') {
  return {
    id: 'e-' + rand(8),
    name: name || 'Principal',
    phrase,
    deviceId: 'web-' + rand(10),
    deviceName: detectDeviceName(),
    hidden: [],
  };
}

// Reprise de l'ancienne config mono-environnement.
function legacyEnv() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem('clipsync.cfg')); } catch {}
  if (!c || !c.phrase) return null;
  const e = newEnv('Principal', c.phrase);
  if (c.deviceId) e.deviceId = c.deviceId;
  // « iPhone » était le nom imposé à tout le monde, y compris sur un Mac : on ne
  // le garde que s'il correspond vraiment à l'appareil.
  if (c.deviceName && (c.deviceName !== 'iPhone' || e.deviceName === 'iPhone')) e.deviceName = c.deviceName;
  return e;
}

function loadEnvs() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(ENVS_KEY)) || []; } catch {}
  if (!Array.isArray(list)) list = [];
  list = list.filter((e) => e && e.id);
  for (const e of list) if (!Array.isArray(e.hidden)) e.hidden = [];
  if (!list.length) list = [legacyEnv() ?? newEnv('Principal')];
  return list;
}

let envs = loadEnvs();
let env = envs.find((e) => e.id === localStorage.getItem(ACTIVE_KEY)) ?? envs[0];

function saveEnvs() {
  localStorage.setItem(ENVS_KEY, JSON.stringify(envs));
  localStorage.setItem(ACTIVE_KEY, env.id);
}
saveEnvs();

// --- État -------------------------------------------------------------------

let entries = [];
let deviceList = [];
let tab = 'all';
let query = '';
let ws = null;
let key = null, token = null, acct = null;
let generation = 0; // invalide les sockets d'un environnement qu'on vient de quitter

const wsURL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
const httpBase = location.origin;

// --- Petits utilitaires -----------------------------------------------------

function setStatus(text, online, sub = '') {
  $('#dot').className = 'dot ' + (online ? 'on' : 'off');
  $('#statusText').textContent = text;
  $('#statusSub').textContent = sub;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  // Une boîte de dialogue ouverte vit dans le « top layer » : un toast resté
  // dans le body passerait dessous. On le déplace dans la boîte active.
  const dlg = document.querySelector('dialog[open]');
  (dlg ?? document.body).appendChild(t);
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function fmtTime(d) {
  const now = new Date();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + time;
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' Ko';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' Mo';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' Go';
}

const MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime',
  mp3: 'audio/mpeg', txt: 'text/plain', csv: 'text/csv',
};
function guessMime(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase();
  return MIMES[ext] ?? '';
}

function fileIcon(mime = '') {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('zip') || mime.includes('compressed')) return '🗜️';
  if (mime.includes('pdf')) return '📕';
  return '📄';
}

// --- Connexion --------------------------------------------------------------

async function ensureKeys() {
  token = await authToken(env.phrase);
  key = await encKey(env.phrase);
  acct = await accountId(env.phrase);
}

async function connect() {
  const mine = ++generation;
  try { ws?.close(); } catch {}
  ws = null;

  if (!env.phrase) { setStatus('À configurer', false); openSettings(); return; }

  setStatus('Connexion…', false);
  await ensureKeys();
  if (mine !== generation) return;

  const sock = new WebSocket(wsURL);
  ws = sock;
  sock.onopen = () => {
    if (mine !== generation) { try { sock.close(); } catch {} return; }
    sock.send(JSON.stringify({
      type: 'hello', accountId: acct, token,
      deviceId: env.deviceId, deviceName: env.deviceName, platform: detectPlatform(),
      // On accepte de recevoir ce qui est arrivé pendant qu'on était fermé.
      caps: ['queue'],
    }));
    setStatus('Connecté', true);
    refreshStatusSub();
  };
  sock.onmessage = (e) => {
    if (mine !== generation) return;
    try { handle(JSON.parse(e.data)); } catch {}
  };
  sock.onclose = () => {
    if (mine !== generation) return;
    setStatus('Hors ligne', false);
    setTimeout(() => { if (mine === generation) connect(); }, 3000);
  };
  sock.onerror = () => {};
}

setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat' })); }, 30000);

function wsSend(msg) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

async function handle(msg) {
  switch (msg.type) {
    case 'welcome':
    case 'devices':
      deviceList = msg.devices || [];
      renderDevices();
      refreshStatusSub();
      break;
    case 'clip': await onClip(msg); break;
    case 'sent': break;
    case 'applied': toast(`Collé sur ${msg.by?.name || 'le PC'} ✓`); break;
    case 'removed': toast('Cet appareil a été retiré depuis un autre'); break;
    case 'error': toast('Erreur : ' + msg.message); break;
  }
}

function refreshStatusSub() {
  const hidden = new Set(env.hidden);
  const visible = deviceList.filter((d) => !hidden.has(d.deviceId));
  const online = visible.filter((d) => d.online).length;
  const sub = visible.length
    ? `${online}/${visible.length} en ligne`
    : 'aucun autre appareil';
  setStatus($('#statusText').textContent, $('#dot').classList.contains('on'), sub);
}

// --- Réception --------------------------------------------------------------

async function onClip(msg) {
  // Un clip rejoué depuis la file d'attente ne doit pas apparaître deux fois.
  if (msg.messageId && entries.some((e) => e.msgId === msg.messageId)) return;

  const peer = msg.from?.name || 'un appareil';
  const ts = msg.ts || Date.now();

  if (msg.contentType === 'text') {
    const text = msg.enc === 'v1' ? await decryptText(key, msg.text) : msg.text;
    if (text == null) return;
    await addEntry({ dir: 'in', kind: 'text', peer, ts, text, msgId: msg.messageId });
    if (!msg.queued) toast('Texte reçu de ' + peer);
    return;
  }
  if (!msg.fileId) return;

  const filename = msg.meta?.filename || (msg.contentType === 'image' ? 'image.png' : 'fichier');
  let mime = msg.fileType && msg.fileType !== 'application/octet-stream' ? msg.fileType : guessMime(filename);
  if (!mime) mime = msg.contentType === 'image' ? 'image/png' : 'application/octet-stream';

  // Le type réel décide de l'affichage : une image envoyée « en fichier »
  // s'affiche quand même en vignette.
  const entry = await addEntry({
    dir: 'in', peer, ts, msgId: msg.messageId,
    kind: mime.startsWith('image/') ? 'image' : 'file',
    filename, size: msg.meta?.size ?? null, mime,
    fileId: msg.fileId, enc: msg.enc,
  });
  if (!msg.queued) toast(`${entry.kind === 'image' ? 'Image reçue' : 'Fichier reçu'} de ${peer}`);

  if (entry.kind === 'image' && (entry.size == null || entry.size <= AUTO_IMG_MAX)) {
    fetchBytes(entry).then((b) => { if (b) renderList(); });
  }
}

async function fetchFile(fileId) {
  try {
    const res = await fetch(httpBase + '/files/' + fileId, {
      headers: { 'x-account-id': acct, 'x-token': token },
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch { return null; }
}

// Récupère les octets depuis le relais, les déchiffre et les garde en local.
async function fetchBytes(entry) {
  if (!entry.fileId) return null;
  if (!token) await ensureKeys();
  const raw = await fetchFile(entry.fileId);
  if (!raw) return null;
  const bytes = entry.enc === 'v1' ? await decryptBytes(key, raw) : raw;
  if (!bytes) return null;
  await saveBytes(entry, bytes);
  return bytes;
}

async function saveBytes(entry, bytes) {
  if (bytes.byteLength > BLOB_CAP) return; // ne tiendra jamais dans le budget
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  try {
    await db.putBlob(entry.id, buf, entry.mime || 'application/octet-stream');
    entry.hasBlob = true;
    if (entry.size == null) entry.size = bytes.byteLength;
    await db.putEntry(entry);
    if (await db.enforceBlobCap(BLOB_CAP)) await reloadEntries();
  } catch {
    toast('Stockage local plein'); // quota navigateur : la fiche reste, pas les octets
  }
}

async function getBytes(entry) {
  const rec = await db.getBlob(entry.id);
  if (rec?.buf) return new Uint8Array(rec.buf);
  return fetchBytes(entry);
}

// --- Historique -------------------------------------------------------------

async function addEntry(partial) {
  const entry = { id: uid(), env: env.id, ts: Date.now(), fav: false, hasBlob: false, ...partial };
  await db.putEntry(entry);
  entries.push(entry);
  entries.sort((a, b) => b.ts - a.ts); // un rejeu peut être plus vieux que l'existant
  renderList();
  return entry;
}

const imgURLs = new Map();
function forgetUrl(id) {
  const u = imgURLs.get(id);
  if (u) { URL.revokeObjectURL(u); imgURLs.delete(id); }
}
function forgetOrphanUrls() {
  const alive = new Set(entries.map((e) => e.id));
  for (const id of [...imgURLs.keys()]) if (!alive.has(id)) forgetUrl(id);
}

async function reloadEntries() {
  entries = await db.entriesOf(env.id);
  forgetOrphanUrls();
  renderList();
}

async function removeEntry(entry) {
  forgetUrl(entry.id);
  await db.deleteEntry(entry.id);
  entries = entries.filter((e) => e.id !== entry.id);
  renderList();
  toast('Supprimé');
}

async function toggleFav(entry) {
  if (!entry.fav && entries.filter((e) => e.fav).length >= MAX_FAV) {
    toast(`${MAX_FAV} favoris maximum — retires-en un d'abord`);
    return;
  }
  entry.fav = !entry.fav;
  entry.favTs = entry.fav ? Date.now() : null;
  await db.putEntry(entry);
  renderList();
  toast(entry.fav ? 'Ajouté aux favoris ★' : 'Retiré des favoris');

  // Un favori doit survivre à la purge du relais : on rapatrie les octets
  // pendant qu'ils sont encore disponibles.
  if (entry.fav && entry.fileId && !entry.hasBlob) {
    fetchBytes(entry).then((b) => { if (b) renderList(); });
  }
}

// Purge automatique de tous les environnements (pas seulement l'actif).
async function purgeOld() {
  const before = Date.now() - PURGE_MS;
  let touched = false;
  for (const e of envs) {
    const n = await db.purgeBefore(e.id, before);
    if (n && e.id === env.id) touched = true;
  }
  if (touched) await reloadEntries();
}

// --- Rendu de la liste ------------------------------------------------------

function searchText(e) {
  return [e.text, e.filename, e.peer, e.kind === 'image' ? 'image' : e.kind === 'file' ? 'fichier' : 'texte']
    .filter(Boolean).join(' ').toLowerCase();
}

function visibleEntries() {
  let list = tab === 'fav' ? entries.filter((e) => e.fav) : entries;
  const q = query.trim().toLowerCase();
  if (q) list = list.filter((e) => searchText(e).includes(q));
  return list;
}

function renderList() {
  const el = $('#list');
  const favCount = entries.filter((e) => e.fav).length;
  document.querySelector('[data-tab="fav"]').textContent = favCount ? `Favoris ${favCount}` : 'Favoris';

  const list = visibleEntries();
  if (!list.length) {
    const msg = query ? 'Aucun résultat.'
      : tab === 'fav' ? 'Aucun favori. Glisse un élément vers la droite pour en ajouter un.'
      : 'Rien pour l’instant. Copie du texte, puis touche « Envoyer le presse-papiers ».';
    el.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: msg }));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of list) frag.appendChild(renderRow(e));
  el.replaceChildren(frag);
}

function iconBtn(label, title, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'i-act ' + cls;
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.onclick = onClick;
  return b;
}

function textBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'i-btn ' + cls;
  b.type = 'button';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function renderRow(e) {
  const row = document.createElement('div');
  row.className = 'row';
  const favBg = document.createElement('div');
  favBg.className = 'act act-fav';
  favBg.textContent = e.fav ? '★ retirer' : '★ favori';
  const delBg = document.createElement('div');
  delBg.className = 'act act-del';
  delBg.textContent = 'supprimer 🗑';
  row.append(favBg, delBg);

  const item = document.createElement('article');
  item.className = 'item' + (e.fav ? ' is-fav' : '');

  const head = document.createElement('div');
  head.className = 'i-head';
  const who = document.createElement('span');
  who.className = 'i-who ' + e.dir;
  who.textContent = e.dir === 'in' ? '← ' + (e.peer || 'reçu') : '→ ' + (e.peer || 'envoyé');
  const time = document.createElement('time');
  time.className = 'i-time';
  time.textContent = fmtTime(new Date(e.ts));
  head.append(who, time);
  if (e.fav) {
    const star = document.createElement('span');
    star.className = 'i-star';
    star.textContent = '★';
    head.insertBefore(star, time);
  }
  item.appendChild(head);

  const foot = document.createElement('div');
  foot.className = 'i-foot';

  if (e.kind === 'text') {
    const body = document.createElement('div');
    body.className = 'i-text';
    body.textContent = e.text;
    item.appendChild(body);
    foot.appendChild(textBtn('Copier', 'primary-ghost', async () => {
      try { await navigator.clipboard.writeText(e.text); toast('Copié ✓'); }
      catch { toast('Touche « Copier » à nouveau'); }
    }));
  } else if (e.kind === 'image') {
    const cached = imgURLs.get(e.id);
    if (cached || e.hasBlob) {
      const img = document.createElement('img');
      img.className = 'i-img';
      img.loading = 'lazy';
      img.alt = e.filename || 'image';
      if (cached) img.src = cached;
      else imageUrl(e).then((u) => { if (u) img.src = u; });
      item.appendChild(img);
    } else {
      // Image trop lourde pour être pré-chargée, ou octets déjà évincés.
      const ph = document.createElement('button');
      ph.className = 'i-placeholder';
      ph.type = 'button';
      ph.textContent = `🖼️ Afficher l’image${e.size ? ' · ' + fmtSize(e.size) : ''}`;
      ph.onclick = async () => {
        ph.disabled = true; ph.textContent = 'Chargement…';
        const bytes = await fetchBytes(e);
        if (!bytes) { ph.disabled = false; ph.textContent = 'Indisponible — expiré sur le relais'; return; }
        renderList();
      };
      item.appendChild(ph);
    }
    foot.appendChild(textBtn(e.hasBlob ? 'Enregistrer' : 'Télécharger', 'primary-ghost', (ev) => download(e, ev.currentTarget)));
  } else {
    const fileRow = document.createElement('div');
    fileRow.className = 'i-file';
    const ic = document.createElement('span');
    ic.className = 'i-fic';
    ic.textContent = fileIcon(e.mime);
    const meta = document.createElement('span');
    meta.className = 'i-fmeta';
    const nm = document.createElement('span');
    nm.className = 'i-fname';
    nm.textContent = e.filename || 'fichier';
    const sz = document.createElement('span');
    sz.className = 'i-fsize';
    sz.textContent = [fmtSize(e.size), e.hasBlob ? 'gardé sur l’appareil' : e.fileId ? 'sur le relais' : ''].filter(Boolean).join(' · ');
    meta.append(nm, sz);
    fileRow.append(ic, meta);
    item.appendChild(fileRow);
    foot.appendChild(textBtn(e.hasBlob ? 'Enregistrer' : 'Télécharger', 'primary-ghost', (ev) => download(e, ev.currentTarget)));
  }

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  foot.appendChild(spacer);
  foot.appendChild(iconBtn(e.fav ? '★' : '☆', e.fav ? 'Retirer des favoris' : 'Ajouter aux favoris', 'fav' + (e.fav ? ' on' : ''), () => toggleFav(e)));
  foot.appendChild(iconBtn('🗑', 'Supprimer', 'del', () => removeEntry(e)));
  item.appendChild(foot);

  row.appendChild(item);
  attachSwipe(row, item, e);
  return row;
}

async function imageUrl(e) {
  if (imgURLs.has(e.id)) return imgURLs.get(e.id);
  const rec = await db.getBlob(e.id);
  if (!rec?.buf) return null;
  const url = URL.createObjectURL(new Blob([rec.buf], { type: rec.mime || 'image/png' }));
  imgURLs.set(e.id, url);
  return url;
}

async function download(entry, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Récupération…';
  const bytes = await getBytes(entry);
  btn.disabled = false;
  btn.textContent = label;
  if (!bytes) { toast('Indisponible — le fichier a expiré sur le relais'); return; }

  const url = URL.createObjectURL(new Blob([bytes], { type: entry.mime || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = entry.filename || 'fichier';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  renderList();
}

// Glissement : vers la droite = favori, vers la gauche = supprimer. Relâcher
// au-delà du seuil déclenche, en deçà ça revient en place.
function attachSwipe(row, item, entry) {
  let pointer = null, x0 = 0, y0 = 0, dx = 0, axis = null, active = false;

  const move = (v) => { item.style.transform = v ? `translateX(${v}px)` : ''; };
  const reset = () => {
    item.style.transition = '';
    move(0);
    row.classList.remove('armed-fav', 'armed-del', 'dir-right', 'dir-left');
    dx = 0; axis = null; pointer = null;
  };

  item.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ev.target.closest('button, a, input')) return;
    pointer = ev.pointerId; x0 = ev.clientX; y0 = ev.clientY;
    dx = 0; axis = null; active = true;
    item.style.transition = 'none';
  });

  item.addEventListener('pointermove', (ev) => {
    if (!active || ev.pointerId !== pointer) return;
    const mx = ev.clientX - x0;
    const my = ev.clientY - y0;
    if (!axis) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) >= Math.abs(mx)) { active = false; reset(); return; } // c'est un défilement
      axis = 'x';
      try { item.setPointerCapture(pointer); } catch {}
    }
    // Résistance passé le seuil : on sent que l'action est armée.
    dx = Math.abs(mx) > SWIPE_TRIGGER
      ? Math.sign(mx) * (SWIPE_TRIGGER + (Math.abs(mx) - SWIPE_TRIGGER) * 0.35)
      : mx;
    move(dx);
    // La couleur découverte dépend du sens ; l'état « armé » dit que ça part.
    row.classList.toggle('dir-right', dx > 0);
    row.classList.toggle('dir-left', dx < 0);
    row.classList.toggle('armed-fav', dx > SWIPE_TRIGGER);
    row.classList.toggle('armed-del', dx < -SWIPE_TRIGGER);
  });

  const finish = (ev) => {
    if (!active || (pointer !== null && ev.pointerId !== pointer)) return;
    active = false;
    const fired = dx > SWIPE_TRIGGER ? 'fav' : dx < -SWIPE_TRIGGER ? 'del' : null;
    reset();
    if (fired === 'fav') toggleFav(entry);
    else if (fired === 'del') removeEntry(entry);
  };
  item.addEventListener('pointerup', finish);
  item.addEventListener('pointercancel', () => { active = false; reset(); });
}

// --- Envoi ------------------------------------------------------------------

function showProgress(name, frac) {
  $('#progress').hidden = false;
  $('#progressLabel').textContent = name;
  $('#progressBar').style.width = Math.round(frac * 100) + '%';
}
function hideProgress() { $('#progress').hidden = true; $('#progressBar').style.width = '0%'; }

// Upload des octets (déjà chiffrés) via XHR pour avoir la progression.
function uploadBlob(bytes, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', httpBase + '/files');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-account-id', acct);
    xhr.setRequestHeader('x-token', token);
    xhr.setRequestHeader('x-file-type', 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => { try { resolve((JSON.parse(xhr.responseText) || {}).fileId || null); } catch { resolve(null); } };
    xhr.onerror = () => resolve(null);
    xhr.send(bytes);
  });
}

async function postClip(payload) {
  try {
    const res = await fetch(httpBase + '/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account-id': acct, 'x-token': token },
      body: JSON.stringify({ ...payload, deviceName: env.deviceName, deviceId: env.deviceId }),
    });
    if (res.status === 401) { toast('Phrase incorrecte'); return null; }
    return await res.json().catch(() => ({}));
  } catch { toast('Serveur injoignable'); return null; }
}

function targetLabel(target) {
  if (target === 'all') return 'tous';
  return deviceList.find((d) => d.deviceId === target)?.name || 'un appareil';
}

function toastDelivery(res) {
  if (!res) return;
  const bits = [];
  if (res.delivered) bits.push(`${res.delivered} appareil${res.delivered > 1 ? 's' : ''}`);
  if (res.queued) bits.push(`${res.queued} en attente`);
  toast(bits.length ? `Envoyé → ${bits.join(' + ')} ✓` : 'Aucun appareil connu pour l’instant');
}

async function sendText(text, target = 'all') {
  if (!text) { toast('Rien à envoyer'); return; }
  if (!token) await ensureKeys();
  const res = await postClip({
    contentType: 'text',
    text: await encryptText(key, text),
    enc: 'v1',
    targets: target === 'all' ? 'all' : [target],
  });
  await addEntry({ dir: 'out', kind: 'text', text, peer: targetLabel(target) });
  toastDelivery(res);
}

// `contentType` distingue la source : le presse-papiers voyage en « image »
// (le PC le recolle directement), le sélecteur de fichiers en « file » (le PC
// l'enregistre). L'affichage, lui, ne regarde que le type MIME.
async function sendBinary(blob, filename, contentType, target = 'all') {
  if (!blob) { toast('Rien à envoyer'); return; }
  if (blob.size > MAX_FILE) { toast(`Trop lourd : ${filename} (max 100 Mo)`); return; }
  if (!token) await ensureKeys();

  const mime = blob.type || guessMime(filename) || 'application/octet-stream';
  const raw = new Uint8Array(await blob.arrayBuffer());
  const enc = await encryptBytes(key, raw);

  showProgress(filename, 0);
  const fileId = await uploadBlob(enc, (p) => showProgress(filename, p));
  hideProgress();
  if (!fileId) { toast('Échec de l’envoi : ' + filename); return; }

  const res = await postClip({
    contentType, fileId, fileType: mime, enc: 'v1',
    meta: { filename, size: blob.size },
    targets: target === 'all' ? 'all' : [target],
  });
  const entry = await addEntry({
    dir: 'out', kind: mime.startsWith('image/') ? 'image' : 'file',
    filename, size: blob.size, mime, fileId, enc: 'v1', peer: targetLabel(target),
  });
  await saveBytes(entry, raw); // pour pouvoir le retélécharger depuis l'historique
  renderList();
  toastDelivery(res);
}

$('#send').onclick = async () => {
  if (!env.phrase) { openSettings(); return; }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find((t) => t.startsWith('image/'));
      if (imgType) {
        const blob = await item.getType(imgType);
        await sendBinary(blob, 'presse-papiers.' + (imgType.split('/')[1] || 'png'), 'image');
        return;
      }
    }
    for (const item of items) {
      if (item.types.includes('text/plain')) {
        const txt = await (await item.getType('text/plain')).text();
        if (txt) { await sendText(txt); return; }
      }
    }
    toast('Presse-papiers vide');
    return;
  } catch { /* read() indisponible → readText */ }

  try {
    const txt = await navigator.clipboard.readText();
    if (txt) { await sendText(txt); return; }
    toast('Presse-papiers vide');
  } catch {
    toast('Réessaie (touche « Coller »), ou passe par « Fichier »');
  }
};

$('#sendFiles').onclick = () => { if (!env.phrase) { openSettings(); return; } $('#fileInput').click(); };
$('#fileInput').onchange = async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const hidden = new Set(env.hidden);
  const candidates = deviceList.filter((d) => !hidden.has(d.deviceId));
  if (candidates.length <= 1) {
    for (const f of files) await sendBinary(f, f.name, 'file', 'all');
  } else {
    openTargetPicker(files, candidates);
  }
};

function openTargetPicker(files, candidates) {
  const list = $('#targetList');
  list.replaceChildren();
  const add = (label, sub, value) => {
    const b = document.createElement('button');
    b.className = 'target-opt';
    b.type = 'button';
    const n = document.createElement('span'); n.className = 't-name'; n.textContent = label;
    const s = document.createElement('span'); s.className = 't-sub'; s.textContent = sub;
    b.append(n, s);
    b.onclick = async () => {
      $('#targetPicker').close();
      for (const f of files) await sendBinary(f, f.name, 'file', value);
    };
    list.appendChild(b);
  };
  const online = candidates.filter((d) => d.online).length;
  $('#targetTitle').textContent = `Envoyer ${files.length > 1 ? files.length + ' fichiers' : files[0].name} à`;
  add('Tous les appareils', `${online}/${candidates.length} en ligne`, 'all');
  for (const d of candidates) {
    add(d.name, d.online ? d.platform : 'hors ligne — livré à sa reconnexion', d.deviceId);
  }
  $('#targetPicker').showModal();
}
$('#targetCancel').onclick = () => $('#targetPicker').close();

// --- Onglets et recherche ---------------------------------------------------

for (const btn of document.querySelectorAll('.tab')) {
  btn.onclick = () => {
    tab = btn.dataset.tab;
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('is-on', b === btn);
    renderList();
  };
}

$('#searchBtn').onclick = () => {
  const input = $('#histSearch');
  input.hidden = !input.hidden;
  if (input.hidden) { query = ''; input.value = ''; renderList(); }
  else input.focus();
};
$('#histSearch').addEventListener('input', (e) => { query = e.target.value; renderList(); });

// --- Confirmation générique -------------------------------------------------

function askConfirm(title, body, okLabel = 'Supprimer') {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    $('#confirmYes').textContent = okLabel;
    const close = (val) => { dlg.close(); resolve(val); };
    $('#confirmYes').onclick = () => close(true);
    $('#confirmNo').onclick = () => close(false);
    dlg.addEventListener('cancel', () => resolve(false), { once: true });
    dlg.showModal();
  });
}

// --- Appareils (dans les réglages) ------------------------------------------

function renderDevices() {
  const el = $('#cfgDevices');
  if (!el) return;
  const hiddenIds = new Set(env.hidden);
  const list = deviceList.filter((d) => !hiddenIds.has(d.deviceId));

  el.replaceChildren();
  const self = document.createElement('div');
  self.className = 'device self';
  self.append(
    Object.assign(document.createElement('span'), { className: 'dot on' }),
    Object.assign(document.createElement('span'), { className: 'name', textContent: env.deviceName }),
    Object.assign(document.createElement('span'), { className: 'plat', textContent: 'cet appareil' }),
  );
  el.appendChild(self);

  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'device';
    row.append(
      Object.assign(document.createElement('span'), { className: 'dot ' + (d.online ? 'on' : 'off') }),
      Object.assign(document.createElement('span'), { className: 'name', textContent: d.name || '?' }),
      Object.assign(document.createElement('span'), {
        className: 'plat',
        textContent: d.online ? (d.platform || '') : (d.queued ? `${d.queued} en attente` : 'hors ligne'),
      }),
    );
    row.appendChild(iconBtn('✕', `Supprimer ${d.name}`, 'del', () => removeDevice(d)));
    el.appendChild(row);
  }
  if (!list.length) {
    el.appendChild(Object.assign(document.createElement('div'), {
      className: 'note', textContent: 'Aucun autre appareil sur cette phrase.',
    }));
  }

  const unhide = $('#cfgUnhide');
  unhide.hidden = !env.hidden.length;
  unhide.textContent = `Réafficher ${env.hidden.length} appareil${env.hidden.length > 1 ? 's' : ''} masqué${env.hidden.length > 1 ? 's' : ''}`;
}

async function removeDevice(d) {
  const ok = await askConfirm(
    'Supprimer cet appareil ?',
    `${d.name} est retiré de la liste partagée. S'il tourne encore avec la même phrase il se reconnectera, mais restera masqué ici.`,
  );
  if (!ok) return;
  wsSend({ type: 'remove-device', deviceId: d.deviceId });
  env.hidden = [...new Set([...env.hidden, d.deviceId])];
  saveEnvs();
  deviceList = deviceList.filter((x) => x.deviceId !== d.deviceId);
  renderDevices();
  refreshStatusSub();
  toast('Appareil supprimé');
}

$('#cfgUnhide').onclick = () => {
  env.hidden = [];
  saveEnvs();
  wsSend({ type: 'list-devices' });
  renderDevices();
  refreshStatusSub();
};

// --- Environnements (bascule, création, suppression) ------------------------

function renderEnvName() {
  $('#envName').textContent = env.name || 'ClipSync';
}

function envRow(e, { withDelete }) {
  const row = document.createElement('div');
  row.className = 'env-row' + (e.id === env.id ? ' is-on' : '');
  const b = document.createElement('button');
  b.className = 'env-pick';
  b.type = 'button';
  const n = document.createElement('span'); n.className = 'e-name'; n.textContent = e.name;
  const s = document.createElement('span'); s.className = 'e-sub';
  s.textContent = e.id === env.id ? 'actif' : e.phrase ? 'prêt' : 'phrase manquante';
  b.append(n, s);
  b.onclick = () => switchEnv(e.id);
  row.appendChild(b);
  if (withDelete && envs.length > 1) {
    row.appendChild(iconBtn('✕', `Supprimer ${e.name}`, 'del', () => deleteEnv(e)));
  }
  return row;
}

function renderEnvs() {
  const inSettings = $('#cfgEnvs');
  if (inSettings) inSettings.replaceChildren(...envs.map((e) => envRow(e, { withDelete: true })));
  const inPicker = $('#envList');
  if (inPicker) inPicker.replaceChildren(...envs.map((e) => envRow(e, { withDelete: false })));
}

async function switchEnv(id) {
  $('#envPicker').close();
  if (id === env.id) return;
  const next = envs.find((e) => e.id === id);
  if (!next) return;
  env = next;
  saveEnvs();
  for (const id of [...imgURLs.keys()]) forgetUrl(id);
  deviceList = [];
  renderEnvName();
  renderEnvs();
  renderDevices();
  await reloadEntries();
  await connect();
  toast('Environnement : ' + env.name);
}

async function deleteEnv(target) {
  const ok = await askConfirm(
    `Supprimer « ${target.name} » ?`,
    'Son historique et ses favoris sont effacés de cet appareil. Les autres appareils ne sont pas touchés.',
  );
  if (!ok) return;
  await db.deleteEnv(target.id);
  envs = envs.filter((e) => e.id !== target.id);
  if (!envs.length) envs = [newEnv('Principal')];
  if (target.id === env.id) {
    env = envs[0];
    renderEnvName();
    await reloadEntries();
    await connect();
  }
  saveEnvs();
  renderEnvs();
  toast('Environnement supprimé');
}

$('#envBtn').onclick = () => { renderEnvs(); $('#envPicker').showModal(); };
$('#envCancel').onclick = () => $('#envPicker').close();

function openEnvEditor() {
  $('#newEnvName').value = '';
  $('#newEnvPhrase').value = '';
  $('#envEdit').showModal();
  $('#newEnvName').focus();
}
$('#envAdd').onclick = () => { $('#envPicker').close(); openEnvEditor(); };
$('#cfgAddEnv').onclick = () => openEnvEditor();
$('#newEnvCancel').onclick = () => $('#envEdit').close();
$('#newEnvSave').onclick = async () => {
  const name = $('#newEnvName').value.trim() || 'Environnement';
  const phrase = $('#newEnvPhrase').value;
  if (!phrase) { toast('Il faut une phrase de couplage'); return; }
  const e = newEnv(name, phrase);
  envs.push(e);
  $('#envEdit').close();
  await switchEnv(e.id);
};

// --- Réglages ---------------------------------------------------------------

async function storageNote() {
  const all = await db.allEntries();
  const used = all.filter((e) => e.hasBlob).reduce((n, e) => n + (e.size || 0), 0);
  const favs = entries.filter((e) => e.fav).length;
  $('#cfgStorage').textContent =
    `Purge automatique après 23 h 59 — les favoris restent (${favs}/${MAX_FAV}). ` +
    `Fichiers gardés sur cet appareil : ${fmtSize(used)} / ${fmtSize(BLOB_CAP)}.`;
}

function openSettings() {
  $('#cfgEnvName').value = env.name || '';
  $('#cfgPhrase').value = env.phrase || '';
  $('#cfgName').value = env.deviceName || '';
  renderDevices();
  renderEnvs();
  storageNote();
  $('#settings').showModal();
}
$('#settingsBtn').onclick = openSettings;
$('#cfgClose').onclick = () => $('#settings').close();

$('#cfgSave').onclick = async () => {
  const phrase = $('#cfgPhrase').value;
  const changed = phrase !== env.phrase || $('#cfgName').value.trim() !== env.deviceName;
  env.name = $('#cfgEnvName').value.trim() || env.name || 'Principal';
  env.phrase = phrase;
  env.deviceName = $('#cfgName').value.trim() || detectDeviceName();
  saveEnvs();
  renderEnvName();
  $('#settings').close();
  if (changed) await connect();
};

$('#cfgClear').onclick = async () => {
  const ok = await askConfirm(
    'Vider l’historique ?',
    'Tout est effacé sur cet appareil sauf les favoris.',
    'Vider',
  );
  if (!ok) return;
  await db.clearHistory(env.id, true);
  await reloadEntries();
  storageNote();
  toast('Historique vidé');
};

// --- Reprise de l'ancien historique (localStorage) --------------------------

async function migrateLegacyHistory() {
  let old = null;
  try { old = JSON.parse(localStorage.getItem('clipsync.hist')); } catch {}
  localStorage.removeItem('clipsync.hist');
  localStorage.removeItem('clipsync.cfg');
  if (!Array.isArray(old) || !old.length) return;

  for (const o of old) {
    const entry = {
      id: uid(), env: env.id, ts: o.ts || Date.now(),
      dir: o.dir === 'out' ? 'out' : 'in',
      kind: o.img ? 'image' : o.kind === 'file' ? 'file' : 'text',
      peer: o.peer, text: o.text, filename: o.filename, size: o.size ?? null,
      mime: o.img ? 'image/png' : guessMime(o.filename) || 'application/octet-stream',
      fav: false, hasBlob: false,
    };
    await db.putEntry(entry);
    if (o.img) {
      try {
        const buf = await (await fetch(o.img)).arrayBuffer();
        await db.putBlob(entry.id, buf, 'image/png');
        entry.hasBlob = true;
        entry.size = buf.byteLength;
        await db.putEntry(entry);
      } catch { /* image illisible : la fiche reste */ }
    }
  }
}

// --- Démarrage --------------------------------------------------------------

(async function start() {
  renderEnvName();
  navigator.storage?.persist?.().catch(() => {});

  if (localStorage.getItem('clipsync.hist') || localStorage.getItem('clipsync.cfg')) {
    await migrateLegacyHistory().catch(() => {});
  }
  await reloadEntries();
  await purgeOld();

  setInterval(purgeOld, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) purgeOld(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  connect();
})();
