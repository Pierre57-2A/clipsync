import { authToken, encKey, accountId, encryptText, encryptBytes, decryptText, decryptBytes } from '/crypto.js';

const $ = (s) => document.querySelector(s);
const CFG = 'clipsync.cfg';
const HIST = 'clipsync.hist';

function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG)) || {}; } catch {}
  if (!c.deviceId) c.deviceId = 'iphone-' + Math.random().toString(36).slice(2, 10);
  if (!c.deviceName) c.deviceName = 'iPhone';
  saveCfg(c);
  return c;
}
function saveCfg(c) { localStorage.setItem(CFG, JSON.stringify(c)); }

let cfg = loadCfg();
let ws = null, connected = false, key = null, token = null, acct = null;
let deviceList = [];

const wsURL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
const httpBase = location.origin;
const configured = () => !!cfg.phrase;

function setStatus(text, online, sub = '') {
  $('#dot').className = 'dot ' + (online ? 'on' : 'off');
  $('#statusText').textContent = text;
  $('#statusSub').textContent = sub;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// --- Connexion WebSocket ---------------------------------------------------

async function ensureKeys() {
  token = await authToken(cfg.phrase);
  key = await encKey(cfg.phrase);
  acct = await accountId(cfg.phrase);
}

async function connect() {
  if (!configured()) { setStatus('À configurer', false); openSettings(); return; }
  await ensureKeys();
  try { ws?.close(); } catch {}
  ws = new WebSocket(wsURL);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'hello', accountId: acct, token,
      deviceId: cfg.deviceId, deviceName: cfg.deviceName, platform: 'ios',
    }));
    connected = true;
    setStatus('Connecté', true);
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { connected = false; setStatus('Hors ligne', false); setTimeout(connect, 3000); };
  ws.onerror = () => {};
}

setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat' })); }, 30000);

async function handle(msg) {
  switch (msg.type) {
    case 'welcome':
    case 'devices': deviceList = msg.devices || []; renderDevices(deviceList); break;
    case 'clip': await onClip(msg); break;
    case 'sent': break;
    case 'applied': toast(`Collé sur ${msg.by?.name || 'PC'} ✓`); break;
    case 'error': toast('Erreur : ' + msg.message); break;
  }
}

// --- Réception (déchiffrement) ---------------------------------------------

async function onClip(msg) {
  const from = msg.from?.name || 'un appareil';
  if (msg.contentType === 'text') {
    const text = msg.enc === 'v1' ? await decryptText(key, msg.text) : msg.text;
    if (text != null) { addHistory({ dir: 'in', peer: from, kind: 'text', text }); toast('Nouveau texte reçu'); }
  } else if (msg.contentType === 'image' && msg.fileId) {
    const blob = await fetchFile(msg.fileId);
    if (!blob) return;
    const bytes = msg.enc === 'v1' ? await decryptBytes(key, blob) : blob;
    if (bytes) { addHistory({ dir: 'in', peer: from, kind: 'image', img: await bytesToDataUrl(bytes) }); toast('Nouvelle image reçue'); }
  }
}

async function fetchFile(fileId) {
  const res = await fetch(httpBase + '/files/' + fileId, {
    headers: { 'x-account-id': acct, 'x-token': token },
  });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

// --- Historique (reçu + envoyé, recherche, persistance locale) --------------

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
  return (n / 1024 / 1024).toFixed(1) + ' Mo';
}
function bytesToDataUrl(bytes, type = 'image/png') {
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(new Blob([bytes], { type })); });
}
function blobToDataUrl(blob) {
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
}

function loadHistory() { try { return JSON.parse(localStorage.getItem(HIST)) || []; } catch { return []; } }
// Sauvegarde en évitant de dépasser le quota localStorage : on retire les
// images (les plus anciennes d'abord) tant que ça ne rentre pas.
function saveHistory() {
  if (history.length > 150) history = history.slice(0, 150);
  const clone = history.map((e) => ({ ...e }));
  for (let attempt = 0; attempt < clone.length + 2; attempt++) {
    try { localStorage.setItem(HIST, JSON.stringify(clone)); return; }
    catch {
      let idx = -1;
      for (let i = clone.length - 1; i >= 0; i--) { if (clone[i].img) { idx = i; break; } }
      if (idx === -1) { clone.splice(Math.ceil(clone.length / 2)); if (!clone.length) return; continue; }
      clone[idx] = { ...clone[idx], img: null, imgDropped: true };
    }
  }
}

let history = loadHistory();
let histQuery = '';

function addHistory(entry) {
  entry.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  entry.ts = Date.now();
  history.unshift(entry);
  saveHistory();
  renderHistory();
}

const kindLabel = (k) => (k === 'image' ? 'image' : k === 'file' ? 'fichier' : 'texte');
function entryText(e) { return [e.text, e.filename, e.peer, kindLabel(e.kind)].filter(Boolean).join(' '); }

function renderEntry(e) {
  const div = document.createElement('div');
  div.className = 'item item-' + e.dir;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const label = document.createElement('span');
  label.className = 'dir dir-' + e.dir;
  label.textContent = e.dir === 'in' ? '↓ Reçu' + (e.peer ? ' de ' + e.peer : '') : '↑ Envoyé';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(new Date(e.ts));
  meta.append(label, time);
  div.appendChild(meta);

  if (e.kind === 'text') {
    const body = document.createElement('div'); body.className = 'body'; body.textContent = e.text;
    div.appendChild(body);
    const btn = document.createElement('button'); btn.className = 'copy'; btn.textContent = 'Copier';
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(e.text); toast('Copié ✓'); }
      catch { toast('Touche « Copier » à nouveau'); }
    };
    div.appendChild(btn);
  } else if (e.kind === 'image') {
    if (e.img) {
      const img = document.createElement('img'); img.src = e.img; img.loading = 'lazy';
      div.appendChild(img);
      const hint = document.createElement('div'); hint.className = 'meta sub';
      hint.textContent = 'Appui long sur l’image → « Ajouter aux photos » / « Copier »';
      div.appendChild(hint);
    } else {
      const body = document.createElement('div'); body.className = 'body muted'; body.textContent = '🖼️ Image (non conservée)';
      div.appendChild(body);
    }
  } else {
    const row = document.createElement('div'); row.className = 'file-row';
    row.innerHTML = `<span class="file-ic">📄</span><span class="file-meta"><span class="file-name">${escapeHtml(e.filename || 'fichier')}</span><span class="file-size">${escapeHtml(fmtSize(e.size))}</span></span>`;
    div.appendChild(row);
  }
  return div;
}

function renderHistory() {
  const el = $('#received');
  const search = $('#histSearch');
  if (search) search.hidden = history.length === 0;
  if (!history.length) { el.innerHTML = '<div class="empty">Rien pour l’instant.</div>'; return; }
  const q = histQuery.trim().toLowerCase();
  const items = q ? history.filter((e) => entryText(e).toLowerCase().includes(q)) : history;
  if (!items.length) { el.innerHTML = '<div class="empty">Aucun résultat.</div>'; return; }
  el.innerHTML = '';
  for (const e of items) el.appendChild(renderEntry(e));
}

function renderDevices(devices) {
  const el = $('#devices');
  if (!devices.length) { el.innerHTML = '<div class="empty">Aucun autre appareil</div>'; return; }
  el.innerHTML = '';
  for (const d of devices) {
    const row = document.createElement('div');
    row.className = 'device';
    row.innerHTML = `<span class="dot ${d.online ? 'on' : 'off'}"></span>
      <span class="name">${escapeHtml(d.name)}</span>
      <span class="plat">${escapeHtml(d.platform)}</span>`;
    el.appendChild(row);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// --- Envoi (chiffrement) ---------------------------------------------------

// Upload des octets (déjà chiffrés) via XHR pour avoir la progression -> renvoie fileId.
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

// Envoi d'une image (Blob/File) : chiffrement -> upload -> clip image.
async function doSendImage(blob) {
  if (!blob) { toast('Aucune image'); return; }
  if (!token || !acct) await ensureKeys();
  toast("Envoi de l'image…");
  const raw = new Uint8Array(await blob.arrayBuffer());
  const enc = await encryptBytes(key, raw);
  const fileId = await uploadBlob(enc);
  if (!fileId) { toast("Échec de l'envoi de l'image"); return; }
  let res;
  try {
    res = await fetch(httpBase + '/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account-id': acct, 'x-token': token },
      body: JSON.stringify({
        contentType: 'image', fileId, fileType: blob.type || 'image/png', enc: 'v1',
        targets: 'all', deviceName: cfg.deviceName, deviceId: cfg.deviceId,
      }),
    });
  } catch { toast('Serveur injoignable'); return; }
  if (res.status === 401) { toast('Phrase incorrecte'); return; }
  const j = await res.json().catch(() => ({}));
  addHistory({ dir: 'out', kind: 'image', img: await blobToDataUrl(blob) });
  toast(j.delivered > 0 ? `Image envoyée à ${j.delivered} PC ✓` : 'Aucun PC en ligne');
}

async function doSend(text) {
  if (!text) { toast('Rien à envoyer'); return; }
  if (!token || !acct) await ensureKeys();
  const ct = await encryptText(key, text);
  let res;
  try {
    res = await fetch(httpBase + '/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account-id': acct, 'x-token': token },
      body: JSON.stringify({
        contentType: 'text', text: ct, enc: 'v1', targets: 'all',
        deviceName: cfg.deviceName, deviceId: cfg.deviceId,
      }),
    });
  } catch { toast('Serveur injoignable'); return; }
  if (res.status === 401) { toast('Phrase incorrecte'); return; }
  const j = await res.json().catch(() => ({}));
  addHistory({ dir: 'out', kind: 'text', text });
  toast(j.delivered > 0 ? `Envoyé à ${j.delivered} PC ✓` : 'Aucun PC en ligne (ouvre ClipSync sur le PC)');
}

$('#send').onclick = async () => {
  if (!configured()) { openSettings(); return; }
  // Lecture directe du presse-papiers (texte OU image). iOS affiche « Coller » : touche-le.
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find((t) => t.startsWith('image/'));
      if (imgType) { await doSendImage(await item.getType(imgType)); return; }
    }
    for (const item of items) {
      if (item.types.includes('text/plain')) {
        const txt = await (await item.getType('text/plain')).text();
        if (txt) { await doSend(txt); return; }
      }
    }
    toast('Presse-papiers vide');
    return;
  } catch { /* read() indisponible -> readText */ }

  try {
    const txt = await navigator.clipboard.readText();
    if (txt) { await doSend(txt); return; }
    toast('Presse-papiers vide');
  } catch {
    toast('Réessaie (touche « Coller »), ou utilise « Envoyer des fichiers »');
  }
};

// --- Envoi de fichiers (n'importe quel type, plusieurs, avec progression) --
const MAX_FILE = 100 * 1024 * 1024;

function showProgress(name, frac) {
  $('#progress').hidden = false;
  $('#progressLabel').textContent = name;
  $('#progressBar').style.width = Math.round(frac * 100) + '%';
}
function hideProgress() { $('#progress').hidden = true; $('#progressBar').style.width = '0%'; }

async function doSendFile(file, target = 'all') {
  if (!token || !acct) await ensureKeys();
  if (file.size > MAX_FILE) { toast(`Trop lourd : ${file.name} (max 100 Mo)`); return; }
  const raw = new Uint8Array(await file.arrayBuffer());
  const enc = await encryptBytes(key, raw);
  showProgress(file.name, 0);
  const fileId = await uploadBlob(enc, (p) => showProgress(file.name, p));
  hideProgress();
  if (!fileId) { toast('Échec : ' + file.name); return; }
  try {
    const res = await fetch(httpBase + '/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account-id': acct, 'x-token': token },
      body: JSON.stringify({
        contentType: 'file', fileId, fileType: file.type || 'application/octet-stream', enc: 'v1',
        meta: { filename: file.name, size: file.size }, targets: target === 'all' ? 'all' : [target],
        deviceName: cfg.deviceName, deviceId: cfg.deviceId,
      }),
    });
    const j = await res.json().catch(() => ({}));
    addHistory({ dir: 'out', kind: 'file', filename: file.name, size: file.size });
    toast(j.delivered > 0 ? `Envoyé : ${file.name}` : 'Aucun PC en ligne');
  } catch { toast('Serveur injoignable'); }
}

$('#sendFiles').onclick = () => { if (!configured()) { openSettings(); return; } $('#fileInput').click(); };
$('#fileInput').onchange = async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const online = deviceList.filter((d) => d.online);
  if (online.length <= 1) {
    for (const f of files) await doSendFile(f, 'all'); // 0 ou 1 cible -> direct
  } else {
    openTargetPicker(files); // plusieurs PC -> on choisit
  }
};

function openTargetPicker(files) {
  const online = deviceList.filter((d) => d.online);
  const list = $('#targetList');
  list.innerHTML = '';
  const addOpt = (label, sub, value) => {
    const b = document.createElement('button');
    b.className = 'target-opt';
    b.innerHTML = `<span class="t-name">${escapeHtml(label)}</span><span class="t-sub">${escapeHtml(sub)}</span>`;
    b.onclick = async () => { $('#targetPicker').close(); for (const f of files) await doSendFile(f, value); };
    list.appendChild(b);
  };
  const plural = files.length > 1 ? `${files.length} fichiers` : files[0].name;
  $('#targetTitle').textContent = `Envoyer ${plural} à`;
  addOpt('Tous les appareils', `${online.length} en ligne`, 'all');
  for (const d of online) addOpt(d.name, d.platform, d.deviceId);
  $('#targetPicker').showModal();
}
$('#targetCancel').onclick = () => $('#targetPicker').close();

// --- Réglages --------------------------------------------------------------

function openSettings() {
  $('#cfgPhrase').value = cfg.phrase || '';
  $('#cfgName').value = cfg.deviceName || '';
  $('#settings').showModal();
}
$('#settingsBtn').onclick = openSettings;
$('#cfgCancel').onclick = () => $('#settings').close();
$('#cfgSave').onclick = async () => {
  cfg.phrase = $('#cfgPhrase').value;
  cfg.deviceName = $('#cfgName').value.trim() || 'iPhone';
  saveCfg(cfg);
  $('#settings').close();
  await connect();
};

// --- Recherche dans l'historique -------------------------------------------

$('#histSearch').addEventListener('input', (e) => { histQuery = e.target.value; renderHistory(); });

// --- Démarrage -------------------------------------------------------------

renderHistory();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
connect();
