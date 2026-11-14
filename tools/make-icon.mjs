// Draws the Dungeon Tiger icon (a stone archway with a glowing door and tiger-striped torches) and saves
// launcher/dungeon.ico with 16, 32, 48 and 256 pixel sizes, plus public/icon.png.
import fs from 'node:fs';
import { Grid, ramp, hex, png, scaleUp } from '../src/sprites.js';

const g = new Grid(1);
// stone arch
g.rect(4, 8, 24, 22, 'body');
g.ell(16, 9, 12, 7, 'body');
// doorway
g.rect(9, 12, 14, 18, 'dark');
g.ell(16, 12, 7, 5, 'dark');
// glowing door planks
g.rect(10, 13, 12, 17, 'glow');
g.ell(16, 13, 6, 4, 'glow');
for (const x of [13, 16, 19]) g.rect(x, 10, 1, 20, 'second');
g.ell(19, 21, 1, 1, 'dark');
// tiger stripes on the arch
for (const [x, y] of [[6, 10], [6, 16], [6, 22], [25, 10], [25, 16], [25, 22]]) { g.rect(x - 1, y, 3, 1.4, 'accent'); }
for (const [x, y] of [[11, 4], [16, 3], [21, 4]]) g.rect(x, y, 1.4, 3, 'accent');
// torches
for (const x of [2, 29]) { g.rect(x, 14, 1.5, 6, 'second'); g.ell(x + 0.5, 12, 1.6, 2.2, 'metal'); }
const pal = { 1: ramp('#e0892e'), 2: ramp('#6a4428'), 3: ramp('#ffd04a'), 4: ramp('#1a1214'), 6: ramp('#2a1810'), 7: ramp('#ffb347') };
const rgba = new Uint8Array(32 * 32 * 4);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const v = g.at(x, y), i = (y * 32 + x) * 4;
  let c = null;
  if (v) { const rp = pal[v] || ramp('#888888'); c = v === 7 || v === 3 || v === 6 ? rp[1] : !g.at(x + 1, y) || !g.at(x, y + 1) ? rp[0] : !g.at(x, y - 1) || !g.at(x - 1, y) ? rp[2] : rp[1]; }
  else if (g.at(x - 1, y) || g.at(x + 1, y) || g.at(x, y - 1) || g.at(x, y + 1)) c = [20, 10, 14];
  if (c) rgba.set([c[0], c[1], c[2], 255], i);
}
const sizes = [16, 32, 48, 256];
const pngs = sizes.map((s) => {
  if (s === 16) { // halve
    const out = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out.set(rgba.subarray(((y * 2) * 32 + x * 2) * 4, ((y * 2) * 32 + x * 2) * 4 + 4), (y * 16 + x) * 4);
    return png(out, 16, 16);
  }
  if (s === 48) { const big = scaleUp(rgba, 32, 32, 3); const out = new Uint8Array(48 * 48 * 4); for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) out.set(big.subarray(((y * 2) * 96 + x * 2) * 4, ((y * 2) * 96 + x * 2) * 4 + 4), (y * 48 + x) * 4); return png(out, 48, 48); }
  return s === 32 ? png(rgba, 32, 32) : png(scaleUp(rgba, 32, 32, 8), 256, 256);
});
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s; head[e + 2] = 0; head[e + 3] = 0;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(new URL('../launcher/dungeon.ico', import.meta.url), Buffer.concat([head, ...pngs]));
fs.writeFileSync(new URL('../public/icon.png', import.meta.url), pngs[3]);
console.log('icon written');
