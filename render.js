// Canvas renderer. Draws the world in one of four art styles, in either
// left-right (side view) or up-down (top-down-ish) orientation.

import { TILE, isCheckpoint } from './constants.js';
import { BIOMES, zoneOf, zoneInfo, sceneryFor, rng, hash } from './world.js';

const TAU = Math.PI * 2;
const PAPER = '#f5efe2';
const INK = '#2b2620';
const NIGHT = '#0b0620';

// ---------------- colour helpers ----------------
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}
function neonOf(c) {
  // push a colour toward a bright, saturated version for glow lines
  const [r, g, b] = hexToRgb(c);
  const max = Math.max(r, g, b) || 1;
  return rgbToHex([r, g, b].map((v) => 90 + (v / max) * 165));
}

// ---------------- painter: one place that knows about styles ----------------
class Painter {
  constructor() { this.style = 'flat'; this.ctx = null; }
  fill(color, build) {
    const c = this.ctx;
    c.beginPath();
    build(c);
    if (this.style === 'sketch') {
      c.fillStyle = mix(color, PAPER, 0.68);
      c.fill();
      c.strokeStyle = INK; c.lineWidth = 1.7; c.lineJoin = 'round';
      c.stroke();
      c.save(); c.translate(0.9, -0.7); c.globalAlpha *= 0.4; c.stroke(); c.restore();
    } else if (this.style === 'neon') {
      c.fillStyle = mix(color, NIGHT, 0.84);
      c.fill();
      const g = neonOf(color);
      c.save();
      c.shadowBlur = 9; c.shadowColor = g; c.strokeStyle = g; c.lineWidth = 1.8; c.lineJoin = 'round';
      c.stroke();
      c.restore();
    } else {
      c.fillStyle = color;
      c.fill();
    }
  }
  line(color, width, build) {
    const c = this.ctx;
    c.beginPath();
    build(c);
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (this.style === 'sketch') { c.strokeStyle = INK; c.lineWidth = Math.max(1.5, width * 0.45); }
    else if (this.style === 'neon') { const g = neonOf(color); c.strokeStyle = g; c.shadowBlur = 8; c.shadowColor = g; c.lineWidth = Math.max(1.5, width * 0.5); }
    else { c.strokeStyle = color; c.lineWidth = width; }
    c.stroke();
    c.restore();
  }
  // solid detail that ignores style (eyes, text, glows)
  solid(color, build) {
    const c = this.ctx;
    c.beginPath(); build(c);
    c.fillStyle = this.style === 'sketch' && color !== '#ffffff' ? INK : color;
    c.fill();
  }
}

function circles(list) {
  return (c) => { for (const [x, y, r] of list) { c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU); } };
}

// ---------------- scenery objects ----------------
// each: (p, x, y = ground baseline, s = scale, B = biome, r = seeded random, t = time)
const OBJECTS = {
  tree(p, x, y, s, B, r) {
    const green = mix(B.hills, r() < 0.5 ? '#2e7d32' : '#7cc95b', 0.4);
    p.fill('#8a5a3b', (c) => c.rect(x - 4 * s, y - 30 * s, 8 * s, 30 * s));
    const h = 40 + r() * 14;
    p.fill(green, circles([[x, y - h * s, 19 * s], [x - 14 * s, y - (h - 12) * s, 14 * s], [x + 14 * s, y - (h - 10) * s, 15 * s]]));
  },
  pine(p, x, y, s, B, r) {
    const green = B === BIOMES.snow ? '#2f6b55' : '#2d5a3c';
    p.fill('#6b4430', (c) => c.rect(x - 3 * s, y - 14 * s, 6 * s, 14 * s));
    const h = 1 + r() * 0.4;
    for (let i = 0; i < 3; i++) {
      const by = y - (12 + i * 16) * s * h, w = (22 - i * 5) * s;
      p.fill(green, (c) => { c.moveTo(x - w, by); c.lineTo(x + w, by); c.lineTo(x, by - 26 * s * h); c.closePath(); });
    }
    if (B === BIOMES.snow) p.fill('#ffffff', (c) => { const ty = y - 70 * s * h; c.moveTo(x - 7 * s, ty + 10 * s); c.lineTo(x + 7 * s, ty + 10 * s); c.lineTo(x, ty - 2 * s); c.closePath(); });
  },
  bush(p, x, y, s, B) {
    p.fill(mix(B.hills, '#2e7d32', 0.25), circles([[x - 10 * s, y - 9 * s, 10 * s], [x + 2 * s, y - 13 * s, 12 * s], [x + 13 * s, y - 8 * s, 9 * s]]));
  },
  flower(p, x, y, s, B, r) {
    const col = r() < 0.5 ? B.accent : ['#ffd84d', '#ffffff', '#9b7bff', '#ff8f5a'][Math.floor(r() * 4)];
    p.line('#3b8b3b', 2.5 * s, (c) => { c.moveTo(x, y); c.quadraticCurveTo(x + 3 * s, y - 8 * s, x, y - 16 * s); });
    const pts = [];
    for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU; pts.push([x + Math.cos(a) * 5 * s, y - 16 * s + Math.sin(a) * 5 * s, 3.6 * s]); }
    p.fill(col, circles(pts));
    p.fill('#ffcf33', circles([[x, y - 16 * s, 2.6 * s]]));
  },
  rock(p, x, y, s, B, r) {
    const w = (12 + r() * 10) * s, h = (8 + r() * 9) * s;
    p.fill(mix('#8b8f99', B.ground, 0.2), (c) => {
      c.moveTo(x - w, y); c.lineTo(x - w * 0.8, y - h * 0.7); c.lineTo(x - w * 0.2, y - h);
      c.lineTo(x + w * 0.6, y - h * 0.8); c.lineTo(x + w, y); c.closePath();
    });
  },
  fence(p, x, y, s) {
    const col = '#c99a66';
    p.fill(col, (c) => { c.rect(x - 20 * s, y - 22 * s, 5 * s, 22 * s); c.rect(x + 15 * s, y - 22 * s, 5 * s, 22 * s); });
    p.fill(col, (c) => { c.rect(x - 24 * s, y - 18 * s, 48 * s, 4 * s); c.rect(x - 24 * s, y - 9 * s, 48 * s, 4 * s); });
  },
  cactus(p, x, y, s, B, r) {
    const col = '#4f9d5b', h = (40 + r() * 20) * s;
    p.fill(col, (c) => {
      c.roundRect(x - 7 * s, y - h, 14 * s, h, 7 * s);
      c.roundRect(x - 20 * s, y - h * 0.75, 8 * s, h * 0.35, 4 * s);
      c.rect(x - 16 * s, y - h * 0.48, 10 * s, 6 * s);
      c.roundRect(x + 12 * s, y - h * 0.9, 8 * s, h * 0.4, 4 * s);
      c.rect(x + 6 * s, y - h * 0.56, 10 * s, 6 * s);
    });
  },
  tumbleweed(p, x, y, s, B, r, t) {
    const rot = t * 0.6 + r() * 6;
    p.fill('#b98b4e', circles([[x, y - 10 * s, 10 * s]]));
    p.line('#8a6535', 1.5 * s, (c) => {
      for (let i = 0; i < 4; i++) { const a = rot + i; c.moveTo(x + Math.cos(a) * 9 * s, y - 10 * s + Math.sin(a) * 9 * s); c.lineTo(x - Math.cos(a) * 9 * s, y - 10 * s - Math.sin(a) * 9 * s); }
    });
  },
  bones(p, x, y, s) {
    p.fill('#f4eee0', (c) => { c.roundRect(x - 12 * s, y - 5 * s, 24 * s, 4 * s, 2 * s); });
    p.fill('#f4eee0', circles([[x - 12 * s, y - 5 * s, 3 * s], [x - 12 * s, y - 1 * s, 3 * s], [x + 12 * s, y - 5 * s, 3 * s], [x + 12 * s, y - 1 * s, 3 * s]]));
  },
  snowman(p, x, y, s) {
    p.fill('#ffffff', circles([[x, y - 13 * s, 13 * s]]));
    p.fill('#ffffff', circles([[x, y - 33 * s, 9 * s]]));
    p.solid('#222222', circles([[x - 3 * s, y - 35 * s, 1.5 * s], [x + 3 * s, y - 35 * s, 1.5 * s]]));
    p.fill('#ff8a2a', (c) => { c.moveTo(x, y - 32 * s); c.lineTo(x + 9 * s, y - 31 * s); c.lineTo(x, y - 30 * s); c.closePath(); });
  },
  crystal(p, x, y, s, B, r) {
    const h = (18 + r() * 18) * s;
    p.fill('#9fd8ff', (c) => { c.moveTo(x, y); c.lineTo(x - 7 * s, y - h * 0.6); c.lineTo(x, y - h); c.lineTo(x + 7 * s, y - h * 0.6); c.closePath(); });
  },
  lollipop(p, x, y, s, B, r) {
    const h = (40 + r() * 16) * s;
    p.fill('#ffffff', (c) => c.rect(x - 2 * s, y - h, 4 * s, h));
    const col = ['#ff5fa2', '#5ec8d8', '#ffcf33', '#9b7bff'][Math.floor(r() * 4)];
    p.fill(col, circles([[x, y - h, 15 * s]]));
    p.line('#ffffff', 2.5 * s, (c) => { for (let a = 0; a < TAU * 2; a += 0.2) { const rr = (a / (TAU * 2)) * 13 * s; const px = x + Math.cos(a) * rr, py = y - h + Math.sin(a) * rr; a === 0 ? c.moveTo(px, py) : c.lineTo(px, py); } });
  },
  gumdrop(p, x, y, s, B, r) {
    const col = ['#ff6b9a', '#6bdcff', '#a8f06b', '#ffb84d', '#c08bff'][Math.floor(r() * 5)];
    p.fill(col, (c) => { c.moveTo(x - 12 * s, y); c.quadraticCurveTo(x - 12 * s, y - 20 * s, x, y - 20 * s); c.quadraticCurveTo(x + 12 * s, y - 20 * s, x + 12 * s, y); c.closePath(); });
  },
  candycane(p, x, y, s) {
    const build = (c) => { c.moveTo(x, y); c.lineTo(x, y - 40 * s); c.arc(x - 8 * s, y - 40 * s, 8 * s, 0, Math.PI, true); };
    p.line('#ffffff', 7 * s, build);
    if (p.style === 'flat' || p.style === 'pixel') {
      const c = p.ctx; c.save(); c.setLineDash([5 * s, 5 * s]); c.beginPath(); build(c); c.strokeStyle = '#e8384f'; c.lineWidth = 7 * s; c.stroke(); c.restore();
    }
  },
  mushroom(p, x, y, s, B, r) {
    const k = 0.8 + r() * 0.9;
    p.fill('#f1e6d2', (c) => c.roundRect(x - 4 * s * k, y - 16 * s * k, 8 * s * k, 16 * s * k, 3 * s));
    const col = r() < 0.6 ? '#e04848' : '#c86bff';
    p.fill(col, (c) => { c.moveTo(x - 15 * s * k, y - 14 * s * k); c.quadraticCurveTo(x, y - 36 * s * k, x + 15 * s * k, y - 14 * s * k); c.closePath(); });
    p.solid('#ffffff', circles([[x - 6 * s * k, y - 20 * s * k, 2 * s * k], [x + 4 * s * k, y - 24 * s * k, 2.2 * s * k], [x + 8 * s * k, y - 17 * s * k, 1.6 * s * k]]));
  },
  glowbug(p, x, y, s, B, r, t) {
    const c = p.ctx;
    const ph = r() * 10;
    c.save();
    c.shadowBlur = 10; c.shadowColor = '#ffe873'; c.fillStyle = '#fff3a0';
    for (let i = 0; i < 3; i++) {
      const bx = x + Math.sin(t * 1.3 + ph + i * 2) * 14 * s, by = y - (20 + i * 12) * s + Math.cos(t * 1.7 + ph + i) * 6 * s;
      c.globalAlpha = 0.5 + 0.5 * Math.sin(t * 3 + ph + i);
      c.beginPath(); c.arc(bx, by, 2.4 * s, 0, TAU); c.fill();
    }
    c.restore();
  },
  pillar(p, x, y, s, B, r) {
    const h = (35 + r() * 40) * s, col = '#d8d2c3';
    p.fill(col, (c) => { c.rect(x - 9 * s, y - h, 18 * s, h); });
    p.fill(col, (c) => { c.rect(x - 13 * s, y - 6 * s, 26 * s, 6 * s); c.rect(x - 13 * s, y - h - 5 * s, 26 * s, 6 * s); });
  },
  wall(p, x, y, s) {
    p.fill('#b7ab96', (c) => { c.moveTo(x - 26 * s, y); c.lineTo(x - 26 * s, y - 26 * s); c.lineTo(x - 10 * s, y - 32 * s); c.lineTo(x, y - 22 * s); c.lineTo(x + 14 * s, y - 28 * s); c.lineTo(x + 26 * s, y - 14 * s); c.lineTo(x + 26 * s, y); c.closePath(); });
    p.line('#8f846f', 1.5 * s, (c) => { c.moveTo(x - 26 * s, y - 10 * s); c.lineTo(x + 26 * s, y - 10 * s); c.moveTo(x - 26 * s, y - 20 * s); c.lineTo(x + 18 * s, y - 20 * s); c.moveTo(x - 8 * s, y); c.lineTo(x - 8 * s, y - 10 * s); c.moveTo(x + 10 * s, y - 10 * s); c.lineTo(x + 10 * s, y - 20 * s); });
  },
  lamp(p, x, y, s) {
    const c = p.ctx;
    c.save(); c.globalAlpha = 0.25; c.fillStyle = '#ffe9a3'; c.beginPath(); c.arc(x, y - 52 * s, 16 * s, 0, TAU); c.fill(); c.restore();
    p.line('#4a4a52', 3 * s, (cc) => { cc.moveTo(x, y); cc.lineTo(x, y - 50 * s); });
    p.fill('#ffe27a', (cc) => cc.roundRect(x - 5 * s, y - 58 * s, 10 * s, 10 * s, 2 * s));
  },
  house(p, x, y, s, B, r) {
    const col = ['#e8c1a0', '#c9d6df', '#f0d78c', '#d9b8d8'][Math.floor(r() * 4)];
    p.fill(col, (c) => c.rect(x - 22 * s, y - 32 * s, 44 * s, 32 * s));
    p.fill('#a5523f', (c) => { c.moveTo(x - 27 * s, y - 32 * s); c.lineTo(x, y - 54 * s); c.lineTo(x + 27 * s, y - 32 * s); c.closePath(); });
    p.fill('#6b4a3a', (c) => c.rect(x - 5 * s, y - 16 * s, 10 * s, 16 * s));
    p.fill('#bfe3ff', (c) => { c.rect(x - 17 * s, y - 25 * s, 8 * s, 8 * s); c.rect(x + 9 * s, y - 25 * s, 8 * s, 8 * s); });
  },

  // ---------- oddities (big, rare) ----------
  sign(p, x, y, s, B, r, t, odd) {
    p.fill('#8a5a3b', (c) => c.rect(x - 3 * s, y - 44 * s, 6 * s, 44 * s));
    p.fill('#e9c48a', (c) => c.roundRect(x - 52 * s, y - 72 * s, 104 * s, 32 * s, 4 * s));
    const c = p.ctx;
    c.save();
    c.fillStyle = p.style === 'neon' ? '#ffe9a3' : '#4a2f1c';
    c.font = `600 ${Math.round(9.5 * s)}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    wrapText(c, odd.text, x, y - 56 * s, 96 * s, 11 * s);
    c.restore();
  },
  bench(p, x, y, s) {
    const col = '#a0673d';
    p.fill('#4a4a52', (c) => { c.rect(x - 26 * s, y - 14 * s, 4 * s, 14 * s); c.rect(x + 22 * s, y - 14 * s, 4 * s, 14 * s); });
    p.fill(col, (c) => { c.rect(x - 32 * s, y - 18 * s, 64 * s, 6 * s); c.rect(x - 32 * s, y - 34 * s, 64 * s, 6 * s); c.rect(x - 32 * s, y - 26 * s, 64 * s, 5 * s); });
  },
  duck(p, x, y, s, B, r, t) {
    const bob = Math.sin(t * 2) * 2 * s;
    p.fill('#ffd93b', (c) => { c.ellipse(x, y - 24 * s + bob, 40 * s, 24 * s, 0, 0, TAU); });
    p.fill('#ffd93b', circles([[x + 26 * s, y - 56 * s + bob, 18 * s]]));
    p.fill('#ff8a2a', (c) => { c.ellipse(x + 46 * s, y - 52 * s + bob, 10 * s, 5 * s, 0, 0, TAU); });
    p.solid('#222222', circles([[x + 32 * s, y - 61 * s + bob, 2.8 * s]]));
  },
  statue(p, x, y, s) {
    const col = '#b9bec7';
    p.fill('#8e939c', (c) => c.rect(x - 22 * s, y - 22 * s, 44 * s, 22 * s));
    p.fill(col, (c) => { c.ellipse(x, y - 50 * s, 13 * s, 20 * s, 0, 0, TAU); });
    p.fill(col, circles([[x, y - 78 * s, 10 * s]]));
    p.line(col, 6 * s, (c) => { c.moveTo(x + 8 * s, y - 58 * s); c.lineTo(x + 30 * s, y - 70 * s); });
  },
  mailbox(p, x, y, s) {
    p.fill('#6b4430', (c) => c.rect(x - 3 * s, y - 34 * s, 6 * s, 34 * s));
    p.fill('#3d6fd1', (c) => c.roundRect(x - 16 * s, y - 50 * s, 32 * s, 18 * s, 8 * s));
    p.fill('#e8384f', (c) => c.rect(x + 12 * s, y - 60 * s, 3 * s, 14 * s));
  },
  arch(p, x, y, s) {
    p.fill('#b7ab96', (c) => {
      c.moveTo(x - 46 * s, y); c.lineTo(x - 46 * s, y - 70 * s); c.arc(x, y - 70 * s, 46 * s, Math.PI, 0); c.lineTo(x + 46 * s, y);
      c.lineTo(x + 30 * s, y); c.lineTo(x + 30 * s, y - 70 * s); c.arc(x, y - 70 * s, 30 * s, 0, Math.PI, true); c.lineTo(x - 30 * s, y); c.closePath();
    });
  },
};

function wrapText(c, text, x, y, maxW, lh) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (c.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  const y0 = y - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => c.fillText(l, x, y0 + i * lh));
}

// ---------------- avatar ----------------
export function drawAvatar(p, x, y, opts) {
  const { facing = 1, phase = 0, equipped = {}, color = '#ffffff', s = 1 } = opts;
  const c = p.ctx;
  // shadow
  c.save(); c.globalAlpha *= 0.22; c.fillStyle = '#000'; c.beginPath(); c.ellipse(x, y, 16 * s, 5 * s, 0, 0, TAU); c.fill(); c.restore();
  // legs
  const l1 = Math.sin(phase) * 5 * s, l2 = -l1;
  p.line('#3a3340', 4 * s, (cc) => { cc.moveTo(x - 6 * s, y - 10 * s); cc.lineTo(x - 6 * s + l1, y - 1 * s); cc.moveTo(x + 6 * s, y - 10 * s); cc.lineTo(x + 6 * s + l2, y - 1 * s); });
  const bob = Math.abs(Math.sin(phase)) * 2 * s;
  const by = y - 27 * s - bob;
  // body
  p.fill(color, (cc) => cc.ellipse(x, by, 16 * s, 18 * s, 0, 0, TAU));
  // scarf
  if (equipped.neck === 'scarf') {
    p.fill('#e0433c', (cc) => { cc.roundRect(x - 15 * s, by + 2 * s, 30 * s, 7 * s, 3 * s); });
    p.fill('#e0433c', (cc) => { cc.roundRect(x - facing * 9 * s - 3.5 * s, by + 6 * s, 7 * s, 13 * s, 2 * s); });
    p.line('#ffd2cc', 1.2 * s, (cc) => { cc.moveTo(x - 6 * s, by + 3 * s); cc.lineTo(x - 6 * s, by + 8 * s); cc.moveTo(x + 4 * s, by + 3 * s); cc.lineTo(x + 4 * s, by + 8 * s); });
  }
  // eyes
  const ex = x + facing * 4 * s, ey = by - 5 * s;
  p.solid('#ffffff', circles([[ex - 5 * s, ey, 4.2 * s], [ex + 5 * s, ey, 4.2 * s]]));
  const ctx = p.ctx;
  ctx.beginPath(); ctx.fillStyle = '#1d1a22';
  ctx.arc(ex - 5 * s + facing * 1.5 * s, ey, 2 * s, 0, TAU); ctx.moveTo(ex + 5 * s, ey); ctx.arc(ex + 5 * s + facing * 1.5 * s, ey, 2 * s, 0, TAU); ctx.fill();
  if (equipped.face === 'sunglasses') {
    ctx.save();
    ctx.fillStyle = '#111'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.roundRect(ex - 10.5 * s, ey - 4 * s, 9 * s, 7 * s, 2.5 * s); ctx.roundRect(ex + 1.5 * s, ey - 4 * s, 9 * s, 7 * s, 2.5 * s); ctx.fill();
    ctx.beginPath(); ctx.moveTo(ex - 1.5 * s, ey - 2 * s); ctx.lineTo(ex + 1.5 * s, ey - 2 * s); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(ex - 9 * s, ey - 3 * s, 2.5 * s, 1.5 * s); ctx.fillRect(ex + 3 * s, ey - 3 * s, 2.5 * s, 1.5 * s);
    ctx.restore();
  }
  // hat
  if (equipped.head === 'fun_hat') {
    const hy = by - 15 * s, apx = x + facing * 3 * s, apy = hy - 28 * s;
    p.fill('#8b5cf6', (cc) => { cc.moveTo(x - 11 * s, hy); cc.lineTo(x + 11 * s, hy); cc.lineTo(apx, apy); cc.closePath(); });
    if (p.style === 'flat' || p.style === 'pixel') {
      ctx.save(); ctx.beginPath(); ctx.moveTo(x - 11 * s, hy); ctx.lineTo(x + 11 * s, hy); ctx.lineTo(apx, apy); ctx.closePath(); ctx.clip();
      ctx.fillStyle = '#ffd23f';
      for (let i = 0; i < 4; i++) { ctx.fillRect(x - 14 * s, hy - (5 + i * 7) * s, 28 * s, 2.6 * s); }
      ctx.restore();
    }
    p.fill('#ff5fa2', circles([[apx, apy, 4.5 * s]]));
  }
}

// ---------------- renderer ----------------
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.main = canvas.getContext('2d');
    this.pixCanvas = document.createElement('canvas');
    this.pixCtx = this.pixCanvas.getContext('2d');
    this.p = new Painter();
    this.orientation = 'horizontal';
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.pixCanvas.width = Math.ceil(this.W / 4);
    this.pixCanvas.height = Math.ceil(this.H / 4);
  }

  // ---- layout ----
  layout() {
    const { W } = this;
    const H = this.H - (this.insetBottom || 0);
    if (this.orientation === 'horizontal') {
      this.playerX = Math.round(W * 0.38);
      this.horizonY = Math.round(H * 0.42);
      this.pathY = Math.round(H * 0.66);
      this.pathHalf = 30;
    } else {
      this.pathX = Math.round(W * 0.5);
      this.playerY = Math.round(H * 0.64);
      this.pathHalf = 32;
    }
  }
  // screen position of the centre of square u
  sx(u) { return this.playerX + (u - this.camU) * TILE; }
  sy(u) { return this.playerY - (u - this.camU) * TILE; }

  visibleRange() {
    if (this.orientation === 'horizontal') {
      return [Math.floor(this.camU - this.playerX / TILE) - 2, Math.ceil(this.camU + (this.W - this.playerX) / TILE) + 2];
    }
    return [Math.floor(this.camU - (this.H - this.playerY) / TILE) - 2, Math.ceil(this.camU + this.playerY / TILE) + 3];
  }

  // where an object (side/depth/offset) sits on screen
  place(u, obj) {
    if (this.orientation === 'horizontal') {
      const x = this.sx(u + obj.offset * 0.8);
      const top = this.pathY - this.pathHalf;
      const bottom = this.pathY + this.pathHalf;
      if (obj.side < 0) {
        const y = top - 6 - obj.depth * (top - 6 - (this.horizonY + 10));
        return { x, y, s: (0.55 + (1 - obj.depth) * 0.5) * (obj.big ? 1.15 : 1) };
      }
      const y = bottom + 22 + obj.depth * Math.max(10, this.H - bottom - 30);
      return { x, y, s: 1.05 + obj.depth * 0.35 };
    }
    const y = this.sy(u + obj.offset * 0.8) + 18;
    const room = Math.max(40, this.W / 2 - this.pathHalf - 60);
    const side = obj.big ? -1 : obj.side < 0 ? (hash(obj.seed, 1) % 2 ? -1 : 1) : (hash(obj.seed, 2) % 2 ? 1 : -1);
    const x = this.pathX + side * (this.pathHalf + 34 + (obj.big ? 30 : obj.depth * room));
    return { x, y, s: obj.big ? 1.1 : 0.9 };
  }

  // contiguous zone segments across the visible range
  segments(u0, u1) {
    const segs = [];
    let cur = null;
    for (let u = u0; u <= u1; u++) {
      const z = zoneOf(Math.max(1, u));
      if (!cur || cur.zone !== z) { cur = { zone: z, u0: u, u1: u }; segs.push(cur); } else cur.u1 = u;
    }
    return segs;
  }

  draw(view) {
    this.camU = view.camU;
    this.layout();
    const zone = zoneInfo(zoneOf(Math.round(view.camU)));
    const style = zone.style;
    this.p.style = style;

    const target = style === 'pixel' ? this.pixCtx : this.main;
    if (style === 'pixel') target.setTransform(0.25, 0, 0, 0.25, 0, 0);
    else target.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    target.globalAlpha = 1;
    this.p.ctx = target;

    const [u0, u1] = this.visibleRange();
    const segs = this.segments(u0, u1);

    if (this.orientation === 'horizontal') this.drawHorizontal(view, segs, u0, u1, style);
    else this.drawVertical(view, segs, u0, u1, style);

    if (style === 'pixel') {
      const m = this.main;
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.imageSmoothingEnabled = false;
      m.drawImage(this.pixCanvas, 0, 0, this.pixCanvas.width, this.pixCanvas.height, 0, 0, this.pixCanvas.width * 4 * this.dpr, this.pixCanvas.height * 4 * this.dpr);
    }
    // overlays that must stay crisp
    this.main.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.p.ctx = this.main;
    this.drawOverlays(view, style);
  }

  // ---------------- horizontal (side view) ----------------
  drawHorizontal(view, segs, u0, u1, style) {
    const c = this.p.ctx, { W, H } = this;
    for (const seg of segs) {
      const B = BIOMES[zoneInfo(seg.zone).biome];
      const x0 = Math.max(0, this.sx(seg.u0 - 0.5)), x1 = Math.min(W, this.sx(seg.u1 + 0.5));
      if (x1 <= x0) continue;
      c.save();
      c.beginPath(); c.rect(x0, 0, x1 - x0 + 0.5, H); c.clip();
      this.drawSkyAndGround(B, style, seg.zone, view.time);
      c.restore();
    }

    // scenery behind the path
    const far = [], near = [];
    for (let u = Math.max(1, u0); u <= u1; u++) {
      const sc = sceneryFor(u);
      for (const o of sc.objects) (o.side < 0 ? far : near).push({ u, o });
      if (sc.oddity) far.push({ u, o: sc.oddity });
    }
    const drawObj = ({ u, o }) => {
      const pos = this.place(u, o);
      const fn = OBJECTS[o.type];
      if (fn) fn(this.p, pos.x, pos.y, pos.s, BIOMES[o.biome], rng(o.seed), view.time, o);
    };
    far.sort((a, b) => this.place(a.u, a.o).y - this.place(b.u, b.o).y).forEach(drawObj);

    // start wall
    if (u0 <= 1) this.drawStart(this.sx(0.5), this.pathY, 'h');

    // path tiles
    for (let u = Math.max(1, u0); u <= u1; u++) this.drawTileH(u, view);

    // checkpoint flags
    for (let u = Math.max(1, u0); u <= u1; u++) {
      if (isCheckpoint(u)) this.drawFlag(this.sx(u) + 26, this.pathY - this.pathHalf + 6, u, u <= view.savedSquare, 1);
    }

    // players
    this.drawPlayers(view, (dispU) => ({ x: this.sx(dispU), y: this.pathY + 10 }));

    near.sort((a, b) => this.place(a.u, a.o).y - this.place(b.u, b.o).y).forEach(drawObj);
  }

  drawSkyAndGround(B, style, zone, time) {
    const c = this.p.ctx, { W, H } = this, hy = this.horizonY;
    const r = rng(hash(zone, 99));
    // sky
    if (style === 'neon') {
      const g = c.createLinearGradient(0, 0, 0, hy);
      g.addColorStop(0, '#07041a'); g.addColorStop(1, mix(B.sky[0], '#1a0b3a', 0.7));
      c.fillStyle = g; c.fillRect(0, 0, W, hy);
      c.fillStyle = '#ffffff';
      for (let i = 0; i < 60; i++) { const x = (r() * W * 2 + this.camU * TILE * 0.05) % W, y = r() * hy * 0.9; c.globalAlpha = 0.3 + r() * 0.6; c.fillRect(x, y, 1.5, 1.5); }
      c.globalAlpha = 1;
      // synthwave sun
      const sx = W * 0.72, sy = hy - 10, sr = Math.min(90, W * 0.12);
      const sg = c.createLinearGradient(0, sy - sr, 0, sy + sr);
      sg.addColorStop(0, '#ffe36b'); sg.addColorStop(1, '#ff3ea5');
      c.save(); c.beginPath(); c.arc(sx, sy, sr, Math.PI, 0); c.closePath(); c.clip();
      c.fillStyle = sg; c.fillRect(sx - sr, sy - sr, sr * 2, sr);
      c.fillStyle = '#07041a';
      for (let i = 0; i < 5; i++) c.fillRect(sx - sr, sy - 8 - i * 12, sr * 2, 2 + i * 0.6);
      c.restore();
    } else if (style === 'sketch') {
      c.fillStyle = PAPER; c.fillRect(0, 0, W, H);
      c.strokeStyle = 'rgba(43,38,32,0.08)'; c.lineWidth = 1;
      c.beginPath(); for (let y = 24; y < H; y += 24) { c.moveTo(0, y); c.lineTo(W, y); } c.stroke();
    } else {
      const g = c.createLinearGradient(0, 0, 0, hy);
      g.addColorStop(0, B.sky[0]); g.addColorStop(1, B.sky[1]);
      c.fillStyle = g; c.fillRect(0, 0, W, hy + 2);
    }
    // clouds (not at night)
    if (style !== 'neon') {
      for (let i = 0; i < 6; i++) {
        const span = W + 300;
        const x = (((r() * span - this.camU * TILE * 0.15 - time * 6) % span) + span) % span - 150;
        const y = 30 + r() * hy * 0.45, s = 0.7 + r() * 0.8;
        this.p.fill('#ffffff', circles([[x, y, 18 * s], [x + 20 * s, y - 8 * s, 22 * s], [x + 42 * s, y, 16 * s]]));
      }
    }
    // hills (two parallax layers)
    const layers = [[B.hills2, 0.25, 55, 0.0031], [B.hills, 0.45, 32, 0.0047]];
    for (const [col, par, amp, freq] of layers) {
      this.p.fill(col, (cc) => {
        cc.moveTo(0, hy + 4);
        for (let x = 0; x <= W; x += 16) {
          const wx = x + this.camU * TILE * par + zone * 997;
          const y = hy - amp * (0.55 + 0.45 * Math.sin(wx * freq) * Math.sin(wx * freq * 0.37 + 1.3)) - 8;
          cc.lineTo(x, y);
        }
        cc.lineTo(W, hy + 4); cc.closePath();
      });
    }
    // ground
    if (style === 'neon') {
      c.fillStyle = '#0c0620'; c.fillRect(0, hy, W, H - hy);
      const g = neonOf(B.accent);
      c.save(); c.strokeStyle = g; c.shadowBlur = 6; c.shadowColor = g; c.lineWidth = 1; c.globalAlpha = 0.55;
      c.beginPath();
      for (let i = 1; i < 14; i++) { const t = i / 14, y = hy + (H - hy) * t * t; c.moveTo(0, y); c.lineTo(W, y); }
      const vx = W / 2;
      const first = Math.floor(this.camU - this.playerX / TILE) - 30;
      for (let k = first; k < first + 80; k++) {
        const xb = this.sx(k + 0.5);
        const xb2 = vx + (xb - vx) * 3;
        c.moveTo(vx + (xb - vx) * 0.08, hy); c.lineTo(xb2, H * 1.8);
      }
      c.stroke(); c.restore();
    } else if (style === 'sketch') {
      c.strokeStyle = INK; c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(0, hy + 2); c.lineTo(W, hy + 2); c.stroke();
      c.strokeStyle = 'rgba(43,38,32,0.25)';
      c.beginPath();
      for (let i = 0; i < 70; i++) { const x = ((r() * W * 3 - this.camU * TILE) % W + W) % W, y = hy + 10 + r() * (H - hy); c.moveTo(x, y); c.lineTo(x + 6, y - 5); }
      c.stroke();
    } else {
      c.fillStyle = B.ground; c.fillRect(0, hy, W, H - hy);
      c.fillStyle = mix(B.ground, '#000000', 0.08);
      for (let i = 0; i < 90; i++) { const x = ((r() * W * 3 - this.camU * TILE) % W + W) % W, y = hy + 8 + r() * (H - hy); c.fillRect(x, y, 3, 2); }
    }
  }

  drawTileH(u, view) {
    const B = BIOMES[zoneInfo(zoneOf(u)).biome];
    const x = this.sx(u), y = this.pathY, h = this.pathHalf;
    const cp = isCheckpoint(u);
    const col = cp ? (u <= view.savedSquare ? '#7fd69a' : '#ffb35c') : B.path;
    this.p.fill(mix(col, '#000000', 0.18), (c) => c.roundRect(x - TILE / 2 + 3, y - h + 5, TILE - 6, h * 2, 7));
    this.p.fill(col, (c) => c.roundRect(x - TILE / 2 + 3, y - h, TILE - 6, h * 2, 7));
    this.tileNumber(u, x, y + h - 9, B);
  }

  tileNumber(u, x, y, B) {
    const c = this.p.ctx;
    c.save();
    c.fillStyle = this.p.style === 'neon' ? neonOf(B.path) : this.p.style === 'sketch' ? INK : mix(B.pathEdge, '#000000', 0.15);
    c.globalAlpha = 0.85;
    c.font = `700 ${u >= 100000 ? 9 : 11}px ui-monospace, Menlo, monospace`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(u), x, y);
    c.restore();
  }

  drawFlag(x, baseY, u, cleared, s) {
    const col = cleared ? '#36b36a' : '#e8484f';
    this.p.line('#5a5560', 3.5 * s, (c) => { c.moveTo(x, baseY); c.lineTo(x, baseY - 84 * s); });
    this.p.fill(col, (c) => { c.moveTo(x, baseY - 84 * s); c.lineTo(x + 44 * s, baseY - 72 * s); c.lineTo(x, baseY - 58 * s); c.closePath(); });
    const c = this.p.ctx;
    c.save();
    c.fillStyle = '#ffffff'; c.font = `800 ${Math.round(10 * s)}px system-ui, sans-serif`; c.textBaseline = 'middle';
    c.fillText(cleared ? '✓' : '!', x + 8 * s, baseY - 71 * s);
    c.restore();
  }

  drawStart(x, y, mode) {
    // a little stone wall marking the edge of the world, with a sign
    if (mode === 'h') {
      this.p.fill('#9a948a', (c) => c.roundRect(x - 16, y - 70, 14, 110, 4));
      this.p.fill('#8a5a3b', (c) => c.rect(x - 52, y - this.pathHalf - 58, 5, 58));
      this.p.fill('#e9c48a', (c) => c.roundRect(x - 86, y - this.pathHalf - 84, 72, 30, 4));
      const c = this.p.ctx; c.save();
      c.fillStyle = this.p.style === 'neon' ? '#ffe9a3' : '#4a2f1c'; c.font = '800 11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('SQUARE ONE', x - 50, y - this.pathHalf - 69); c.restore();
    } else {
      this.p.fill('#9a948a', (c) => c.roundRect(this.pathX - this.pathHalf - 30, y + 2, (this.pathHalf + 30) * 2, 14, 4));
      const c = this.p.ctx; c.save();
      c.fillStyle = this.p.style === 'neon' ? '#ffe9a3' : '#4a2f1c'; c.font = '800 11px system-ui, sans-serif'; c.textAlign = 'center';
      c.fillText('SQUARE ONE', this.pathX, y + 34); c.restore();
    }
  }

  drawPlayers(view, posOf) {
    const list = [];
    for (const o of view.others) list.push({ ...o, ghost: true });
    list.push({ ...view.player, ghost: false });
    list.sort((a, b) => (a.ghost === b.ghost ? 0 : a.ghost ? -1 : 1));
    const c = this.p.ctx;
    for (const pl of list) {
      let { x, y } = posOf(pl.dispU);
      if (pl.ghost && this.orientation === 'vertical') x += pl.lat || 0;
      c.save();
      if (pl.ghost) c.globalAlpha = 0.62;
      drawAvatar(this.p, x, y, pl);
      c.restore();
    }
  }

  // ---------------- vertical (path goes up the screen) ----------------
  drawVertical(view, segs, u0, u1, style) {
    const c = this.p.ctx, { W, H } = this;
    for (const seg of segs) {
      const B = BIOMES[zoneInfo(seg.zone).biome];
      const yTop = Math.max(0, this.sy(seg.u1 + 0.5)), yBot = Math.min(H, this.sy(seg.u0 - 0.5));
      if (yBot <= yTop) continue;
      const r = rng(hash(seg.zone, 98));
      c.save(); c.beginPath(); c.rect(0, yTop, W, yBot - yTop + 0.5); c.clip();
      if (style === 'neon') {
        c.fillStyle = '#0c0620'; c.fillRect(0, 0, W, H);
        const g = neonOf(B.accent);
        c.save(); c.strokeStyle = g; c.globalAlpha = 0.35; c.shadowBlur = 5; c.shadowColor = g; c.lineWidth = 1;
        c.beginPath();
        const off = ((this.camU * TILE) % 48 + 48) % 48;
        for (let y = -48 + off; y < H + 48; y += 48) { c.moveTo(0, y); c.lineTo(W, y); }
        for (let x = (W / 2) % 48; x < W; x += 48) { c.moveTo(x, 0); c.lineTo(x, H); }
        c.stroke(); c.restore();
      } else if (style === 'sketch') {
        c.fillStyle = PAPER; c.fillRect(0, 0, W, H);
        c.strokeStyle = 'rgba(43,38,32,0.22)'; c.lineWidth = 1; c.beginPath();
        for (let i = 0; i < 120; i++) { const x = r() * W, y = ((r() * H * 3 + this.camU * TILE) % H + H) % H; c.moveTo(x, y); c.lineTo(x + 6, y - 5); }
        c.stroke();
      } else {
        c.fillStyle = B.ground; c.fillRect(0, 0, W, H);
        c.fillStyle = mix(B.ground, '#000000', 0.08);
        for (let i = 0; i < 140; i++) { const x = r() * W, y = ((r() * H * 3 + this.camU * TILE) % H + H) % H; c.fillRect(x, y, 3, 2); }
      }
      c.restore();
    }

    // path tiles
    for (let u = Math.max(1, u0); u <= u1; u++) {
      const B = BIOMES[zoneInfo(zoneOf(u)).biome];
      const y = this.sy(u), x = this.pathX, h = this.pathHalf;
      const cp = isCheckpoint(u);
      const col = cp ? (u <= view.savedSquare ? '#7fd69a' : '#ffb35c') : B.path;
      this.p.fill(mix(col, '#000000', 0.18), (cc) => cc.roundRect(x - h, y - TILE / 2 + 7, h * 2, TILE - 6, 7));
      this.p.fill(col, (cc) => cc.roundRect(x - h, y - TILE / 2 + 3, h * 2, TILE - 6, 7));
      this.tileNumber(u, x - h + 15, y + TILE / 2 - 11, B);
    }
    if (u0 <= 1) this.drawStart(this.pathX, this.sy(0.5), 'v');

    // everything standing up, sorted by screen y
    const items = [];
    for (let u = Math.max(1, u0); u <= u1; u++) {
      const sc = sceneryFor(u);
      for (const o of sc.objects) items.push({ kind: 'obj', u, o, y: this.place(u, o).y });
      if (sc.oddity) items.push({ kind: 'obj', u, o: sc.oddity, y: this.place(u, sc.oddity).y });
      if (isCheckpoint(u)) items.push({ kind: 'flag', u, y: this.sy(u) + 10 });
    }
    items.push({ kind: 'players', y: this.sy(view.camU) + 14 });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) {
      if (it.kind === 'obj') {
        const pos = this.place(it.u, it.o);
        const fn = OBJECTS[it.o.type];
        if (fn) fn(this.p, pos.x, pos.y, pos.s, BIOMES[it.o.biome], rng(it.o.seed), view.time, it.o);
      } else if (it.kind === 'flag') {
        this.drawFlag(this.pathX + this.pathHalf + 12, this.sy(it.u) + 10, it.u, it.u <= view.savedSquare, 0.9);
      } else {
        this.drawPlayers(view, (dispU) => ({ x: this.pathX, y: this.sy(dispU) + 14 }));
      }
    }
  }

  // ---------------- crisp overlays: name tags + comment bubbles ----------------
  drawOverlays(view, style) {
    const c = this.main;
    const [u0, u1] = this.visibleRange();
    const H = this.orientation === 'horizontal';
    // comment bubbles
    for (let u = Math.max(1, u0); u <= u1; u++) {
      const n = view.counts[u];
      if (!n) continue;
      const x = H ? this.sx(u) + 18 : this.pathX + this.pathHalf - 6;
      const y = H ? this.pathY - this.pathHalf - 4 : this.sy(u) - TILE / 2 + 12;
      c.save();
      c.fillStyle = n >= 100 ? '#e8484f' : '#ffffff';
      c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 1;
      c.beginPath(); c.roundRect(x - 13, y - 10, 26, 17, 6); c.moveTo(x - 4, y + 7); c.lineTo(x - 8, y + 12); c.lineTo(x + 1, y + 7); c.fill(); c.stroke();
      c.fillStyle = n >= 100 ? '#ffffff' : '#333';
      c.font = '700 10px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(n >= 100 ? 'FULL' : String(n), x, y - 1.5);
      c.restore();
    }
    // name tags for other players
    for (const o of view.others) {
      const x = H ? this.sx(o.dispU) : this.pathX + (o.lat || 0);
      const y = H ? this.pathY + 10 - 78 : this.sy(o.dispU) + 14 - 78;
      c.save();
      c.font = '600 11px system-ui, sans-serif';
      const w = c.measureText(o.name).width + 12;
      c.fillStyle = 'rgba(20,16,30,0.6)';
      c.beginPath(); c.roundRect(x - w / 2, y - 9, w, 17, 8); c.fill();
      c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(o.name, x, y);
      c.restore();
    }
  }
}
