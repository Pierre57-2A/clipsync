import { authToken, encKey, accountId, encryptText, encryptBytes, decryptText, decryptBytes } from '/crypto.js';
import * as db from '/db.js';

const $ = (s) => document.querySelector(s);

// --- Réglages du comportement ----------------------------------------------

const CFG_KEY = 'clipsync.config';
const NEWS_KEY = 'clipsync.v2-vu';

// 7 jours glissants : chaque élément part 7 jours après son arrivée. Le relais
// garde les fichiers aussi longtemps, pour qu'une image de la veille s'ouvre.
const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 7 * DAY;

// Place que l'historique s'autorise sur l'appareil. Au-delà, les octets des
// éléments les plus anciens sont libérés : la fiche reste, le fichier redevient
// téléchargeable depuis le relais tant qu'il y est.
const BLOB_CAP = 300 * 1024 * 1024;

// Une image se pré-charge pour afficher sa vignette ; au-delà de cette taille
// on attend que l'utilisateur la demande.
const AUTO_IMG_MAX = 12 * 1024 * 1024;

const MAX_FILE = 100 * 1024 * 1024;
const SWIPE_TRIGGER = 88;

// Le client Windows envoie parfois la même copie 2 à 5 fois en une seconde :
// le même contenu, du même appareil, dans cette fenêtre, compte pour un seul
// élément (badge « ×3 »).
const DUP_WINDOW = 15_000;

// --- Configuration : une phrase, un appareil --------------------------------

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

const freshConfig = (phrase = '') => ({ phrase, deviceId: 'web-' + rand(10), deviceName: detectDeviceName(), hidden: [] });

// Passage à la v2 : les environnements disparaissent. On garde l'actif (c'est
// lui qui parle aux PC), avec son identifiant d'appareil pour que les autres le
// reconnaissent ; les autres et leur historique sont effacés.
function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY)); } catch {}
  if (cfg && cfg.deviceId) {
    if (!Array.isArray(cfg.hidden)) cfg.hidden = [];
    return { cfg, report: null, keepEnvId: null };
  }

  let envs = [];
  try { envs = JSON.parse(localStorage.getItem('clipsync.envs')) || []; } catch {}
  if (!Array.isArray(envs)) envs = [];
  envs = envs.filter((e) => e && e.id);
  const activeId = localStorage.getItem('clipsync.env');
  const keep = envs.find((e) => e.id === activeId && e.phrase) ?? envs.find((e) => e.phrase) ?? envs[0] ?? null;

  if (keep) {
    cfg = {
      phrase: keep.phrase || '',
      deviceId: keep.deviceId || freshConfig().deviceId,
      deviceName: keep.deviceName || detectDeviceName(),
      hidden: Array.isArray(keep.hidden) ? keep.hidden : [],
    };
  } else {
    // Config d'avant les environnements.
    let old = null;
    try { old = JSON.parse(localStorage.getItem('clipsync.cfg')); } catch {}
    cfg = freshConfig(old?.phrase || '');
    if (old?.deviceId) cfg.deviceId = old.deviceId;
    if (old?.deviceName) cfg.deviceName = old.deviceName;
  }
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  for (const k of ['clipsync.envs', 'clipsync.env', 'clipsync.cfg', 'clipsync.hist']) localStorage.removeItem(k);

  const report = envs.length ? { kept: keep, dropped: envs.filter((e) => e !== keep) } : null;
  return { cfg, report, keepEnvId: keep?.id ?? null };
}

const { cfg, report, keepEnvId } = loadConfig();
if (keepEnvId) db.keepOnlyEnv(keepEnvId);
const saveCfg = () => localStorage.setItem(CFG_KEY, JSON.stringify(cfg));

// --- État -------------------------------------------------------------------

let entries = [];
let deviceList = [];
let query = '';
let ws = null;
let key = null, token = null, acct = null;
let generation = 0; // invalide les sockets d'une phrase qu'on vient de changer
let fileTarget = 'all';

const wsURL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
const httpBase = location.origin;

// --- Petits utilitaires -----------------------------------------------------

const ICONS = {
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  laptop: '<rect width="18" height="12" x="3" y="4" rx="2"/><line x1="2" x2="22" y1="20" y2="20"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  down: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
};
const icon = (n, s = 16, w = 1.9) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const platIcon = (p) => (p === 'windows' ? 'monitor' : p === 'mac' ? 'laptop' : p === 'ios' || p === 'android' ? 'phone' : 'globe');

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function setStatus(text, online, sub = '') {
  $('#dot').className = 'dot ' + (online ? '' : 'off');
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

const hhmm = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' Ko';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
  return (n / 1024 / 1024 / 1024).toFixed(2).replace('.', ',') + ' Go';
}

// « part demain », « part dans 5 h »…
function fmtLeft(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return `part dans ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 24) return `part dans ${Math.max(1, Math.floor(h))} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'part demain' : `part dans ${d} j`;
}

function dayLabel(ts) {
  const today = new Date(new Date().toDateString());
  const diff = Math.round((today - new Date(new Date(ts).toDateString())) / DAY);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Hier';
  const s = new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' });
  return s[0].toUpperCase() + s.slice(1);
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

const isLink = (t) => /^https?:\/\/\S+$/i.test(String(t).trim());

// --- Connexion --------------------------------------------------------------

async function ensureKeys() {
  token = await authToken(cfg.phrase);
  key = await encKey(cfg.phrase);
  acct = await accountId(cfg.phrase);
}

async function connect() {
  const mine = ++generation;
  try { ws?.close(); } catch {}
  ws = null;

  if (!cfg.phrase) { setStatus('À configurer', false); openSettings(); return; }

  setStatus('Connexion…', false);
  await ensureKeys();
  if (mine !== generation) return;

  const sock = new WebSocket(wsURL);
  ws = sock;
  sock.onopen = () => {
    if (mine !== generation) { try { sock.close(); } catch {} return; }
    sock.send(JSON.stringify({
      type: 'hello', accountId: acct, token,
      deviceId: cfg.deviceId, deviceName: cfg.deviceName, platform: detectPlatform(),
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
    case 'applied': toast(`Collé sur ${msg.by?.name || 'le PC'}`); break;
    case 'removed': toast('Cet appareil a été retiré depuis un autre'); break;
    case 'error': toast('Erreur : ' + msg.message); break;
  }
}

const visibleDevices = () => {
  const hidden = new Set(cfg.hidden);
  return deviceList.filter((d) => !hidden.has(d.deviceId));
};

function refreshStatusSub() {
  const list = visibleDevices();
  const online = list.filter((d) => d.online).length;
  const sub = !list.length ? 'aucun autre appareil'
    : online ? `${online} appareil${online > 1 ? 's' : ''} en ligne` : 'tes appareils sont hors ligne';
  setStatus($('#statusText').textContent, !$('#dot').classList.contains('off'), sub);
}

// --- Réception --------------------------------------------------------------

// Ce qui permet de reconnaître deux envois identiques sans comparer les octets.
function signature(e) {
  if (e.kind === 'text') return 't:' + e.text;
  if (!e.dims && e.size == null) return null; // trop peu d'indices pour être sûr
  return `${e.kind}:${e.dims || ''}:${e.size ?? ''}:${e.filename || ''}`;
}

async function mergeDuplicate(candidate, messageId) {
  const sig = signature(candidate);
  if (!sig) return false;
  const last = entries.find((e) => e.dir === 'in' && e.peer === candidate.peer);
  if (!last || signature(last) !== sig) return false;
  if (Math.abs(candidate.ts - (last.lastTs || last.ts)) > DUP_WINDOW) return false;
  last.dup = (last.dup || 1) + 1;
  last.lastTs = candidate.ts;
  if (messageId) last.dupIds = [...(last.dupIds || []), messageId];
  await db.putEntry(last);
  renderList();
  document.querySelector(`[data-dup="${last.id}"]`)?.classList.add('pop');
  return true;
}

async function onClip(msg) {
  // Un clip rejoué depuis la file d'attente ne doit pas apparaître deux fois.
  if (msg.messageId && entries.some((e) => e.msgId === msg.messageId || e.dupIds?.includes(msg.messageId))) return;

  const peer = msg.from?.name || 'un appareil';
  const plat = deviceList.find((d) => d.deviceId === msg.from?.deviceId)?.platform || null;
  const ts = msg.ts || Date.now();

  if (msg.contentType === 'text') {
    const text = msg.enc === 'v1' ? await decryptText(key, msg.text) : msg.text;
    if (text == null) return;
    const entry = { dir: 'in', kind: 'text', peer, plat, ts, text, msgId: msg.messageId };
    if (await mergeDuplicate(entry, msg.messageId)) return;
    await addEntry(entry, true);
    if (!msg.queued) toast('Texte reçu de ' + peer);
    return;
  }
  if (!msg.fileId) return;

  const filename = msg.meta?.filename || (msg.contentType === 'image' ? 'image.png' : 'fichier');
  let mime = msg.fileType && msg.fileType !== 'application/octet-stream' ? msg.fileType : guessMime(filename);
  if (!mime) mime = msg.contentType === 'image' ? 'image/png' : 'application/octet-stream';
  const dims = msg.meta?.width && msg.meta?.height ? `${msg.meta.width}x${msg.meta.height}` : null;

  // Le type réel décide de l'affichage : une image envoyée « en fichier »
  // s'affiche quand même en vignette.
  const partial = {
    dir: 'in', peer, plat, ts, msgId: msg.messageId,
    kind: mime.startsWith('image/') ? 'image' : 'file',
    filename, size: msg.meta?.size ?? null, dims, mime,
    fileId: msg.fileId, enc: msg.enc,
  };
  if (await mergeDuplicate(partial, msg.messageId)) return;
  const entry = await addEntry(partial, true);
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

const freshIds = new Set();

async function addEntry(partial, fresh = false) {
  const entry = { id: uid(), ts: Date.now(), hasBlob: false, ...partial };
  await db.putEntry(entry);
  entries.push(entry);
  entries.sort((a, b) => b.ts - a.ts); // un rejeu peut être plus vieux que l'existant
  if (fresh) freshIds.add(entry.id);
  renderAll();
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
  entries = await db.allEntries();
  forgetOrphanUrls();
  renderAll();
}

async function removeEntry(entry) {
  forgetUrl(entry.id);
  await db.deleteEntry(entry.id);
  entries = entries.filter((e) => e.id !== entry.id);
  renderAll();
  toast('Supprimé');
}

async function purgeOld() {
  if (await db.purgeBefore(Date.now() - KEEP_MS)) await reloadEntries();
  else renderAll(); // les « part dans … » avancent
}

// --- Rendu ------------------------------------------------------------------

function renderAll() {
  renderRetention();
  renderList();
}

function renderRetention() {
  const counts = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY).toDateString();
    counts.push({
      i,
      n: entries.filter((e) => new Date(e.ts).toDateString() === day).length,
      lbl: i === 0 ? 'auj.' : new Date(Date.now() - i * DAY).toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', ''),
    });
  }
  const max = Math.max(4, ...counts.map((c) => c.n));
  const stored = entries.filter((e) => e.hasBlob).reduce((n, e) => n + (e.size || 0), 0);
  $('#ret').innerHTML = `
    <div class="card-h"><b>7 jours d'historique</b><small>${entries.length} élément${entries.length > 1 ? 's' : ''}${stored ? ' · ' + fmtSize(stored) : ''}</small></div>
    <div class="cols">${counts.map((c) => `<div class="col ${c.i === 0 ? 'today' : c.i === 6 ? 'old' : ''}"><i style="height:${Math.max(7, (c.n / max) * 100)}%"></i><span>${c.lbl}</span></div>`).join('')}</div>
    <p class="hint">${icon('clock', 15)}<span>Chaque jour, la journée la plus ancienne (en orange) part toute seule.</span></p>`;
  $('#histCount').textContent = entries.length ? String(entries.length) : '';
}

function searchText(e) {
  return [e.text, e.filename, e.peer, e.kind === 'image' ? 'image' : e.kind === 'file' ? 'fichier' : 'texte']
    .filter(Boolean).join(' ').toLowerCase();
}

function renderList() {
  const box = $('#list');
  const q = query.trim().toLowerCase();
  const list = q ? entries.filter((e) => searchText(e).includes(q)) : entries;
  if (!list.length) {
    box.replaceChildren(el('div', 'empty', q ? 'Aucun résultat.' : 'Rien pour l’instant. Copie du texte, puis touche « Envoyer le presse-papiers ».'));
    return;
  }
  const frag = document.createDocumentFragment();
  let day = null;
  for (const e of list) {
    const k = new Date(e.ts).toDateString();
    if (k !== day) {
      day = k;
      const group = list.filter((x) => new Date(x.ts).toDateString() === k);
      const soonest = Math.min(...group.map((x) => x.ts + KEEP_MS - Date.now()));
      const h = el('div', 'day');
      h.append(el('b', '', dayLabel(e.ts)), el('small', '', String(group.length)));
      if (soonest < 2 * DAY) h.append(el('span', 'exp', fmtLeft(soonest)));
      frag.appendChild(h);
    }
    frag.appendChild(renderRow(e));
  }
  box.replaceChildren(frag);
  freshIds.clear();
}

function actionBtn(cls, html, label, onClick) {
  const b = el('button', 'cb ' + cls, html);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.onclick = onClick;
  return b;
}

function renderRow(e) {
  const wrap = el('div', 'row-sw');
  wrap.appendChild(el('div', 'act-del', 'Supprimer'));
  const item = el('article', 'clip' + (freshIds.has(e.id) ? ' fresh' : ''));

  const head = el('div', 'ch');
  if (e.dir === 'in') {
    head.append(el('span', 'di', icon(platIcon(e.plat), 13)), el('b', '', ''));
    head.lastChild.textContent = e.peer || 'un appareil';
  } else {
    head.append(el('span', 'di me', icon('phone', 13)), el('b', '', 'Toi'), el('span', 'to', ''));
    head.lastChild.textContent = '→ ' + (e.peer || 'tous');
  }
  head.appendChild(el('time', '', hhmm(e.ts)));
  if (e.dup > 1) {
    const d = el('span', 'dup', icon('layers', 11, 2.2) + '×' + e.dup);
    d.dataset.dup = e.id;
    d.title = `Envoyé ${e.dup} fois, gardé une fois`;
    head.appendChild(d);
  }
  item.appendChild(head);

  const foot = el('div', 'cf');
  if (e.kind === 'text') {
    const body = el('div', 'txt' + (isLink(e.text) ? ' link' : ''));
    body.textContent = e.text;
    body.onclick = () => body.classList.toggle('open');
    item.appendChild(body);
    foot.appendChild(actionBtn('pri', icon('copy', 14, 2.2) + 'Copier', null, async () => {
      try { await navigator.clipboard.writeText(e.text); toast('Copié'); }
      catch { toast('Touche « Copier » à nouveau'); }
    }));
    if (isLink(e.text)) foot.appendChild(actionBtn('', icon('open', 14, 2.2) + 'Ouvrir', null, () => window.open(e.text.trim(), '_blank', 'noopener')));
  } else if (e.kind === 'image') {
    const cached = imgURLs.get(e.id);
    if (cached || e.hasBlob) {
      const img = el('img', 'thumb');
      img.loading = 'lazy';
      img.alt = e.filename || 'image';
      if (cached) img.src = cached;
      else imageUrl(e).then((u) => { if (u) img.src = u; });
      item.appendChild(img);
    } else {
      // Image trop lourde pour être pré-chargée, ou octets déjà évincés.
      const ph = el('button', 'ph', icon('image', 18) + `<span>Afficher l’image${e.size ? ' · ' + fmtSize(e.size) : ''}</span>`);
      ph.type = 'button';
      ph.onclick = async () => {
        ph.disabled = true; ph.lastChild.textContent = 'Chargement…';
        const bytes = await fetchBytes(e);
        if (!bytes) { ph.disabled = false; ph.lastChild.textContent = 'Indisponible : expiré sur le relais'; return; }
        renderList();
      };
      item.appendChild(ph);
    }
    foot.appendChild(actionBtn('pri', icon('down', 14, 2.2) + (e.hasBlob ? 'Enregistrer' : 'Télécharger'), null, (ev) => download(e, ev.currentTarget)));
  } else {
    const row = el('div', 'file');
    const meta = el('span', 'fm');
    const nm = el('b');
    nm.textContent = e.filename || 'fichier';
    meta.append(nm, el('small', '', [fmtSize(e.size), e.hasBlob ? 'sur cet appareil' : e.fileId ? 'sur le relais' : ''].filter(Boolean).join(' · ')));
    row.append(el('span', 'fi', icon('file', 19)), meta);
    item.appendChild(row);
    foot.appendChild(actionBtn('pri', icon('down', 14, 2.2) + (e.hasBlob ? 'Enregistrer' : 'Télécharger'), null, (ev) => download(e, ev.currentTarget)));
  }
  foot.appendChild(actionBtn('ic', icon('trash', 15), 'Supprimer', () => removeEntry(e)));
  const left = e.ts + KEEP_MS - Date.now();
  if (left < 2 * DAY) foot.appendChild(el('span', 'meta soon', fmtLeft(left)));
  item.appendChild(foot);

  wrap.appendChild(item);
  attachSwipe(wrap, item, e);
  return wrap;
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
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Récupération…';
  const bytes = await getBytes(entry);
  btn.disabled = false;
  btn.innerHTML = label;
  if (!bytes) { toast('Indisponible : le fichier a expiré sur le relais'); return; }

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

// Glisser vers la gauche = supprimer. Relâcher au-delà du seuil déclenche, en
// deçà ça revient en place.
function attachSwipe(wrap, item, entry) {
  let pointer = null, x0 = 0, y0 = 0, dx = 0, axis = null, active = false;

  const move = (v) => { item.style.transform = v ? `translateX(${v}px)` : ''; };
  const reset = () => {
    item.style.transition = '';
    move(0);
    wrap.classList.remove('armed-del', 'dir-left');
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
    const mx = Math.min(0, ev.clientX - x0);
    const my = ev.clientY - y0;
    if (!axis) {
      if (Math.abs(ev.clientX - x0) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) >= Math.abs(ev.clientX - x0)) { active = false; reset(); return; } // c'est un défilement
      axis = 'x';
      try { item.setPointerCapture(pointer); } catch {}
    }
    // Résistance passé le seuil : on sent que l'action est armée.
    dx = -mx > SWIPE_TRIGGER ? -(SWIPE_TRIGGER + (-mx - SWIPE_TRIGGER) * 0.35) : mx;
    move(dx);
    wrap.classList.toggle('dir-left', dx < 0);
    wrap.classList.toggle('armed-del', dx < -SWIPE_TRIGGER);
  });

  const finish = (ev) => {
    if (!active || (pointer !== null && ev.pointerId !== pointer)) return;
    active = false;
    const fired = dx < -SWIPE_TRIGGER;
    reset();
    if (fired) removeEntry(entry);
  };
  item.addEventListener('pointerup', finish);
  item.addEventListener('pointercancel', () => { active = false; reset(); });
}

// --- Appareils ----------------------------------------------------------------

function renderDevices() {
  const list = visibleDevices();

  // Bandeau du haut : tes autres appareils, puis celui-ci.
  const chips = list.map((d) => {
    const b = el('button', 'dv' + (d.online ? '' : ' off'), `<span class="di">${icon(platIcon(d.platform), 15)}<span class="dot ${d.online ? '' : 'off'}"></span></span>`);
    b.type = 'button';
    b.appendChild(document.createTextNode(d.name || '?'));
    b.onclick = () => openDevice(d);
    return b;
  });
  const me = el('button', 'dv me', `<span class="di">${icon(platIcon(detectPlatform()), 15)}</span>`);
  me.type = 'button';
  me.append(document.createTextNode(cfg.deviceName), el('small', '', '· toi'));
  me.onclick = () => toast('C’est cet appareil');
  $('#devs').replaceChildren(...chips, me);

  // Réglages : la liste avec « Oublier ».
  const box = $('#cfgDevices');
  box.replaceChildren();
  for (const d of list) {
    const row = el('div', 'row', `<span class="ri">${icon(platIcon(d.platform), 16)}<span class="dot ${d.online ? '' : 'off'}"></span></span>`);
    const m = el('span', 'rm');
    const n = el('b');
    n.textContent = d.name || '?';
    m.append(n, el('small', '', d.online ? 'en ligne' : d.queued ? `hors ligne · ${d.queued} en attente` : 'hors ligne'));
    const forget = el('button', 'ra', 'Oublier');
    forget.type = 'button';
    forget.onclick = () => removeDevice(d);
    row.append(m, forget);
    box.appendChild(row);
  }
  if (!list.length) box.appendChild(el('div', 'row', '<span class="rm"><small>Aucun autre appareil avec cette phrase.</small></span>'));

  const unhide = $('#cfgUnhide');
  unhide.hidden = !cfg.hidden.length;
  unhide.textContent = `Réafficher ${cfg.hidden.length} appareil${cfg.hidden.length > 1 ? 's' : ''} oublié${cfg.hidden.length > 1 ? 's' : ''}`;
}

function openDevice(d) {
  $('#devTitle').textContent = d.name || 'Appareil';
  const info = $('#devInfo');
  info.innerHTML = `<span class="ri">${icon(platIcon(d.platform), 16)}<span class="dot ${d.online ? '' : 'off'}"></span></span>`;
  const m = el('span', 'rm');
  const n = el('b');
  n.textContent = d.name || '?';
  m.append(n, el('small', '', d.online ? 'en ligne, reçoit tout de suite' : 'hors ligne, recevra à sa reconnexion'));
  info.appendChild(m);
  $('#devSend').textContent = `Envoyer le presse-papiers à ${d.name}`;
  $('#devSend').onclick = () => { $('#devSheet').close(); sendClipboard(d.deviceId).catch(sendFailed); };
  $('#devFile').onclick = () => { $('#devSheet').close(); fileTarget = d.deviceId; $('#fileInput').click(); };
  $('#devForget').onclick = () => { $('#devSheet').close(); removeDevice(d); };
  $('#devSheet').showModal();
}

async function removeDevice(d) {
  const ok = await askConfirm(
    `Oublier ${d.name} ?`,
    `Il disparaît de ta liste. S'il tourne encore avec la même phrase, il se reconnectera mais restera masqué ici.`,
    'Oublier',
  );
  if (!ok) return;
  wsSend({ type: 'remove-device', deviceId: d.deviceId });
  cfg.hidden = [...new Set([...cfg.hidden, d.deviceId])];
  saveCfg();
  deviceList = deviceList.filter((x) => x.deviceId !== d.deviceId);
  renderDevices();
  refreshStatusSub();
  toast('Appareil oublié');
}

$('#cfgUnhide').onclick = () => {
  cfg.hidden = [];
  saveCfg();
  wsSend({ type: 'list-devices' });
  renderDevices();
  refreshStatusSub();
};

// --- Envoi ------------------------------------------------------------------

function sending(label, frac) {
  $('#send').disabled = true;
  $('#sendLbl').textContent = label;
  $('#sendFill').style.transform = `scaleX(${frac})`;
}
function sendingDone() {
  $('#send').disabled = false;
  $('#sendLbl').textContent = 'Envoyer le presse-papiers';
  const f = $('#sendFill');
  f.style.transition = 'none';
  f.style.transform = 'scaleX(0)';
  requestAnimationFrame(() => { f.style.transition = ''; });
}

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
      body: JSON.stringify({ ...payload, deviceName: cfg.deviceName, deviceId: cfg.deviceId }),
    });
    if (res.status === 401) { toast('Phrase incorrecte'); return null; }
    return await res.json().catch(() => ({}));
  } catch { toast('Serveur injoignable'); return null; }
}

function targetLabel(target) {
  if (target === 'all') return 'tous';
  return deviceList.find((d) => d.deviceId === target)?.name || 'un appareil';
}

function toastDelivery(res, target) {
  if (!res) return;
  const bits = [];
  if (res.delivered) bits.push(target === 'all' ? `${res.delivered} appareil${res.delivered > 1 ? 's' : ''}` : targetLabel(target));
  if (res.queued) bits.push(`${res.queued} en attente`);
  toast(bits.length ? `Envoyé à ${bits.join(' + ')}` : 'Aucun appareil connu pour l’instant');
}

async function sendText(text, target = 'all') {
  if (!text) { toast('Rien à envoyer'); return; }
  if (!token) await ensureKeys();
  sending('Chiffrement…', 0.4);
  const res = await postClip({
    contentType: 'text',
    text: await encryptText(key, text),
    enc: 'v1',
    targets: target === 'all' ? 'all' : [target],
  });
  sending('Envoyé', 1);
  await addEntry({ dir: 'out', kind: 'text', text, peer: targetLabel(target) }, true);
  setTimeout(sendingDone, 350);
  toastDelivery(res, target);
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
  sending('Chiffrement…', 0.05);
  const enc = await encryptBytes(key, raw);

  const fileId = await uploadBlob(enc, (p) => sending(`Envoi · ${Math.round(p * 100)} %`, 0.05 + p * 0.9));
  if (!fileId) { sendingDone(); toast('Échec de l’envoi : ' + filename); return; }

  const res = await postClip({
    contentType, fileId, fileType: mime, enc: 'v1',
    meta: { filename, size: blob.size },
    targets: target === 'all' ? 'all' : [target],
  });
  sending('Envoyé', 1);
  const entry = await addEntry({
    dir: 'out', kind: mime.startsWith('image/') ? 'image' : 'file',
    filename, size: blob.size, mime, fileId, enc: 'v1', peer: targetLabel(target),
  }, true);
  await saveBytes(entry, raw); // pour pouvoir le retélécharger depuis l'historique
  renderList();
  setTimeout(sendingDone, 350);
  toastDelivery(res, target);
}

async function sendClipboard(target = 'all') {
  if (!cfg.phrase) { openSettings(); return; }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find((t) => t.startsWith('image/'));
      if (imgType) {
        const blob = await item.getType(imgType);
        await sendBinary(blob, 'presse-papiers.' + (imgType.split('/')[1] || 'png'), 'image', target);
        return;
      }
    }
    for (const item of items) {
      if (item.types.includes('text/plain')) {
        const txt = await (await item.getType('text/plain')).text();
        if (txt) { await sendText(txt, target); return; }
      }
    }
    toast('Presse-papiers vide');
    return;
  } catch { /* read() indisponible → readText */ }

  try {
    const txt = await navigator.clipboard.readText();
    if (txt) { await sendText(txt, target); return; }
    toast('Presse-papiers vide');
  } catch {
    toast('Réessaie (touche « Coller »), ou passe par le bouton fichier');
  }
}

function sendFailed() { sendingDone(); toast('Échec de l’envoi'); }

$('#send').onclick = () => sendClipboard('all').catch(sendFailed);

$('#sendFiles').onclick = () => { if (!cfg.phrase) { openSettings(); return; } fileTarget = 'all'; $('#fileInput').click(); };
$('#fileInput').onchange = async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const candidates = visibleDevices();
  if (fileTarget !== 'all' || candidates.length <= 1) {
    try { for (const f of files) await sendBinary(f, f.name, 'file', fileTarget); } catch { sendFailed(); }
  } else {
    openTargetPicker(files, candidates);
  }
};

function openTargetPicker(files, candidates) {
  const box = $('#targetList');
  box.replaceChildren();
  const add = (iconName, label, sub, value) => {
    const b = el('button', 'row', `<span class="ri">${icon(iconName, 16)}</span>`);
    b.type = 'button';
    const m = el('span', 'rm');
    const n = el('b');
    n.textContent = label;
    m.append(n, el('small', '', sub));
    b.appendChild(m);
    b.onclick = async () => {
      $('#targetPicker').close();
      try { for (const f of files) await sendBinary(f, f.name, 'file', value); } catch { sendFailed(); }
    };
    box.appendChild(b);
  };
  const online = candidates.filter((d) => d.online).length;
  $('#targetTitle').textContent = `Envoyer ${files.length > 1 ? files.length + ' fichiers' : files[0].name} à`;
  add('layers', 'Tous tes appareils', `${online} sur ${candidates.length} en ligne`, 'all');
  for (const d of candidates) add(platIcon(d.platform), d.name, d.online ? 'en ligne' : 'hors ligne, livré à sa reconnexion', d.deviceId);
  $('#targetPicker').showModal();
}

// --- Recherche ----------------------------------------------------------------

$('#searchBtn').onclick = () => {
  const input = $('#histSearch');
  input.hidden = !input.hidden;
  if (input.hidden) { query = ''; input.value = ''; renderList(); }
  else input.focus();
};
$('#histSearch').addEventListener('input', (e) => { query = e.target.value; renderList(); });

// --- Feuilles ---------------------------------------------------------------

for (const dlg of document.querySelectorAll('dialog.sheet')) {
  // Toucher le voile ferme la feuille.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  for (const b of dlg.querySelectorAll('[data-close]')) b.addEventListener('click', () => dlg.close());
}

function askConfirm(title, body, okLabel = 'Supprimer') {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    $('#confirmYes').textContent = okLabel;
    let answered = false;
    const close = (val) => { if (answered) return; answered = true; dlg.close(); resolve(val); };
    $('#confirmYes').onclick = () => close(true);
    $('#confirmNo').onclick = () => close(false);
    dlg.addEventListener('close', () => close(false), { once: true });
    dlg.showModal();
  });
}

// --- Réglages ---------------------------------------------------------------

function storageNote() {
  const used = entries.filter((e) => e.hasBlob).reduce((n, e) => n + (e.size || 0), 0);
  $('#cfgStoreLbl').textContent = `${used ? fmtSize(used) : '0 Mo'} sur 300 Mo`;
  $('#cfgStoreBar').style.width = Math.min(100, (used / BLOB_CAP) * 100) + '%';
}

function openSettings() {
  $('#cfgPhrase').value = cfg.phrase || '';
  $('#cfgPhrase').type = 'password';
  $('#cfgName').value = cfg.deviceName || '';
  renderDevices();
  storageNote();
  $('#settings').showModal();
}
$('#settingsBtn').onclick = openSettings;
$('#cfgClose').onclick = () => $('#settings').close();
$('#cfgEye').onclick = () => { const i = $('#cfgPhrase'); i.type = i.type === 'password' ? 'text' : 'password'; };

$('#cfgSave').onclick = async () => {
  const phrase = $('#cfgPhrase').value;
  const name = $('#cfgName').value.trim() || detectDeviceName();
  const changed = phrase !== cfg.phrase || name !== cfg.deviceName;
  cfg.phrase = phrase;
  cfg.deviceName = name;
  saveCfg();
  renderDevices();
  $('#settings').close();
  if (changed) await connect();
};

// Vider : il faut maintenir le bouton, pas de suppression sur un simple toucher.
$('#cfgClear').addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  const b = ev.currentTarget, fill = b.querySelector('.fill'), t0 = performance.now();
  let done = false, raf;
  fill.style.transition = 'none';
  const step = (now) => {
    const p = Math.min(1, (now - t0) / 900);
    fill.style.transform = `scaleX(${p})`;
    if (p < 1) { raf = requestAnimationFrame(step); return; }
    done = true;
    clearAll().then(() => { fill.style.transition = 'transform .25s'; fill.style.transform = 'scaleX(0)'; });
  };
  raf = requestAnimationFrame(step);
  const end = () => {
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    if (done) return;
    cancelAnimationFrame(raf);
    fill.style.transition = 'transform .25s';
    fill.style.transform = 'scaleX(0)';
    if (performance.now() - t0 < 300) toast('Maintiens le bouton enfoncé');
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
});

async function clearAll() {
  const n = entries.length;
  await db.clearHistory();
  for (const id of [...imgURLs.keys()]) forgetUrl(id);
  await reloadEntries();
  storageNote();
  toast(n ? `Historique vidé (${n} élément${n > 1 ? 's' : ''})` : 'Historique déjà vide');
}

// --- Nouveautés (une fois, après le passage à la v2) ------------------------

function showNews() {
  if (!report || localStorage.getItem(NEWS_KEY)) return;
  localStorage.setItem(NEWS_KEY, '1');
  const box = $('#newsList');
  box.replaceChildren();
  const add = (keep, title, sub) => {
    const r = el('div', 'row', `<span class="ri">${icon(keep ? 'phone' : 'trash', 16)}</span>`);
    const m = el('span', 'rm');
    const n = el('b');
    n.textContent = title;
    m.append(n, el('small', '', sub));
    r.append(m, el('span', 'tag' + (keep ? '' : ' drop'), keep ? 'Gardé' : 'Retiré'));
    box.appendChild(r);
  };
  if (report.kept) add(true, report.kept.name || 'Principal', `ta phrase et ${entries.length} élément${entries.length > 1 ? 's' : ''} des 7 derniers jours`);
  for (const e of report.dropped) add(false, e.name || 'Sans nom', 'environnement inutilisé, effacé de cet appareil');
  if (!report.dropped.length && !report.kept) $('#newsBox').hidden = true;
  $('#news').showModal();
}

// --- Démarrage --------------------------------------------------------------

(async function start() {
  navigator.storage?.persist?.().catch(() => {});
  await db.purgeBefore(Date.now() - KEEP_MS);
  await reloadEntries();
  renderDevices();
  showNews();

  setInterval(purgeOld, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) purgeOld(); });

  if ('serviceWorker' in navigator) {
    // Nouvelle version installée pendant que l'app tourne : on recharge une fois
    // pour l'afficher tout de suite (sauf au tout premier lancement).
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  connect();
})();
