// DEMO backend: used when config.js has no Supabase keys.
// Mirrors the server rules so the game behaves the same, but everything is
// stored in this browser only, and the "other players" are bots.

import { isCheckpoint, SHOP_ITEMS, COMMENT_MAX_CHARS, COMMENTS_PER_SQUARE } from './constants.js';

const KEY = 'squareone-demo-v1';
const BOT_NAMES = ['pebble', 'marlo', 'juniper', 'ozzie'];
const SEED_COMMENTS = [
  [1, 'pebble', 'first!!'],
  [1, 'marlo', 'here we go. see you at square 1,000,000'],
  [1, 'juniper', 'Hi from Chicago 👋'],
  [2, 'marlo', 'square two, the sequel'],
  [7, 'ozzie', 'lucky number seven'],
  [42, 'juniper', 'the answer to everything is a square'],
  [100, 'pebble', 'the robot always picks rock. trust me.'],
  [100, 'ozzie', 'pebble lied to me'],
];

const fail = (msg) => { throw new Error(msg); };

export function createDemoApi() {
  let db = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    const now = Date.now();
    return {
      profile: {
        id: 'demo-' + Math.random().toString(36).slice(2, 10),
        display_name: 'walker' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
        saved_square: 1, current_square: 1, max_square: 1, coins: 0,
        equipped_head: null, equipped_face: null, equipped_neck: null,
        is_admin: true, owned: [],
      },
      lastCommentAt: 0,
      nextId: SEED_COMMENTS.length + 1,
      comments: SEED_COMMENTS.map(([square, name, body], i) => ({
        id: i + 1, square, user_id: 'bot-' + name, author_name: name, body,
        created_at: new Date(now - (SEED_COMMENTS.length - i) * 3600e3).toISOString(),
      })),
    };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} }
  const P = () => db.profile;
  const state = () => JSON.parse(JSON.stringify(P()));
  const delay = (v) => new Promise((res) => setTimeout(() => res(v), 60));

  let bots = [];
  let botTimer = null;
  let me = { square: 1 };

  return {
    mode: 'demo',
    async init() { P().current_square = P().saved_square; save(); return state(); },
    async account() { return { mode: 'demo', isAnonymous: true, email: null }; },

    async reportProgress(square) {
      const p = P();
      const target = Math.max(1, square | 0);
      if (target > p.max_square) { p.coins += target - p.max_square; p.max_square = target; }
      p.current_square = target;
      save();
      return delay({ square: target, coins: p.coins, max_square: p.max_square });
    },

    async playRps(choice) {
      const p = P();
      if (!['rock', 'paper', 'scissors'].includes(choice)) fail('Pick rock, paper or scissors');
      if (!isCheckpoint(p.current_square)) fail('You are not standing on a checkpoint');
      if (p.current_square <= p.saved_square) fail('You already saved here');
      const bot = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];
      const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
      const outcome = bot === choice ? 'tie' : beats[choice] === bot ? 'win' : 'lose';
      if (outcome === 'win') p.saved_square = p.current_square;
      save();
      return delay({ bot, outcome, saved_square: p.saved_square });
    },

    async getComments(square) {
      return delay(db.comments.filter((c) => c.square === square).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    },
    async postComment(square, body) {
      const p = P();
      const b = (body || '').trim();
      if (!b) fail('Your comment is empty');
      if (b.length > COMMENT_MAX_CHARS) fail(`Comments can be at most ${COMMENT_MAX_CHARS} characters`);
      if (Math.abs(p.current_square - square) > 1) fail('You can only comment on the square you are standing on');
      if (Date.now() - db.lastCommentAt < 10000) fail('Slow down! Wait a few seconds between comments');
      const here = db.comments.filter((c) => c.square === square);
      if (here.length >= COMMENTS_PER_SQUARE) fail(`This square is full (${COMMENTS_PER_SQUARE}/${COMMENTS_PER_SQUARE} comments)`);
      if (here.some((c) => c.user_id === p.id)) fail('You already left a comment on this square');
      const c = { id: db.nextId++, square, user_id: p.id, author_name: p.display_name, body: b, created_at: new Date().toISOString() };
      db.comments.push(c);
      db.lastCommentAt = Date.now();
      save();
      return delay(c);
    },
    async deleteComment(id) {
      if (!P().is_admin) fail('Only moderators can delete comments');
      db.comments = db.comments.filter((c) => c.id !== id);
      save();
    },
    async commentCounts(from, to) {
      const out = {};
      for (const c of db.comments) if (c.square >= from && c.square <= to) out[c.square] = (out[c.square] || 0) + 1;
      return out;
    },

    async leaderboard() {
      const p = P();
      const fake = ['pebble', 'marlo', 'juniper', 'ozzie', 'trailblazer', 'sockfoot', 'wendy_walks', 'ramble_on', 'nomad', 'kip']
        .map((name, i) => ({ display_name: name, saved_square: [3600, 2500, 1600, 1600, 900, 900, 400, 400, 100, 100][i], saved_at: new Date(Date.now() - (i + 1) * 86400e3).toISOString(), is_me: false }));
      const all = p.saved_square > 1 ? [...fake, { display_name: p.display_name, saved_square: p.saved_square, saved_at: new Date().toISOString(), is_me: true }] : fake;
      all.sort((a, b) => b.saved_square - a.saved_square || a.saved_at.localeCompare(b.saved_at));
      const rows = all.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));
      const mine = all.findIndex((r) => r.is_me);
      return delay({ rows, myRank: mine >= 0 ? mine + 1 : null });
    },

    async shopItems() { return SHOP_ITEMS; },
    async buy(itemId) {
      const p = P();
      const it = SHOP_ITEMS.find((i) => i.id === itemId) || fail('No such item');
      if (p.owned.includes(it.id)) fail('You already own that');
      if (p.coins < it.price) fail('Not enough coins');
      p.coins -= it.price;
      p.owned.push(it.id);
      p['equipped_' + it.slot] = it.id;
      save();
      return state();
    },
    async equip(slot, itemId) {
      const p = P();
      if (itemId && !p.owned.includes(itemId)) fail('You do not own that item');
      p['equipped_' + slot] = itemId || null;
      save();
      return state();
    },
    async setName(name) {
      const n = (name || '').trim();
      if (n.length < 3 || n.length > 20) fail('Names must be 3 to 20 characters');
      if (!/^[A-Za-z0-9 _.-]+$/.test(n)) fail('Names can use letters, numbers, spaces, _ . and -');
      P().display_name = n;
      save();
      return state();
    },

    // fake nearby players so you can see the feature working
    joinPresence(onChange) {
      bots = BOT_NAMES.map((name, i) => ({
        id: 'bot-' + name, name, square: 1 + i * 2, equipped: i === 1 ? { head: 'fun_hat' } : i === 2 ? { face: 'sunglasses', neck: 'scarf' } : {},
      }));
      clearInterval(botTimer);
      botTimer = setInterval(() => {
        for (const b of bots) {
          if (Math.abs(b.square - me.square) > 14) b.square = Math.max(1, me.square + Math.round((Math.random() - 0.3) * 16));
          else if (Math.random() < 0.5) b.square = Math.max(1, b.square + (Math.random() < 0.62 ? 1 : -1));
        }
        onChange(bots.map((b) => ({ ...b })));
      }, 450);
    },
    updatePresence(payload) { me = { ...me, ...payload }; },
    sendPosition(payload) { me = { ...me, ...payload }; },

    async linkEmail() { fail('Accounts need Supabase. Follow the README to connect it.'); },
    async signIn() { fail('Accounts need Supabase. Follow the README to connect it.'); },
    async signOut() { localStorage.removeItem(KEY); location.reload(); },
  };
}
