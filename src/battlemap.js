// The battle map: a 12×8 grid of 5-foot squares drawn over a pixel-art floor that matches the dungeon level (cellar
// flagstones, flooded crypt slabs, fungus and moss, forge plates with lava, black glass with runes). Heroes start by the
// door on the left, monsters on the right. Pillars, barrels, tombs and the like block movement. Large monsters take
// 2×2 squares, Huge and bigger 3×3.
import { Grid, ramp, hex, mix, rng, drawMonster, drawHero, png, scaleUp } from './sprites.js';

export const TILE = 32, WALL = 1; // one row of wall drawn above the floor
export const FP = { Tiny: 1, Small: 1, Medium: 1, Large: 2, Huge: 3, Gargantuan: 3 };

// ---------- the five looks ----------
export const THEMES = [
  { name: 'cellar', floor: '#5d5249', grout: '#3a312b', wall: '#6a4a3a', mortar: '#3b2a22', blockers: ['barrel', 'crate', 'barrel', 'pillar'], decor: ['straw', 'puddle', 'crack', 'bones'] },
  { name: 'crypt', floor: '#46525a', grout: '#2a3238', wall: '#4d5961', mortar: '#2b3238', blockers: ['tomb', 'pillar', 'tomb', 'urn'], decor: ['puddle', 'bones', 'puddle', 'crack'] },
  { name: 'fungal', floor: '#3e4634', grout: '#2a2f22', wall: '#4b4a3a', mortar: '#2d2c22', blockers: ['mushroom', 'rock', 'mushroom'], decor: ['moss', 'shroom', 'moss', 'shroom'] },
  { name: 'forge', floor: '#4c4440', grout: '#2b2523', wall: '#5a4038', mortar: '#2c1f1b', blockers: ['anvil', 'lava', 'pillar', 'lava'], decor: ['glowcrack', 'chain', 'crack'] },
  { name: 'dark', floor: '#2f2839', grout: '#1c1724', wall: '#3a3048', mortar: '#1d1726', blockers: ['crystal', 'pillar', 'crystal'], decor: ['rune', 'crack', 'rune'] },
];
export const themeFor = (floor) => THEMES[Math.max(0, Math.min(THEMES.length - 1, floor - 1))];

// ---------- the field ----------
// Room sizes, small to big. Shapes: plain, corners cut off, L-shaped, a hall with rows of pillars, or a rough cave.
export const SIZES = [[7, 5], [8, 6], [9, 6], [10, 7], [12, 8], [14, 9], [16, 10]];
export function roomDims(kind, seed) {
  const r = rng(`dims|${seed}`);
  const pickOf = (a) => a[Math.floor(r() * a.length)];
  let size;
  if (kind === 'boss') size = [16, 10];
  else if (kind === 'stairs') size = pickOf([[12, 8], [14, 9]]);
  else if (kind === 'start' || kind === 'rest') size = pickOf([[7, 5], [8, 6]]);
  else size = pickOf(SIZES.slice(0, 6));
  const [w, h] = size;
  const shapes = ['rect', 'rect', 'cut'];
  if (w >= 9 && h >= 6) shapes.push('L', 'cave');
  if (w >= 10) shapes.push('pillars');
  return { w, h, shape: kind === 'boss' ? pickOf(['pillars', 'rect', 'cave']) : pickOf(shapes) };
}
// One size up (when a fight needs more room).
export function biggerDims(d) {
  const i = SIZES.findIndex(([w, h]) => w > d.w || h > d.h);
  return i < 0 ? { ...d, shape: 'rect' } : { w: SIZES[i][0], h: SIZES[i][1], shape: d.shape === 'L' ? 'cut' : d.shape };
}

// blocked: 0 floor, 1 something in the way (barrel, pillar…), 2 solid rock/wall.
export function makeField(floor, seed, dims = { w: 12, h: 8, shape: 'rect' }) {
  const r = rng(`field|${seed}|${dims.w}x${dims.h}|${dims.shape}`);
  const theme = themeFor(floor);
  const { w, h, shape } = dims;
  const blocked = new Uint8Array(w * h);
  const at = (x, y) => y * w + x;
  const things = [];
  // carve the shape (the three columns by the door always stay open)
  if (shape === 'cut') for (const [cx, cy, sx, sy] of [[w - 1, 0, -1, 1], [w - 1, h - 1, -1, -1], [0, 0, 1, 1], [0, h - 1, 1, -1]].slice(0, 2 + Math.floor(r() * 3))) {
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2 - k; j++) { const x = cx + sx * j, y = cy + sy * k; if (x > 2 || cx > 2) blocked[at(x, y)] = 2; }
  }
  if (shape === 'L') {
    const qw = Math.floor(w / 3) + Math.floor(r() * 2), qh = Math.floor(h / 2) - (r() < 0.5 ? 1 : 0), top = r() < 0.5;
    for (let y = 0; y < qh; y++) for (let x = w - qw; x < w; x++) blocked[at(x, top ? y : h - 1 - y)] = 2;
  }
  if (shape === 'cave') {
    for (let x = 3; x < w; x++) { if (r() < 0.45) blocked[at(x, 0)] = 2; if (r() < 0.45) blocked[at(x, h - 1)] = 2; }
    for (let y = 0; y < h; y++) if (r() < 0.4) blocked[at(w - 1, y)] = 2;
    for (let n = 0; n < Math.floor(w * h / 30); n++) { const x = 4 + Math.floor(r() * (w - 6)), y = 1 + Math.floor(r() * (h - 2)); blocked[at(x, y)] = 2; if (r() < 0.5 && x + 1 < w) blocked[at(x + 1, y)] = 2; }
  }
  if (shape === 'pillars') {
    for (let x = 4; x < w - 2; x += 3) for (const y of [1, h - 2]) if (!blocked[at(x, y)]) { blocked[at(x, y)] = 1; things.push({ x, y, kind: 'pillar', block: true }); }
  }
  // floor cut off from the door becomes rock too
  {
    const seen = new Uint8Array(w * h); const q = [at(0, Math.floor(h / 2))]; seen[q[0]] = 1;
    while (q.length) {
      const i = q.pop(), x = i % w, y = Math.floor(i / w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, j = at(nx, ny);
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && !blocked[j] && !seen[j]) { seen[j] = 1; q.push(j); }
      }
    }
    for (let i = 0; i < blocked.length; i++) if (!blocked[i] && !seen[i]) blocked[i] = 2;
  }
  // obstacles in the middle, more in bigger rooms, never walling anyone off
  const n = Math.max(1, Math.round((w * h) / 22 + r() * 2));
  for (let i = 0, tries = 0; i < n && tries < 80; tries++) {
    const x = 3 + Math.floor(r() * Math.max(1, w - 5)), y = Math.floor(r() * h);
    if (blocked[at(x, y)]) continue;
    blocked[at(x, y)] = 1;
    if (!connected(blocked, w, h)) { blocked[at(x, y)] = 0; continue; }
    things.push({ x, y, kind: theme.blockers[Math.floor(r() * theme.blockers.length)], block: true });
    i++;
  }
  for (let i = 0; i < Math.round(w * h / 14); i++) {
    const x = Math.floor(r() * w), y = Math.floor(r() * h);
    if (!blocked[at(x, y)]) things.push({ x, y, kind: theme.decor[Math.floor(r() * theme.decor.length)], block: false });
  }
  return { w, h, shape, blocked, things, theme: theme.name, floor, seed };
}
function connected(blocked, w, h) {
  const start = blocked.indexOf(0);
  if (start < 0) return false;
  const seen = new Uint8Array(w * h); const q = [start]; seen[start] = 1; let count = 1;
  while (q.length) {
    const i = q.pop(), x = i % w, y = Math.floor(i / w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, j = ny * w + nx;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && !blocked[j] && !seen[j]) { seen[j] = 1; count++; q.push(j); }
    }
  }
  return count === blocked.reduce((n, b) => n + (b ? 0 : 1), 0);
}
export const freeSquares = (field) => field.blocked.reduce((n, b) => n + (b ? 0 : 1), 0);

// ---------- positions ----------
export const fpOf = (u) => u.fp || 1;
// Squares between two creatures (5e: diagonals count as 1). 1 = next to each other.
export function dist(a, b, ax = a.bx, ay = a.by) {
  const af = fpOf(a), bf = fpOf(b);
  const dx = Math.max(0, b.bx - (ax + af - 1), ax - (b.bx + bf - 1));
  const dy = Math.max(0, b.by - (ay + af - 1), ay - (b.by + bf - 1));
  return Math.max(dx, dy);
}
function occupancy(field, units, except) {
  const occ = new Array(field.w * field.h).fill(null);
  for (const u of units) {
    if (u === except || u.bx == null) continue;
    const f = fpOf(u);
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) occ[(u.by + j) * field.w + u.bx + i] = u;
  }
  return occ;
}
function fits(field, occ, u, x, y, { passAllies = false } = {}) {
  const f = fpOf(u);
  if (x < 0 || y < 0 || x + f > field.w || y + f > field.h) return false;
  for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
    const k = (y + j) * field.w + x + i;
    if (field.blocked[k]) return false;
    const o = occ[k];
    if (o && !(passAllies && o.side === u.side)) return false;
  }
  return true;
}
// Every square this creature could reach this turn: { "x,y": steps }. Allies can be walked through, not stopped on.
export function reachable(field, units, u, steps) {
  const occ = occupancy(field, units, u);
  const out = new Map([[`${u.bx},${u.by}`, 0]]);
  const q = [[u.bx, u.by, 0]];
  const pass = new Set([`${u.bx},${u.by}`]);
  while (q.length) {
    const [x, y, s] = q.shift();
    if (s >= steps) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (pass.has(k) || !fits(field, occ, u, nx, ny, { passAllies: true })) continue;
      pass.add(k);
      if (fits(field, occ, u, nx, ny)) out.set(k, s + 1);
      q.push([nx, ny, s + 1]);
    }
  }
  return out;
}
// The best square to move to so the target is within `range` (closest such square), else as close as possible.
export function approach(field, units, u, target, range, steps) {
  const opts = [...reachable(field, units, u, steps)].map(([k, s]) => { const [x, y] = k.split(',').map(Number); return { x, y, s, d: dist(u, target, x, y) }; });
  const inRange = opts.filter((o) => o.d <= range).sort((a, b) => a.s - b.s || b.d - a.d);
  if (inRange.length) return inRange[0];
  return opts.sort((a, b) => a.d - b.d || a.s - b.s)[0];
}
// The square farthest from every enemy (to back off).
export function retreat(field, units, u, enemies, steps) {
  const opts = [...reachable(field, units, u, steps)].map(([k, s]) => { const [x, y] = k.split(',').map(Number); return { x, y, s, d: Math.min(...enemies.map((e) => dist(u, e, x, y))) }; });
  return opts.sort((a, b) => b.d - a.d || a.s - b.s)[0];
}
// Starting places: heroes in the left columns, monsters on the right.
export function placeAll(field, heroes, monsters) { // returns false if someone didn't fit
  const units = [...heroes, ...monsters];
  units.forEach((u) => { u.bx = null; u.by = null; });
  const put = (u, cols) => {
    const occ = occupancy(field, units, u);
    const ys = [...Array(field.h).keys()].sort((a, b) => Math.abs(a - field.h / 2 + 0.5) - Math.abs(b - field.h / 2 + 0.5));
    for (const x of cols) for (const y of ys) if (fits(field, occ, u, x, y)) { u.bx = x; u.by = y; return true; }
    return false;
  };
  for (const h of heroes) put(h, [1, 0, 2, 3]) || put(h, [...Array(field.w).keys()]);
  // biggest monsters first, as far right as they fit
  for (const m of [...monsters].sort((a, b) => fpOf(b) - fpOf(a))) {
    const cols = []; for (let x = field.w - fpOf(m); x >= Math.max(3, Math.floor(field.w / 2)); x--) cols.push(x);
    put(m, cols) || put(m, [...Array(field.w).keys()].reverse());
  }
  return units.every((u) => u.bx != null);
}

// ---------- drawing ----------
class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.p = new Uint8Array(w * h * 4); }
  px(x, y, c, a = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (a >= 1) { this.p[i] = c[0]; this.p[i + 1] = c[1]; this.p[i + 2] = c[2]; this.p[i + 3] = 255; return; }
    for (let k = 0; k < 3; k++) this.p[i + k] = Math.round(this.p[i + k] * (1 - a) + c[k] * a);
    this.p[i + 3] = 255;
  }
  rect(x, y, w, h, c, a = 1) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c, a); }
  // Draws a 32×32 sprite, scaled by k, optionally mirrored, greyed out or see-through.
  sprite(rgba, x, y, { k = 1, flip = false, gray = false, alpha = 1 } = {}) {
    for (let j = 0; j < 32 * k; j++) for (let i = 0; i < 32 * k; i++) {
      const sx = flip ? 31 - Math.floor(i / k) : Math.floor(i / k), s = (Math.floor(j / k) * 32 + sx) * 4;
      if (!rgba[s + 3]) continue;
      let c = [rgba[s], rgba[s + 1], rgba[s + 2]];
      if (gray) { const g = Math.round((c[0] + c[1] + c[2]) / 3 * 0.55); c = [g, g, g]; }
      this.px(x + i, y + j, c, alpha);
    }
  }
}

// A tiny 3×5 pixel font for the labels on the map (1–9, A–Z).
const FONT = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111',
  6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111',
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
};
function label(cv, text, x, y, bg, fg = [255, 255, 255]) {
  const w = text.length * 4 + 1;
  cv.rect(x, y, w + 2, 9, [16, 10, 14]);
  cv.rect(x + 1, y + 1, w, 7, bg);
  [...text].forEach((ch, n) => {
    const f = FONT[ch];
    if (f) for (let i = 0; i < 15; i++) if (f[i] === '1') cv.px(x + 2 + n * 4 + (i % 3), y + 2 + Math.floor(i / 3), fg);
  });
}

// Floor tiles: flagstones with grout and speckles; the theme picks the stone.
function floorTile(theme, x, y) {
  const r = rng(`tile|${theme.name}|${x}|${y}`);
  const base = hex(theme.floor), grout = hex(theme.grout);
  const out = [];
  const split = theme.name === 'fungal' ? -1 : Math.floor(r() * 3); // 0: one slab, 1: two, 2: four
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    let c = mix(base, [0, 0, 0], (r() - 0.5) * 0.12);
    const edge = i === 0 || j === 0 || (split >= 1 && i === 16) || (split === 2 && j === 16);
    if (edge && split >= 0) c = grout;
    else if (split >= 0 && (i === 1 || j === 1 || (split >= 1 && i === 17) || (split === 2 && j === 17))) c = mix(c, [255, 255, 255], 0.08);
    if (theme.name === 'fungal' && r() < 0.06) c = mix(c, [90, 140, 60], 0.4);
    out.push(c);
  }
  return out;
}
// Things on the floor, drawn with the same pixel-art tools as the monsters.
const THING_COLOURS = {
  barrel: ['#8a5a32', '#5a3a22'], crate: ['#9a7244', '#6a4a2a'], pillar: ['#8c857c', '#5a554e'], tomb: ['#7e8a90', '#4c565c'], urn: ['#8a6a4a', '#3a2a22'],
  mushroom: ['#a8483f', '#e6dcc0'], rock: ['#6e6a5c', '#4a463c'], anvil: ['#5a5e66', '#2a2c30'], lava: ['#e0602a', '#ffd04a'], crystal: ['#8a5ad0', '#d8b8ff'],
  straw: ['#b8a050', '#8a7838'], puddle: ['#3a5a6a', '#6a9aaa'], crack: ['#2a2420', '#2a2420'], bones: ['#ddd3b8', '#a89e86'], moss: ['#4f7a34', '#6a9a44'],
  shroom: ['#c7a0ff', '#7a5ab0'], glowcrack: ['#ff8a3a', '#ffd04a'], chain: ['#7a7e86', '#4a4c52'], rune: ['#9a6aff', '#d8c8ff'],
};
function thingSprite(kind, seed) {
  const g = new Grid(1);
  const r = rng(`${kind}|${seed}`);
  switch (kind) {
    case 'barrel': g.ell(16, 18, 9, 11, 'body'); g.rect(7, 11, 18, 1.5, 'dark'); g.rect(7, 24, 18, 1.5, 'dark'); g.ell(16, 8, 8, 3, 'second'); break;
    case 'crate': g.rect(5, 7, 22, 21, 'body'); g.line(6, 8, 26, 27, 'second', 2); g.line(26, 8, 6, 27, 'second', 2); g.rect(5, 7, 22, 2, 'second'); break;
    case 'pillar': g.rect(9, 3, 14, 26, 'body'); g.rect(7, 2, 18, 3, 'second'); g.rect(7, 26, 18, 3, 'second'); for (const x of [12, 16, 20]) g.rect(x, 6, 1, 19, 'second'); break;
    case 'tomb': g.rect(5, 4, 22, 25, 'body'); g.rect(7, 6, 18, 21, 'second'); g.ell(16, 11, 4, 4, 'body'); g.rect(15, 14, 2, 10, 'body'); g.rect(12, 17, 8, 2, 'body'); break;
    case 'urn': g.ell(16, 20, 8, 9, 'body'); g.rect(12, 6, 8, 6, 'body'); g.ell(16, 6, 6, 2, 'second'); g.rect(9, 18, 14, 2, 'second'); break;
    case 'mushroom': g.rect(13, 16, 6, 13, 'second'); g.ell(16, 12, 13, 8, 'body'); g.rect(3, 12, 26, 3, 'body'); for (let i = 0; i < 5; i++) g.ell(7 + i * 4.5, 9 + (i % 2) * 2, 1.5, 1.2, 'second'); break;
    case 'rock': g.ell(16, 20, 12, 9, 'body'); g.ell(12, 14, 7, 6, 'body'); g.line(10, 18, 18, 22, 'second'); break;
    case 'anvil': g.rect(6, 10, 20, 6, 'body'); g.tri(26, 10, 31, 11, 26, 15, 'body'); g.rect(12, 16, 8, 6, 'body'); g.rect(8, 22, 16, 5, 'body'); g.rect(6, 10, 20, 1.5, 'second'); break;
    case 'lava': g.ell(16, 17, 14, 11, 'body'); for (let i = 0; i < 4; i++) g.ell(8 + r() * 16, 12 + r() * 10, 2.5, 2, 'second'); break;
    case 'crystal': g.tri(16, 1, 9, 28, 23, 28, 'body'); g.tri(9, 9, 4, 28, 13, 28, 'body'); g.tri(24, 11, 19, 28, 29, 28, 'body'); g.line(16, 3, 14, 26, 'second'); break;
    case 'straw': for (let i = 0; i < 14; i++) { const x = 6 + r() * 20, y = 10 + r() * 14; g.line(x, y, x + 4 - r() * 8, y + 3, i % 2 ? 'body' : 'second'); } break;
    case 'puddle': g.ell(16, 18, 11, 6, 'body'); g.ell(13, 16, 4, 1.5, 'second'); break;
    case 'crack': { let x = 6, y = 8; for (let i = 0; i < 7; i++) { const nx = x + 3, ny = y + 2 + r() * 4 - 1; g.line(x, y, nx, ny, 'body'); x = nx; y = ny; } break; }
    case 'glowcrack': { let x = 6, y = 8; for (let i = 0; i < 7; i++) { const nx = x + 3, ny = y + 2 + r() * 4 - 1; g.line(x, y, nx, ny, 'second', 1.5); x = nx; y = ny; } break; }
    case 'bones': g.line(9, 20, 20, 15, 'body', 1.6); g.ell(8, 21, 1.6, 1.6, 'body'); g.ell(21, 14, 1.6, 1.6, 'body'); g.ell(22, 22, 3.5, 3, 'body'); g.dot(21, 22, 'dark'); g.dot(23, 22, 'dark'); break;
    case 'moss': for (let i = 0; i < 18; i++) g.dot(6 + r() * 20, 8 + r() * 18, i % 3 ? 'body' : 'second'); break;
    case 'shroom': for (let i = 0; i < 3; i++) { const x = 8 + i * 7 + r() * 3, y = 18 + r() * 6; g.rect(x - 0.5, y, 1.5, 4, 'second'); g.ell(x, y, 2.6, 1.6, 'body'); } break;
    case 'chain': for (let i = 0; i < 6; i++) g.ell(8 + i * 3.5, 14 + Math.sin(i) * 3, 1.6, 1.2, i % 2 ? 'body' : 'second'); break;
    case 'rune': for (let a = 0; a < 6.28; a += 0.25) g.dot(16 + Math.cos(a) * 10, 16 + Math.sin(a) * 7, 'body'); g.tri(16, 10, 11, 20, 21, 20, 'second'); break;
    default: break;
  }
  const [c1, c2] = THING_COLOURS[kind] || ['#777777', '#555555'];
  const rp1 = ramp(c1), rp2 = ramp(c2);
  const out = new Uint8Array(32 * 32 * 4);
  const flat = new Set(['puddle', 'crack', 'glowcrack', 'moss', 'straw', 'rune', 'shroom', 'chain', 'bones']).has(kind);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const v = g.at(x, y), i = (y * 32 + x) * 4;
    let c = null;
    if (v) {
      const rp = v === 2 ? rp2 : v === 6 ? [hex('#26141a'), hex('#26141a'), hex('#26141a')] : rp1;
      c = !g.at(x + 1, y) || !g.at(x, y + 1) ? rp[0] : !g.at(x, y - 1) || !g.at(x - 1, y) ? rp[2] : rp[1];
    } else if (!flat && (g.at(x - 1, y) || g.at(x + 1, y) || g.at(x, y - 1) || g.at(x, y + 1))) c = [20, 12, 18];
    if (c) { out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; }
  }
  return out;
}

// The wall along the top: bricks, with torches.
function drawWall(cv, theme) {
  const r = rng(`wall|${theme.name}`);
  const wc = hex(theme.wall), mc = hex(theme.mortar);
  for (let y = 0; y < TILE * WALL; y++) for (let x = 0; x < cv.w; x++) {
    const row = Math.floor(y / 8), off = row % 2 ? 8 : 0;
    const mortar = y % 8 === 7 || (x + off) % 16 === 15;
    cv.px(x, y, mortar ? mc : mix(wc, [0, 0, 0], (r() - 0.4) * 0.15 + (y > 24 ? 0.2 : 0)));
  }
  for (let t = 0; t < 3; t++) {
    const x = Math.round(cv.w * (t + 0.5) / 3);
    cv.rect(x - 1, 14, 3, 10, [70, 50, 34]);
    cv.rect(x - 2, 9, 5, 5, [255, 170, 60]); cv.rect(x - 1, 6, 3, 4, [255, 220, 120]); cv.px(x, 4, [255, 240, 200]);
  }
}

// Solid rock where the room's walls bend in: dark bricks, lit along the edge that faces the room.
function rockTile(cv, theme, field, x, y, oy) {
  const r = rng(`rock|${field.seed}|${x}|${y}`);
  const wc = mix(hex(theme.wall), [0, 0, 0], 0.35), mc = mix(hex(theme.mortar), [0, 0, 0], 0.3);
  const open = (dx, dy) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < field.w && ny < field.h && field.blocked[ny * field.w + nx] !== 2; };
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    const row = Math.floor(j / 8), off = row % 2 ? 8 : 0;
    let c = j % 8 === 7 || (i + off) % 16 === 15 ? mc : mix(wc, [0, 0, 0], (r() - 0.4) * 0.15);
    if ((open(0, 1) && j > 25) || (open(-1, 0) && i < 2) || (open(1, 0) && i > 29) || (open(0, -1) && j < 2)) c = mix(hex(theme.wall), [255, 240, 220], 0.12);
    cv.px(x * TILE + i, oy + y * TILE + j, c);
  }
}

const spriteCache = new Map();
function unitSprite(u) {
  const key = u.side === 'h' ? `h|${u.name}|${u.cls}` : `m|${u.n}`;
  if (!spriteCache.has(key)) spriteCache.set(key, (u.side === 'h' ? drawHero(u) : drawMonster(u)).rgba);
  return spriteCache.get(key);
}

// The battle picture. opts: { scale, reach: Map("x,y" → steps) to highlight, current: unit id, target: unit id }
export function renderBattle(field, heroes, monsters, { scale = 2, reach = null, current = null, target = null, labels = true } = {}) {
  const theme = THEMES.find((t) => t.name === field.theme) || THEMES[0];
  const cv = new Canvas(field.w * TILE, (field.h + WALL) * TILE);
  drawWall(cv, theme);
  const oy = WALL * TILE;
  for (let y = 0; y < field.h; y++) for (let x = 0; x < field.w; x++) {
    if (field.blocked[y * field.w + x] === 2) { rockTile(cv, theme, field, x, y, oy); continue; }
    const t = floorTile(theme, x, y);
    t.forEach((c, n) => cv.px(x * TILE + (n % TILE), oy + y * TILE + Math.floor(n / TILE), c));
  }
  // shadow under the wall, and torchlight
  for (let y = 0; y < 10; y++) cv.rect(0, oy + y, cv.w, 1, [0, 0, 0], 0.35 * (1 - y / 10));
  for (const th of field.things.filter((t) => !t.block)) cv.sprite(thingSprite(th.kind, `${field.seed}${th.x}${th.y}`), th.x * TILE, oy + th.y * TILE, { alpha: 0.9 });
  // the grid
  for (let y = 0; y < field.h; y++) for (let x = 0; x < field.w; x++) {
    if (field.blocked[y * field.w + x] === 2) continue;
    if (x > 0) cv.rect(x * TILE, oy + y * TILE, 1, TILE, [0, 0, 0], 0.22);
    if (y > 0) cv.rect(x * TILE, oy + y * TILE, TILE, 1, [0, 0, 0], 0.22);
    // shadow cast by rock on the square below it
    if (y > 0 && field.blocked[(y - 1) * field.w + x] === 2) for (let j = 0; j < 8; j++) cv.rect(x * TILE, oy + y * TILE + j, TILE, 1, [0, 0, 0], 0.4 * (1 - j / 8));
  }
  if (reach) for (const k of reach.keys()) { const [x, y] = k.split(',').map(Number); cv.rect(x * TILE + 1, oy + y * TILE + 1, TILE - 1, TILE - 1, [120, 200, 255], 0.18); }
  for (const th of field.things.filter((t) => t.block)) {
    cv.rect(th.x * TILE + 4, oy + th.y * TILE + 26, 24, 4, [0, 0, 0], 0.3);
    cv.sprite(thingSprite(th.kind, `${field.seed}${th.x}${th.y}`), th.x * TILE, oy + th.y * TILE);
  }
  // creatures, back rows first so the front ones overlap them
  const units = [...heroes.filter((h) => !h.dead && h.bx != null), ...monsters.filter((m) => m.hp > 0 && m.bx != null)]
    .sort((a, b) => a.by + fpOf(a) - (b.by + fpOf(b)));
  for (const u of units) {
    const f = fpOf(u), px = u.bx * TILE, py = oy + u.by * TILE;
    if (u.id === current) { cv.rect(px, py, f * TILE, f * TILE, [255, 210, 90], 0.22); }
    if (u.id === target) { cv.rect(px, py, f * TILE, f * TILE, [255, 70, 60], 0.22); }
    cv.rect(px + 4 * f, py + f * TILE - 5, f * TILE - 8 * f, 4, [0, 0, 0], 0.35); // shadow
    cv.sprite(unitSprite(u), px, py, { k: f, flip: u.side === 'm', gray: u.side === 'h' && u.down });
    // health bar
    const pct = Math.max(0, u.hp / u.maxHp);
    cv.rect(px + 3, py + f * TILE - 3, f * TILE - 6, 3, [20, 10, 12]);
    cv.rect(px + 4, py + f * TILE - 2, Math.round((f * TILE - 8) * pct), 1, pct < 0.3 ? [220, 70, 60] : pct < 0.6 ? [230, 180, 70] : [110, 200, 100]);
    if (labels && u.tag) label(cv, u.tag, px + 1, py + 1, u.side === 'h' ? [50, 110, 200] : [170, 50, 45]);
  }
  return scale > 1 ? { rgba: scaleUp(cv.p, cv.w, cv.h, scale), w: cv.w * scale, h: cv.h * scale } : { rgba: cv.p, w: cv.w, h: cv.h };
}
export function battlePng(...args) {
  const { rgba, w, h } = renderBattle(...args);
  return png(rgba, w, h);
}
