// Makes the dungeon: five floors, each a 5×4 grid of cells with 9–12 rooms joined by doors. The start is in one corner
// area, the stairs (or, on the last floor, the boss lair) as far away as possible. Rooms hold monsters, traps, treasure,
// a safe place to rest, or nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick, shuffle, d } from './dice.js';
import { roomDims } from './battlemap.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
export const MONSTERS = load('monsters-srd.json');
export const ITEMS = load('items-srd.json');

export const FLOORS = 5;
const W = 5, H = 4;
const DIRS = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' };

// XP budgets per character level for a "medium" fight (2014 DMG table), and the multiplier for several monsters.
const MEDIUM = [50, 100, 150, 250, 500, 600, 750, 900, 1100, 1200, 1600, 2000, 2200, 2500, 2800, 3200, 3900, 4200, 4900, 5700];
const groupMult = (n) => (n <= 1 ? 1 : n === 2 ? 1.5 : n <= 6 ? 2 : 2.5);

const FLOOR_NAMES = ['The Rat-Gnawed Cellars', 'The Drowned Crypts', 'The Fungal Deep', 'The Forgotten Forge', 'The Heart of the Dark'];
const ROOM_FLAVOR = ['a damp stone hall', 'a collapsed library', 'an old guard post', 'a flooded chamber', 'a shrine to a forgotten god',
  'a storeroom of rotten crates', 'a bone-strewn den', 'a narrow gallery of statues', 'a mushroom grotto', 'a rusted torture chamber',
  'a crumbling barracks', 'an echoing cistern', 'a cracked mosaic hall', 'a spider-webbed vault', 'a smoke-stained kitchen'];
const TRAPS = [
  { name: 'a poison dart trap', save: 'dex', dmg: 'poison' }, { name: 'a collapsing ceiling', save: 'dex', dmg: 'bludgeoning' },
  { name: 'a fire rune', save: 'dex', dmg: 'fire' }, { name: 'a pit with spikes', save: 'dex', dmg: 'piercing' },
  { name: 'a cloud of spores', save: 'con', dmg: 'poison' }, { name: 'a whispering glyph', save: 'wis', dmg: 'psychic' },
];

const WATER = /piranha|shark|octopus|crab|plesiosaurus|killer whale|quipper|reef|sea |merfolk|sahuagin|crocodile|giant frog|hippocampus|eel/i;

// Monsters for a fight: an XP budget from the party's level and size, scaled by floor; the boss fight is one big monster plus helpers.
export function makeEncounter({ edition, level, size, floor, kind = 'fight' }) {
  const list = MONSTERS[edition === '2014' ? '2014' : '2024'];
  const scale = kind === 'boss' ? 1.6 : kind === 'guard' ? 0.9 : 0.5 + 0.08 * (floor - 1);
  // Small parties and level 1 characters are fragile: go easier on them.
  const easy = (size === 1 ? 0.55 : size === 2 ? 0.8 : 1) * (level === 1 ? 0.8 : 1);
  const budget = MEDIUM[Math.min(19, level - 1)] * size * scale * easy;
  const maxCr = kind === 'boss' ? Math.max(level === 1 ? 0.5 : 1, level + (size >= 3 ? 2 : size === 2 ? 1 : 0) - (level === 1 ? 1 : 0)) : Math.max(0.25, level <= 2 ? level / 2 : level - 1);
  const ok = list.filter((m) => !WATER.test(m.n) && m.cr <= maxCr && m.cr >= (kind === 'boss' ? Math.min(maxCr, Math.max(0.5, level - 1)) : 0) && m.xp > 0);
  const out = [];
  if (kind === 'boss') {
    const big = ok.filter((m) => m.xp <= budget * 0.7).sort((a, b) => b.xp - a.xp).slice(0, 8);
    if (big.length) out.push(pick(big));
  }
  // Add monsters (the same kind, mostly) until the budget is used.
  const base = pick(ok.filter((m) => m.xp <= budget / 2)) || ok.sort((a, b) => a.xp - b.xp)[0];
  for (let tries = 0; tries < 12 && out.length < 6; tries++) {
    const m = Math.random() < 0.7 ? base : pick(ok.filter((x) => x.xp <= budget / 3)) || base;
    const xp = [...out, m].reduce((n, x) => n + x.xp, 0) * groupMult(out.length + 1);
    if (xp > budget && out.length) break;
    out.push(m);
  }
  const counts = {};
  return out.map((m) => {
    counts[m.n] = (counts[m.n] || 0) + 1;
    const label = out.filter((x) => x.n === m.n).length > 1 ? `${m.n} ${String.fromCharCode(64 + counts[m.n])}` : m.n;
    return { ...m, name: label, maxHp: m.hp, hp: m.hp, id: `${m.n}-${counts[m.n]}-${Math.random().toString(36).slice(2, 6)}` };
  });
}

function makeLoot({ edition, floor, level, kind }) {
  const gold = (kind === 'boss' ? 5 : 1) * (d(6) + d(6)) * 10 * floor * Math.max(1, Math.ceil(level / 4));
  const loot = { gold, items: [] };
  if (Math.random() < 0.55 || kind === 'boss') loot.items.push('Potion of Healing');
  const rare = floor >= 4 || kind === 'boss' ? ['Uncommon', 'Rare'] : floor >= 2 ? ['Common', 'Uncommon'] : ['Common'];
  if (Math.random() < 0.25 + floor * 0.08 || kind === 'boss') {
    const pool = ITEMS[edition === '2014' ? '2014' : '2024'].filter((i) => rare.includes(i.r));
    if (pool.length) loot.items.push(pick(pool).n);
  }
  return loot;
}

export function makeFloor({ floor, edition, level, size }) {
  // A random tree of rooms over the grid (so every room is reachable), plus a couple of extra doors for loops.
  const cells = new Map();
  const key = (x, y) => `${x},${y}`;
  const want = 9 + Math.floor(Math.random() * 4);
  const start = [0, Math.floor(Math.random() * H)];
  cells.set(key(...start), { x: start[0], y: start[1], exits: {} });
  const frontier = [start];
  while (cells.size < want && frontier.length) {
    const [x, y] = pick(frontier);
    const dirs = shuffle(Object.keys(DIRS)).filter((dir) => {
      const [nx, ny] = [x + DIRS[dir][0], y + DIRS[dir][1]];
      return nx >= 0 && ny >= 0 && nx < W && ny < H && !cells.has(key(nx, ny));
    });
    if (!dirs.length) { frontier.splice(frontier.findIndex(([a, b]) => a === x && b === y), 1); continue; }
    const dir = dirs[0];
    const [nx, ny] = [x + DIRS[dir][0], y + DIRS[dir][1]];
    cells.get(key(x, y)).exits[dir] = key(nx, ny);
    cells.set(key(nx, ny), { x: nx, y: ny, exits: { [OPP[dir]]: key(x, y) } });
    frontier.push([nx, ny]);
  }
  for (let i = 0; i < 2; i++) {
    const c = pick([...cells.values()]);
    const dir = pick(Object.keys(DIRS));
    const other = cells.get(key(c.x + DIRS[dir][0], c.y + DIRS[dir][1]));
    if (other && !c.exits[dir]) { c.exits[dir] = key(other.x, other.y); other.exits[OPP[dir]] = key(c.x, c.y); }
  }
  // The stairs: the room farthest (in steps) from the start.
  const dist = new Map([[key(...start), 0]]);
  const queue = [key(...start)];
  while (queue.length) {
    const k = queue.shift();
    for (const n of Object.values(cells.get(k).exits)) if (!dist.has(n)) { dist.set(n, dist.get(k) + 1); queue.push(n); }
  }
  const far = [...dist.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const last = floor === FLOORS;
  const flavors = shuffle(ROOM_FLAVOR);
  const others = shuffle([...cells.keys()].filter((k) => k !== key(...start) && k !== far));
  const kinds = {};
  // One safe room per floor; the rest mostly fights.
  others.forEach((k, i) => { kinds[k] = i === 0 ? 'rest' : pick(['fight', 'fight', 'fight', 'empty', 'empty', 'empty', 'treasure', 'treasure', 'trap']); });
  kinds[key(...start)] = 'start';
  kinds[far] = last ? 'boss' : 'stairs';
  const rooms = {};
  let n = 0;
  for (const [k, c] of cells) {
    const kind = kinds[k];
    const room = { id: k, x: c.x, y: c.y, exits: c.exits, kind, name: flavors[n++ % flavors.length], seen: false, visited: false, cleared: false, dims: roomDims(kind, `${floor}|${k}|${Math.random()}`) };
    if (kind === 'fight') room.monsters = makeEncounter({ edition, level, size, floor });
    if (kind === 'stairs') room.monsters = makeEncounter({ edition, level, size, floor, kind: 'guard' });
    if (kind === 'boss') room.monsters = makeEncounter({ edition, level, size, floor, kind: 'boss' });
    if (['fight', 'treasure', 'stairs', 'boss'].includes(kind)) room.loot = makeLoot({ edition, floor, level, kind });
    if (kind === 'trap') room.trap = { ...pick(TRAPS), dc: 11 + floor, dice: `${Math.min(10, 1 + floor + Math.floor(level / 3))}d6` };
    // Say how big it is: "a cramped mushroom grotto", "a vast echoing cistern".
    const big = room.dims.w >= 14 ? 'vast' : room.dims.w >= 12 ? 'large' : room.dims.w <= 8 ? 'cramped' : '';
    if (big) room.name = `a ${big} ${room.name.replace(/^an? /, '')}`;
    rooms[k] = room;
  }
  rooms[key(...start)].seen = true;
  return { floor, name: FLOOR_NAMES[floor - 1], w: W, h: H, rooms, start: key(...start), exit: far };
}

// A small text map for Discord: [@] you, [S] stairs, [B] boss, [M] monsters seen, [$] loot, [+] safe room, [ ] cleared, [?] unexplored.
export function asciiMap(fl, here) {
  const icon = (r) => {
    if (r.id === here) return '@';
    if (!r.seen) return '?';
    if (r.kind === 'stairs') return 'S';
    if (r.kind === 'boss') return r.cleared ? ' ' : 'B';
    if ((r.kind === 'fight') && !r.cleared) return 'M';
    if (r.loot && !r.looted && r.visited) return '$';
    if (r.kind === 'rest' && !r.rested) return '+';
    return ' ';
  };
  const lines = [];
  for (let y = 0; y < fl.h; y++) {
    let row = '', below = '';
    for (let x = 0; x < fl.w; x++) {
      const r = fl.rooms[`${x},${y}`];
      const show = r && (r.seen || r.visited);
      row += show ? `[${icon(r)}]` : '   ';
      row += show && r.exits.e && (r.visited || fl.rooms[r.exits.e].visited) ? '─' : ' ';
      below += show && r.exits.s && (r.visited || fl.rooms[r.exits.s].visited) ? ' │  ' : '    ';
    }
    lines.push(row.trimEnd());
    if (y < fl.h - 1) lines.push(below.trimEnd());
  }
  return lines.join('\n');
}
export { DIRS };
