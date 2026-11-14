// Talks to Note Tiger's connection API (Note Tiger → Settings → Connections). If Note Tiger isn't running or the key is
// wrong, the game still works: it makes simple stand-in characters and skips the Party tracker and the recap.
import { pick } from './dice.js';

export class NoteTiger {
  constructor({ url, key, server }) {
    this.url = (url || 'http://localhost:3081/v1').replace(/\/+$/, '');
    this.key = key || '';
    this.server = server || '';
    this.ok = false;
    this.lastError = '';
  }
  async call(method, route, body, { raw = false } = {}) {
    const sep = route.includes('?') ? '&' : '?';
    const res = await fetch(`${this.url}${route}${this.server ? `${sep}server=${this.server}` : ''}`, {
      method, signal: AbortSignal.timeout(method === 'POST' && route.startsWith('/rules/ask') ? 180_000 : 20_000),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify({ server: this.server || undefined, ...body }) : undefined,
    });
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Note Tiger said ${res.status}`);
    return data;
  }
  async check() {
    try { const info = await this.call('GET', '/info'); this.ok = true; this.lastError = ''; return info; }
    catch (err) { this.ok = false; this.lastError = err.message; return null; }
  }
  async randomCharacters({ count, level, edition, player, playerId, cls }) {
    const { characters } = await this.call('POST', '/characters/random', { count, level, edition, player, playerId, class: cls, tag: 'dungeon', source: 'Dungeon Tiger' });
    return characters;
  }
  // Fire-and-forget updates for the Party tab.
  track(id, change) {
    if (!this.ok || !id || String(id).startsWith('local-')) return;
    this.call('POST', `/characters/${encodeURIComponent(id)}/track`, { ...change, source: 'Dungeon Tiger' }).catch(() => {});
  }
  remove(id) {
    if (!this.ok || !id || String(id).startsWith('local-')) return;
    this.call('DELETE', `/characters/${encodeURIComponent(id)}`).catch(() => {});
  }
  ask(question) { return this.call('POST', '/rules/ask', { question }); }
  sendRun(run) { return this.call('POST', '/runs', run); }
  // Puts (or takes down) the "join the dungeon" link on Note Tiger's password-protected player website.
  publishLive(body) { return this.call('POST', '/site/live', body); }
}

// Stand-ins when Note Tiger can't be reached: simple level-scaled fighters, rogues, clerics and wizards.
const LOCAL = {
  Fighter: { hd: 10, ac: 18, ab: { str: 16, dex: 12, con: 15, int: 8, wis: 12, cha: 10 }, saves: ['str', 'con'], attacks: [['Longsword', 'str', '1d8', 'slashing']], spells: [] },
  Rogue: { hd: 8, ac: 14, ab: { str: 8, dex: 16, con: 14, int: 12, wis: 10, cha: 13 }, saves: ['dex', 'int'], attacks: [['Rapier', 'dex', '1d8', 'piercing'], ['Shortbow', 'dex', '1d6', 'piercing']], spells: [] },
  Cleric: { hd: 8, ac: 18, ab: { str: 14, dex: 10, con: 14, int: 8, wis: 16, cha: 12 }, saves: ['wis', 'cha'], attacks: [['Mace', 'str', '1d6', 'bludgeoning']], spells: [['Sacred Flame', 0], ['Cure Wounds', 1], ['Guiding Bolt', 1]], cast: 'wis', full: true },
  Wizard: { hd: 6, ac: 12, ab: { str: 8, dex: 14, con: 14, int: 16, wis: 12, cha: 10 }, saves: ['int', 'wis'], attacks: [['Quarterstaff', 'str', '1d6', 'bludgeoning']], spells: [['Fire Bolt', 0], ['Magic Missile', 1], ['Burning Hands', 1], ['Scorching Ray', 2], ['Fireball', 3]], cast: 'int', full: true },
};
const FULL = [[2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2]];
export function localCharacter({ level = 1, player = '', playerId = '', cls } = {}) {
  const name = `${pick(['Ash', 'Bree', 'Corin', 'Dell', 'Ember', 'Fen', 'Gale', 'Hob', 'Ivy', 'Jory'])} ${pick(['Stone', 'Vale', 'Thorn', 'Brook', 'Wick'])}`;
  const k = cls && LOCAL[cls] ? cls : pick(Object.keys(LOCAL));
  const t = LOCAL[k];
  const pb = 2 + Math.floor((level - 1) / 4);
  const m = (a) => Math.floor((t.ab[a] - 10) / 2);
  const hp = t.hd + m('con') + (level - 1) * (t.hd / 2 + 1 + m('con'));
  const slots = t.full ? Object.fromEntries((FULL[Math.min(9, level - 1)] || []).map((n, i) => [i + 1, { max: n, used: 0 }])) : {};
  const maxL = Math.max(0, ...Object.keys(slots).map(Number));
  return {
    id: `local-${Math.random().toString(36).slice(2, 8)}`, name, player, playerId, classes: [{ name: k, level }], abilities: t.ab, ac: t.ac,
    hp: { max: hp, current: hp }, profBonus: pb, saves: Object.fromEntries(t.saves.map((a) => [a, { prof: true }])),
    attacks: t.attacks.map(([n, a, dice, type]) => ({ name: n, bonus: `+${m(a) + pb}`, damage: `${dice}${m(a) >= 0 ? "+" : ""}${m(a)} ${type}` })),
    spellcasting: { ability: t.cast || '', slots, spells: t.spells.filter(([, l]) => l <= maxL).map(([n, l]) => ({ name: n, level: l })) },
    inventory: [{ name: 'Potion of Healing', qty: 1 }], features: level >= 5 && k === 'Fighter' ? [{ name: 'Extra Attack' }] : [], money: { gp: 10 },
  };
}
