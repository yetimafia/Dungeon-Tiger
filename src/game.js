// A run: the party goes floor by floor, room by room. Fights are turn by turn: players choose their character's action
// (in Discord or on the GM page); characters nobody controls, and monsters, act on their own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { roll, avg, d20, mod, pick } from './dice.js';
import { makeFloor, FLOORS, asciiMap } from './dungeon.js';
import { makeField, placeAll, reachable, approach, retreat, dist, FP, roomDims, biggerDims, freeSquares } from './battlemap.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SPELLS = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'spells-combat.json'), 'utf8')).map((s) => [s.n.toLowerCase(), s]));
const AB = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// Ranges on the battle map, in 5-foot squares.
const TOUCH = /cure wounds|shocking grasp|inflict wounds|vampiric touch|lay on hands|spare the dying|heal$|regenerate|primal savagery/i;
const SELF_AREA = /burning hands|thunderwave|cone of cold|color spray|thunderclap|sword burst|word of radiance|destructive wave|spirit guardians|arms of hadar/i;
const AREA = { fireball: 4, 'ice storm': 4, 'cone of cold': 6, 'burning hands': 3, thunderwave: 2, shatter: 2, 'lightning bolt': 3, 'sword burst': 1, thunderclap: 1, 'word of radiance': 1, 'flame strike': 2, 'meteor swarm': 8, 'arms of hadar': 2, 'spirit guardians': 3, 'destructive wave': 6 };
const spellRange = (sp) => (TOUCH.test(sp.name) ? 1 : /healing word|sacred flame|toll the dead|vicious mockery|mind sliver/i.test(sp.name) ? 12 : 24);
const weaponRange = (w) => (!w.ranged ? 1 : /javelin|dart|handaxe|dagger|trident|spear/i.test(w.name) ? 6 : 16);
const RANGED_MON = /bow|crossbow|sling|javelin|spit|ray\b|bolt|blast|throw|rock|dart|spine|spike|beam|eye ray|tail spike|hurl/i;
export const spellInfo = (sp) => ({ range: spellRange(sp), radius: sp.data.aoe ? AREA[sp.name.toLowerCase()] || 2 : 0, self: SELF_AREA.test(sp.name), heal: !!sp.data.heal });
export const weaponReach = (w) => weaponRange(w);
const nearest = (u, list) => [...list].sort((a, b) => dist(u, a) - dist(u, b) || a.hp - b.hp)[0];

// ---------- the party: a Note Tiger character, made ready for fights ----------
function attacksPerTurn(c) {
  const f = (c.features || []).map((x) => x.name).join(' | ');
  if (/Three Extra Attacks|Extra Attack \(3\)/.test(f)) return 4;
  if (/Two Extra Attacks|Extra Attack \(2\)/.test(f)) return 3;
  if (/Extra Attack/.test(f)) return 2;
  return 1;
}
export function toHero(c, { player = null, playerName = '' } = {}) {
  const lvl = (c.classes || []).reduce((n, k) => n + k.level, 0) || 1;
  const pb = c.profBonus || 2 + Math.floor((lvl - 1) / 4);
  const m = Object.fromEntries(AB.map((a) => [a, mod(c.abilities?.[a])]));
  const sa = c.spellcasting?.ability || '';
  const spells = (c.spellcasting?.spells || []).map((s) => ({ name: s.name, level: s.level, data: SPELLS.get(s.name.toLowerCase()) })).filter((s) => s.data);
  const attacks = (c.attacks || []).map((a) => {
    const dm = String(a.damage || '').match(/^\s*([\dd+\- ]+?)\s*([a-z]+)?\s*$/i) || [];
    return { name: a.name, bonus: Number(String(a.bonus).replace(/[^\d-]/g, '')) || 0, dice: (dm[1] || '1d4').replace(/\s/g, ''), type: dm[2] || '',
      ranged: /bow|crossbow|sling|dart|blowgun|javelin/i.test(a.name), finesse: /finesse|light/i.test(a.notes || '') || /rapier|dagger|shortsword|scimitar|whip|bow|crossbow|dart/i.test(a.name) };
  });
  if (!attacks.length) attacks.push({ name: 'Unarmed strike', bonus: m.str + pb, dice: `1${m.str >= 0 ? '+' : ''}${m.str}`, type: 'bludgeoning' });
  const potions = (c.inventory || []).filter((i) => /potion of healing/i.test(i.name)).reduce((n, i) => n + (i.qty || 1), 0);
  const isRogue = (c.classes || []).some((k) => /rogue/i.test(k.name));
  const main = (c.classes || [])[0]?.name || '';
  const hitDie = /barbarian/i.test(main) ? 12 : /fighter|paladin|ranger/i.test(main) ? 10 : /sorcerer|wizard/i.test(main) ? 6 : 8;
  return {
    id: c.id, name: c.name, species: c.species || '', player, playerName: playerName || c.player || '', cls: (c.classes || []).map((k) => `${k.name} ${k.level}`).join('/'),
    level: lvl, ac: c.ac || 10, hp: c.hp?.current ?? c.hp?.max ?? 10, maxHp: c.hp?.max ?? 10, temp: 0, m, pb,
    saves: Object.fromEntries(AB.map((a) => [a, m[a] + (c.saves?.[a]?.prof ? pb : 0)])),
    init: c.initiative ?? m.dex, attacks, perTurn: attacksPerTurn(c), sneak: isRogue ? Math.ceil(lvl / 2) : 0,
    spells, slots: JSON.parse(JSON.stringify(c.spellcasting?.slots || {})), dc: sa ? 8 + pb + m[sa] : 0, spellAtk: sa ? pb + m[sa] : 0, castMod: sa ? m[sa] : 0,
    potions, hitDie, hdUsed: 0, gold: c.money?.gp || 0, items: [], down: false, dead: false, stable: false, ds: { s: 0, f: 0 }, dodging: false,
    ...classAbilities(c, attacks),
  };
}
// What a character's classes let them do with actions and bonus actions (Baldur's Gate 3 style).
const LIGHT = /dagger|shortsword|scimitar|handaxe|light hammer|sickle|club/i;
function classAbilities(c, attacks) {
  const lv = (n) => (c.classes || []).filter((k) => new RegExp(n, 'i').test(k.name)).reduce((a, k) => a + k.level, 0);
  const fighter = lv('fighter'), rogue = lv('rogue'), barb = lv('barbarian'), monk = lv('monk');
  const ab = { abilities: {}, uses: {}, maxUses: {} };
  if (fighter >= 1) { ab.abilities.secondWind = true; ab.maxUses.secondWind = fighter >= 10 ? 4 : fighter >= 4 ? 3 : 2; }
  if (fighter >= 2) { ab.abilities.actionSurge = true; ab.maxUses.actionSurge = fighter >= 17 ? 2 : 1; }
  if (rogue >= 2) ab.abilities.cunning = true;
  if (barb >= 1) { ab.abilities.rage = barb >= 16 ? 4 : barb >= 9 ? 3 : 2; ab.maxUses.rage = barb >= 17 ? 6 : barb >= 12 ? 5 : barb >= 6 ? 4 : barb >= 3 ? 3 : 2; }
  if (monk >= 1) ab.abilities.martialArts = monk >= 17 ? '1d12' : monk >= 11 ? '1d10' : monk >= 5 ? '1d8' : '1d6';
  // Two light weapons: a bonus-action swing with the other one.
  if (attacks.filter((a) => LIGHT.test(a.name) && !a.ranged).length >= 2 || attacks.some((a) => LIGHT.test(a.name) && /×2|x2|pair/i.test(a.name))) ab.abilities.offhand = true;
  ab.uses = { ...ab.maxUses };
  return ab;
}
// Spells cast with a bonus action instead of an action.
const BONUS_SPELLS = /healing word|spiritual weapon|misty step|hex$|hunter's mark|shillelagh|sanctuary|shield of faith|expeditious retreat|divine favor|searing smite|thunderous smite|wrathful smite|branding smite|flame blade|magic weapon|healing spirit|ensnaring strike|hail of thorns/i;
export const isBonusSpell = (sp) => BONUS_SPELLS.test(sp.name);

// ---------- spells in a fight ----------
function spellDice(sp, hero, slot) {
  const dt = sp.data;
  if (dt.cl) {
    const lv = Object.keys(dt.cl).map(Number).filter((l) => l <= hero.level).sort((a, b) => b - a)[0] ?? 1;
    return dt.cl[lv];
  }
  const table = dt.sl || dt.heal;
  const lv = Object.keys(table).map(Number).filter((l) => l <= slot).sort((a, b) => b - a)[0] ?? Number(Object.keys(table)[0]);
  return table[lv];
}
// The lowest free slot that can cast this spell (cantrips need none). null = can't cast now.
function slotFor(hero, sp) {
  if (sp.level === 0) return 0;
  const levels = Object.keys(hero.slots).map(Number).filter((l) => l >= sp.level && hero.slots[l].max - (hero.slots[l].used || 0) > 0).sort((a, b) => a - b);
  return levels.length ? levels[0] : null;
}
export function castable(hero) {
  return hero.spells.filter((sp) => slotFor(hero, sp) !== null);
}

// ---------- the run ----------
export class Run extends EventEmitter {
  constructor({ id, edition = '2024', level = 1, title, heroes, source = 'web', guildId = null, channelId = null, auto = false, defer = false }) {
    super();
    Object.assign(this, { id, edition, level, title: title || `Dungeon run ${new Date().toLocaleDateString()}`, heroes, source, guildId, channelId });
    this.auto = auto;            // everyone plays themselves (test runs)
    this.floorN = 1;
    this.floor = makeFloor({ floor: 1, edition, level, size: heroes.length });
    this.here = this.floor.start;
    this.state = 'explore';      // explore | combat | ended
    this.combat = null;
    this.events = [];            // the whole story, for the recap
    this.log = [];               // recent lines, for the screens
    this.outcome = '';
    this.gold = 0;
    this.started = Date.now();
    if (!defer) this.begin();
  }
  begin() {
    this.say(`🗝️ **${this.title}**: ${this.heroes.map((h) => `${h.name} (${h.cls})`).join(', ')} enter the dungeon.`);
    this.enterRoom(this.here);
  }

  // Every change bumps the version, so the website only downloads the run when something happened.
  emit(...args) { this.version = (this.version || 0) + 1; return super.emit(...args); }

  say(text, { story = true } = {}) {
    this.log.push(text);
    if (this.log.length > 200) this.log.shift();
    if (story) this.events.push(text.replace(/\*\*/g, ''));
    this.emit('say', text);
  }
  room(id = this.here) { return this.floor.rooms[id]; }
  alive() { return this.heroes.filter((h) => !h.dead && !h.down); }
  standing() { return this.heroes.filter((h) => !h.dead); }
  heroChanged(h) { this.emit('hero', h); }

  // ---------- exploring ----------
  exits() {
    const r = this.room();
    return Object.entries(r.exits).map(([dir, id]) => ({ dir, id, room: this.floor.rooms[id] }));
  }
  move(dir) {
    if (this.state !== 'explore') throw new Error('Not now: finish the fight first.');
    const to = this.room().exits[dir];
    if (!to) throw new Error('There\'s no door that way.');
    this.here = to;
    this.enterRoom(to);
  }
  enterRoom(id) {
    const r = this.room(id);
    const first = !r.visited;
    r.visited = true; r.seen = true;
    for (const n of Object.values(r.exits)) this.floor.rooms[n].seen = true;
    this.emit('map');
    if (!first || r.kind === 'start') {
      if (r.kind === 'start' && first) this.say(`📍 **Floor ${this.floorN}: ${this.floor.name}.** You stand in ${r.name}.`);
      else this.say(`You go back to ${r.name}.`, { story: false });
      return;
    }
    const where = r.kind === 'boss' ? 'the lair at the bottom of the dungeon' : r.name;
    if (r.monsters?.length && !r.cleared) {
      this.say(`⚔️ In ${where}: ${r.monsters.map((m) => `**${m.name}**`).join(', ')}!${r.kind === 'boss' ? ' This is the master of the dungeon.' : r.kind === 'stairs' ? ' They guard the stairs down.' : ''}`);
      return this.startCombat(r.monsters);
    }
    if (r.kind === 'trap') return this.springTrap(r);
    if (r.kind === 'rest') return this.say(`🕯️ ${r.name[0].toUpperCase() + r.name.slice(1)}. It feels safe here: a good place to **rest** (once per floor).`);
    if (r.kind === 'treasure') return this.say(`💰 ${r.name[0].toUpperCase() + r.name.slice(1)}, with something glinting in the dust.`);
    this.say(`🚪 ${r.name[0].toUpperCase() + r.name.slice(1)}. Quiet.`);
  }
  springTrap(r) {
    const t = r.trap;
    const lines = [`🪤 **${t.name}!** (DC ${t.dc} ${t.save.toUpperCase()} save)`];
    for (const h of this.alive()) {
      const save = d20() + h.saves[t.save];
      let dmg = roll(t.dice);
      if (save >= t.dc) dmg = Math.floor(dmg / 2);
      lines.push(`${h.name} ${save >= t.dc ? 'partly dodges' : 'is caught'}: ${dmg} ${t.dmg}.`);
      this.hurt(h, dmg, { quiet: true });
    }
    r.cleared = true;
    this.say(lines.join(' '));
    this.checkWipe();
  }
  loot() {
    const r = this.room();
    if (!r.loot || r.looted) throw new Error('Nothing to take here.');
    if (r.monsters?.length && !r.cleared) throw new Error('Deal with the monsters first.');
    r.looted = true;
    this.gold += r.loot.gold;
    const share = Math.floor(r.loot.gold / Math.max(1, this.standing().length));
    for (const h of this.standing()) h.gold += share;
    for (const it of r.loot.items) {
      const h = /potion/i.test(it) ? [...this.standing()].sort((a, b) => a.potions - b.potions)[0] : pick(this.standing());
      if (/potion of healing/i.test(it)) h.potions++; else h.items.push(it);
      this.heroChanged(h);
    }
    this.say(`💰 Found **${r.loot.gold} gold**${r.loot.items.length ? ` and ${r.loot.items.map((x) => `**${x}**`).join(', ')}` : ''}.`);
    this.emit('map');
  }
  // The safe room on each floor is a full rest: HP, spell slots and hit dice come back (once per floor).
  shortRest() {
    const r = this.room();
    if (this.state !== 'explore') throw new Error('Not during a fight.');
    if (r.kind !== 'rest') throw new Error('Find the safe room to rest in.');
    if (r.rested) throw new Error('You already rested here.');
    r.rested = true;
    for (const h of this.standing()) {
      h.down = false; h.stable = false; h.ds = { s: 0, f: 0 };
      h.hp = h.maxHp; h.hdUsed = 0;
      for (const s of Object.values(h.slots)) s.used = 0;
      h.uses = { ...(h.maxUses || {}) };
      this.heroChanged(h);
    }
    this.say('🛏️ **The party rests** and wakes up fully healed, spells back.');
    this.emit('rest');
    this.emit('map');
  }
  // A potion outside a fight.
  drink(h) {
    if (!h || h.dead || !h.potions) throw new Error('No potion to drink.');
    h.potions--;
    this.say(`🧪 ${h.name} drinks a Potion of Healing: +${this.heal(h, roll('2d4+2'))} HP.`);
    this.emit('map');
  }
  // A breather anywhere quiet: spend hit dice to get back to about half.
  breather() {
    if (this.state !== 'explore') throw new Error('Not during a fight.');
    const r = this.room();
    if (r.breather) throw new Error('You already caught your breath here.');
    r.breather = true;
    const lines = ['☕ **Short rest.**'];
    for (const h of this.standing()) {
      const before = h.hp;
      if (h.down) { h.down = false; h.stable = false; h.hp = Math.max(1, h.hp); h.ds = { s: 0, f: 0 }; }
      while (h.hp < h.maxHp / 2 && h.hdUsed < h.level) { h.hdUsed++; h.hp = Math.min(h.maxHp, h.hp + Math.max(1, roll(`1d${h.hitDie}`) + h.m.con)); }
      if (/warlock/i.test(h.cls)) for (const s of Object.values(h.slots)) s.used = 0;
      for (const k of ['secondWind', 'actionSurge']) if (h.maxUses?.[k]) h.uses[k] = h.maxUses[k];
      if (h.hp !== before) lines.push(`${h.name} ${before} → ${h.hp} HP.`);
      this.heroChanged(h);
    }
    this.say(lines.join(' '));
    this.emit('map');
  }
  descend() {
    const r = this.room();
    if (r.kind !== 'stairs') throw new Error('The stairs aren\'t here.');
    if (!r.cleared) throw new Error('The guards are still in the way.');
    this.floorN++;
    // Catch your breath on the stairs: everyone standing gets back a bit.
    for (const h of this.standing()) { if (!h.down) h.hp = Math.min(h.maxHp, h.hp + Math.ceil(h.maxHp / 4)); this.heroChanged(h); }
    this.floor = makeFloor({ floor: this.floorN, edition: this.edition, level: this.level, size: this.heroes.length });
    this.here = this.floor.start;
    this.say(`🪜 Down the stairs, catching your breath on the way (+¼ HP).`);
    this.enterRoom(this.here);
  }

  // ---------- damage and healing ----------
  hurt(h, dmg, { quiet = false, crit = false } = {}) {
    if (h.dead || dmg <= 0) return;
    if (h.down) {
      h.ds.f += crit ? 2 : 1;
      if (h.ds.f >= 3) { h.dead = true; this.say(`💀 **${h.name} dies.**`); }
      this.heroChanged(h);
      return;
    }
    const fromTemp = Math.min(h.temp, dmg); h.temp -= fromTemp; dmg -= fromTemp;
    h.hp -= dmg;
    if (h.hp <= 0) {
      if (-h.hp >= h.maxHp) { h.hp = 0; h.dead = true; this.say(`💀 **${h.name}** is struck down for good.`); }
      else { h.hp = 0; h.down = true; h.ds = { s: 0, f: 0 }; if (!quiet) this.say(`🩸 **${h.name} drops!**`, { story: true }); }
    }
    this.heroChanged(h);
  }
  heal(h, n) {
    if (h.dead || n <= 0) return 0;
    const was = h.hp;
    if (h.down) { h.down = false; h.stable = false; h.ds = { s: 0, f: 0 }; }
    h.hp = Math.min(h.maxHp, h.hp + n);
    this.heroChanged(h);
    return h.hp - was;
  }
  checkWipe() {
    if (this.heroes.every((h) => h.dead || h.down)) {
      this.end(`The party fell on floor ${this.floorN} (${this.floor.name}).`, 'wipe');
      return true;
    }
    return false;
  }

  // ---------- fights ----------
  // ---------- fights, on the battle map ----------
  startCombat(monsters) {
    this.state = 'combat';
    this.heroes.forEach((h, i) => Object.assign(h, { side: 'h', tag: String(i + 1), fp: 1, speed: 6, bx: null, by: null }));
    monsters.forEach((m, i) => Object.assign(m, { side: 'm', tag: String.fromCharCode(65 + i), fp: FP[m.size] || 1,
      speed: m.speed || (m.type === 'ooze' ? 3 : /zombie|mummy/i.test(m.n) ? 4 : m.size === 'Tiny' ? 4 : 6) }));
    // The room's own size; a bigger one if the fight wouldn't fit (everyone needs some room to move).
    const room = this.room();
    let dims = room.dims || roomDims(room.kind, `${this.id}|${this.floorN}|${this.here}`);
    const need = [...this.standing(), ...monsters].reduce((n, u) => n + (u.fp || 1) ** 2, 0) * 3;
    let field;
    for (let tries = 0; tries < 8; tries++) {
      field = makeField(this.floorN, `${this.id}|${this.floorN}|${this.here}|${tries}`, dims);
      if (freeSquares(field) >= need && placeAll(field, this.standing(), monsters)) break;
      dims = biggerDims(dims);
    }
    const order = [
      ...this.standing().map((h) => ({ kind: 'h', id: h.id, init: d20() + h.init + Math.random() / 10 })),
      ...monsters.map((m) => ({ kind: 'm', id: m.id, init: d20() + mod(m.ab[1]) + Math.random() / 10 })),
    ].sort((a, b) => b.init - a.init);
    this.combat = { monsters, order, turn: -1, round: 1, field };
    this.emit('fight', monsters);
    this.say(`🎲 Initiative: ${order.map((o) => (o.kind === 'h' ? this.hero(o.id).name : monsters.find((m) => m.id === o.id).name)).join(' → ')}`, { story: false });
    this.next();
  }
  hero(id) { return this.heroes.find((h) => h.id === id); }
  foes() { return (this.combat?.monsters || []).filter((m) => m.hp > 0); }
  units() { return [...this.heroes.filter((h) => !h.dead && h.bx != null), ...this.foes()]; }
  field() { return this.combat?.field; }
  current() {
    if (!this.combat) return null;
    const o = this.combat.order[this.combat.turn];
    return o ? { ...o, who: o.kind === 'h' ? this.hero(o.id) : this.combat.monsters.find((m) => m.id === o.id) } : null;
  }
  // Moves to the next turn, playing every turn that doesn't need a person, and stops at a player's turn.
  next() {
    for (let guard = 0; guard < 5000 && this.state === 'combat'; guard++) {
      if (!this.foes().length) return this.winFight();
      // A fight nobody can win: after 30 rounds the monsters give up and flee.
      if (this.combat.round > 30) { this.say('The worn-out monsters flee into the dark.'); this.combat.monsters.forEach((m) => { m.hp = 0; m.announced = true; }); return this.winFight(); }
      if (this.checkWipe()) return;
      const c = this.combat;
      c.turn++;
      if (c.turn >= c.order.length) { c.turn = 0; c.round++; }
      const cur = this.current();
      if (cur.kind === 'm') { if (cur.who.hp > 0) this.monsterTurn(cur.who); continue; }
      const h = cur.who;
      if (h.dead) continue;
      h.dodging = false; h.disengaged = false; h.reactionUsed = false;
      h.steps = h.speed;
      h.res = { action: 1, bonus: 1 }; h.attacksLeft = 0; h.attackedThisTurn = false; h.sneakUsed = false;
      if (h.down) { this.deathSave(h); continue; }
      if (this.auto || !h.player) { this.heroAI(h); continue; }
      this.waiting = { heroId: h.id, since: Date.now() };
      this.emit('turn', h);
      return;
    }
  }
  winFight() {
    const r = this.room();
    r.cleared = true;
    this.state = 'explore';
    this.combat = null;
    this.waiting = null;
    // Anyone down but not dead gets back up with 1 HP after the fight.
    for (const h of this.heroes) if (h.down && !h.dead) { h.down = false; h.hp = 1; h.ds = { s: 0, f: 0 }; this.heroChanged(h); }
    for (const h of this.heroes) h.raging = false;
    this.say(`✅ The fight is won.${r.loot ? ' There\'s loot to take.' : ''}`);
    if (r.kind === 'boss') return this.end(`Victory! The party beat the master of the dungeon on floor ${FLOORS}.`, 'win');
    this.emit('map');
  }
  deathSave(h) {
    if (h.stable) return;
    const r = d20();
    if (r === 20) { h.down = false; h.hp = 1; h.ds = { s: 0, f: 0 }; this.say(`✨ ${h.name} rolls a 20 on a death save and gets back up!`); }
    else if (r === 1) h.ds.f += 2;
    else if (r >= 10) h.ds.s++;
    else h.ds.f++;
    if (h.ds.f >= 3) { h.dead = true; this.say(`💀 **${h.name} dies.**`); }
    else if (h.ds.s >= 3) { h.stable = true; this.say(`${h.name} is stable (unconscious).`, { story: false }); }
    else if (r !== 20) this.say(`${h.name} death save: ${r} (${h.ds.s}✓ ${h.ds.f}✗)`, { story: false });
    this.heroChanged(h);
  }

  // ---------- moving ----------
  reach(u) { return reachable(this.field(), this.units(), u, u.steps ?? u.speed); }
  stepTo(u, x, y, steps) {
    if (x === u.bx && y === u.by) return false;
    const before = this.enemiesNext(u);
    u.bx = x; u.by = y; u.steps = Math.max(0, (u.steps ?? u.speed) - steps);
    // Leaving an enemy's reach without Disengaging gives them a free swing (their reaction, once a round).
    if (!u.disengaged) for (const e of before) if (dist(u, e) > 1 && !e.reactionUsed && (u.side === 'h' ? !u.dead : u.hp > 0)) this.opportunity(e, u);
    this.emit('moved', u);
    return true;
  }
  opportunity(a, t) {
    a.reactionUsed = true;
    if (a.side === 'm') {
      const dmgOf = (x) => x.d.reduce((n, z) => n + avg(z), 0);
      const w = a.a.filter((x) => x.b !== undefined && !RANGED_MON.test(x.n)).sort((x, y) => dmgOf(y) - dmgOf(x))[0];
      if (!w || t.down || t.dead) return;
      const r = d20(t.dodging ? -1 : 0);
      const ok = r === 20 || (r !== 1 && r + w.b >= t.ac);
      if (!ok) return this.say(`⚡ ${a.name} swipes at ${t.name} as they pull away, and misses.`);
      let dmg = w.d.reduce((n, x) => n + roll(x, { crit: r === 20 }), 0);
      if (t.raging) dmg = Math.floor(dmg / 2);
      this.hurt(t, dmg, { quiet: true, crit: r === 20 });
      return this.say(`⚡ ${a.name} catches ${t.name} as they pull away: ${dmg} damage.${this.dropsText([t])}`);
    }
    if (a.down || a.dead) return;
    const w = a.attacks.filter((x) => weaponRange(x) === 1).sort((x, y) => avg(y.dice) + y.bonus - avg(x.dice) - x.bonus)[0];
    if (!w || t.hp <= 0) return;
    const r = d20();
    const ok = r === 20 || (r !== 1 && r + w.bonus >= t.ac);
    if (!ok) return this.say(`⚡ ${a.name} swings at the fleeing ${t.name}, and misses.`);
    const dmg = roll(w.dice, { crit: r === 20 });
    this.damageMonster(t, dmg);
    this.say(`⚡ ${a.name} strikes the fleeing ${t.name} (${w.name}) for ${dmg}.${this.deathsText([t])}`);
  }
  // Get within `range` squares of the target if possible. Returns true if in range afterwards.
  closeIn(u, target, range) {
    if (dist(u, target) <= range) return true;
    const spot = approach(this.field(), this.units(), u, target, range, u.steps ?? u.speed);
    if (spot) this.stepTo(u, spot.x, spot.y, spot.s);
    return dist(u, target) <= range;
  }
  enemiesNext(u) { return (u.side === 'h' ? this.foes() : this.heroes.filter((h) => !h.dead && !h.down && h.bx != null)).filter((e) => dist(u, e) <= 1); }

  // A hero's action. act: { type: 'move'|'attack'|'cast'|'dodge'|'potion'|'retreat', weapon, spell, target, to: [x, y] }
  // Moving doesn't end the turn; everything else does (moving closer first if needed).
  // Each turn: one Action, one Bonus Action and your movement, like Baldur's Gate 3. Abilities can add more
  // (Action Surge gives another Action). keepTurn: the turn goes on until End turn, or until everything's used.
  // Without it (the game playing a character) one action ends the turn.
  costOf(h, act) {
    const t = act.type;
    if (t === 'cast') { const sp = h.spells.find((x) => x.name === act.spell); return sp && isBonusSpell(sp) ? 'bonus' : 'action'; }
    if (t === 'potion') return !act.target || act.target === h.id ? 'bonus' : 'action';
    if ((t === 'dash' || t === 'disengage') && h.abilities?.cunning && h.res.bonus > 0) return 'bonus';
    if (['offhand', 'martial', 'rage', 'secondWind', 'shove'].includes(t)) return 'bonus';
    if (t === 'actionSurge') return 'free';
    if (t === 'attack' && h.attacksLeft > 0) return 'free'; // more swings from the same Attack action (Extra Attack)
    return 'action';
  }
  canDo(h, act) {
    const cost = this.costOf(h, act);
    const t = act.type;
    if (t === 'offhand' && !(h.abilities?.offhand && h.attackedThisTurn)) return 'Attack with a light weapon first, then swing the other one.';
    if (t === 'martial' && !(h.abilities?.martialArts && h.attackedThisTurn)) return 'Attack first, then follow up with an unarmed strike.';
    if (t === 'rage' && (!h.abilities?.rage || h.raging || !h.uses.rage)) return h.raging ? 'Already raging.' : 'No rages left until you rest.';
    if (t === 'secondWind' && (!h.abilities?.secondWind || !h.uses.secondWind)) return 'No Second Wind left until you rest.';
    if (t === 'actionSurge' && (!h.abilities?.actionSurge || !h.uses.actionSurge)) return 'No Action Surge left until you rest.';
    if (t === 'potion' && !h.potions) return 'No potions left.';
    if (t === 'help' && !this.heroes.some((x) => x.down && !x.dead)) return 'Nobody is down.';
    if (t === 'potion' && (!act.target || act.target === h.id) && h.hp >= h.maxHp) return 'You\'re at full HP.';
    if (cost === 'action' && h.res.action < 1) return 'No action left this turn.';
    if (cost === 'bonus' && h.res.bonus < 1) return 'No bonus action left this turn.';
    return '';
  }
  act(heroId, act, { keepTurn = false } = {}) {
    if (this.state !== 'combat') throw new Error('There\'s no fight going on.');
    const cur = this.current();
    if (!cur || cur.kind !== 'h' || cur.id !== heroId) throw new Error('It isn\'t that character\'s turn.');
    const h = cur.who;
    if (act.type === 'move') {
      const [x, y] = act.to || [];
      const steps = this.reach(h).get(`${x},${y}`);
      if (steps === undefined) throw new Error('Can\'t get there this turn.');
      this.stepTo(h, x, y, steps);
      if (h.down || h.dead || !this.foes().length) { this.waiting = null; return this.next(); }
      this.emit('turn', h);
      return;
    }
    if (act.type === 'end') { this.waiting = null; return this.next(); }
    const why = this.canDo(h, act);
    if (why) throw new Error(why);
    const cost = this.costOf(h, act);
    if (cost === 'action') h.res.action--;
    if (cost === 'bonus') h.res.bonus--;
    this.doAction(h, act);
    const left = h.res.action > 0 || h.res.bonus > 0 || h.attacksLeft > 0 || h.steps > 0;
    const goOn = keepTurn && left && this.state === 'combat' && this.foes().length && !h.down && !h.dead;
    if (goOn) { this.emit('turn', h); return; }
    this.waiting = null;
    this.next();
  }
  // What this character can do right now, for the screens: each with its cost and whether it's possible.
  options(h) {
    const o = [];
    const add = (type, label, extra = {}) => { const act = { type, ...extra }; const why = this.canDo(h, act); o.push({ type, label, cost: this.costOf(h, act), ok: !why, why, ...extra }); };
    if (h.abilities?.actionSurge) add('actionSurge', `⚡ Action Surge (${h.uses.actionSurge} left)`);
    if (h.abilities?.rage && !h.raging) add('rage', `😤 Rage (${h.uses.rage} left)`);
    if (h.abilities?.secondWind) add('secondWind', `❤️‍🩹 Second Wind (${h.uses.secondWind} left)`);
    if (h.abilities?.offhand) add('offhand', '🗡️ Off-hand attack');
    if (h.abilities?.martialArts) add('martial', '👊 Martial Arts strike');
    add('shove', '🤚 Shove');
    add('help', '🤝 Help a fallen friend up');
    return o;
  }
  doAction(h, act) {
    const foes = this.foes();
    if (act.type === 'actionSurge') { h.uses.actionSurge--; h.res.action++; return this.say(`⚡ ${h.name} uses **Action Surge**: one more action this turn!`); }
    if (act.type === 'rage') { h.uses.rage--; h.raging = true; this.heroChanged(h); return this.say(`😤 ${h.name} flies into a **Rage**: +${h.abilities.rage} damage, and weapon hits do half damage to them.`); }
    if (act.type === 'secondWind') { h.uses.secondWind--; const n = this.heal(h, roll(`1d10+${h.level}`)); return this.say(`❤️‍🩹 ${h.name} gets a **Second Wind**: +${n} HP.`); }
    if (act.type === 'help') {
      const t = (act.target && this.hero(act.target)) || this.heroes.filter((x) => x.down && !x.dead).sort((a, b) => dist(h, a) - dist(h, b))[0];
      if (!t || !t.down) return this.say(`${h.name} looks for someone to help, but nobody's down.`, { story: false });
      if (!this.closeIn(h, t, 1)) return this.say(`${h.name} runs toward ${t.name} but can't reach them yet.`);
      t.down = false; t.stable = false; t.hp = Math.max(1, t.hp); t.ds = { s: 0, f: 0 };
      this.heroChanged(t);
      return this.say(`🤝 ${h.name} hauls ${t.name} back to their feet (1 HP).`);
    }
    if (act.type === 'shove') {
      const t = foes.find((m) => m.id === act.target) || nearest(h, foes);
      if (!this.closeIn(h, t, 1)) return this.say(`${h.name} can't reach ${t.name} to shove them.`, { story: false });
      if ((t.fp || 1) > 2) return this.say(`${t.name} is far too big to shove.`, { story: false });
      const mine = d20() + h.m.str + h.pb, theirs = d20() + Math.max(mod(t.ab[0]), mod(t.ab[1]));
      if (mine < theirs) return this.say(`🤚 ${h.name} tries to shove ${t.name}, who doesn't budge.`);
      // Push two squares straight away from the hero, stopping at walls and other creatures.
      const dx = Math.sign(t.bx - h.bx), dy = Math.sign(t.by - h.by);
      let moved = 0;
      for (let i = 0; i < 2; i++) {
        const spot = approach(this.field(), this.units(), { ...t, steps: 1 }, { bx: t.bx + dx * 5, by: t.by + dy * 5, fp: 1 }, 0, 1);
        if (!spot || (spot.x === t.bx && spot.y === t.by) || Math.sign(spot.x - t.bx) !== dx || Math.sign(spot.y - t.by) !== dy) break;
        t.bx = spot.x; t.by = spot.y; moved++;
      }
      this.emit('moved', t);
      return this.say(`🤚 ${h.name} shoves ${t.name} ${moved ? `${moved * 5} feet back` : 'against the wall'}.`);
    }
    if (act.type === 'offhand' || act.type === 'martial') {
      const w = act.type === 'martial'
        ? { name: 'Unarmed strike', bonus: Math.max(h.m.str, h.m.dex) + h.pb, dice: `${h.abilities.martialArts}+${Math.max(h.m.str, h.m.dex)}`, ranged: false }
        : (() => { const lw = h.attacks.filter((a) => LIGHT.test(a.name) && !a.ranged); const x = lw[1] || lw[0]; return { ...x, dice: x.dice.replace(/[+-]\d+$/, '') }; })();
      const t = foes.find((m) => m.id === act.target) || nearest(h, foes);
      if (!this.closeIn(h, t, 1)) return this.say(`${h.name} can't reach ${t.name} for a follow-up.`, { story: false });
      const r = d20();
      const ok = r === 20 || (r !== 1 && r + w.bonus >= t.ac);
      if (!ok) return this.say(`${act.type === 'martial' ? '👊' : '🗡️'} ${h.name} (${w.name}) misses ${t.name}.`);
      const dmg = roll(w.dice, { crit: r === 20 }) + (h.raging ? h.abilities.rage : 0);
      this.damageMonster(t, dmg);
      return this.say(`${act.type === 'martial' ? '👊' : '🗡️'} ${h.name} follows up (${w.name}): ${r === 20 ? 'crits' : 'hits'} ${t.name} for ${dmg}.${this.deathsText([t])}`);
    }
    if (act.type === 'retreat') {
      h.disengaged = true;
      const spot = retreat(this.field(), this.units(), h, foes, h.steps ?? h.speed);
      if (spot) this.stepTo(h, spot.x, spot.y, spot.s);
      return this.say(`🏃 ${h.name} disengages and backs off.`, { story: false });
    }
    if (act.type === 'disengage') { h.disengaged = true; return this.say(`🏃 ${h.name} disengages: moving away won't draw attacks this turn.`, { story: false }); }
    if (act.type === 'dash') { h.steps = (h.steps ?? h.speed) + h.speed; return this.say(`💨 ${h.name} dashes (${h.steps * 5} ft of movement left).`, { story: false }); }
    if (act.type === 'dodge') { h.dodging = true; return this.say(`🛡️ ${h.name} takes the Dodge action.`, { story: false }); }
    if (act.type === 'potion') {
      const target = act.target ? this.hero(act.target) : h;
      if (h.potions < 1) return this.say(`${h.name} has no potions left.`, { story: false });
      if (target !== h && !this.closeIn(h, target, 1)) return this.say(`${h.name} runs toward ${target.name} but can't reach them yet.`);
      h.potions--;
      const n = this.heal(target, roll('2d4+2'));
      return this.say(`🧪 ${h.name} ${target === h ? 'drinks' : `pours into ${target.name}'s mouth`} a Potion of Healing: +${n} HP.`);
    }
    if (act.type === 'cast') {
      const sp = h.spells.find((s) => s.name === act.spell);
      if (!sp) throw new Error('Unknown spell.');
      const slot = slotFor(h, sp);
      if (slot === null) throw new Error('No spell slot left for that.');
      const range = spellRange(sp);
      if (sp.data.heal) {
        const t = (act.target && this.hero(act.target)) || [...this.standing()].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (!this.closeIn(h, t, range)) return this.say(`${h.name} hurries toward ${t.name} but can't reach them to cast ${sp.name}.`);
        if (slot > 0) h.slots[slot].used = (h.slots[slot].used || 0) + 1;
        const n = this.heal(t, roll(spellDice(sp, h, slot), { mod: h.castMod }));
        this.say(`💚 ${h.name} casts **${sp.name}** on ${t.name}: +${n} HP.`);
        this.heroChanged(h);
        return;
      }
      const selfArea = SELF_AREA.test(sp.name);
      // Area spells can be aimed at a square: everyone in the blast is hit, friends too.
      const spot = sp.data.aoe && !selfArea && Array.isArray(act.at) ? { bx: act.at[0], by: act.at[1], fp: 1, hp: 1, name: 'that spot' } : null;
      const first = spot || foes.find((m) => m.id === act.target) || nearest(h, foes);
      // Spells that burst from the caster: step up so the closest foes are inside it.
      if (!(selfArea ? this.closeIn(h, first, AREA[sp.name.toLowerCase()] || 2) : this.closeIn(h, first, range))) {
        return this.say(`${h.name} moves toward ${first.name} but is still too far to cast ${sp.name}.`);
      }
      if (slot > 0) h.slots[slot].used = (h.slots[slot].used || 0) + 1;
      const dice = spellDice(sp, h, slot);
      const radius = AREA[sp.name.toLowerCase()] || 2;
      const inBlast = (u) => (selfArea ? dist(h, u) : dist(first, u)) <= radius || u === first;
      const targets = sp.data.aoe
        ? [...foes.filter(inBlast), ...(selfArea ? [] : this.heroes.filter((x) => !x.dead && x.bx != null && inBlast(x)))]
        : /scorching ray/i.test(sp.name) ? Array(3 + Math.max(0, slot - 2)).fill(first)
          : /eldritch blast/i.test(sp.name) ? Array(1 + (h.level >= 5) + (h.level >= 11) + (h.level >= 17)).fill(first) : [first];
      const isAtk = sp.data.atk || /scorching ray/i.test(sp.name);
      const lines = [];
      for (const m of targets) {
        if (m.hp <= 0 && m.side !== 'h') continue;
        if (m.side === 'h' && m.dead) continue;
        let dmg;
        if (isAtk) {
          const r = d20(this.enemiesNext(h).length && range > 1 ? -1 : 0); const hit = r === 20 || (r !== 1 && r + h.spellAtk >= m.ac);
          dmg = hit ? roll(dice, { crit: r === 20 }) : 0;
          lines.push(hit ? `${r === 20 ? 'crits' : 'hits'} ${m.name} for ${dmg}` : `misses ${m.name}`);
        } else if (sp.data.save) {
          const save = d20() + (m.side === 'h' ? m.saves[sp.data.save] : mod(m.ab[AB.indexOf(sp.data.save)]));
          dmg = roll(dice);
          if (save >= h.dc) dmg = sp.data.half ? Math.floor(dmg / 2) : 0;
          lines.push(`${m.name} ${save >= h.dc ? (dmg ? 'half-saves' : 'saves') : 'fails'}: ${dmg}`);
        } else {
          dmg = roll(dice);
          lines.push(`${m.name} takes ${dmg}`);
        }
        if (m.side === 'h') this.hurt(m, dmg, { quiet: true }); else this.damageMonster(m, dmg);
      }
      const friends = targets.filter((x) => x.side === 'h');
      this.say(`✨ ${h.name} casts **${sp.name}**${slot ? ` (level ${slot})` : ''}: ${lines.join('; ') || 'nothing in the area'}.${this.deathsText(targets.filter((x) => x.side !== 'h'))}${friends.length ? this.dropsText(friends) : ''}`);
      this.heroChanged(h);
      return;
    }
    // Weapon attacks: the Attack action gives one swing, or more with Extra Attack. With keepTurn (a person playing)
    // each click is one swing, so you can move or switch targets in between; otherwise all swings happen at once.
    const w = h.attacks.find((a) => a.name === act.weapon) || h.attacks[0];
    h.lastWeapon = w;
    const range = weaponRange(w);
    const want = foes.find((m) => m.id === act.target) || nearest(h, foes);
    if (h.attacksLeft <= 0) { h.attacksLeft = h.perTurn; }
    if (!this.closeIn(h, want, range)) { return this.say(`🏃 ${h.name} moves toward ${want.name}.`, { story: false }); }
    const swings = act.allSwings === false ? 1 : act.oneSwing ? 1 : h.attacksLeft;
    const lines = [];
    const hit = [];
    for (let i = 0; i < swings && h.attacksLeft > 0; i++) {
      const live = this.foes().filter((m) => dist(h, m) <= range);
      if (!live.length) break;
      h.attacksLeft--;
      h.attackedThisTurn = true;
      const m = live.find((x) => x.id === want.id) || nearest(h, live);
      const r = d20(range > 1 && this.enemiesNext(h).length ? -1 : 0);
      const ok = r === 20 || (r !== 1 && r + w.bonus >= m.ac);
      if (!ok) { lines.push(`misses ${m.name}`); continue; }
      let dmg = roll(w.dice, { crit: r === 20 });
      let sneak = false;
      if (h.sneak && !h.sneakUsed && (w.finesse || w.ranged)) { dmg += roll(`${h.sneak}d6`, { crit: r === 20 }); h.sneakUsed = true; sneak = true; }
      if (h.raging && range === 1) dmg += h.abilities.rage;
      for (const it of h.items) if (/^\+(\d) /.test(it) || /weapon, \+(\d)/i.test(it)) dmg += Number((it.match(/\+(\d)/) || [0, 0])[1]);
      lines.push(`${r === 20 ? 'crits' : 'hits'} ${m.name} for ${dmg}${sneak ? ' (sneak attack)' : ''}`);
      this.damageMonster(m, dmg);
      hit.push(m);
    }
    this.say(`⚔️ ${h.name} (${w.name}) ${lines.join(', ') || 'has no one in reach'}.${this.deathsText(hit)}${h.attacksLeft > 0 ? ` (${h.attacksLeft} more attack${h.attacksLeft > 1 ? 's' : ''} this turn)` : ''}`);
  }
  damageMonster(m, dmg) { m.hp = Math.max(0, m.hp - dmg); }
  deathsText(list) {
    const dead = [...new Set(list)].filter((m) => m.hp <= 0 && !m.announced);
    dead.forEach((m) => { m.announced = true; });
    return dead.length ? ` ${dead.map((m) => `**${m.name}** falls!`).join(' ')}` : '';
  }

  // Monsters walk up to someone and hit them (or shoot from where they are, if they can); area attacks now and then.
  monsterTurn(m) {
    m.steps = m.speed; m.reactionUsed = false;
    const awake = this.heroes.filter((h) => !h.dead && !h.down && h.bx != null);
    const prey = awake.length ? awake : this.heroes.filter((h) => !h.dead && h.bx != null);
    if (!prey.length) return;
    const aoe = m.a.filter((a) => a.aoe && a.dc);
    if (aoe.length && Math.random() < 0.35) {
      // Aim where the most heroes stand close together, within 6 squares.
      const spots = awake.filter((h) => dist(m, h) <= 6).map((c) => ({ c, hit: awake.filter((h) => dist(c, h) <= 2) })).sort((a, b) => b.hit.length - a.hit.length);
      if (spots.length && spots[0].hit.length >= 2) {
        const a = aoe[0];
        const lines = [];
        for (const h of spots[0].hit) {
          const save = d20() + h.saves[a.s || 'dex'];
          let dmg = a.d.reduce((n, x) => n + roll(x), 0);
          if (save >= a.dc) dmg = a.half ? Math.floor(dmg / 2) : 0;
          lines.push(`${h.name} ${dmg}`);
          this.hurt(h, dmg, { quiet: true });
        }
        this.say(`🔥 ${m.name} uses **${a.n}**: ${lines.join(', ')}.${this.dropsText(spots[0].hit)}`);
        return;
      }
    }
    const dmgOf = (a) => a.d.reduce((n, z) => n + avg(z), 0);
    const attacks = m.a.filter((a) => !(a.aoe && a.dc));
    const pool = attacks.length ? attacks : m.a;
    const melee = pool.filter((a) => !RANGED_MON.test(a.n)).sort((x, y) => dmgOf(y) - dmgOf(x))[0];
    const ranged = pool.filter((a) => RANGED_MON.test(a.n)).sort((x, y) => dmgOf(y) - dmgOf(x))[0];
    // Who to go after: close by, easy to hit, a bit of chance.
    const target = [...prey].sort((a, b) => dist(m, a) + a.ac / 3 + Math.random() * 3 - (dist(m, b) + b.ac / 3 + Math.random() * 3))[0];
    let best = melee;
    if (ranged && (!melee || (dist(m, target) > 1 && (dist(m, target) <= 12) && Math.random() < 0.7))) best = ranged;
    const range = best === ranged && ranged ? 12 : 1;
    if (!this.closeIn(m, target, range)) return m.hp > 0 && this.say(`${m.name} closes in on ${target.name}.`, { story: false });
    if (m.hp <= 0) return;
    const times = best.b !== undefined ? Math.max(1, m.multi) : 1;
    const lines = [];
    const hitList = [];
    for (let i = 0; i < times; i++) {
      const live = prey.filter((h) => !h.dead && dist(m, h) <= range && (!h.down || !awake.some((x) => !x.down && !x.dead && dist(m, x) <= range)));
      if (!live.length) break;
      const h = live.includes(target) ? target : live[0];
      if (best.b !== undefined) {
        const adv = (h.dodging ? -1 : 0) + (range > 1 && this.enemiesNext(m).length ? -1 : 0);
        const r = d20(adv < 0 ? -1 : 0);
        const ok = r === 20 || (r !== 1 && r + best.b >= h.ac);
        if (!ok) { lines.push(`misses ${h.name}`); continue; }
        const crit = r === 20 || (h.down && range === 1);
        let dmg = best.d.reduce((n, x) => n + roll(x, { crit }), 0);
        if (h.raging) dmg = Math.floor(dmg / 2);
        lines.push(`${crit ? 'crits' : 'hits'} ${h.name} for ${dmg}`);
        this.hurt(h, dmg, { quiet: true, crit });
      } else {
        const save = d20() + h.saves[best.s || 'dex'];
        let dmg = best.d.reduce((n, x) => n + roll(x), 0);
        if (save >= best.dc) dmg = best.half ? Math.floor(dmg / 2) : 0;
        lines.push(`${h.name} ${save >= best.dc ? 'resists' : 'fails the save'}: ${dmg} damage`);
        this.hurt(h, dmg, { quiet: true });
      }
      hitList.push(h);
    }
    this.say(`👹 ${m.name} (${best.n}) ${lines.join(', ')}.${this.dropsText(hitList)}`);
  }
  dropsText(list) {
    const dropped = [...new Set(list)].filter((h) => (h.down || h.dead) && !h.droppedSaid);
    dropped.forEach((h) => { h.droppedSaid = true; });
    this.heroes.forEach((h) => { if (!h.down && !h.dead) h.droppedSaid = false; });
    return dropped.length ? ` ${dropped.map((h) => `🩸 **${h.name}** ${h.dead ? 'is dead' : 'drops'}!`).join(' ')}` : '';
  }

  // What a character does when nobody's playing them: heal a friend in trouble, blast groups, shoot from afar if they
  // can, else walk up and hit the closest foe.
  // Spends an action the way a player would (checking it's allowed and paying for it). Returns true if done.
  tryAct(h, act) {
    if (this.state !== 'combat' || h.down || h.dead || !this.foes().length) return false;
    if (this.canDo(h, act)) return false;
    const cost = this.costOf(h, act);
    if (cost === 'action') h.res.action--;
    if (cost === 'bonus') h.res.bonus--;
    this.doAction(h, act);
    return true;
  }
  // A whole turn for a character nobody's playing: bonus actions that help, the main action, follow-ups,
  // and Action Surge for a second main action.
  heroAI(h) {
    h.res = h.res || { action: 1, bonus: 1 };
    const live = () => this.state === 'combat' && this.foes().length && !h.down && !h.dead;
    if (h.abilities?.rage && !h.raging && h.uses.rage) this.tryAct(h, { type: 'rage' });
    if (h.abilities?.secondWind && h.uses.secondWind && h.hp < h.maxHp / 2) this.tryAct(h, { type: 'secondWind' });
    const down = this.heroes.find((x) => x.down && !x.dead);
    const bonusHeal = castable(h).find((x) => x.data.heal && isBonusSpell(x));
    if (down && bonusHeal && h.res.bonus) this.tryAct(h, { type: 'cast', spell: bonusHeal.name, target: down.id });
    if (h.hp / h.maxHp < 0.3 && h.potions && h.res.bonus) this.tryAct(h, { type: 'potion' });
    for (let n = 0; n < 3 && live(); n++) {
      if (h.res.action > 0) this.mainAction(h);
      else if (h.attacksLeft > 0) { const t = nearest(h, this.foes()); this.tryAct(h, { type: 'attack', weapon: (h.lastWeapon || h.attacks[0]).name, target: t.id }); }
      if (!live()) break;
      if (h.res.action <= 0 && h.attacksLeft <= 0 && h.abilities?.actionSurge && h.uses.actionSurge && this.foes().length >= 2) { this.tryAct(h, { type: 'actionSurge' }); continue; }
      break;
    }
    if (live() && h.res.bonus > 0 && h.attackedThisTurn) {
      const t = this.foes().filter((m) => dist(h, m) <= 1).sort((a, b2) => a.hp - b2.hp)[0];
      if (t && h.abilities?.offhand) this.tryAct(h, { type: 'offhand', target: t.id });
      else if (t && h.abilities?.martialArts) this.tryAct(h, { type: 'martial', target: t.id });
    }
    if (live() && h.res.bonus > 0) {
      const bs = castable(h).find((x) => !x.data.heal && isBonusSpell(x));
      if (bs) this.tryAct(h, { type: 'cast', spell: bs.name, target: nearest(h, this.foes()).id });
    }
  }
  // The character's main Action when the game plays them.
  mainAction(h) {
    const foes = this.foes();
    const hurt = this.standing().filter((x) => x.down || x.hp / x.maxHp < 0.3).sort((a, b) => a.hp - b.hp)[0];
    const can = castable(h);
    const healSpell = can.filter((s) => s.data.heal).sort((a, b) => spellRange(b) - spellRange(a))[0];
    if (hurt && healSpell && (spellRange(healSpell) > 1 || dist(h, hurt) <= (h.steps ?? h.speed) + 1)) return this.tryAct(h, { type: 'cast', spell: healSpell.name, target: hurt.id });
    if (hurt && hurt.down && hurt !== h && h.potions && dist(h, hurt) <= (h.steps ?? h.speed) + 1) return this.tryAct(h, { type: 'potion', target: hurt.id });
    if (h.hp / h.maxHp < 0.3 && h.potions) return this.tryAct(h, { type: 'potion' });
    const near = nearest(h, foes);
    const dmgSpells = can.filter((s) => !s.data.heal);
    const aoe = dmgSpells.filter((s) => s.data.aoe && s.level > 0)
      .map((s) => {
        const rad = AREA[s.name.toLowerCase()] || 2;
        const safe = SELF_AREA.test(s.name) ? foes : foes.filter((c) => !this.heroes.some((x) => !x.dead && x.bx != null && dist(c, x) <= rad));
        return { s, hits: safe.length ? Math.max(...safe.map((c) => foes.filter((f) => dist(c, f) <= rad).length)) : 0, safe };
      })
      .filter((x) => x.hits >= 2 && (!SELF_AREA.test(x.s.name) || dist(h, near) <= (h.steps ?? h.speed) + (AREA[x.s.name.toLowerCase()] || 2))).sort((a, b) => b.hits - a.hits || b.s.level - a.s.level)[0];
    if (aoe) {
      const pool = SELF_AREA.test(aoe.s.name) ? foes : aoe.safe;
      const center = [...pool].sort((a, b) => foes.filter((f) => dist(b, f) <= 2).length - foes.filter((f) => dist(a, f) <= 2).length)[0];
      return this.tryAct(h, { type: 'cast', spell: aoe.s.name, target: center.id });
    }
    const castBetter = h.castMod >= Math.max(h.m.str, h.m.dex);
    if (castBetter && dmgSpells.length) {
      const leveled = dmgSpells.filter((s) => s.level > 0 && !SELF_AREA.test(s.name) && !s.data.aoe);
      const cantrips = dmgSpells.filter((s) => s.level === 0 && spellRange(s) > 1);
      const choice = leveled.length && Math.random() < 0.5 ? leveled.sort((a, b) => b.level - a.level)[0] : cantrips[0] || dmgSpells[0];
      const target = [...foes].filter((f) => dist(h, f) <= spellRange(choice)).sort((a, b) => a.hp - b.hp)[0] || near;
      return this.tryAct(h, { type: 'cast', spell: choice.name, target: target.id });
    }
    const adjacent = this.enemiesNext(h);
    const melee = h.attacks.filter((a) => weaponRange(a) === 1).sort((a, b) => avg(b.dice) + b.bonus - avg(a.dice) - a.bonus)[0];
    const ranged = h.attacks.filter((a) => weaponRange(a) > 1).sort((a, b) => avg(b.dice) + b.bonus - avg(a.dice) - a.bonus)[0];
    const w = adjacent.length ? (melee || ranged) : ranged && (h.m.dex > h.m.str || !melee) ? ranged : melee || ranged;
    const pickT = adjacent.length && weaponRange(w) === 1 ? [...adjacent].sort((a, b) => a.hp - b.hp)[0]
      : [...foes].filter((f) => dist(h, f) <= weaponRange(w)).sort((a, b) => a.hp - b.hp)[0] || near;
    this.tryAct(h, { type: 'attack', weapon: w.name, target: pickT.id });
  }
  // Someone else (GM, or a timeout) plays this turn the way the AI would.
  autoTurn() {
    const cur = this.current();
    if (!cur || cur.kind !== 'h') return;
    this.waiting = null;
    this.heroAI(cur.who);
    this.next();
  }

  end(outcome, how) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.combat = null;
    this.waiting = null;
    this.outcome = outcome;
    this.result = how;
    this.say(`🏁 ${outcome}`);
    this.emit('end');
  }
  map() { return asciiMap(this.floor, this.here); }

  // ---------- auto-play exploring (test runs, or a GM who wants to skip ahead) ----------
  // The next door toward the nearest room worth visiting (unexplored, or the stairs once the floor is explored enough).
  pathTo(test) {
    const prev = new Map([[this.here, null]]);
    const queue = [this.here];
    while (queue.length) {
      const k = queue.shift();
      if (k !== this.here && test(this.floor.rooms[k])) {
        let step = k;
        while (prev.get(step) !== this.here) step = prev.get(step);
        return Object.entries(this.room().exits).find(([, id]) => id === step)[0];
      }
      for (const n of Object.values(this.floor.rooms[k].exits)) if (!prev.has(n) && (this.floor.rooms[n].seen || this.floor.rooms[k].visited)) { prev.set(n, k); queue.push(n); }
    }
    return null;
  }
  exploreStep() {
    if (this.state !== 'explore') return false;
    const r = this.room();
    const hurt = this.standing().some((h) => h.hp < h.maxHp * 0.6);
    if (r.loot && !r.looted && (r.cleared || !r.monsters?.length)) { this.loot(); return true; }
    if ((r.kind === 'rest') && !r.rested && hurt) { this.shortRest(); return true; }
    if (!r.breather && this.standing().some((h) => h.hp < h.maxHp / 3) && !this.pathTo((x) => x.kind === 'rest' && !x.rested && x.seen)) { this.breather(); return true; }
    if (r.kind === 'stairs' && r.cleared) { this.descend(); return true; }
    // Go to the rest room first if hurt and it's known, else explore, else head for the stairs/boss.
    const dir = (hurt && this.pathTo((x) => x.kind === 'rest' && !x.rested && x.seen))
      || this.pathTo((x) => !x.visited && x.kind !== 'stairs' && x.kind !== 'boss')
      || this.pathTo((x) => x.kind === 'stairs' || x.kind === 'boss');
    if (!dir) return false;
    this.move(dir);
    return true;
  }

  // Everything the screens need.
  snapshot() {
    return {
      id: this.id, title: this.title, edition: this.edition, level: this.level, state: this.state, floor: this.floorN, floors: FLOORS, floorName: this.floor.name,
      here: this.here, rooms: Object.values(this.floor.rooms).map((r) => ({ id: r.id, x: r.x, y: r.y, kind: r.seen ? r.kind : '?', seen: r.seen, visited: r.visited,
        cleared: r.cleared, looted: r.looted, rested: r.rested, exits: r.exits, name: r.visited ? r.name : '', dims: r.seen ? r.dims : null })),
      heroes: this.heroes.map(({ id, name, cls, species, hp, maxHp, ac, down, dead, ds, potions, slots, player, playerName, gold, items, tag }) => ({ id, name, cls, species, hp, maxHp, ac, down, dead, ds, potions, slots, player, playerName, gold, items, tag })),
      foes: (this.combat?.monsters || []).map(({ id, n, name, hp, maxHp, ac, cr, tag, bx, by, fp }) => ({ id, n, name, hp, maxHp, ac, cr, tag, bx, by, fp })),
      battle: this.combat ? {
        w: this.combat.field.w, h: this.combat.field.h, theme: this.combat.field.theme,
        units: this.units().map((u) => ({ id: u.id, side: u.side, tag: u.tag, name: u.name, bx: u.bx, by: u.by, fp: u.fp || 1 })),
        reach: this.waiting ? [...this.reach(this.hero(this.waiting.heroId)).keys()] : [], steps: this.waiting ? this.hero(this.waiting.heroId).steps : 0,
      } : null,
      turn: this.current() ? { kind: this.current().kind, id: this.current().id, name: this.current().who.name } : null,
      round: this.combat?.round || 0, waiting: this.waiting, version: this.version || 0, log: this.log.slice(-60), outcome: this.outcome, auto: this.auto, gold: this.gold, source: this.source,
    };
  }
}
