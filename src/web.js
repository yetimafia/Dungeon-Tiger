// The GM page: watch any run (Discord ones too), start runs at the table, and step in when needed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONSTERS } from './dungeon.js';
import { spritePng, bodyPlan, heroPng } from './sprites.js';
import { battlePng } from './battlemap.js';
import { spellInfo, weaponReach } from './game.js';
import { SETTINGS, settings, writeEnv, findNoteTiger, linkNoteTiger, VERSION } from './config.js';
import { updateStatus, checkForUpdate, installUpdate } from './updater.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');

export function startWeb({ delve, port = 3090, lan = false, app = {} }) {
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
      if (/^\/fonts\/pixelify-sans-(400|700)\.woff2$/.test(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=604800' });
        return res.end(fs.readFileSync(path.join(path.dirname(PAGE), url.pathname)));
      }
      if (url.pathname === '/icon.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(path.join(path.dirname(PAGE), 'icon.png'))); }
      // Monster sprites: /sprite/<name>.png?scale=4, and a gallery of them all at /sprites
      if (p[0] === 'sprite' && p[1]) {
        const name = decodeURIComponent(p[1]).replace(/\.png$/, '').replace(/ [A-Z]$/, '');
        const m = findMonster(name);
        if (!m) return send(res, 404, { error: 'No such monster' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
        return res.end(spritePng(m, Math.max(1, Math.min(8, Number(url.searchParams.get('scale')) || 1))));
      }
      if (p[0] === 'sprites') {
        const all = [...new Map([...MONSTERS['2024'], ...MONSTERS['2014']].map((m) => [m.n, m])).values()].sort((a, b) => a.n.localeCompare(b.n));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><title>Monsters · Dungeon Tiger</title><style>body{background:#14110f;color:#eae2d6;font:13px system-ui;margin:16px}
          div{display:inline-block;width:118px;text-align:center;margin:4px;vertical-align:top}img{width:96px;height:96px;image-rendering:pixelated;background:#221d19;border-radius:8px}
          small{color:#9c8f80;display:block}</style><h2>All ${all.length} monsters</h2>`
          + all.map((m) => `<div><img src="/sprite/${encodeURIComponent(m.n)}.png" loading="lazy"><br>${m.n}<small>CR ${m.cr} · ${bodyPlan(m)}</small></div>`).join(''));
      }
      if (p[0] !== 'api') return send(res, 404, { error: 'Not found' });
      // For the Windows launcher and installer.
      if (p[1] === 'status') return send(res, 200, { ok: true, version: VERSION });
      if (p[1] === 'stop' && req.method === 'POST') { send(res, 200, { ok: true }); return app.stop?.(); }
      if (p[1] === 'restart' && req.method === 'POST') {
        if (!process.env.DT_LAUNCHER) return send(res, 400, { error: 'Close the black window and start Dungeon Tiger again.' });
        send(res, 200, { ok: true });
        return setTimeout(() => process.exit(75), 300); // the launcher starts it again
      }
      // Settings
      if (p[1] === 'settings' && req.method === 'GET') return send(res, 200, settingsView());
      if (p[1] === 'settings' && p[2] === 'link' && req.method === 'POST') { linkNoteTiger(); await app.apply?.(); return send(res, 200, settingsView()); }
      if (p[1] === 'settings' && req.method === 'POST') {
        const b = await readJson(req);
        const prev = settings();
        const changes = {};
        for (const def of SETTINGS) {
          if (!(def.key in b)) continue;
          let v = String(b[def.key] ?? '').replace(/[\r\n]/g, '').trim();
          if (def.secret && !v && !b[`${def.key}_clear`]) continue; // empty secret box = keep it
          changes[def.key] = v;
        }
        writeEnv(changes);
        await app.apply?.();
        return send(res, 200, { ...settingsView(), needsRestart: ('PORT' in changes && changes.PORT !== prev.PORT) || ('PLAYER_PORT' in changes && changes.PLAYER_PORT !== prev.PLAYER_PORT) || ('GM_LAN' in changes && changes.GM_LAN !== prev.GM_LAN), canRestart: Boolean(process.env.DT_LAUNCHER) });
      }
      // The players' website going online
      if (p[1] === 'online' && req.method === 'GET') return send(res, 200, app.online.status());
      if (p[1] === 'online' && p[2] === 'start' && req.method === 'POST') { writeEnv({ PLAYER_ONLINE: 'true' }); return send(res, 200, await app.online.start()); }
      if (p[1] === 'online' && p[2] === 'newlink' && req.method === 'POST') return send(res, 200, app.online.newLink());
      if (p[1] === 'online' && p[2] === 'stop' && req.method === 'POST') { writeEnv({ PLAYER_ONLINE: 'false' }); return send(res, 200, app.online.stop()); }
      // Updates
      if (p[1] === 'update' && req.method === 'GET') return send(res, 200, updateStatus());
      if (p[1] === 'update' && p[2] === 'check' && req.method === 'POST') return send(res, 200, await checkForUpdate());
      if (p[1] === 'update' && p[2] === 'install' && req.method === 'POST') return send(res, 200, await installUpdate(async () => { await app.stop?.(); }));
      if (p[1] === 'state' && req.method === 'GET') {
        if (url.searchParams.get('check')) await delve.nt.check();
        return send(res, 200, {
          noteTiger: { ok: delve.nt.ok, error: delve.nt.lastError, url: delve.nt.url, hasKey: !!delve.nt.key }, noteTigerOnPC: { found: findNoteTiger().found },
          edition: delve.edition, discord: app.discord?.() || { state: 'off' }, version: VERSION, update: updateStatus(),
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
      // The battle map picture, and the party's sprites.
      if (req.method === 'GET' && p[3] === 'battle.png') {
        if (!run.combat) return send(res, 404, { error: 'No fight' });
        const w = run.waiting && run.hero(run.waiting.heroId);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(battlePng(run.combat.field, run.heroes, run.combat.monsters, { scale: 2, reach: w ? run.reach(w) : null, current: run.current()?.id, target: url.searchParams.get('target') }));
      }
      if (req.method === 'GET' && p[3] === 'hero' && p[4]) {
        const h = run.hero(decodeURIComponent(p[4]).replace(/\.png$/, ''));
        if (!h) return send(res, 404, { error: 'No such hero' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
        return res.end(heroPng(h));
      }
      if (req.method === 'GET' && !p[3]) return send(res, 200, { ...run.snapshot(), autoplaying: !!run.autoplaying, recap: run.recap || null, actions: actionsFor(run) });
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const b = await readJson(req);
      const a = p[3];
      if (a === 'move') run.move(b.dir);
      else if (a === 'loot') run.loot();
      else if (a === 'rest') run.shortRest();
      else if (a === 'breather') run.breather();
      else if (a === 'down') run.descend();
      else if (a === 'act') run.act(b.heroId, b, { keepTurn: true });
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
  server.on('error', (err) => { console.error(`[web] couldn't open port ${port}:`, err.message); if (err.code === 'EADDRINUSE') process.exit(3); });
  server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => console.log(`[web] GM page: http://localhost:${port}`));
  return server;
}

function findMonster(name) {
  const k = name.toLowerCase();
  return MONSTERS['2024'].find((m) => m.n.toLowerCase() === k) || MONSTERS['2014'].find((m) => m.n.toLowerCase() === k);
}

function settingsView() {
  const now = settings();
  const nt = findNoteTiger();
  return {
    values: Object.fromEntries(SETTINGS.map((d) => [d.key, d.secret ? '' : now[d.key]])),
    set: Object.fromEntries(SETTINGS.filter((d) => d.secret).map((d) => [d.key, Boolean(now[d.key])])),
    noteTigerOnPC: { found: nt.found, enabled: nt.enabled, linked: nt.found && Boolean(nt.key) && nt.key === now.NOTE_TIGER_KEY },
  };
}

// What the current character can do (for the GM page's turn buttons).
export function actionsFor(run) {
  const cur = run.current();
  if (!cur || cur.kind !== 'h' || run.waiting?.heroId !== cur.id) return null;
  const h = cur.who;
  const check = (act) => { const why = run.canDo(h, act); return { cost: run.costOf(h, act), ok: !why, why }; };
  return {
    heroId: h.id, potions: h.potions,
    // Action, bonus action and movement left this turn (Baldur's Gate 3 style).
    res: { action: h.res?.action ?? 0, bonus: h.res?.bonus ?? 0, attacksLeft: h.attacksLeft || 0, perTurn: h.perTurn },
    weapons: h.attacks.map((a) => ({ name: a.name, text: `${a.bonus >= 0 ? '+' : ''}${a.bonus}, ${a.dice}${h.perTurn > 1 ? `, ${h.perTurn} attacks` : ''}`, ranged: weaponReach(a) > 1, ...check({ type: 'attack', weapon: a.name }) })),
    spells: h.spells.map((s) => ({ name: s.name, level: s.level, heal: !!s.data.heal, aoe: !!s.data.aoe, ...spellInfo(s), ...check({ type: 'cast', spell: s.name }),
      slotOk: s.level === 0 || Object.entries(h.slots).some(([l, x]) => Number(l) >= s.level && x.max - (x.used || 0) > 0) })).map((s) => ({ ...s, ok: s.ok && s.slotOk })),
    basics: [['dash', '💨 Dash'], ['disengage', '🏃 Disengage'], ['dodge', '🛡️ Dodge'], ['potion', `🧪 Potion (${h.potions})`]].map(([type, label]) => ({ type, label, ...check({ type }), ...(type === 'potion' && !h.potions ? { ok: false, why: 'No potions.' } : {}) })),
    options: run.options(h),
    steps: h.steps, disengaged: !!h.disengaged, raging: !!h.raging,
  };
}
