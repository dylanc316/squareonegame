// Square One — game client
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { STEP_MS, NEARBY_RANGE, COMMENT_MAX_CHARS, COMMENTS_PER_SQUARE, isCheckpoint, nextCheckpointAfter } from './constants.js';
import { Renderer, drawAvatar } from './render.js';
import { zoneOf, zoneInfo, BIOMES, STYLES, sceneryFor, hash } from './world.js';
import { createDemoApi } from './api-demo.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- state ----------------
let api;
let me;                 // server profile
let pos = 1;            // current square (integer)
let dispU = 1;          // animated position
let facing = 1;
let phase = 0;
let lastReported = 1;
const others = new Map();
let counts = {};
let countsRange = [0, -1];
let shopItems = [];
let orientation = 'horizontal';
let zoneShown = -1;

const renderer = new Renderer($('game'));

// ---------------- helpers ----------------
function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
const errMsg = (e) => (e && e.message ? e.message : String(e));
const fmt = (n) => n.toLocaleString();

function colorFor(id) {
  const h = hash(...Array.from(String(id)).map((c) => c.charCodeAt(0))) % 360;
  // hsl(h, 70%, 72%) → hex
  const s = 0.7, l = 0.72;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}
const equippedOf = (p) => ({ head: p.equipped_head, face: p.equipped_face, neck: p.equipped_neck });
const coinsShown = () => me.coins + Math.max(0, pos - me.max_square);
const anyDialogOpen = () => document.querySelector('dialog[open]') !== null;

// ---------------- boot ----------------
async function boot() {
  try {
    if (SUPABASE_URL && SUPABASE_KEY) {
      const { createOnlineApi } = await import('./api-online.js');
      api = await createOnlineApi(SUPABASE_URL, SUPABASE_KEY);
    } else {
      api = createDemoApi();
      $('demoBadge').hidden = false;
    }
    me = await api.init();
    shopItems = await api.shopItems().catch(() => []);
  } catch (e) {
    const box = $('loading');
    box.classList.add('error');
    box.innerHTML = '<h2>Couldn’t reach the path</h2><p></p><button class="btn" onclick="location.reload()">Try again</button>';
    box.querySelector('p').textContent = errMsg(e);
    return;
  }

  pos = dispU = lastReported = me.current_square;
  try { orientation = localStorage.getItem('sq1-orientation') || 'horizontal'; } catch {}
  applyOrientation();

  $('loading').remove();
  $('hud').hidden = false;
  if (window.innerWidth > 900) openComments();

  api.joinPresence((list) => {
    const seen = new Set();
    for (const o of list) {
      seen.add(o.id);
      const cur = others.get(o.id);
      if (cur) Object.assign(cur, o);
      else others.set(o.id, { ...o, dispU: o.square, color: colorFor(o.id), facing: 1, phase: 0, lat: ((parseInt(colorFor(o.id).slice(1, 3), 16) % 5) - 2) * 14 || 14 });
    }
    for (const id of others.keys()) if (!seen.has(id)) others.delete(id);
  });
  sendPresence();

  bindInput();
  bindUi();
  onMoved(true);
  requestAnimationFrame(frame);
}

// ---------------- movement ----------------
const held = [];
let nextStepAt = 0;
let edgeWarned = false;

function tryStep(d) {
  if (d < 0 && pos <= 1) {
    if (!edgeWarned) { toast('Square one is the edge of the world. The only way is forward!'); edgeWarned = true; }
    return;
  }
  pos = Math.max(1, pos + d);
  facing = d;
  onMoved(false);
}

function onMoved(initial) {
  scheduleReport();
  schedulePresence();
  maybeFetchCounts();
  scheduleCommentsLoad();
  updateHud();
  const z = zoneOf(pos);
  if (z !== zoneShown) { showZoneBanner(z, initial); zoneShown = z; }
  if (!initial) $('hint').classList.add('gone');
}

function frame(t) {
  const now = performance.now();
  const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
  frame.last = now;

  const dir = held.length ? held[held.length - 1] : 0;
  if (dir && now >= nextStepAt && !anyDialogOpen()) { tryStep(dir); nextStepAt = now + STEP_MS; }

  const before = dispU;
  dispU += (pos - dispU) * Math.min(1, dt * 14);
  if (Math.abs(pos - dispU) > 12) dispU = pos;
  if (Math.abs(dispU - before) > 0.002) phase += dt * 16; else phase *= 0.85;

  const view = [];
  for (const o of others.values()) {
    const prev = o.dispU;
    o.dispU += (o.square - o.dispU) * Math.min(1, dt * 8);
    if (Math.abs(o.square - o.dispU) > 30) o.dispU = o.square;
    const moved = o.dispU - prev;
    if (Math.abs(moved) > 0.002) { o.phase += dt * 16; o.facing = moved > 0 ? 1 : -1; } else o.phase *= 0.85;
    if (Math.abs(o.dispU - dispU) <= NEARBY_RANGE + 6) view.push(o);
  }

  renderer.draw({
    camU: dispU,
    time: t / 1000,
    savedSquare: me.saved_square,
    counts,
    others: view,
    player: { dispU, facing, phase, equipped: equippedOf(me), color: colorFor(me.id) },
  });
  requestAnimationFrame(frame);
}

function bindInput() {
  const keyDir = (k) => {
    if (k === 'ArrowRight' || k === 'ArrowUp' || k === 'd' || k === 'w') return 1;
    if (k === 'ArrowLeft' || k === 'ArrowDown' || k === 'a' || k === 's') return -1;
    return 0;
  };
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  window.addEventListener('keydown', (e) => {
    if (typing(e) || anyDialogOpen()) return;
    const d = keyDir(e.key);
    if (d) {
      e.preventDefault();
      if (e.repeat) return;
      held.push(d);
      tryStep(d);
      nextStepAt = performance.now() + STEP_MS * 1.8; // tap = 1 step, hold = walk
      return;
    }
    if (e.key === 'Enter' && !$('cpBanner').hidden) { e.preventDefault(); openRps(); }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); toggleComments(); }
  });
  window.addEventListener('keyup', (e) => {
    const d = keyDir(e.key);
    if (!d) return;
    const i = held.lastIndexOf(d);
    if (i >= 0) held.splice(i, 1);
  });
  window.addEventListener('blur', () => { held.length = 0; });

  for (const b of document.querySelectorAll('.tbtn')) {
    const d = Number(b.dataset.dir);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); held.push(d); tryStep(d); nextStepAt = performance.now() + STEP_MS * 1.8; });
    const up = () => { const i = held.lastIndexOf(d); if (i >= 0) held.splice(i, 1); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  window.addEventListener('resize', () => { renderer.resize(); fitLayout(); });
  window.addEventListener('beforeunload', (e) => {
    if (pos - me.saved_square >= 50) { e.preventDefault(); e.returnValue = ''; }
  });
}

function applyOrientation() {
  renderer.orientation = orientation;
  const [back, fwd] = document.querySelectorAll('.tbtn');
  back.textContent = orientation === 'horizontal' ? '◀' : '▼';
  fwd.textContent = orientation === 'horizontal' ? '▶' : '▲';
  $('btnOrient').textContent = orientation === 'horizontal' ? '⇅' : '⇆';
}

// ---------------- server sync ----------------
let reportTimer = null;
let reportInflight = false;

function scheduleReport(delay = 400) {
  if (!reportTimer) reportTimer = setTimeout(flushReport, delay);
}
async function flushReport() {
  reportTimer = null;
  if (reportInflight) { scheduleReport(); return; }
  if (pos === lastReported) return;
  reportInflight = true;
  const sent = pos;
  try {
    const r = await api.reportProgress(sent);
    me.coins = r.coins;
    me.max_square = r.max_square;
    me.current_square = r.square;
    lastReported = r.square;
    if (r.square !== sent && pos === sent) {
      pos = r.square;
      toast('Whoa, slow down there!');
    }
  } catch (e) {
    console.warn('progress report failed', e);
    reportInflight = false;
    scheduleReport(3000);
    return;
  }
  reportInflight = false;
  updateHud();
}
async function syncNow() {
  clearTimeout(reportTimer);
  reportTimer = null;
  while (reportInflight) await sleep(40);
  if (pos !== lastReported) await flushReport();
}

let presenceTimer = null;
function schedulePresence() {
  if (!presenceTimer) presenceTimer = setTimeout(() => { presenceTimer = null; sendPresence(); }, 300);
}
function sendPresence() {
  api.updatePresence({ name: me.display_name, square: pos, equipped: equippedOf(me) });
}

async function maybeFetchCounts(force = false) {
  const [a, b] = countsRange;
  if (!force && pos - 25 >= a && pos + 40 <= b) return;
  const from = Math.max(1, pos - 60), to = pos + 120;
  countsRange = [from, to];
  try {
    const c = await api.commentCounts(from, to);
    for (let s = from; s <= to; s++) delete counts[s];
    Object.assign(counts, c);
    updateHud();
  } catch (e) { console.warn(e); }
}

// ---------------- HUD ----------------
function updateHud() {
  $('sqNum').textContent = fmt(pos);
  $('coins').textContent = fmt(coinsShown());

  const unsaved = pos - me.saved_square;
  $('saveInfo').innerHTML = me.saved_square <= 1
    ? `Progress <span class="warn">not saved yet</span>`
    : `Saved at square <b>${fmt(me.saved_square)}</b>` + (unsaved > 0 ? ` · <span class="warn">${fmt(unsaved)} unsaved</span>` : '');

  const next = nextCheckpointAfter(Math.max(pos - 1, me.saved_square));
  if (isCheckpoint(pos)) {
    $('nextCp').innerHTML = pos <= me.saved_square ? `<span class="ok">Checkpoint ${fmt(pos)} ✓</span>` : `You're on checkpoint ${fmt(pos)}!`;
  } else {
    $('nextCp').textContent = `Next checkpoint: ${fmt(next)} (${fmt(Math.abs(next - pos))} ${next > pos ? 'ahead' : 'back'})`;
  }

  let near = 0;
  for (const o of others.values()) if (Math.abs(o.square - pos) <= NEARBY_RANGE) near++;
  $('nearby').textContent = near ? `${near} walker${near === 1 ? '' : 's'} nearby` : '';

  const n = counts[pos] || 0;
  $('cBadge').textContent = n >= COMMENTS_PER_SQUARE ? 'full' : n;
  $('cBadge').classList.toggle('full', n >= COMMENTS_PER_SQUARE);

  $('cpBanner').hidden = !(isCheckpoint(pos) && pos > me.saved_square) || anyDialogOpen();

  const odd = sceneryFor(pos).oddity;
  const cap = $('caption');
  if (odd) { cap.textContent = odd.line; cap.classList.add('show'); } else cap.classList.remove('show');
}
setInterval(() => { if (me) updateHud(); }, 1000);

let bannerTimer;
function showZoneBanner(zone, initial) {
  const { biome, style } = zoneInfo(zone);
  const el = $('zoneBanner');
  el.innerHTML = '';
  el.append(document.createTextNode(BIOMES[biome].name));
  const sm = document.createElement('small');
  sm.textContent = STYLES[style] + (initial ? '' : ' style');
  el.append(sm);
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------------- comments ----------------
let commentsOpen = false;
let commentsSquare = 0;
let commentsTimer = null;
let commentsList = [];

function openComments() { commentsOpen = true; $('comments').hidden = false; document.body.classList.add('comments-open'); fitLayout(); loadComments(true); }
function closeComments() { commentsOpen = false; $('comments').hidden = true; document.body.classList.remove('comments-open'); fitLayout(); }
// on phones the notes sheet covers the bottom of the screen, so lift the path above it
function fitLayout() {
  renderer.insetBottom = commentsOpen && window.innerWidth <= 760 ? $('comments').offsetHeight + 8 : 0;
}
function toggleComments() { commentsOpen ? closeComments() : openComments(); }

function scheduleCommentsLoad() {
  if (!commentsOpen) return;
  $('cSq').textContent = fmt(pos);
  clearTimeout(commentsTimer);
  commentsTimer = setTimeout(() => loadComments(false), 220);
}
async function loadComments(force) {
  if (!commentsOpen) return;
  const sq = pos;
  if (!force && sq === commentsSquare) return;
  $('cSq').textContent = fmt(sq);
  try {
    const list = await api.getComments(sq);
    if (sq !== pos) return; // walked away meanwhile
    commentsSquare = sq;
    commentsList = list;
    counts[sq] = list.length;
    renderComments();
    updateHud();
  } catch (e) { toast(errMsg(e), true); }
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function renderComments() {
  const list = $('cList');
  list.innerHTML = '';
  $('cCap').textContent = `${commentsList.length} / ${COMMENTS_PER_SQUARE} notes`;
  if (!commentsList.length) {
    const e = document.createElement('div');
    e.className = 'c-empty';
    e.textContent = commentsSquare > me.max_square - 1 && commentsSquare > 3 ? 'No notes yet. You might be the first one ever to stand here.' : 'No notes on this square yet.';
    list.append(e);
  }
  for (const c of commentsList) {
    const item = document.createElement('div');
    item.className = 'c-item';
    const meta = document.createElement('div');
    meta.className = 'c-meta';
    const name = document.createElement('b');
    name.textContent = c.author_name;
    if (c.user_id === me.id) name.classList.add('me');
    const when = document.createElement('span');
    when.textContent = ago(c.created_at);
    meta.append(name, when);
    if (me.is_admin) {
      const del = document.createElement('button');
      del.className = 'btn small ghost danger';
      del.textContent = 'Remove';
      del.onclick = async () => {
        if (!confirm('Remove this note? This frees up its slot.')) return;
        try { await api.deleteComment(c.id); commentsList = commentsList.filter((x) => x.id !== c.id); counts[commentsSquare] = commentsList.length; renderComments(); updateHud(); }
        catch (e) { toast(errMsg(e), true); }
      };
      meta.append(del);
    }
    const body = document.createElement('div');
    body.className = 'c-body';
    body.textContent = c.body;
    item.append(meta, body);
    list.append(item);
  }
  const mine = commentsList.some((c) => c.user_id === me.id);
  const full = commentsList.length >= COMMENTS_PER_SQUARE;
  $('cInput').disabled = $('cPost').disabled = mine || full;
  $('cNote').textContent = mine ? 'You already left your note on this square.' : full ? 'This square is full. Walk on to find an empty one!' : '';
}

async function postComment(e) {
  e.preventDefault();
  const input = $('cInput');
  const text = input.value.trim();
  if (!text) return;
  $('cPost').disabled = true;
  try {
    await syncNow();
    const c = await api.postComment(pos, text);
    input.value = '';
    $('cChars').textContent = `0 / ${COMMENT_MAX_CHARS}`;
    if (commentsSquare === c.square) commentsList.unshift(c);
    counts[c.square] = (counts[c.square] || 0) + 1;
    renderComments();
    updateHud();
    input.blur();
  } catch (err) {
    toast(errMsg(err), true);
    $('cPost').disabled = false;
  }
}

// ---------------- rock paper scissors ----------------
const HAND = { rock: '✊', paper: '✋', scissors: '✌️' };
function openRps() {
  held.length = 0;
  $('rpsSq').textContent = fmt(pos);
  $('youHand').textContent = '?';
  $('botHand').textContent = '🤖';
  $('rpsResult').textContent = 'Choose wisely.';
  $('rpsResult').className = 'result';
  $('rpsChoices').hidden = false;
  $('rpsClose').textContent = 'Not now';
  $('rpsClose').className = 'btn ghost';
  for (const b of $('rpsChoices').children) b.disabled = false;
  $('rpsDlg').showModal();
  updateHud();
}
async function playRps(choice) {
  for (const b of $('rpsChoices').children) b.disabled = true;
  $('youHand').textContent = HAND[choice];
  $('botHand').classList.add('shake');
  $('rpsResult').textContent = 'The robot is thinking…';
  $('rpsResult').className = 'result';
  try {
    await syncNow();
    const [r] = await Promise.all([api.playRps(choice), sleep(750)]);
    $('botHand').classList.remove('shake');
    $('botHand').textContent = HAND[r.bot];
    const res = $('rpsResult');
    if (r.outcome === 'win') {
      me.saved_square = r.saved_square;
      res.textContent = `You win! Progress saved at square ${fmt(r.saved_square)}.`;
      res.className = 'result win';
      $('rpsChoices').hidden = true;
      $('rpsClose').textContent = 'Keep walking';
      $('rpsClose').className = 'btn primary';
    } else {
      res.textContent = r.outcome === 'tie' ? 'A tie! Go again.' : 'The robot wins this round. Try again!';
      res.className = 'result' + (r.outcome === 'lose' ? ' lose' : '');
      for (const b of $('rpsChoices').children) b.disabled = false;
    }
    updateHud();
  } catch (e) {
    $('botHand').classList.remove('shake');
    toast(errMsg(e), true);
    for (const b of $('rpsChoices').children) b.disabled = false;
  }
}

// ---------------- shop ----------------
function drawPreview(canvas, equipped) {
  const c = canvas.getContext('2d');
  const dpr = 2;
  canvas.width = 180 * dpr; canvas.height = 180 * dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, 180, 180);
  c.fillStyle = '#e6c896';
  c.beginPath(); c.roundRect(30, 128, 120, 30, 8); c.fill();
  drawAvatar({ ctx: c, style: 'flat', fill(col, b) { c.beginPath(); b(c); c.fillStyle = col; c.fill(); }, line(col, w, b) { c.beginPath(); b(c); c.save(); c.lineCap = 'round'; c.strokeStyle = col; c.lineWidth = w; c.stroke(); c.restore(); }, solid(col, b) { c.beginPath(); b(c); c.fillStyle = col; c.fill(); } },
    90, 146, { facing: 1, phase: 0, equipped, color: colorFor(me.id), s: 2.1 });
}
function renderShop(tryOn) {
  $('shopCoins').textContent = fmt(coinsShown());
  const eq = equippedOf(me);
  drawPreview($('shopPreview'), tryOn ? { ...eq, [tryOn.slot]: tryOn.id } : eq);
  const list = $('shopList');
  list.innerHTML = '';
  for (const it of shopItems) {
    const owned = me.owned.includes(it.id);
    const wearing = eq[it.slot] === it.id;
    const row = document.createElement('div');
    row.className = 'shop-item' + (owned ? ' owned' : '');
    const info = document.createElement('div');
    info.innerHTML = '<div class="nm"></div><div class="pr"></div>';
    info.querySelector('.nm').textContent = it.name;
    info.querySelector('.pr').innerHTML = owned ? (wearing ? 'Wearing' : 'Owned') : `<span class="coin"></span>${fmt(it.price)}`;
    const btn = document.createElement('button');
    btn.className = 'btn small' + (!owned ? ' primary' : '');
    if (!owned) {
      btn.textContent = 'Buy';
      btn.disabled = coinsShown() < it.price;
      if (btn.disabled) btn.title = `You need ${fmt(it.price - coinsShown())} more coins`;
      btn.onclick = () => shopAction(() => api.buy(it.id), `You bought the ${it.name}!`);
    } else {
      btn.textContent = wearing ? 'Take off' : 'Wear';
      btn.onclick = () => shopAction(() => api.equip(it.slot, wearing ? null : it.id));
    }
    row.addEventListener('mouseenter', () => !owned && drawPreview($('shopPreview'), { ...equippedOf(me), [it.slot]: it.id }));
    row.addEventListener('mouseleave', () => drawPreview($('shopPreview'), equippedOf(me)));
    row.append(info, btn);
    list.append(row);
  }
}
async function shopAction(fn, okMsg) {
  try {
    await syncNow();
    me = { ...me, ...(await fn()), current_square: pos };
    if (okMsg) toast(okMsg);
    renderShop();
    updateHud();
    sendPresence();
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------- account ----------------
async function openAccount() {
  held.length = 0;
  $('nameInput').value = me.display_name;
  const body = $('acctBody');
  body.innerHTML = '<div class="acct"><p class="small">Loading…</p></div>';
  $('acctDlg').showModal();
  const acct = await api.account();
  const box = document.createElement('div');
  box.className = 'acct';
  if (acct.mode === 'demo') {
    box.innerHTML = `<p><b>Demo mode.</b> Your walker is saved in this browser only, and the other walkers are bots. Connect Supabase (see the README) for real accounts and real players.</p>
      <button class="btn small danger" id="resetDemo">Reset demo</button>`;
    box.querySelector('#resetDemo').onclick = () => { if (confirm('Start over from square one?')) api.signOut(); };
  } else if (acct.isAnonymous) {
    box.innerHTML = `<p><b>You're playing as a guest.</b> Your progress is saved in this browser. Add your email to keep your walker if you switch devices or clear your browser.</p>
      ${acct.pendingEmail ? '<p class="small">We sent a confirmation link to <b id="pendingEmail"></b>. Click it to finish.</p>' : ''}
      <div class="row"><input id="linkEmail" type="email" placeholder="you@example.com" /><button class="btn primary" id="linkBtn">Save my walker</button></div>
      <p class="small" style="margin-top:14px">Already have a walker on another device?</p>
      <div class="row"><input id="signEmail" type="email" placeholder="you@example.com" /><button class="btn" id="signBtn">Email me a sign-in link</button></div>
      <p class="small" style="margin-top:6px">Signing in switches to that walker. This guest's progress stays behind.</p>`;
    if (acct.pendingEmail) box.querySelector('#pendingEmail').textContent = acct.pendingEmail;
    box.querySelector('#linkBtn').onclick = async () => {
      const email = box.querySelector('#linkEmail').value.trim();
      if (!email) return;
      try { await api.linkEmail(email); toast('Check your inbox for a confirmation link!'); } catch (e) { toast(errMsg(e), true); }
    };
    box.querySelector('#signBtn').onclick = async () => {
      const email = box.querySelector('#signEmail').value.trim();
      if (!email) return;
      try { await api.signIn(email); toast('Sign-in link sent. Open it on this device.'); } catch (e) { toast(errMsg(e), true); }
    };
  } else {
    box.innerHTML = `<p>Signed in as <b></b>. Your walker is saved to your account.</p><button class="btn small" id="signOut">Sign out</button>`;
    box.querySelector('b').textContent = acct.email;
    box.querySelector('#signOut').onclick = () => api.signOut();
  }
  if (me.is_admin) {
    const p = document.createElement('p');
    p.className = 'small';
    p.style.marginTop = '10px';
    p.textContent = 'You are a moderator: you can remove any note.';
    box.append(p);
  }
  body.innerHTML = '';
  body.append(box);
}
async function saveName() {
  try {
    me = { ...me, ...(await api.setName($('nameInput').value)), current_square: pos };
    toast('Name saved');
    sendPresence();
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------- wire up UI ----------------
function bindUi() {
  $('btnComments').onclick = toggleComments;
  $('cClose').onclick = closeComments;
  $('cForm').addEventListener('submit', postComment);
  $('cInput').addEventListener('input', (e) => { $('cChars').textContent = `${e.target.value.length} / ${COMMENT_MAX_CHARS}`; });
  $('cInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('cForm').requestSubmit(); } });

  $('btnChallenge').onclick = openRps;
  for (const b of $('rpsChoices').children) b.onclick = () => playRps(b.dataset.c);
  $('rpsClose').onclick = () => $('rpsDlg').close();
  $('rpsDlg').addEventListener('close', updateHud);

  $('btnShop').onclick = async () => {
    held.length = 0;
    if (!shopItems.length) shopItems = await api.shopItems().catch(() => []);
    renderShop();
    $('shopDlg').showModal();
  };
  $('shopClose').onclick = () => $('shopDlg').close();

  $('btnAccount').onclick = openAccount;
  $('acctClose').onclick = () => $('acctDlg').close();
  $('nameSave').onclick = saveName;

  $('btnOrient').onclick = () => {
    orientation = orientation === 'horizontal' ? 'vertical' : 'horizontal';
    try { localStorage.setItem('sq1-orientation', orientation); } catch {}
    applyOrientation();
    $('btnOrient').blur();
  };
  // keep buttons from stealing arrow keys
  for (const b of document.querySelectorAll('.hud .btn')) b.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) e.preventDefault(); });
}

boot();
