// A run: the party goes floor by floor, room by room. Fights are turn by turn: players choose their character's action
// (in Discord or on the GM page); characters nobody controls, and monsters, act on their own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { roll, avg, d20, mod, pick } from './dice.js';
import { makeFloor, FLOORS, asciiMap } from './dungeon.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SPELLS = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'spells-combat.json'), 'utf8')).map((s) => [s.n.toLowerCase(), s]));
const AB = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

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
    id: c.id, name: c.name, player, playerName: playerName || c.player || '', cls: (c.classes || []).map((k) => `${k.name} ${k.level}`).join('/'),
    level: lvl, ac: c.ac || 10, hp: c.hp?.current ?? c.hp?.max ?? 10, maxHp: c.hp?.max ?? 10, temp: 0, m, pb,
    saves: Object.fromEntries(AB.map((a) => [a, m[a] + (c.saves?.[a]?.prof ? pb : 0)])),
    init: c.initiative ?? m.dex, attacks, perTurn: attacksPerTurn(c), sneak: isRogue ? Math.ceil(lvl / 2) : 0,
    spells, slots: JSON.parse(JSON.stringify(c.spellcasting?.slots || {})), dc: sa ? 8 + pb + m[sa] : 0, spellAtk: sa ? pb + m[sa] : 0, castMod: sa ? m[sa] : 0,
    potions, hitDie, hdUsed: 0, gold: c.money?.gp || 0, items: [], down: false, dead: false, stable: false, ds: { s: 0, f: 0 }, dodging: false,
  };
}

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
  startCombat(monsters) {
    this.state = 'combat';
    const order = [
      ...this.standing().map((h) => ({ kind: 'h', id: h.id, init: d20() + h.init + Math.random() / 10 })),
      ...monsters.map((m) => ({ kind: 'm', id: m.id, init: d20() + mod(m.ab[1]) + Math.random() / 10 })),
    ].sort((a, b) => b.init - a.init);
    this.combat = { monsters, order, turn: -1, round: 1 };
    this.emit('fight', monsters);
    this.say(`🎲 Initiative: ${order.map((o) => (o.kind === 'h' ? this.hero(o.id).name : monsters.find((m) => m.id === o.id).name)).join(' → ')}`, { story: false });
    this.next();
  }
  hero(id) { return this.heroes.find((h) => h.id === id); }
  foes() { return (this.combat?.monsters || []).filter((m) => m.hp > 0); }
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
      h.dodging = false;
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

  // A hero's action. act: { type: 'attack'|'cast'|'dodge'|'potion', weapon, spell, target }
  act(heroId, act) {
    if (this.state !== 'combat') throw new Error('There\'s no fight going on.');
    const cur = this.current();
    if (!cur || cur.kind !== 'h' || cur.id !== heroId) throw new Error('It isn\'t that character\'s turn.');
    this.waiting = null;
    this.doAction(cur.who, act);
    this.next();
  }
  doAction(h, act) {
    const foes = this.foes();
    if (act.type === 'dodge') { h.dodging = true; return this.say(`🛡️ ${h.name} takes the Dodge action.`, { story: false }); }
    if (act.type === 'potion') {
      const target = act.target ? this.hero(act.target) : h;
      if (h.potions < 1) return this.say(`${h.name} has no potions left.`, { story: false });
      h.potions--;
      const n = this.heal(target, roll('2d4+2'));
      return this.say(`🧪 ${h.name} ${target === h ? 'drinks' : `pours into ${target.name}'s mouth`} a Potion of Healing: +${n} HP.`);
    }
    if (act.type === 'cast') {
      const sp = h.spells.find((s) => s.name === act.spell);
      if (!sp) throw new Error('Unknown spell.');
      const slot = slotFor(h, sp);
      if (slot === null) throw new Error('No spell slot left for that.');
      if (slot > 0) h.slots[slot].used = (h.slots[slot].used || 0) + 1;
      const dice = spellDice(sp, h, slot);
      if (sp.data.heal) {
        const t = act.target ? this.hero(act.target) : [...this.standing()].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        const n = this.heal(t, roll(dice, { mod: h.castMod }));
        this.say(`💚 ${h.name} casts **${sp.name}** on ${t.name}: +${n} HP.`);
        this.heroChanged(h);
        return;
      }
      const first = foes.find((m) => m.id === act.target) || foes[0];
      // Scorching Ray: one attack per ray (3, +1 per slot level above 2).
      const targets = sp.data.aoe ? foes.slice(0, 4) : /scorching ray/i.test(sp.name) ? Array(3 + Math.max(0, slot - 2)).fill(first) : [first];
      const lines = [];
      for (const m of targets) {
        if (m.hp <= 0) continue;
        let dmg;
        if (sp.data.atk) {
          const r = d20(); const hit = r === 20 || (r !== 1 && r + h.spellAtk >= m.ac);
          dmg = hit ? roll(dice, { crit: r === 20 }) : 0;
          lines.push(hit ? `${r === 20 ? 'crits' : 'hits'} ${m.name} for ${dmg}` : `misses ${m.name}`);
        } else if (sp.data.save) {
          const save = d20() + mod(m.ab[AB.indexOf(sp.data.save)]);
          dmg = roll(dice);
          if (save >= h.dc) dmg = sp.data.half ? Math.floor(dmg / 2) : 0;
          lines.push(`${m.name} ${save >= h.dc ? (dmg ? 'half-saves' : 'saves') : 'fails'}: ${dmg}`);
        } else {
          dmg = /magic missile/i.test(sp.name) ? roll(dice) * (2 + slot) : roll(dice);
          lines.push(`${m.name} takes ${dmg}`);
        }
        this.damageMonster(m, dmg);
      }
      this.say(`✨ ${h.name} casts **${sp.name}**${slot ? ` (level ${slot})` : ''}: ${lines.join('; ')}.${this.deathsText(targets)}`);
      this.heroChanged(h);
      return;
    }
    // Weapon attacks (Extra Attack gives more; Sneak Attack once a turn).
    const w = h.attacks.find((a) => a.name === act.weapon) || h.attacks[0];
    const lines = [];
    let sneakUsed = false;
    const hit = [];
    for (let i = 0; i < h.perTurn; i++) {
      const live = this.foes();
      if (!live.length) break;
      const m = live.find((x) => x.id === act.target) || live[0];
      const r = d20();
      const ok = r === 20 || (r !== 1 && r + w.bonus >= m.ac);
      if (!ok) { lines.push(`misses ${m.name}`); continue; }
      let dmg = roll(w.dice, { crit: r === 20 });
      if (h.sneak && !sneakUsed && (w.finesse || w.ranged)) { dmg += roll(`${h.sneak}d6`, { crit: r === 20 }); sneakUsed = true; }
      for (const it of h.items) if (/^\+(\d) /.test(it) || /weapon, \+(\d)/i.test(it)) dmg += Number((it.match(/\+(\d)/) || [0, 0])[1]);
      lines.push(`${r === 20 ? 'crits' : 'hits'} ${m.name} for ${dmg}${sneakUsed && !hit.includes('sneak') ? ' (sneak attack)' : ''}`);
      if (sneakUsed) hit.push('sneak');
      this.damageMonster(m, dmg);
      hit.push(m);
    }
    this.say(`⚔️ ${h.name} (${w.name}) ${lines.join(', ')}.${this.deathsText(hit.filter((x) => typeof x === 'object'))}`);
  }
  damageMonster(m, dmg) { m.hp = Math.max(0, m.hp - dmg); }
  deathsText(list) {
    const dead = [...new Set(list)].filter((m) => m.hp <= 0 && !m.announced);
    dead.forEach((m) => { m.announced = true; });
    return dead.length ? ` ${dead.map((m) => `**${m.name}** falls!`).join(' ')}` : '';
  }

  // Monsters: the action that hurts most; area attacks now and then; they go after whoever's easiest to hit.
  monsterTurn(m) {
    const targets = this.alive();
    if (!targets.length) return;
    const aoe = m.a.filter((a) => a.aoe && a.dc);
    const single = m.a.filter((a) => !a.aoe || !a.dc);
    const useAoe = aoe.length && targets.length > 1 && Math.random() < 0.3;
    if (useAoe) {
      const a = aoe[0];
      const lines = [];
      for (const h of targets) {
        const save = d20() + h.saves[a.s || 'dex'];
        let dmg = a.d.reduce((n, x) => n + roll(x), 0);
        if (save >= a.dc) dmg = a.half ? Math.floor(dmg / 2) : 0;
        lines.push(`${h.name} ${dmg}`);
        this.hurt(h, dmg, { quiet: true });
      }
      this.say(`🔥 ${m.name} uses **${a.n}**: ${lines.join(', ')}.${this.dropsText(targets)}`);
      return;
    }
    const best = [...(single.length ? single : m.a)].sort((x, y) => y.d.reduce((n, z) => n + avg(z), 0) - x.d.reduce((n, z) => n + avg(z), 0))[0];
    const times = best.b !== undefined ? Math.max(1, m.multi) : 1;
    const lines = [];
    const hitList = [];
    for (let i = 0; i < times; i++) {
      const live = this.alive();
      if (!live.length) break;
      const h = [...live].sort((a, b) => a.ac - b.ac + (Math.random() - 0.5) * 20)[0];
      if (best.b !== undefined) {
        const r = d20(h.dodging ? -1 : 0);
        const ok = r === 20 || (r !== 1 && r + best.b >= h.ac);
        if (!ok) { lines.push(`misses ${h.name}`); continue; }
        const dmg = best.d.reduce((n, x) => n + roll(x, { crit: r === 20 }), 0);
        lines.push(`${r === 20 ? 'crits' : 'hits'} ${h.name} for ${dmg}`);
        this.hurt(h, dmg, { quiet: true, crit: r === 20 });
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

  // What a character does when nobody's playing them: heal a friend in trouble, blast groups, else hit the weakest foe.
  heroAI(h) {
    const foes = this.foes();
    const hurt = this.standing().filter((x) => x.down || x.hp / x.maxHp < 0.3).sort((a, b) => a.hp - b.hp)[0];
    const can = castable(h);
    const healSpell = can.find((s) => s.data.heal);
    if (hurt && healSpell) return this.doAction(h, { type: 'cast', spell: healSpell.name, target: hurt.id });
    if (hurt && hurt.down && h.potions) return this.doAction(h, { type: 'potion', target: hurt.id });
    if (h.hp / h.maxHp < 0.3 && h.potions) return this.doAction(h, { type: 'potion' });
    const dmgSpells = can.filter((s) => !s.data.heal);
    const aoe = dmgSpells.filter((s) => s.data.aoe && s.level > 0);
    const weakest = [...foes].sort((a, b) => a.hp - b.hp)[0];
    if (aoe.length && foes.length >= 2) return this.doAction(h, { type: 'cast', spell: aoe.sort((a, b) => b.level - a.level)[0].name });
    const castBetter = h.castMod >= Math.max(h.m.str, h.m.dex);
    if (castBetter && dmgSpells.length) {
      const leveled = dmgSpells.filter((s) => s.level > 0);
      const choice = leveled.length && Math.random() < 0.5 ? leveled.sort((a, b) => b.level - a.level)[0] : dmgSpells.filter((s) => s.level === 0)[0] || dmgSpells[0];
      return this.doAction(h, { type: 'cast', spell: choice.name, target: weakest.id });
    }
    const w = [...h.attacks].sort((a, b) => avg(b.dice) + b.bonus - avg(a.dice) - a.bonus)[0];
    this.doAction(h, { type: 'attack', weapon: w.name, target: weakest.id });
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
        cleared: r.cleared, looted: r.looted, rested: r.rested, exits: r.exits, name: r.visited ? r.name : '' })),
      heroes: this.heroes.map(({ id, name, cls, hp, maxHp, ac, down, dead, ds, potions, slots, player, playerName, gold, items }) => ({ id, name, cls, hp, maxHp, ac, down, dead, ds, potions, slots, player, playerName, gold, items })),
      foes: (this.combat?.monsters || []).map(({ id, n, name, hp, maxHp, ac, cr }) => ({ id, n, name, hp, maxHp, ac, cr })),
      turn: this.current() ? { kind: this.current().kind, id: this.current().id, name: this.current().who.name } : null,
      round: this.combat?.round || 0, waiting: this.waiting, log: this.log.slice(-60), outcome: this.outcome, auto: this.auto, gold: this.gold, source: this.source,
    };
  }
}
