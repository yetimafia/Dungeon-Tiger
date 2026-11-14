// Keeps the runs that are going on, makes the party (through Note Tiger when it's reachable), keeps Note Tiger's Party tab
// in step, and sends the finished run to Note Tiger for a recap.
import { Run, toHero } from './game.js';
import { localCharacter } from './notetiger.js';

export class Delve {
  constructor({ nt, edition = '2024', deleteAfter = true }) {
    Object.assign(this, { nt, edition, deleteAfter });
    this.runs = new Map();
    this.n = 0;
  }

  // players: [{ id, name, cls }] (people), plus `companions` characters nobody plays.
  async makeParty({ players = [], companions = 0, level = 3, edition = this.edition }) {
    const wants = [...players.map((p) => ({ ...p })), ...Array.from({ length: companions }, () => ({ id: null, name: '' }))];
    const heroes = [];
    let usedLocal = false;
    for (const p of wants) {
      let c = null;
      if (this.nt.ok || (await this.nt.check())) {
        try { [c] = await this.nt.randomCharacters({ count: 1, level, edition, player: p.name, playerId: p.id || '', cls: p.cls }); }
        catch (err) { this.nt.lastError = err.message; }
      }
      if (!c) { c = localCharacter({ level, player: p.name, playerId: p.id || '', cls: p.cls }); usedLocal = true; }
      heroes.push(toHero(c, { player: p.id, playerName: p.name }));
    }
    return { heroes, usedLocal };
  }
  async reroll(hero, { level, edition = this.edition, cls }) {
    this.nt.remove(hero.id);
    const { heroes } = await this.makeParty({ players: [{ id: hero.player, name: hero.playerName, cls }], level, edition });
    return heroes[0];
  }

  start(opts) {
    const id = `r${Date.now().toString(36)}${(this.n++).toString(36)}`;
    const run = new Run({ id, edition: this.edition, ...opts });
    this.runs.set(id, run);
    // Note Tiger's Party tab: send what changed a second after it settles (fights change HP a lot).
    const last = new Map(run.heroes.map((h) => [h.id, this.state(h)]));
    const timers = new Map();
    run.on('hero', (h) => {
      clearTimeout(timers.get(h.id));
      timers.set(h.id, setTimeout(() => {
        const was = last.get(h.id), now = this.state(h);
        if (was.hp !== now.hp) this.nt.track(h.id, { op: 'setHp', amount: now.hp });
        for (const [lv, used] of Object.entries(now.slots)) if (was.slots[lv] !== used) this.nt.track(h.id, { op: 'slot', level: lv, used });
        if (was.ds !== now.ds) this.nt.track(h.id, { op: 'death', s: h.ds.s, f: h.ds.f });
        if (was.gold !== now.gold) this.nt.track(h.id, { op: 'money', gp: now.gold });
        last.set(h.id, now);
      }, 1000));
    });
    run.on('end', () => this.finish(run));
    return run;
  }
  state(h) {
    return { hp: h.hp, slots: Object.fromEntries(Object.entries(h.slots).map(([l, s]) => [l, s.used || 0])), ds: `${h.ds.s}/${h.ds.f}`, gold: h.gold };
  }
  get(id) { return this.runs.get(id); }
  list() { return [...this.runs.values()]; }

  async finish(run) {
    run.recap = { status: this.nt.ok ? 'sending' : 'off' };
    if (this.nt.ok && run.events.length > 3) {
      try {
        const sent = await this.nt.sendRun({
          title: run.title, outcome: run.outcome, floors: run.floorN, source: 'Dungeon Tiger',
          party: run.heroes.map((h) => `${h.name} (${h.cls}${h.playerName ? `, played by ${h.playerName}` : ''})${h.dead ? ' – died' : ''}`),
          events: run.events,
        });
        run.recap = { status: 'writing', id: sent.id };
      } catch (err) { run.recap = { status: 'failed', error: err.message }; }
    }
    if (this.deleteAfter) setTimeout(() => run.heroes.forEach((h) => this.nt.remove(h.id)), 3000);
    run.emit('recap', run.recap);
    // Forget finished runs after an hour.
    setTimeout(() => this.runs.delete(run.id), 3600_000).unref?.();
  }
}
