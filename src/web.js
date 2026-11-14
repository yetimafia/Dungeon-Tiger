// The GM page: watch any run (Discord ones too), start runs at the table, and step in when needed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');

export function startWeb({ delve, port = 3090, lan = false, settings = {} }) {
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });

  // Auto-play: one step every so often so you can watch it.
  function autoplay(run, on) {
    clearInterval(run.ticker);
    run.autoplaying = !!on;
    if (!on) return;
    run.ticker = setInterval(() => {
      try {
        if (run.state === 'ended') return autoplay(run, false);
        if (run.state === 'combat') { if (run.waiting) run.autoTurn(); else run.next(); return; }
        if (!run.exploreStep()) autoplay(run, false);
      } catch (err) { console.error('[auto]', err.message); autoplay(run, false); }
    }, 700);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(PAGE));
      }
      if (p[0] !== 'api') return send(res, 404, { error: 'Not found' });
      if (p[1] === 'state' && req.method === 'GET') {
        if (url.searchParams.get('check')) await delve.nt.check();
        return send(res, 200, {
          noteTiger: { ok: delve.nt.ok, error: delve.nt.lastError, url: delve.nt.url, hasKey: !!delve.nt.key },
          edition: delve.edition, discord: settings.discord?.() || 'off',
          runs: delve.list().map((r) => ({ id: r.id, title: r.title, state: r.state, floor: r.floorN, source: r.source, party: r.heroes.map((h) => h.name), outcome: r.outcome, started: r.started })),
        });
      }
      if (p[1] !== 'runs') return send(res, 404, { error: 'Not found' });
      // POST /api/runs: a new run from the GM page.
      if (!p[2] && req.method === 'POST') {
        const b = await readJson(req);
        const size = Math.max(1, Math.min(6, Number(b.size) || 4));
        const level = Math.max(1, Math.min(10, Number(b.level) || 3));
        const { heroes, usedLocal } = await delve.makeParty({ companions: size, level, edition: b.edition || delve.edition });
        // At the table the GM chooses each action; a test run plays itself.
        if (b.mode === 'table') heroes.forEach((h) => { h.player = 'gm'; h.playerName = 'GM'; });
        const run = delve.start({ heroes, level, edition: b.edition || delve.edition, source: b.mode === 'table' ? 'table' : 'test', title: b.title || undefined });
        if (b.mode !== 'table') autoplay(run, true);
        return send(res, 200, { id: run.id, usedLocal });
      }
      const run = delve.get(p[2]);
      if (!run) return send(res, 404, { error: 'That run is gone (finished runs are kept for an hour).' });
      if (req.method === 'GET' && !p[3]) return send(res, 200, { ...run.snapshot(), autoplaying: !!run.autoplaying, recap: run.recap || null, actions: actionsFor(run) });
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const b = await readJson(req);
      const a = p[3];
      if (a === 'move') run.move(b.dir);
      else if (a === 'loot') run.loot();
      else if (a === 'rest') run.shortRest();
      else if (a === 'breather') run.breather();
      else if (a === 'down') run.descend();
      else if (a === 'act') run.act(b.heroId, b);
      else if (a === 'auto') run.autoTurn();
      else if (a === 'step') { if (run.state === 'combat') run.autoTurn(); else run.exploreStep(); }
      else if (a === 'autoplay') autoplay(run, b.on);
      // GM powers
      else if (a === 'heal') { run.heroes.filter((h) => !h.dead).forEach((h) => { run.heal(h, h.maxHp); }); run.say('✨ The GM heals the party.', { story: false }); run.emit('map'); }
      else if (a === 'skip') {
        if (run.state === 'combat') { run.foes().forEach((m) => { m.hp = 0; }); run.say('The GM waves the fight away.', { story: false }); run.waiting = null; run.next(); }
        else throw new Error('There\'s no fight to skip.');
      } else if (a === 'nextfloor') {
        if (run.floorN >= 5) throw new Error('This is the last floor.');
        if (run.state === 'combat') { run.foes().forEach((m) => { m.hp = 0; }); run.waiting = null; run.next(); }
        const st = run.floor.rooms[run.floor.exit]; st.cleared = true; run.here = st.id; run.say('The GM moves the party to the stairs.', { story: false }); run.descend();
      } else if (a === 'end') run.end(b.outcome || `The GM ended the run on floor ${run.floorN}.`, 'quit');
      else return send(res, 404, { error: 'Unknown action' });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });
  server.on('error', (err) => console.error(`[web] couldn't open port ${port}:`, err.message));
  server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => console.log(`[web] GM page: http://localhost:${port}`));
  return server;
}

// What the current character can do (for the GM page's turn buttons).
function actionsFor(run) {
  const cur = run.current();
  if (!cur || cur.kind !== 'h' || run.waiting?.heroId !== cur.id) return null;
  const h = cur.who;
  return {
    heroId: h.id, potions: h.potions,
    weapons: h.attacks.map((a) => ({ name: a.name, text: `${a.bonus >= 0 ? '+' : ''}${a.bonus}, ${a.dice}${h.perTurn > 1 ? ` ×${h.perTurn}` : ''}` })),
    spells: h.spells.map((s) => ({ name: s.name, level: s.level, heal: !!s.data.heal, aoe: !!s.data.aoe, ok: s.level === 0 || Object.entries(h.slots).some(([l, x]) => Number(l) >= s.level && x.max - (x.used || 0) > 0) })),
  };
}
