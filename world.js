// Procedural world. Everything is derived from the square number with a
// seeded random generator, so every player sees exactly the same world.

import { ZONE_SIZE, isCheckpoint } from './constants.js';

const WORLD_SEED = 1337; // change this to generate a completely different world

export function hash(...nums) {
  let h = 2166136261 ^ WORLD_SEED;
  for (const n of nums) {
    h = Math.imul(h ^ (n | 0), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// ---------------------------------------------------------------------
//  Biomes (what is in the world) and styles (how it is drawn)
// ---------------------------------------------------------------------
export const BIOMES = {
  meadow: {
    name: 'Meadow', sky: ['#8fd3ff', '#e9f7ff'], ground: '#8fd16a', path: '#e6c896', pathEdge: '#c9a46b',
    hills: '#6db657', hills2: '#a3dc84', accent: '#ff7aa2',
    objects: [['tree', 4], ['bush', 3], ['flower', 5], ['rock', 1], ['fence', 1]],
  },
  desert: {
    name: 'Dunes', sky: ['#ffbf73', '#fff0d1'], ground: '#f2d08f', path: '#cf9f5f', pathEdge: '#a77a41',
    hills: '#e5a85d', hills2: '#f3c982', accent: '#5aa864',
    objects: [['cactus', 4], ['rock', 3], ['tumbleweed', 2], ['bones', 1]],
  },
  snow: {
    name: 'Frostlands', sky: ['#b9d3ee', '#f4f8fd'], ground: '#f4f8fc', path: '#b7c5d8', pathEdge: '#8fa1ba',
    hills: '#d5e2f0', hills2: '#e9f0f8', accent: '#e64b4b',
    objects: [['pine', 5], ['snowman', 1], ['crystal', 2], ['rock', 1]],
  },
  candy: {
    name: 'Candy Hills', sky: ['#ffbfe0', '#fff1f8'], ground: '#ffd6ea', path: '#b892e6', pathEdge: '#8f68c4',
    hills: '#f6a1cb', hills2: '#ffc8e3', accent: '#5ec8d8',
    objects: [['lollipop', 3], ['gumdrop', 4], ['candycane', 2], ['flower', 1]],
  },
  shroom: {
    name: 'Dusk Woods', sky: ['#4b3f7f', '#b199e0'], ground: '#4d7b55', path: '#8f7456', pathEdge: '#6b553d',
    hills: '#36573f', hills2: '#4f7458', accent: '#ffd95e',
    objects: [['mushroom', 5], ['pine', 2], ['glowbug', 2], ['rock', 1]],
  },
  ruins: {
    name: 'Old Ruins', sky: ['#aab6c4', '#e9edf1'], ground: '#a9b59b', path: '#8a8a86', pathEdge: '#676764',
    hills: '#8f9b86', hills2: '#b8c2ad', accent: '#d9b46a',
    objects: [['pillar', 3], ['wall', 2], ['lamp', 2], ['house', 2], ['bush', 2]],
  },
};
const BIOME_KEYS = Object.keys(BIOMES);

export const STYLES = {
  flat: 'Storybook',
  pixel: 'Pixel',
  sketch: 'Sketchbook',
  neon: 'Neon Night',
};
const STYLE_KEYS = Object.keys(STYLES);

const zoneCache = new Map();
export function zoneOf(square) {
  return Math.floor((Math.max(1, square) - 1) / ZONE_SIZE);
}
export function zoneInfo(zone) {
  if (zoneCache.has(zone)) return zoneCache.get(zone);
  let info;
  if (zone <= 0) info = { biome: 'meadow', style: 'flat' };
  else {
    const prev = zoneInfo(zone - 1);
    const r = rng(hash(zone, 77));
    let biome, style;
    do biome = pick(r, BIOME_KEYS); while (biome === prev.biome);
    do style = pick(r, STYLE_KEYS); while (style === prev.style);
    info = { biome, style };
  }
  zoneCache.set(zone, info);
  return info;
}

// ---------------------------------------------------------------------
//  Per-square scenery
// ---------------------------------------------------------------------
const ODDITIES = [
  { type: 'sign', weight: 4 },
  { type: 'bench', weight: 2 },
  { type: 'duck', weight: 1 },
  { type: 'statue', weight: 1 },
  { type: 'mailbox', weight: 2 },
  { type: 'arch', weight: 1 },
];
const SIGN_TEXTS = [
  'Keep going.', 'You are doing great.', 'Nothing to see here.', 'Turn back? Never.',
  'Almost there (not really).', 'Free hugs ahead.', 'This way →', 'Have you tried walking?',
  'The path remembers you.', 'Wrong way. Just kidding.', 'Snacks: 9,000 squares.', 'Hi mom!',
  'Beware of ducks.', 'You found a sign!', 'Left is for quitters.', 'Rest your feet.',
];
const ODDITY_LINES = {
  sign: (t) => `A little sign reads: "${t}"`,
  bench: () => 'A bench. Someone carved their initials into it.',
  duck: () => 'An enormous rubber duck. Nobody knows why.',
  statue: () => 'A statue of a walker, pointing onward.',
  mailbox: () => 'A mailbox. It is empty… or is it?',
  arch: () => 'A stone arch. Walking through it feels important.',
};

function weighted(r, list) {
  const total = list.reduce((s, x) => s + x[1], 0);
  let v = r() * total;
  for (const [k, w] of list) { if ((v -= w) <= 0) return k; }
  return list[0][0];
}

const sceneCache = new Map();
export function sceneryFor(square) {
  if (sceneCache.has(square)) return sceneCache.get(square);
  const r = rng(hash(square, 5));
  const { biome } = zoneInfo(zoneOf(square));
  const B = BIOMES[biome];
  const objects = [];

  // far side (behind the path): 0-2 things
  const farCount = r() < 0.15 ? 0 : r() < 0.6 ? 1 : 2;
  for (let i = 0; i < farCount; i++) {
    objects.push({ type: weighted(r, B.objects), side: -1, depth: 0.15 + r() * 0.85, offset: r() - 0.5, seed: hash(square, i, 9), biome });
  }
  // near side (in front of the path): small things
  if (r() < 0.55) {
    const small = B.objects.filter(([k]) => ['flower', 'rock', 'bush', 'gumdrop', 'crystal', 'mushroom', 'tumbleweed', 'bones', 'glowbug'].includes(k));
    const list = small.length ? small : B.objects;
    objects.push({ type: weighted(r, list), side: 1, depth: r(), offset: r() - 0.5, seed: hash(square, 3, 9), biome });
  }

  // rare oddity (never on square 1 or a checkpoint)
  let oddity = null;
  if (square > 3 && !isCheckpoint(square) && rng(hash(square, 42))() < 1 / 90) {
    const r2 = rng(hash(square, 43));
    const type = weighted(r2, ODDITIES.map((o) => [o.type, o.weight]));
    const text = pick(r2, SIGN_TEXTS);
    oddity = { type, text, line: ODDITY_LINES[type](text), side: -1, depth: 0.05, offset: 0, seed: hash(square, 44), biome, big: true };
  }

  const res = { objects, oddity, biome };
  if (sceneCache.size > 4000) sceneCache.clear();
  sceneCache.set(square, res);
  return res;
}
