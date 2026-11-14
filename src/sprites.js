// 256×256 pixel-art sprites for every monster and hero, drawn by code: a body plan picked from the monster's kind and
// name (people, beasts, birds, bugs, snakes, dragons, oozes, ghosts, golems…), colours from its name ("red", "frost",
// "bone"…), small touches from a seed (weapons, horns, hoods). The shapes are laid out on a 32-unit sketch grid and
// painted at 256×256: rounded shading lit from the top left with dithered pixel-art tones, fur, scales and stone
// textures, eyes with pupils and a glint, glowing bits, and a thick dark outline. The same monster always gets the same
// sprite. Saved as PNG with a tiny built-in encoder (no extra packages), and kept on disk so it's only painted once.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SPRITE = 256;          // the finished sprite, in pixels
const N = 32;                       // the sketch grid the body plans are drawn on

// ---------- colour helpers ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const ramp = (h) => { const c = hex(h); return [mix(c, [20, 12, 30], 0.38), c, mix(c, [255, 250, 235], 0.32)]; };

// ---------- a seeded random, so a monster always looks the same ----------
function rng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

// ---------- the drawing surface ----------
// Materials: body, second (cloth/belly), metal, accent (horns, claws), eye, dark (mouth, holes), glow.
const M = { body: 1, second: 2, metal: 3, accent: 4, eye: 5, dark: 6, glow: 7, wing: 8 };
// Shapes are given in sketch units (0–32) and painted at `res` pixels (256 for sprites, 32 for the app icon).
class Grid {
  constructor(scale = 1, res = N) { this.R = res; this.k = res / N; this.p = new Uint8Array(res * res); this.s = scale; }
  X(x) { return (16 + (x - 16) * this.s) * this.k; }
  Y(y) { return (30 - (30 - y) * this.s) * this.k; }
  raw(x, y, m) { x = Math.round(x); y = Math.round(y); const pad = Math.max(1, this.k); if (x >= pad && x < this.R - pad && y >= pad && y < this.R - pad) this.p[y * this.R + x] = M[m] ?? m; }
  at(x, y) { return x < 0 || y < 0 || x >= this.R || y >= this.R ? 0 : this.p[y * this.R + x]; }
  dot(x, y, m) { if (this.k === 1) this.raw(this.X(x), this.Y(y), m); else this.ell(x, y, 0.55 / this.s, 0.55 / this.s, m); }
  ell(cx, cy, rx, ry, m) {
    const k = this.k, X = this.X(cx), Y = this.Y(cy), RX = Math.max(0.6, rx * this.s * k), RY = Math.max(0.6, ry * this.s * k);
    const pad = k === 1 ? 0.3 : 0.5;
    for (let y = Math.floor(Y - RY); y <= Math.ceil(Y + RY); y++) for (let x = Math.floor(X - RX); x <= Math.ceil(X + RX); x++) {
      if (((x - X) / (RX + pad)) ** 2 + ((y - Y) / (RY + pad)) ** 2 <= 1) this.raw(x, y, m);
    }
  }
  rect(x, y, w, h, m) {
    const k = this.k, X = this.X(x), Y = this.Y(y), W = Math.max(1, Math.round(w * this.s * k)), H = Math.max(1, Math.round(h * this.s * k));
    // At sprite size, corners are rounded so limbs and bodies look soft instead of boxy.
    const rr = k > 1 ? Math.min(W, H) * 0.42 : 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (rr) {
        const cx = i < rr ? rr : i > W - 1 - rr ? W - 1 - rr : i, cy = j < rr ? rr : j > H - 1 - rr ? H - 1 - rr : j;
        if (Math.hypot(i - cx, j - cy) > rr + 0.5) continue;
      }
      this.raw(Math.round(X) + i, Math.round(Y) + j, m);
    }
  }
  line(x0, y0, x1, y1, m, t = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * this.s * 2 * this.k + 1;
    for (let i = 0; i <= n; i++) {
      const x = x0 + (x1 - x0) * (i / n), y = y0 + (y1 - y0) * (i / n);
      if (t <= 1 && this.k === 1) this.dot(x, y, m); else this.ell(x, y, Math.max(t, 0.25) / 2, Math.max(t, 0.25) / 2, m);
    }
  }
  // A limb: a stroke that goes from thickness t0 to t1 (rounded ends).
  taper(x0, y0, x1, y1, t0, t1, m) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * this.s * 2 * this.k + 1;
    for (let i = 0; i <= n; i++) { const f = i / n, t = t0 + (t1 - t0) * f; this.ell(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, t / 2, t / 2, m); }
  }
  tri(x0, y0, x1, y1, x2, y2, m) { // filled triangle
    const P = [[x0, y0], [x1, y1], [x2, y2]].map(([x, y]) => [this.X(x), this.Y(y)]);
    const minX = Math.floor(Math.min(...P.map((p) => p[0]))), maxX = Math.ceil(Math.max(...P.map((p) => p[0])));
    const minY = Math.floor(Math.min(...P.map((p) => p[1]))), maxY = Math.ceil(Math.max(...P.map((p) => p[1])));
    const side = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const s1 = side(P[0], P[1], x, y), s2 = side(P[1], P[2], x, y), s3 = side(P[2], P[0], x, y);
      const e = this.k === 1 ? 0.5 : 0.5 * this.k;
      if ((s1 >= -e && s2 >= -e && s3 >= -e) || (s1 <= e && s2 <= e && s3 <= e)) this.raw(x, y, m);
    }
  }
}

// ---------- what kind of body ----------
const has = (re, s) => re.test(s);
export function bodyPlan(m) {
  const n = m.n.toLowerCase(), t = String(m.type || '').toLowerCase();
  if (/^swarm|swarm of/.test(n) || /swarm/.test(t)) return 'swarm';
  if (has(/skeleton|lich|demilich|dracolich/, n) || (/bone/.test(n) && t !== 'fiend')) return 'skeleton';
  if (has(/gargoyle/, n)) return 'fiend';
  if (has(/drider/, n)) return 'bug';
  if (has(/grick|behir|remorhaz/, n)) return 'snake';
  if (has(/sea horse|seahorse/, n)) return 'quad';
  if (has(/\bdog\b|hound|wolf(?! spider)|jackal(?!were)|hyena/, n) && !/were/.test(n)) return 'quad';
  if (has(/doppelganger|grimlock|yeti|troglodyte|kuo-toa|hook horror|were|gnoll|minotaur|medusa|lamia|harpy(?!.)|oni|rakshasa/, n)) return /yeti/.test(n) ? 'giant' : 'humanoid';
  if (has(/merfolk|sahuagin|kobold|lizardfolk|kuo-toa/, n)) return 'humanoid';
  if (has(/sphinx|lammasu/, n)) return 'quad';
  if (has(/ghost|specter|spectre|wraith|banshee|shadow(?! dragon)|will-o|poltergeist|phantom/, n)) return 'ghost';
  if (has(/dragon turtle/, n)) return 'quad';
  if (t === 'dragon' || has(/dragon|wyrmling|wyvern|drake/, n)) return 'dragon';
  if (has(/spider|scorpion|beetle|centipede|ankheg|wasp|\bbee\b|\bant\b|tick|crab|insect|mite|cockroach|carrion crawler|phase spider|ettercap/, n)) return 'bug';
  if (has(/snake|serpent|worm|naga|eel|python|constrictor|cobra|asp\b|viper|couatl/, n)) return 'snake';
  if (has(/\bbat\b|hawk|eagle|owl(?!bear)|raven|vulture|stirge|pteranodon|crow|roc\b|griffon|hippogriff|peryton|cockatrice|harpy|axe beak|vrock|pegasus/, n)) return 'bird';
  if (t === 'ooze' || has(/ooze|pudding|jelly|gelatinous|slime/, n)) return 'ooze';
  if (t === 'plant' || has(/shrub|blight|shambling|treant|myconid|shrieker|violet fungus|vine/, n)) return 'plant';
  if (t === 'elemental' || has(/elemental|mephit|magmin|salamander|azer|invisible stalker|xorn/, n)) return 'elemental';
  if (t === 'construct' || has(/golem|animated|armor|shield guardian|homunculus|modron/, n)) return 'construct';
  if (t === 'aberration' || has(/beholder|spectator|gibbering|otyugh|cloaker|chuul|aboleth|nothic|intellect|gauth/, n)) return 'eye';
  if (t === 'giant' || has(/troll|ogre|ettin|giant(?! (spider|rat|toad|frog|lizard|eagle|owl|wasp|bee|centipede|crab|scorpion|boar|elk|goat|hyena|badger|bat|weasel|vulture|shark|octopus|constrictor|crocodile|poisonous|venomous|ape|seahorse|wolf spider))|cyclops|fomorian/, n)) return 'giant';
  if (t === 'fiend') return has(/hell hound|nightmare|barghest|gnoll/, n) ? 'quad' : 'fiend';
  if (t === 'celestial') return has(/unicorn|pegasus|ki-rin|couatl/, n) ? 'quad' : 'angel';
  if (t === 'undead') return has(/zombie|ghoul|ghast|mummy|wight|vampire|revenant|mummy lord/, n) ? 'zombie' : 'skeleton';
  if (t === 'humanoid' || t === 'fey' || has(/medusa|minotaur|lamia|yuan-ti|hag|gnoll|sahuagin|merrow|centaur|satyr|dryad|sprite|pixie|kenku|kobold|goblin|orc|lizardfolk|bugbear|hobgoblin|gnome|dwarf|elf|drow|duergar|mage|priest|cultist|guard|bandit|thug|knight|veteran|scout|spy|noble|acolyte|berserker|gladiator|assassin|druid|warrior|commoner|pirate|tough|archer|warlock|wizard/, n)) return 'humanoid';
  if (has(/frog|toad|lizard|crocodile|basilisk|salamander|gecko|iguana|turtle|tortoise/, n)) return 'low';
  return 'quad';
}

// ---------- colours from the name ----------
const NAMED = [
  [/red |fire|flame|hell|magma|lava|ember|infernal|balor|pit fiend|efreeti|imp\b|salamander|magmin|chimera/, '#c8442e'],
  [/white|frost|ice|winter|polar|snow|yeti|remorhaz/, '#cfe2ee'],
  [/blue|storm|lightning|air elemental|djinni/, '#3b72cf'],
  [/black|shadow|night|dark|drow|shade|wraith|specter|spectre|cloaker|nightmare/, '#433a5a'],
  [/green|poison|goblin|hag|troll|lizardfolk|orc\b|orc |hobgoblin|ooze|slime|myconid|blight|shambling/, '#5c9b3a'],
  [/gold|brass|copper|bronze|silver|deva|planetar|solar|angel|couatl|lammasu/, null],
  [/bone|skeleton|lich|dracolich/, '#e4d9bb'],
  [/zombie|ghoul|ghast|mummy|wight|revenant/, '#8d9b6a'],
  [/earth|stone|gargoyle|golem|rock|clay|xorn|galeb|dwarf|duergar/, '#8b7d6b'],
  [/water|sea|sahuagin|merrow|kraken|aboleth|chuul|kuo/, '#2f8f9c'],
  [/purple|violet|aberr|gibbering|nothic|intellect/, '#7b4aa6'],
  [/wolf|bear|boar|ape|dog|hound|horse|deer|elk|mule|camel|ox\b|badger|weasel|hyena|jackal|rat|bat|owlbear|minotaur|bugbear|gnoll|kobold|centaur|satyr/, '#8a5a3b'],
  [/lion|tiger|panther|cat\b|leopard|sphinx|manticore/, '#c08a3e'],
  [/spider|scorpion|ettercap/, '#6a5240'],
];
const METAL = { gold: '#e0b13c', brass: '#c99a4a', copper: '#c06a3d', bronze: '#a87232', silver: '#c9ced6' };
const BY_TYPE = { beast: '#8a5a3b', monstrosity: '#7a6a8a', dragon: '#b04a3a', fiend: '#b0352e', celestial: '#efd27a', undead: '#b8b49a', aberration: '#7b4aa6',
  construct: '#8b8a86', elemental: '#d9762d', fey: '#7fbf6a', plant: '#4f8a34', ooze: '#6db84a', giant: '#b98a64', humanoid: '#d8a27c' };
const SKIN = ['#f0c9a4', '#d8a27c', '#b77b55', '#8c5a3c', '#5f3c28'];
const CLOTH = ['#7a3b3b', '#3b5a7a', '#4f6b3a', '#6b4f7a', '#7a6a3b', '#3a3a44', '#8a5a2e'];

function palette(m, plan, r) {
  const n = m.n.toLowerCase(), t = String(m.type || '').toLowerCase();
  let body = null;
  for (const [re, c] of NAMED) if (re.test(n)) { body = c ?? METAL[(n.match(/gold|brass|copper|bronze|silver/) || ['gold'])[0]]; break; }
  const humanish = plan === 'humanoid' && t === 'humanoid' && !/goblin|orc|hobgoblin|bugbear|kobold|lizardfolk|gnoll|drow|duergar|sahuagin|merrow|yuan|kenku|troglodyte|grimlock|minotaur|medusa/.test(n);
  if (humanish) body = SKIN[Math.floor(r() * SKIN.length)];
  if (!body) body = BY_TYPE[t.startsWith('swarm') ? 'beast' : t] || '#8a7a6a';
  const second = plan === 'humanoid' || plan === 'giant' || plan === 'zombie' ? CLOTH[Math.floor(r() * CLOTH.length)] : hex(body).reduce((a, b) => a + b) > 450 ? '#9a8f80' : '#d8c8a8';
  const eye = /undead|fiend/.test(t) || /lich|wraith|specter|ghost|shadow|demon|devil/.test(n) ? '#ff4a3a' : t === 'celestial' ? '#9ff0ff' : t === 'aberration' ? '#ffe14a' : '#ffffff';
  const glow = /fire|flame|magma|hell|lava|efreeti|salamander|magmin/.test(n) ? '#ffcf4a' : /ice|frost|cold|white/.test(n) ? '#e8fbff' : /lightning|storm|air/.test(n) ? '#bfe6ff' : /water/.test(n) ? '#9fe8ff' : /earth|stone/.test(n) ? '#c8b89a' : t === 'celestial' ? '#fff3b0' : '#c9a0ff';
  const wing = '#' + mix(hex(body), [30, 20, 40], 0.35).map((v) => v.toString(16).padStart(2, '0')).join('');
  return { body, second, metal: '#a9b0ba', accent: '#e8dcc0', eye, dark: '#26141a', glow, wing };
}

// ---------- body plans ----------
export { Grid, ramp, hex, mix, rng };
export const SIZE = { Tiny: 0.62, Small: 0.78, Medium: 0.9, Large: 1, Huge: 1, Gargantuan: 1 };

function humanoid(g, r, n, o = {}) {
  const bulk = o.bulk || 0;
  const caster = /mage|priest|cultist|acolyte|druid|warlock|wizard|archmage|shaman|hag|lich|necromancer|cult|deva|planetar|solar/.test(n);
  const armored = /knight|guard|soldier|veteran|warrior|gladiator|champion|infantry|captain|hobgoblin|duergar|hill giant|sergeant|commander|paladin|devil/.test(n);
  const archer = /scout|archer|bandit|ranger|hunter|bowman/.test(n);
  // legs, then body, arms, head
  const big = g.k > 1;
  if (!o.noLegs) {
    if (big) { // tapered legs and rounded boots
      g.taper(13 - bulk, 21, 12.8 - bulk, 27.5, 4.2, 3.2, 'second'); g.taper(19 + bulk, 21, 19.2 + bulk, 27.5, 4.2, 3.2, 'second');
      g.ell(12.4 - bulk, 28.6, 2.7, 1.5, 'dark'); g.ell(19.6 + bulk, 28.6, 2.7, 1.5, 'dark');
    } else { g.rect(11 - bulk, 22, 4, 8, 'second'); g.rect(17 + bulk, 22, 4, 8, 'second'); g.rect(10 - bulk, 28, 5, 2, 'dark'); g.rect(17 + bulk, 28, 5, 2, 'dark'); }
  }
  if (caster) { g.tri(16, 11, 7 - bulk, 30, 25 + bulk, 30, 'second'); }
  const torso = caster ? 'second' : armored ? 'metal' : 'second';
  if (big) { // shoulders wider than the waist
    g.ell(16, 14.2, 6.6 + bulk, 3.2, torso); g.taper(16, 14.5, 16, 20.5, 11 + bulk * 2, 9.4 + bulk * 2, torso);
    g.rect(11.2 - bulk, 19.8, 9.6 + bulk * 2, 1.8, 'dark'); // belt
    const sleeve = armored ? 'metal' : 'body';
    g.taper(9.4 - bulk, 13.8, 8.4 - bulk, 21.2, 3.4, 2.6, sleeve); g.taper(22.6 + bulk, 13.8, 23.6 + bulk, 21.2, 3.4, 2.6, sleeve);
    g.ell(8.3 - bulk, 22.4, 1.7, 1.7, 'body'); g.ell(23.7 + bulk, 22.4, 1.7, 1.7, 'body');
  } else {
    g.rect(10 - bulk, 12, 12 + bulk * 2, 11, torso);
    g.rect(10 - bulk, 20, 12 + bulk * 2, 2, 'dark'); // belt
    g.rect(7 - bulk, 13, 3, 9, armored ? 'metal' : 'body'); g.rect(22 + bulk, 13, 3, 9, armored ? 'metal' : 'body');
    g.ell(8.5 - bulk, 22.5, 1.6, 1.6, 'body'); g.ell(23.5 + bulk, 22.5, 1.6, 1.6, 'body');
  }
  const hy = 7.5;
  if (big) g.ell(16, hy + 4.2, 1.8, 1.4, 'body'); // neck
  if (caster && !/lich/.test(n)) g.ell(16, hy - 0.5, big ? 6 : 5.5, big ? 6 : 5.5, 'second'); // hood
  g.ell(16, hy, (big ? 5 : 4.5) + bulk * 0.4, big ? 4.9 : 4.5, 'body');
  if (/goblin|kobold|elf|drow|hobgoblin|gnome|pixie|sprite|imp|satyr/.test(n)) { g.tri(11, hy - 1, 7, hy - 4, 12, hy + 1, 'body'); g.tri(21, hy - 1, 25, hy - 4, 20, hy + 1, 'body'); }
  if (/orc|boar|ogre|troll/.test(n)) { g.dot(14, hy + 3, 'accent'); g.dot(18, hy + 3, 'accent'); }
  if (/minotaur|devil|demon|horned|satyr|tiefling|fiend|balor|ram|goat|bull|cambion|imp\b/.test(n) || o.horns) {
    g.line(13, hy - 3, 10, hy - 8, 'accent', 2); g.line(19, hy - 3, 22, hy - 8, 'accent', 2);
  }
  if (armored && !o.horns) { g.ell(16, hy - 2, 5, 3, 'metal'); g.rect(11, hy - 1, 10, 1.5, 'metal'); }
  if (/medusa|yuan-ti/.test(n)) for (let i = 0; i < 5; i++) g.line(12 + i * 2, hy - 3, 10 + i * 3, hy - 8 + (i % 2), 'accent', 1.5);
  g.dot(14, hy + 0.5, 'eye'); g.dot(18, hy + 0.5, 'eye');
  if (g.k > 1) { // face and fine details, only when painting big
    g.line(13.1, hy - 0.8, 14.8, hy - 0.55, 'dark', 0.35); g.line(18.9, hy - 0.8, 17.2, hy - 0.55, 'dark', 0.35); // brows
    g.line(15.2, hy + 2.5, 16.8, hy + 2.5, 'dark', 0.3);                                                  // mouth
    g.rect(15.2, 20.2, 1.6, 1.5, 'metal');                                                                // belt buckle
    if (!o.noLegs) { g.ell(12.5 - bulk, 29.4, 2.3, 0.8, 'dark'); g.ell(19.5 + bulk, 29.4, 2.3, 0.8, 'dark'); }
  }
  if (/gnoll|bugbear|kobold|lizardfolk|kenku|werewolf|wererat|jackalwere/.test(n)) g.ell(16, hy + 3, 2.5, 2, 'body'); // snout
  // something in the hand
  const w = /barbarian/.test(n) ? 'axe' : /rogue|bard/.test(n) ? 'dagger' : /monk/.test(n) ? 'none' : archer ? 'bow' : caster ? 'staff' : armored ? (r() < 0.5 ? 'sword' : 'axe') : ['sword', 'club', 'spear', 'dagger', 'axe', 'none'][Math.floor(r() * 6)];
  const hx = 24 + bulk, hy2 = 22;
  if (w === 'sword') { g.line(hx, hy2, hx + 1, 5, 'metal', 1.6); g.rect(hx - 2, hy2 - 2, 5, 1.4, 'accent'); }
  if (w === 'axe') { g.line(hx, hy2 + 3, hx, 7, 'accent', 1.4); g.ell(hx + 2, 9, 2.5, 3, 'metal'); }
  if (w === 'spear') { g.line(hx, 29, hx, 3, 'accent', 1.2); g.tri(hx - 1.5, 5, hx + 1.5, 5, hx, 1, 'metal'); }
  if (w === 'club') g.line(hx, hy2, hx + 2, 10, 'accent', 2.6);
  if (w === 'dagger') g.line(hx, hy2, hx, 17, 'metal', 1.3);
  if (w === 'staff') { g.line(hx, 29, hx, 5, 'accent', 1.3); g.ell(hx, 4, 1.8, 1.8, 'glow'); }
  if (w === 'bow') { for (let a = -1.2; a <= 1.2; a += 0.15) g.dot(6 - Math.cos(a) * 4, 17 + Math.sin(a) * 9, 'accent'); g.line(6, 8.5, 6, 25.5, 'metal'); }
  if (armored && r() < 0.5 && w !== 'bow') { g.ell(7 - bulk, 18, 3.5, 4.5, 'metal'); g.dot(7 - bulk, 18, 'accent'); }
}
function zombie(g, r, n) {
  humanoid(g, r, n, {});
  for (let i = 0; i < 6; i++) g.dot(10 + Math.floor(r() * 12), 13 + Math.floor(r() * 9), 'dark'); // rags and holes
  if (/mummy/.test(n)) for (let y = 13; y < 22; y += 2) g.rect(10, y, 12, 1, 'accent');
}
function skeleton(g, r, n) {
  g.rect(12, 22, 2, 8, 'body'); g.rect(18, 22, 2, 8, 'body');
  g.rect(15, 11, 2, 11, 'body');
  for (let y = 13; y < 20; y += 2) g.rect(11, y, 10, 1, 'body');
  g.rect(12, 20, 8, 2, 'body');
  g.line(10, 13, 7, 22, 'body', 1.4); g.line(22, 13, 25, 22, 'body', 1.4);
  if (/lich/.test(n)) { g.tri(16, 9, 7, 30, 25, 30, 'second'); g.ell(16, 5, 4.5, 2, 'metal'); g.line(25, 29, 25, 4, 'accent', 1.3); g.ell(25, 3.5, 1.8, 1.8, 'glow'); }
  g.ell(16, 7.5, 4.2, 4.2, 'body');
  g.rect(13, 7, 2, 2, 'dark'); g.rect(17, 7, 2, 2, 'dark'); g.dot(14, 8, 'eye'); g.dot(18, 8, 'eye');
  g.rect(14, 11, 4, 1, 'dark');
  if (!/lich/.test(n) && r() < 0.6) { g.line(25, 22, 26, 6, 'metal', 1.5); g.rect(23, 20, 5, 1.2, 'accent'); }
}
function ghost(g, r, n) {
  g.ell(16, 12, 8, 8, 'body');
  g.rect(8, 12, 16, 10, 'body');
  for (let i = 0; i < 4; i++) g.tri(8 + i * 4, 21, 12 + i * 4, 21, 10 + i * 4, 27 + (i % 2) * 2, 'body');
  g.line(8, 15, 3, 19, 'body', 2); g.line(24, 15, 29, 19, 'body', 2);
  g.ell(13, 11, 1.5, 2, 'dark'); g.ell(19, 11, 1.5, 2, 'dark'); g.dot(13, 11, 'eye'); g.dot(19, 11, 'eye');
  g.ell(16, 16, 1.5, 2, 'dark');
}
function quad(g, r, n, o = {}) {
  const long = /horse|elk|deer|pony|mule|camel|giraffe|unicorn|nightmare|pegasus|centaur|antelope/.test(n);
  const bulky = /bear|ape|owlbear|mammoth|elephant|rhinoceros|ox\b|bull|triceratops|ankylosaurus|boar|hippo|dragon turtle|bulette|behir/.test(n) || o.bulky;
  const cat = /lion|tiger|panther|cat\b|leopard|sabre|displacer|manticore|sphinx|chimera/.test(n);
  const legH = long ? 9 : bulky ? 5 : 6;
  const by = 28 - legH - (bulky ? 5 : 4);
  const brx = bulky ? 10 : 8.5, bry = bulky ? 6 : 4.5;
  // legs (far pair darker), body, tail, head
  if (g.k > 1) {
    const t0 = bulky ? 4.6 : 3.4, t1 = bulky ? 3.2 : 2.2;
    for (const [x, far] of [[10, 1], [21, 1], [12, 0], [23, 0]]) { g.taper(x + 0.2, by + 1.5, x + (far ? -0.3 : 0.3), 28.2, t0, t1, far ? 'wing' : 'body'); }
    for (const x of [12, 23]) g.ell(x + 0.6, 28.8, bulky ? 2.5 : 1.9, 1.2, 'accent');
  } else {
    for (const [x, far] of [[9, 1], [20, 1], [11, 0], [22, 0]]) g.rect(x, by + 2, bulky ? 3.5 : 2.5, legH + 2, far ? 'dark' : 'body');
    for (const x of [11, 22]) g.rect(x - 0.5, 28, bulky ? 4.5 : 3.5, 2, 'accent');
  }
  g.ell(15, by, brx, bry, 'body');
  g.ell(15, by + bry * 0.55, brx * 0.7, bry * 0.4, 'second');
  if (!bulky || cat) g.line(6, by - 1, 2, by - 6 + (cat ? -2 : 3), 'body', cat ? 1.6 : 2);
  const hx = 25, hy = by - (long ? 6 : 3);
  if (long) g.line(22, by - 2, hx, hy, 'body', 4);
  g.ell(hx, hy, bulky ? 4.5 : 3.5, bulky ? 4 : 3.2, 'body');
  g.ell(hx + 3, hy + 1.5, 2.4, 1.8, 'body'); // snout
  g.dot(hx + 5, hy + 1, 'dark');
  g.dot(hx + 1, hy - 1, 'eye');
  if (g.k > 1) {
    g.line(hx + 2, hy + 2.6, hx + 5, hy + 2.2, 'dark', 0.5);                                        // mouth
    for (const x of [11.2, 22.2]) for (let c = 0; c < 3; c++) g.tri(x + c * 1, 29.5, x + c * 1 + 0.7, 29.5, x + c * 1 + 0.5, 30.4, 'accent'); // claws
    if (/owlbear/.test(n)) { g.tri(hx + 3, hy, hx + 3, hy + 2.4, hx + 6.5, hy + 1.6, 'accent'); g.ell(hx - 1, hy + 1, 4.5, 3.5, 'second'); g.ell(hx + 1, hy - 1, 1.2, 1.2, 'eye'); }
  }
  g.tri(hx - 2, hy - 2, hx - 1, hy - 6, hx + 1, hy - 3, 'body'); // ear
  if (cat && /lion/.test(n)) g.ell(hx - 1, hy, 5, 5, 'second');
  if (/boar|mammoth|elephant/.test(n)) g.line(hx + 3, hy + 3, hx + 6, hy, 'accent', 1.4);
  if (/elephant|mammoth/.test(n)) g.line(hx + 4, hy + 2, hx + 5, hy + 9, 'body', 2);
  if (/rhinoceros|unicorn|triceratops/.test(n)) g.tri(hx + 3, hy - 1, hx + 5, hy - 1, hx + 6, hy - 6, 'accent');
  if (/goat|ram|ox\b|bull|elk|deer|minotaur|nightmare|gorgon|hell hound|bison/.test(n) || o.horns) { g.line(hx - 1, hy - 3, hx - 4, hy - 7, 'accent', 1.6); g.line(hx + 1, hy - 3, hx + 2, hy - 7, 'accent', 1.6); }
  if (/nightmare|hell hound|fire/.test(n)) for (let i = 0; i < 4; i++) g.dot(hx - 4 + i, hy - 5 - (i % 2), 'glow');
  if (/spider|displacer/.test(n)) { g.line(10, by - 3, 5, by - 10, 'body', 1.3); g.line(13, by - 3, 9, by - 11, 'body', 1.3); }
  if (o.wings || /pegasus|griffon|hippogriff|manticore|chimera|sphinx|lammasu/.test(n)) { g.tri(12, by - 2, 20, by - 2, 8, by - 13, 'second'); g.tri(14, by - 2, 21, by - 2, 17, by - 14, 'second'); }
}
function low(g, r, n) {
  const frog = /frog|toad/.test(n);
  const by = frog ? 21 : 24;
  if (frog) { g.ell(10, 26, 4, 3, 'body'); g.ell(22, 26, 4, 3, 'body'); }
  g.ell(15, by, frog ? 9 : 10, frog ? 6 : 3.6, 'body');
  g.ell(15, by + 2, frog ? 6 : 8, 1.6, 'second');
  if (!frog) { g.line(5, by, 1, by + 3, 'body', 2); for (const x of [8, 13, 18, 22]) g.rect(x, by + 2, 2, 4, 'body'); }
  const hx = frog ? 19 : 26, hy = frog ? by - 4 : by - 1;
  g.ell(hx, hy, frog ? 6 : 4.5, frog ? 4 : 2.6, 'body');
  g.line(hx - 2, hy + 1.5, hx + 4, hy + 1.5, 'dark');
  g.ell(hx - (frog ? 3 : 1), hy - (frog ? 3.5 : 2), 1.6, 1.6, 'body'); g.dot(hx - (frog ? 3 : 1), hy - (frog ? 3.5 : 2), 'eye');
  if (frog) { g.ell(hx + 3, hy - 3.5, 1.6, 1.6, 'body'); g.dot(hx + 3, hy - 3.5, 'eye'); }
  if (/crocodile/.test(n)) for (let x = 7; x < 24; x += 3) g.dot(x, by - 3.5, 'accent');
  if (/basilisk/.test(n)) for (let x = 8; x < 22; x += 3) g.tri(x, by - 3, x + 2, by - 3, x + 1, by - 6, 'accent');
}
function bird(g, r, n) {
  const bat = /\bbat\b|stirge|vrock|peryton/.test(n);
  g.ell(16, 16, 4.5, 6, 'body');
  g.ell(16, 18, 3, 3.5, 'second');
  const wing = bat ? 'body' : 'second';
  g.tri(12, 13, 1, 6, 4, 20, wing); g.tri(20, 13, 31, 6, 28, 20, wing);
  if (bat) { for (const x of [4, 8]) g.tri(x - 2, 20, x + 2, 20, x, 15, 0); for (const x of [24, 28]) g.tri(x - 2, 20, x + 2, 20, x, 15, 0); }
  g.ell(16, 8.5, 3.6, 3.4, bat ? 'body' : 'body');
  g.dot(14.5, 8, 'eye'); g.dot(17.5, 8, 'eye');
  if (bat) { g.tri(13, 7, 12, 3, 15, 6, 'body'); g.tri(19, 7, 20, 3, 17, 6, 'body'); g.dot(15, 11, 'accent'); g.dot(17, 11, 'accent'); }
  else if (/stirge/.test(n)) g.line(16, 10, 16, 15, 'accent', 1);
  else g.tri(15, 10, 17, 10, 16, 13, 'accent');
  if (/harpy/.test(n)) { g.ell(16, 8.5, 3.6, 3.4, 'second'); g.ell(16, 9, 3, 3, 'body'); g.dot(14.5, 9, 'eye'); g.dot(17.5, 9, 'eye'); }
  g.line(14, 22, 13, 27, 'accent'); g.line(18, 22, 19, 27, 'accent');
  g.tri(14, 21, 18, 21, 16, 26, wing);
}
function bug(g, r, n) {
  const scorp = /scorpion/.test(n), crab = /crab/.test(n), cent = /centipede|crawler/.test(n), fly = /wasp|\bbee\b|fly\b|mosquito/.test(n);
  if (cent) {
    for (let i = 0; i < 6; i++) { const x = 5 + i * 4, y = 22 - Math.sin(i * 0.9) * 3; g.line(x, y, x - 1, y + 5, 'accent'); g.line(x, y, x + 1, y - 5 + 10, 'accent'); g.ell(x, y, 2.6, 2.4, 'body'); }
    g.ell(28, 18, 2.8, 2.6, 'body'); g.dot(29, 17, 'eye'); g.line(29, 16, 31, 12, 'accent'); return;
  }
  if (fly) {
    g.ell(9, 10, 6, 3, 'glow'); g.ell(23, 10, 6, 3, 'glow');
    g.ell(16, 18, 4, 6, 'body'); for (let y = 15; y < 24; y += 3) g.rect(12, y, 8, 1, 'dark');
    g.ell(16, 9.5, 3.4, 3, 'body'); g.dot(14.5, 9, 'eye'); g.dot(17.5, 9, 'eye'); g.line(16, 24, 16, 28, 'accent');
    for (const s of [-1, 1]) { g.line(16 + s * 3, 16, 16 + s * 8, 22, 'accent'); g.line(16 + s * 3, 19, 16 + s * 7, 26, 'accent'); } return;
  }
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) {
    const y = 18 + i * 2.2;
    g.line(16 + s * 4, y, 16 + s * 10, y - 4, 'body', 1.2); g.line(16 + s * 10, y - 4, 16 + s * 13, y + 5, 'body', 1.2);
  }
  g.ell(16, 21, crab ? 9 : 6, crab ? 5 : 5, 'body');
  if (!crab) g.ell(16, 26 - (scorp ? 6 : 0), 5, 4, scorp ? 'body' : 'second');
  g.ell(16, 15, 4, 3, 'body');
  for (const x of [14, 15, 17, 18]) g.dot(x, 14.5, 'eye');
  if (scorp || crab) { g.ell(7, 11, 3, 2.4, 'body'); g.ell(25, 11, 3, 2.4, 'body'); g.dot(5, 10, 0); g.dot(27, 10, 0); }
  if (scorp) { g.line(16, 24, 22, 28, 'body', 2); g.line(22, 28, 26, 22, 'body', 2); g.line(26, 22, 24, 15, 'body', 2); g.tri(23, 15, 25, 15, 24, 12, 'accent'); }
  if (/spider/.test(n) && r() < 0.5) g.rect(15, 24, 2, 3, 'glow');
}
function snake(g, r, n) {
  const naga = /naga|yuan-ti|couatl/.test(n);
  for (let i = 0; i <= 22; i++) {
    const t = i / 22, x = 4 + t * 20, y = 26 - Math.sin(t * Math.PI * 1.6) * 4 - t * 4;
    g.ell(x, y, 2.4 + t * 1.2, 2.4 + t * 1.2, 'body');
    if (i % 3 === 0) g.dot(x, y + 1.5, 'second');
  }
  if (naga) { g.line(23, 19, 24, 11, 'body', 4); g.ell(24, 10, 4, 4.5, 'body'); g.dot(22.5, 9.5, 'eye'); g.dot(25.5, 9.5, 'eye'); if (/couatl/.test(n)) { g.tri(20, 16, 30, 10, 28, 20, 'second'); } }
  else {
    g.line(24, 20, 25, 12, 'body', 4.5);
    g.ell(26, 10, 4, 3, 'body'); g.dot(27, 9, 'eye'); g.line(29, 12, 31, 13, 'glow');
    if (/cobra|naga/.test(n)) { g.ell(25, 13, 4.5, 3, 'body'); g.ell(26, 10, 4, 3, 'body'); g.dot(27, 9, 'eye'); }
  }
  if (/worm/.test(n)) { g.ell(26, 10, 4, 3, 'body'); g.ell(27, 10, 2.2, 2.2, 'dark'); for (let a = 0; a < 6; a++) g.dot(27 + Math.cos(a) * 2.6, 10 + Math.sin(a) * 2.6, 'accent'); }
}
function dragon(g, r, n) {
  const wyrmling = /wyrmling|pseudodragon|faerie/.test(n);
  // wings behind, then a quadruped body with a long neck
  // a bat-like wing: bony fingers with membrane between, scalloped along the bottom
  const tips = [[2, 3], [7, 1.5], [13, 2], [18, 5]];
  for (let i = 0; i < tips.length - 1; i++) g.tri(17, 13, tips[i][0], tips[i][1], tips[i + 1][0], tips[i + 1][1], 'wing');
  g.tri(17, 13, 2, 3, 4, 12, 'wing'); g.tri(17, 13, 4, 12, 10, 11, 'wing');
  for (const [x, y] of tips) g.line(17, 12, x, y, 'body', 1.2);
  for (const [x, far] of [[8, 1], [18, 1], [10, 0], [20, 0]]) g.rect(x, 19, 3, 9, far ? 'dark' : 'body');
  for (const x of [10, 20]) g.rect(x - 0.5, 28, 4, 2, 'accent');
  g.line(5, 19, 1, 26, 'body', 2.4); g.tri(0, 27, 3, 26, 1, 30, 'body');
  g.ell(14, 17, 9, 5, 'body');
  g.ell(14, 19.5, 6.5, 2.4, 'second');
  for (let x = 7; x < 21; x += 3) g.tri(x, 12.5, x + 2, 12.5, x + 1, 10, 'accent');
  g.line(21, 15, 25, 7, 'body', 3.6);
  g.ell(26, 7, 3.6, 3, 'body');
  g.ell(29, 8, 2.6, 1.8, 'body');
  g.line(26.5, 9.2, 31, 9.2, 'dark');
  if (g.k > 1) {
    for (let x = 27.2; x < 30.8; x += 1.1) g.tri(x, 9.1, x + 0.6, 9.1, x + 0.3, 10, 'accent');            // teeth
    for (const x of [10, 20]) for (let c = 0; c < 3; c++) g.tri(x + c * 1.1, 29.4, x + c * 1.1 + 0.8, 29.4, x + c * 1.1 + 0.6, 30.6, 'accent'); // claws
    g.ell(30, 7.6, 0.35, 0.3, 'dark');                                                                       // nostril
  }
  g.dot(26, 6, 'eye');
  g.line(24, 5, 21, 1, 'accent', 1.5); g.line(26, 4.5, 25, 0.5, 'accent', 1.3);
  if (!wyrmling && /red|gold|brass|fire/.test(n)) for (let i = 0; i < 3; i++) g.dot(31, 10 + i, 'glow');
}
function ooze(g, r, n) {
  const cube = /cube|gelatinous/.test(n);
  if (cube) { g.rect(5, 6, 22, 23, 'body'); g.ell(11, 21, 2.5, 3.5, 'accent'); g.line(18, 12, 23, 16, 'metal', 1.2); g.ell(20, 23, 2, 1.5, 'accent'); return; }
  g.ell(16, 23, 12, 6.5, 'body');
  g.ell(14, 16, 7, 7, 'body');
  g.ell(21, 19, 4, 4, 'body');
  for (const x of [6, 25]) g.rect(x, 27, 2, 3, 'body');
  g.ell(12, 14, 1.6, 2, 'eye'); g.dot(12, 14.5, 'dark'); g.ell(17, 15, 1.4, 1.8, 'eye'); g.dot(17, 15.5, 'dark');
  g.line(11, 19, 18, 20, 'dark');
  for (let i = 0; i < 4; i++) g.dot(8 + r() * 16, 22 + r() * 5, 'glow');
}
function plant(g, r, n) {
  const tree = /treant|tree/.test(n);
  if (tree) {
    g.rect(12, 13, 9, 17, 'second');
    g.line(12, 29, 7, 30, 'second', 2); g.line(20, 29, 26, 30, 'second', 2);
    g.line(12, 16, 5, 8, 'second', 2); g.line(20, 16, 27, 8, 'second', 2);
    g.ell(16, 7, 11, 6, 'body'); g.ell(6, 9, 4, 3.5, 'body'); g.ell(26, 9, 4, 3.5, 'body');
    g.ell(14, 17, 1.2, 1.5, 'eye'); g.ell(19, 17, 1.2, 1.5, 'eye'); g.line(14, 21, 19, 21, 'dark');
    return;
  }
  if (/myconid|shrieker|violet|fung|mushroom/.test(n)) {
    g.rect(13, 14, 6, 15, 'second'); g.ell(16, 11, 10, 5.5, 'body'); g.rect(6, 11, 20, 2, 'body');
    for (let i = 0; i < 5; i++) g.ell(9 + i * 3.5, 9 - (i % 2), 1, 1, 'accent'); g.dot(14.5, 18, 'eye'); g.dot(17.5, 18, 'eye'); return;
  }
  g.ell(16, 20, 8, 9, 'body');
  for (let i = 0; i < 7; i++) { const a = -2.6 + i * 0.85; g.line(16, 18, 16 + Math.cos(a) * 13, 18 + Math.sin(a) * 11, 'body', 2.2); }
  g.ell(16, 18, 4, 2.5, 'dark'); for (const x of [13.5, 16, 18.5]) g.dot(x, 16.5, 'accent');
  g.dot(13, 13, 'eye'); g.dot(19, 13, 'eye');
  for (let i = 0; i < 4; i++) g.ell(6 + r() * 20, 6 + r() * 10, 1.4, 1.2, 'glow');
}
function elemental(g, r, n) {
  if (/mephit|imp/.test(n)) { humanoid(g, r, n, { horns: true }); g.tri(10, 13, 1, 6, 6, 20, 'second'); g.tri(22, 13, 31, 6, 26, 20, 'second'); return; }
  if (/earth|xorn|galeb/.test(n)) {
    g.ell(16, 18, 9, 9, 'body'); g.ell(6, 15, 4, 5, 'body'); g.ell(26, 15, 4, 5, 'body'); g.ell(6, 22, 3.5, 3, 'body'); g.ell(26, 22, 3.5, 3, 'body');
    g.rect(10, 25, 4, 5, 'body'); g.rect(18, 25, 4, 5, 'body'); g.ell(16, 9, 5, 4, 'body');
    for (let i = 0; i < 6; i++) g.dot(9 + r() * 14, 12 + r() * 12, 'dark'); g.rect(13, 8, 2, 1.5, 'glow'); g.rect(17, 8, 2, 1.5, 'glow'); return;
  }
  if (/water|kuo/.test(n)) { for (let i = 0; i < 5; i++) g.ell(16 + Math.sin(i) * 3, 27 - i * 4.5, 9 - i * 1.2, 3.5, 'body'); g.ell(16, 7, 4, 3.5, 'body'); g.dot(14.5, 7, 'eye'); g.dot(17.5, 7, 'eye'); g.line(8, 18, 4, 12, 'body', 2.5); g.line(24, 18, 28, 12, 'body', 2.5); return; }
  if (/air|stalker|storm/.test(n)) { for (let i = 0; i < 6; i++) g.ell(16 + Math.sin(i * 1.3) * 2, 27 - i * 4, 2 + i * 1.5, 2, i % 2 ? 'body' : 'second'); g.dot(14, 8, 'eye'); g.dot(18, 8, 'eye'); return; }
  // fire (and the rest): a flame body with arms
  g.tri(16, 1, 6, 22, 26, 22, 'body'); g.tri(9, 6, 7, 22, 15, 20, 'body'); g.tri(23, 5, 17, 20, 25, 22, 'body');
  g.ell(16, 22, 10, 6, 'body'); g.tri(9, 27, 23, 27, 16, 31, 'body');
  g.ell(16, 18, 5, 6, 'glow'); g.tri(16, 9, 12, 19, 20, 19, 'glow');
  g.line(7, 17, 2, 12, 'body', 2.5); g.line(25, 17, 30, 12, 'body', 2.5);
  g.dot(14, 14, 'dark'); g.dot(18, 14, 'dark');
}
function construct(g, r, n) {
  if (/flying sword/.test(n)) { g.line(6, 26, 26, 6, 'metal', 2.5); g.line(9, 19, 13, 23, 'accent', 2); g.ell(6, 26, 1.8, 1.8, 'accent'); return; }
  if (/rug|carpet/.test(n)) { g.tri(3, 24, 29, 18, 27, 28, 'second'); g.tri(3, 24, 6, 14, 29, 18, 'second'); for (let x = 6; x < 27; x += 4) g.dot(x, 21, 'accent'); return; }
  if (/homunculus/.test(n)) { humanoid(g, r, n, {}); g.tri(10, 13, 1, 6, 6, 20, 'second'); g.tri(22, 13, 31, 6, 26, 20, 'second'); return; }
  const big = /golem|guardian/.test(n);
  g.rect(10, 21, 5, 9, 'body'); g.rect(17, 21, 5, 9, 'body');
  g.rect(8 - (big ? 1 : 0), 10, 16 + (big ? 2 : 0), 12, 'body');
  g.rect(4, 11, 4, 12, 'body'); g.rect(24, 11, 4, 12, 'body');
  g.rect(3.5, 21, 5, 4, 'metal'); g.rect(23.5, 21, 5, 4, 'metal');
  g.rect(12, 3, 8, 7, 'body'); g.rect(13, 5, 6, 2, 'dark'); g.dot(14, 6, 'glow'); g.dot(17, 6, 'glow');
  g.rect(12, 13, 8, 5, 'second');
  if (/iron|armor|guardian/.test(n)) for (const [x, y] of [[9, 11], [22, 11], [9, 20], [22, 20]]) g.dot(x, y, 'accent');
  if (/stone|clay/.test(n)) for (let i = 0; i < 5; i++) g.dot(9 + r() * 14, 11 + r() * 10, 'dark');
  if (/flesh/.test(n)) { g.line(9, 15, 22, 15, 'dark'); g.line(16, 10, 16, 21, 'dark'); }
}
function eye(g, r, n) {
  const tent = /chuul|aboleth|otyugh|gibbering|cloaker|intellect/.test(n);
  if (!tent || /spectator|gauth|beholder/.test(n)) for (let i = 0; i < 6; i++) { const a = -2.9 + i * 0.55; const x = 16 + Math.cos(a) * 12, y = 14 + Math.sin(a) * 11; g.line(16 + Math.cos(a) * 7, 14 + Math.sin(a) * 7, x, y, 'body', 1.4); g.ell(x, y, 1.6, 1.6, 'eye'); g.dot(x, y, 'dark'); }
  if (tent) for (let i = 0; i < 6; i++) g.line(8 + i * 3.2, 20, 5 + i * 4 + (i % 2) * 2, 30, 'body', 2);
  g.ell(16, 16, 9, 8.5, 'body');
  g.ell(16, 14, 4.6, 4.2, 'eye'); g.ell(16, 14, 2.2, 3, 'glow'); g.rect(15.5, 12, 1, 4, 'dark');
  g.ell(16, 21, 5, 2, 'dark'); for (let x = 12.5; x < 20; x += 2) g.dot(x, 20, 'accent');
  if (/nothic/.test(n)) { g.ell(16, 14, 5.5, 5, 'eye'); g.ell(16, 14, 2.5, 3, 'glow'); }
}
function swarm(g, r, n, type) {
  const what = /insect|spider|wasp|beetle|centipede/.test(n) ? 'bug' : /bat|raven|bird/.test(n) ? 'bird' : /rat/.test(n) ? 'rat' : /snake|serpent/.test(n) ? 'snake' : 'bug';
  for (let i = 0; i < 9; i++) {
    const x = 5 + (i % 3) * 10 + r() * 3, y = 8 + Math.floor(i / 3) * 8 + r() * 3;
    if (what === 'bird') { g.tri(x - 4, y - 2, x, y, x - 1, y + 2, 'body'); g.tri(x + 4, y - 2, x, y, x + 1, y + 2, 'body'); g.ell(x, y, 1.4, 1.4, 'body'); }
    else if (what === 'rat') { g.ell(x, y, 3, 2, 'body'); g.dot(x + 3, y - 0.5, 'body'); g.dot(x + 2, y - 1, 'eye'); g.line(x - 3, y, x - 5, y + 2, 'accent'); }
    else if (what === 'snake') { g.line(x - 3, y + 1, x, y - 1, 'body', 1.6); g.line(x, y - 1, x + 3, y + 1, 'body', 1.6); g.dot(x + 3, y, 'eye'); }
    else { g.ell(x, y, 1.8, 1.5, 'body'); g.line(x - 3, y - 1, x + 3, y + 1, 'accent'); g.line(x - 3, y + 1, x + 3, y - 1, 'accent'); }
  }
}
function fiend(g, r, n) {
  const beast = /hezrou|vrock|glabrezu|chasme|barlgura/.test(n);
  g.tri(11, 13, 1, 3, 4, 21, 'second'); g.tri(21, 13, 31, 3, 28, 21, 'second');
  humanoid(g, r, n, { horns: true, bulk: /balor|pit fiend|glabrezu|hezrou|nalfeshnee|marilith/.test(n) ? 1 : 0 });
  g.line(20, 26, 27, 29, 'body', 1.2); g.tri(26, 28, 29, 27, 29, 30, 'body');
  if (beast) { g.ell(16, 8, 5, 4, 'body'); g.dot(14, 8, 'eye'); g.dot(18, 8, 'eye'); g.ell(16, 11, 3, 2, 'dark'); }
  if (/balor|fire/.test(n)) for (let i = 0; i < 6; i++) g.dot(8 + i * 3.2, 2 + (i % 2), 'glow');
}
function angel(g, r, n) {
  g.tri(11, 12, 1, 2, 5, 24, 'accent'); g.tri(21, 12, 31, 2, 27, 24, 'accent');
  humanoid(g, r, n, {});
  g.ell(16, 1.8, 4, 1.1, 'glow');
}
function giant(g, r, n) {
  g.s = 1;
  humanoid(g, r, n, { bulk: 1 });
  if (/ettin/.test(n)) { g.ell(11, 7, 3.6, 3.6, 'body'); g.ell(21, 7, 3.6, 3.6, 'body'); g.dot(10, 7, 'eye'); g.dot(12, 7, 'eye'); g.dot(20, 7, 'eye'); g.dot(22, 7, 'eye'); }
  if (/cyclops/.test(n)) { g.ell(16, 7.5, 4.8, 4.5, 'body'); g.ell(16, 7.5, 1.6, 1.6, 'eye'); }
  if (/troll/.test(n)) { g.ell(16, 9, 3, 2, 'body'); for (let i = 0; i < 3; i++) g.line(12 + i * 4, 3, 11 + i * 4, 1, 'second', 1.4); }
  if (/frost/.test(n)) g.rect(12, 10, 8, 3, 'accent');
  if (/fire/.test(n)) g.ell(16, 3, 5, 1.6, 'glow');
}
const PLANS = { humanoid, zombie, skeleton, ghost, quad, low, bird, bug, snake, dragon, ooze, plant, elemental, construct, eye, swarm, fiend, angel, giant };

// ---------- painting at 256×256 ----------
// Five tones per colour, darkest to lightest, and a 4×4 Bayer pattern to dither between them (classic pixel-art look).
// Shadows lean cool (toward blue-violet) and lights lean warm (toward gold), the way pixel artists shift hues.
const ramp5 = (h) => { const c = hex(h); return [mix(c, [34, 20, 74], 0.62), mix(c, [52, 40, 96], 0.33), c, mix(c, [255, 236, 170], 0.26), mix(c, [255, 250, 220], 0.52)]; };
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const TEXTURE = { quad: 'fur', bird: 'feather', dragon: 'scale', snake: 'scale', low: 'scale', construct: 'stone', giant: 'skin', humanoid: 'skin', zombie: 'skin', fiend: 'skin', angel: 'skin', elemental: 'swirl', plant: 'bark', bug: 'shell', skeleton: 'bone', ooze: 'goo', ghost: 'goo', eye: 'skin', swarm: 'fur' };

// Distance (in pixels) from each pixel to the nearest pixel that isn't part of the same blob (two-pass chamfer).
function distanceIn(mask, R, edgeIsOutside = true) {
  const E = edgeIsOutside ? 1 : 1e6;
  const BIG = 1e6, d = new Float32Array(R * R);
  for (let i = 0; i < R * R; i++) d[i] = mask[i] ? BIG : 0;
  const s2 = Math.SQRT2;
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const i = y * R + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1); else v = Math.min(v, E);
    if (y > 0) { v = Math.min(v, d[i - R] + 1); if (x > 0) v = Math.min(v, d[i - R - 1] + s2); if (x < R - 1) v = Math.min(v, d[i - R + 1] + s2); } else v = Math.min(v, E);
    d[i] = v;
  }
  for (let y = R - 1; y >= 0; y--) for (let x = R - 1; x >= 0; x--) {
    const i = y * R + x; if (!d[i]) continue;
    let v = d[i];
    if (x < R - 1) v = Math.min(v, d[i + 1] + 1); else v = Math.min(v, E);
    if (y < R - 1) { v = Math.min(v, d[i + R] + 1); if (x < R - 1) v = Math.min(v, d[i + R + 1] + s2); if (x > 0) v = Math.min(v, d[i + R - 1] + s2); } else v = Math.min(v, E);
    d[i] = v;
  }
  return d;
}

export function drawMonster(m, { words, seed, res = SPRITE } = {}) {
  const r = rng(seed || m.n);
  const plan = words ? 'humanoid' : bodyPlan(m);
  const n = (words || m.n).toLowerCase();
  const g = new Grid(plan === 'swarm' || plan === 'eye' ? 1 : SIZE[m.size] ?? 0.9, res);
  PLANS[plan](g, r, n, m.type);
  const pal = palette(words ? { ...m, n: `${words} ${m.n}` } : m, plan, r);
  const R = g.R, P = g.p, K = g.k;
  const ramps = Object.fromEntries(Object.keys(M).map((k) => [M[k], ramp5(pal[k])]));
  const out = new Uint8Array(R * R * 4);
  const tex = TEXTURE[plan] || 'skin';
  const tr = rng(`tex|${seed || m.n}`);
  const jitter = new Float32Array(64).map(() => tr());

  // Each part (same colour, touching) gets its own rounded "pillow": the height grows from its edge inward.
  const height = new Float32Array(R * R);
  for (const v of new Set(P)) {
    if (!v || v === M.eye || v === M.dark) continue;
    const mask = new Uint8Array(R * R);
    // Eyes, mouths and other small marks don't count as edges (they sit on the surface).
    for (let i = 0; i < R * R; i++) if (P[i] === v || P[i] === M.eye || P[i] === M.dark) mask[i] = 1;
    const d = distanceIn(mask, R);
    const cap = 2.6 * K;
    for (let i = 0; i < R * R; i++) if (mask[i]) { const t = Math.min(d[i], cap) / cap; height[i] = Math.sqrt(1 - (1 - t) ** 2); }
  }
  // Smooth the height a little, so stair-stepped edges don't turn into stripes of shading.
  {
    const rad = Math.max(1, Math.round(K * 0.45)), tmp = new Float32Array(R * R);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
        const i = y * R + x; if (!P[i]) { tmp[i] = 0; continue; }
        let sum = 0, n2 = 0;
        for (let d = -rad; d <= rad; d++) { const xx = x + d; if (xx >= 0 && xx < R && P[i + d] === P[i]) { sum += height[i + d]; n2++; } }
        tmp[i] = sum / n2;
      }
      for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
        const i = y * R + x; if (!P[i]) continue;
        let sum = 0, n2 = 0;
        for (let d = -rad; d <= rad; d++) { const yy = y + d; if (yy >= 0 && yy < R && P[i + d * R] === P[i]) { sum += tmp[i + d * R]; n2++; } }
        height[i] = sum / n2;
      }
    }
  }
  const L = [-0.55, -0.72, 0.65]; // light from the top left, a little in front
  // Contact shadows: a part is a little darker right where another part sits on top of it.
  const contact = new Float32Array(R * R);
  {
    const reach = 1.4 * K;
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      const i = y * R + x, v = P[i];
      if (!v || v === M.eye || v === M.dark || v === M.glow) continue;
      for (let d = 1; d <= reach; d++) {
        const o = g.at(x, y - d);  // something different just above: it overlaps / casts down
        if (o && o !== v && o !== M.eye && o !== M.dark && o > v) { contact[i] = 0.9 * (1 - d / reach); break; }
      }
    }
  }
  const outline = mix(hex(pal.body), [10, 5, 16], 0.86);
  const reachSeam = Math.max(1, Math.round(K / 4));
  const seam = (x, y, v) => { // a pixel next to a different part: draw the line between them
    for (let s2 = 1; s2 <= reachSeam; s2++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const o = g.at(x + dx * s2, y + dy * s2); if (o && o !== v && o !== M.eye && o !== M.dark && v !== M.dark && v < o) return true; }
    return false;
  };
  const surface = (x, y, v, t) => { // fur, scales, stone… a nudge up or down in tone
    const k = K;
    if (v === M.metal) return 0;
    if (v === M.second) return (Math.sin(x / (1.6 * k) + Math.sin(y / (4 * k)) * 1.5) > 0.96 ? -0.6 : 0); // cloth folds
    if (v !== M.body && v !== M.wing) return 0;
    if (t === 'fur') { const s = (x * 2 + y * 5 + Math.floor(jitter[((x >> 3) + (y >> 3) * 7) & 63] * 60)) % Math.round(22 * k / 4); return s < 2 ? -0.7 : 0; }
    if (t === 'feather') { const cy = y % (3 * k), cx = (x + (Math.floor(y / (3 * k)) % 2) * 1.5 * k) % (3 * k); return cy > 2.4 * k || Math.abs(cx - 1.5 * k) > 1.35 * k ? -1 : 0; }
    if (t === 'scale') { const row = Math.floor(y / (1.6 * k)), cx = (x + (row % 2) * 1.2 * k) % (2.4 * k) - 1.2 * k, cy = y % (1.6 * k); return Math.hypot(cx, cy * 1.4) > 1.15 * k && cy < 0.9 * k ? -1 : 0; }
    if (t === 'stone') { const c = jitter[((x / (3 * k)) | 0) * 7 + ((y / (2 * k)) | 0) * 13 & 63]; return (x % (3 * k) < 1 || y % (2 * k) < 1) && c > 0.3 ? -1 : 0; }
    if (t === 'bark') return Math.sin(x / (0.7 * k) + Math.sin(y / (3 * k)) * 2) > 0.85 ? -1 : 0;
    if (t === 'shell') return Math.abs(Math.sin(y / (1.2 * k))) < 0.12 ? -1 : 0;
    if (t === 'goo') return jitter[((x >> 3) * 5 + (y >> 3) * 3) & 63] > 0.93 ? 1 : 0;
    if (t === 'bone') return 0;
    return jitter[((x >> 2) * 11 + (y >> 2) * 17) & 63] > 0.94 ? -1 : 0; // skin: a few freckles of shade
  };
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const i = y * R + x, v = P[i];
    if (!v) continue;
    const rp = ramps[v];
    let c;
    if (v === M.eye) c = rp[3];
    else if (v === M.dark) c = rp[1];
    else if (v === M.glow) c = (height[i] > 0.55 ? rp[4] : height[i] > 0.25 ? rp[3] : rp[2]);
    else {
      // normal from the height slope → how much it faces the light
      const hx = (height[i + 1] || 0) - (height[i - 1] || 0), hy = (height[i + R] || 0) - (height[i - R] || 0);
      const nx = -hx * K * 1.6, ny = -hy * K * 1.6, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const lum = (nx * L[0] + ny * L[1] + nz * L[2]) / len;             // how much it faces the light
      // the lower part of the sprite sits a little more in shadow; textures nudge the tone
      let t = 2.1 + (lum - 0.62) * 4.4 + surface(x, y, v, tex) * 0.6 - (contact[i] || 0);
      t = Math.max(0, Math.min(4, t));
      // Clean bands of tone, dithered only right at the border between two bands.
      const base = Math.floor(t), frac = t - base;
      const edge = Math.max(0, Math.min(1, (frac - 0.38) / 0.24));
      let tone = edge > BAYER[(y & 3) * 4 + (x & 3)] ? base + 1 : base;
      if (seam(x, y, v)) tone = Math.min(tone, 1);
      // Rim light: a thin cool edge on the side away from the main light.
      const rim = nx > 0.35 && height[i] < 0.22 && tone <= 1;
      if (v === M.metal && lum > 0.9) tone = 4; // a shine on metal
      c = rp[Math.max(0, Math.min(4, tone))];
      if (rim) c = mix(c, [150, 190, 255], 0.28);
    }
    out.set([c[0], c[1], c[2], 255], i * 4);
  }

  // Eyes: a dark pupil (looking the way the creature faces) and a white glint.
  const seen = new Uint8Array(R * R);
  for (let i = 0; i < R * R; i++) {
    if (P[i] !== M.eye || seen[i]) continue;
    const q = [i]; seen[i] = 1; let sx = 0, sy = 0, cnt = 0;
    while (q.length) { const j = q.pop(); const x = j % R, y = (j / R) | 0; sx += x; sy += y; cnt++; for (const o of [j + 1, j - 1, j + R, j - R]) if (o >= 0 && o < R * R && !seen[o] && P[o] === M.eye) { seen[o] = 1; q.push(o); } }
    if (cnt < 6) continue;
    const cx = sx / cnt, cy = sy / cnt, rad = Math.sqrt(cnt / Math.PI);
    const look = plan === 'humanoid' || plan === 'giant' || plan === 'zombie' || plan === 'skeleton' || plan === 'fiend' || plan === 'angel' ? 0 : 0.25;
    const glowy = hex(pal.eye)[0] > 200 && hex(pal.eye)[1] < 120; // red, glowing eyes have no pupil
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++) for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
      const j = y * R + x; if (P[j] !== M.eye) continue;
      const d = Math.hypot(x - (cx + rad * look), y - cy);
      if (!glowy && d < rad * 0.55) out.set([20, 12, 18, 255], j * 4);
      if (Math.hypot(x - (cx - rad * 0.3), y - (cy - rad * 0.32)) < rad * 0.24) out.set([255, 255, 255, 255], j * 4);
    }
  }

  // A soft glow around glowing parts (flames, magic, burning eyes).
  const glowMask = new Uint8Array(R * R);
  let anyGlow = false;
  for (let i = 0; i < R * R; i++) if (P[i] === M.glow || (P[i] === M.eye && hex(pal.eye)[1] < 120)) { glowMask[i] = 1; anyGlow = true; }
  const gd = anyGlow ? distanceIn(glowMask.map((v) => (v ? 0 : 1)), R, false) : null;

  // Thick dark outline around the whole creature, then the glow outside it.
  const solid = new Uint8Array(R * R);
  for (let i = 0; i < R * R; i++) solid[i] = P[i] ? 0 : 1;
  const od = distanceIn(solid, R, false);   // distance from empty pixels to the creature
  const thick = Math.max(1, Math.round(K * 0.42));
  const gc = hex(pal.glow);
  // Ground shadow under the feet.
  let lowest = 0; for (let i = R * R - 1; i >= 0; i--) if (P[i]) { lowest = (i / R) | 0; break; }
  let minX = R, maxX = 0; for (let y = Math.max(0, lowest - 2 * K); y <= lowest; y++) for (let x = 0; x < R; x++) if (P[y * R + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  const shX = (minX + maxX) / 2, shW = Math.max(3 * K, (maxX - minX) / 2 + K), shY = Math.min(R - 2, lowest + 0.2 * K), shH = 0.9 * K;
  for (let i = 0; i < R * R; i++) {
    if (P[i]) continue;
    if (od[i] <= thick + 0.01) {
      // Outline in a very dark version of the colour it borders (softer than plain black).
      const x = i % R, y = (i / R) | 0;
      let nb = 0;
      for (let d = 1; d <= thick + 1 && !nb; d++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const o = g.at(x + dx * d, y + dy * d); if (o) { nb = o; break; } }
      const oc = nb && nb !== M.dark ? mix(ramps[nb][0], [8, 4, 14], 0.55) : outline;
      out.set([oc[0], oc[1], oc[2], 255], i * 4);
      continue;
    }
    const x = i % R, y = (i / R) | 0;
    const e = ((x - shX) / shW) ** 2 + ((y - shY) / shH) ** 2;
    if (e < 1) { out.set([10, 6, 14, Math.round(70 * (1 - e))], i * 4); continue; }
    if (gd && gd[i] < 3 * K) {
      const a = Math.round(150 * (1 - gd[i] / (3 * K)) ** 2);
      if (a > 6 && BAYER[(((i / R) | 0) & 3) * 4 + ((i % R) & 3)] < a / 150 + 0.15) out.set([gc[0], gc[1], gc[2], a], i * 4);
    }
  }
  // Ghosts and oozes are a little see-through.
  if (plan === 'ghost') for (let i = 0; i < R * R; i++) if (P[i]) out[i * 4 + 3] = 215;
  return { rgba: out, plan, res: R };
}

// Smaller copies (for the battle map): each output pixel is the average of the pixels it covers.
export function shrink(rgba, from, to) {
  const out = new Uint8Array(to * to * 4), f = from / to;
  for (let y = 0; y < to; y++) for (let x = 0; x < to; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let j = Math.floor(y * f); j < Math.floor((y + 1) * f); j++) for (let i = Math.floor(x * f); i < Math.floor((x + 1) * f); i++) {
      const s = (j * from + i) * 4, al = rgba[s + 3];
      r += rgba[s] * al; g += rgba[s + 1] * al; b += rgba[s + 2] * al; a += al; n++;
    }
    const d = (y * to + x) * 4;
    if (a) { out[d] = r / a; out[d + 1] = g / a; out[d + 2] = b / a; out[d + 3] = a / n; }
  }
  return out;
}

// ---------- PNG ----------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Bigger copies keep the hard pixel edges (Discord would blur a 32px image).
export function scaleUp(rgba, w, h, k) {
  const out = new Uint8Array(w * k * h * k * 4);
  for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) {
    const s = (Math.floor(y / k) * w + Math.floor(x / k)) * 4, d = (y * w * k + x) * 4;
    out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
  }
  return out;
}

// The party: a person dressed for their class and people (a wizard's robe and staff, a fighter's armour, elf ears…).
const CLASS_WORDS = { wizard: 'wizard', sorcerer: 'mage', warlock: 'warlock', cleric: 'priest', druid: 'druid', fighter: 'knight', paladin: 'knight',
  ranger: 'ranger', rogue: 'rogue', barbarian: 'barbarian', monk: 'monk', bard: 'bard', artificer: 'veteran' };
export function heroWords(h) {
  const cls = String(h.cls || '').toLowerCase().split(/[\s/]/)[0];
  const sp = String(h.species || '').toLowerCase();
  const kin = /elf/.test(sp) ? 'elf' : /orc/.test(sp) ? 'orc' : /gnome/.test(sp) ? 'gnome' : /tiefling/.test(sp) ? 'tiefling' : /dragonborn/.test(sp) ? 'kobold' : /goliath/.test(sp) ? 'stone' : '';
  return `${CLASS_WORDS[cls] || 'warrior'} ${kin}`;
}
export function drawHero(h, opts = {}) {
  return drawMonster({ n: h.name, type: 'humanoid', size: /halfling|gnome/i.test(h.species || '') ? 'Small' : 'Medium' }, { words: heroWords(h), seed: h.name, ...opts });
}

// Painting a 256×256 sprite takes a moment, so finished ones are kept in memory and on disk (cache\sprites).
const VERSION = 'v3';
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache', `sprites-${VERSION}`);
const cache = new Map();
function cached(key, paint) {
  if (cache.has(key)) return cache.get(key);
  const file = path.join(CACHE_DIR, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}.png`);
  let buf = null;
  try { buf = fs.readFileSync(file); } catch { /* not yet */ }
  if (!buf) {
    buf = paint();
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, buf); } catch { /* fine, memory only */ }
  }
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  cache.set(key, buf);
  return buf;
}
export function heroPng(h) {
  return cached(`hero|${h.name}|${heroWords(h)}|${h.species || ''}`, () => png(drawHero(h).rgba, SPRITE, SPRITE));
}
export function spritePng(m) {
  return cached(`mon|${m.n}|${m.size}|${m.type}`, () => png(drawMonster(m).rgba, SPRITE, SPRITE));
}
// Pixels of a sprite at any size (the battle map uses 64 per square), kept in memory.
const pixelCache = new Map();
export function spritePixels(u, size) {
  const key = `${u.side === 'h' ? `h|${u.name}|${heroWords(u)}` : `m|${u.n}`}|${size}`;
  if (!pixelCache.has(key)) {
    const full = u.side === 'h' ? drawHero(u).rgba : drawMonster(u).rgba;
    if (pixelCache.size > 300) pixelCache.delete(pixelCache.keys().next().value);
    pixelCache.set(key, size === SPRITE ? full : shrink(full, SPRITE, size));
  }
  return pixelCache.get(key);
}
