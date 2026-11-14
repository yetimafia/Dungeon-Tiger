// The players' website: its own small server (separate from the GM page), meant to be put online through a tunnel.
// Everything needs a login: the group password, or the join link (which carries a random token).
// Players open a lobby, get a random adventurer each, and play the run: walking the dungeon and fighting on the
// battle map by tapping squares and monsters.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { battlePng } from './battlemap.js';
import { spritePng, heroPng } from './sprites.js';
import { MONSTERS } from './dungeon.js';
import { actionsFor } from './web.js';
import { castable } from './game.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DAY = 24 * 3600_000;

export function startPlayers({ delve, port = 3091, password = () => '', token = () => '', turnSeconds = () => 120 }) {
  const sessions = new Map();      // sid → { sid, name, at }
  const lobbies = new Map();       // id → lobby
  const fails = new Map();         // ip → [times]
  const turnTimers = new Map();    // run id → { key, timer }

  const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const readJson = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 5e4) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  const cookieOf = (req) => (String(req.headers.cookie || '').match(/(?:^|;\s*)dt_play=([A-Za-z0-9_-]+)/) || [])[1];
  const who = (req) => { const s = sessions.get(cookieOf(req)); return s && Date.now() - s.at < 14 * DAY ? s : null; };
  const pid = (s) => `web:${s.sid}`;
  const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 24) || 'Adventurer';

  // ---------- lobbies ----------
  const lobbyView = (lb, me) => ({
    id: lb.id, host: lb.host === me?.sid, hostName: sessions.get(lb.host)?.name || '', level: lb.level, edition: lb.edition, party: lb.party, started: lb.runId || null,
    players: lb.players.map((p) => ({ name: p.name, me: p.sid === me?.sid, cls: p.hero?.cls || '', hero: p.hero ? { id: p.hero.id, name: p.hero.name, cls: p.hero.cls, species: p.hero.species, hp: p.hero.maxHp, ac: p.hero.ac, spells: p.hero.spells.length } : null })),
  });
  async function rollHero(lb, p, cls) {
    p.hero = null;
    const { heroes } = await delve.makeParty({ players: [{ id: pid({ sid: p.sid }), name: p.name, cls: cls || undefined }], level: lb.level, edition: lb.edition });
    if (lb.players.includes(p)) p.hero = heroes[0]; else delve.nt.remove(heroes[0].id);
  }
  async function startLobby(lb) {
    const { heroes: comps } = await delve.makeParty({ companions: Math.max(0, lb.party - lb.players.length), level: lb.level, edition: lb.edition });
    const heroes = [...lb.players.map((p) => Object.assign(p.hero, { player: pid({ sid: p.sid }), playerName: p.name })), ...comps];
    const run = delve.start({ heroes, level: lb.level, edition: lb.edition, source: 'website', title: `Dungeon run ${new Date().toLocaleDateString()}` });
    lb.runId = run.id;
    // Someone who doesn't choose in time: the game plays that turn for them.
    run.on('turn', (h) => {
      const key = `${run.combat?.round}-${run.combat?.turn}`;
      const t = turnTimers.get(run.id);
      if (t?.key === key) return;
      clearTimeout(t?.timer);
      turnTimers.set(run.id, { key, timer: setTimeout(() => { if (run.waiting?.heroId === h.id) { run.say(`⏳ ${h.name} hesitates; instinct takes over.`, { story: false }); run.autoTurn(); } }, Number(turnSeconds()) * 1000) });
    });
    run.on('end', () => { clearTimeout(turnTimers.get(run.id)?.timer); setTimeout(() => lobbies.delete(lb.id), 3600_000); });
  }

  // ---------- what a player sees of a run ----------
  function runView(run, me) {
    const mine = run.heroes.filter((h) => h.player === pid(me)).map((h) => h.id);
    const snap = run.snapshot();
    const a = actionsFor(run);
    const myTurn = a && mine.includes(a.heroId);
    return {
      ...snap, mine, inParty: mine.length > 0, myTurn: !!myTurn, actions: myTurn ? a : null,
      // Where everyone stands is public; the squares you can reach only matter on your turn.
      battle: snap.battle ? { ...snap.battle, reach: myTurn ? snap.battle.reach : [] } : null,
      deadline: myTurn && run.waiting ? run.waiting.since + Number(turnSeconds()) * 1000 : null,
      foes: snap.foes.map((f) => ({ ...f })),
      rooms: snap.rooms.map((r) => ({ ...r, kind: r.visited ? r.kind : r.kind === 'stairs' || r.kind === 'boss' ? r.kind : '?' })),
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.split('/').filter(Boolean);
    try {
      // The page itself, its font and icon, and sprites, are fine to fetch without logging in.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/play')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
        return res.end(fs.readFileSync(path.join(PUBLIC, 'play.html')));
      }
      if (req.method === 'GET' && /^\/fonts\/pixelify-sans-(400|700)\.woff2$/.test(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=604800' });
        return res.end(fs.readFileSync(path.join(PUBLIC, url.pathname)));
      }
      if (req.method === 'GET' && url.pathname === '/icon.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(path.join(PUBLIC, 'icon.png'))); }
      if (req.method === 'GET' && p[0] === 'sprite' && p[1]) {
        const name = decodeURIComponent(p[1]).replace(/\.png$/, '').replace(/ [A-Z]$/, '').toLowerCase();
        const m = MONSTERS['2024'].find((x) => x.n.toLowerCase() === name) || MONSTERS['2014'].find((x) => x.n.toLowerCase() === name);
        if (!m) return send(res, 404, { error: 'No such monster' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
        return res.end(spritePng(m));
      }
      if (p[0] !== 'api') return send(res, 404, { error: 'Not found' });

      // ---------- logging in ----------
      if (p[1] === 'login' && req.method === 'POST') {
        const ip = ipOf(req);
        const recent = (fails.get(ip) || []).filter((t) => Date.now() - t < 10 * 60_000);
        if (recent.length >= 8) return send(res, 429, { error: 'Too many wrong tries. Wait 10 minutes.' });
        const b = await readJson(req);
        const pw = String(password() || ''), tk = String(token() || '');
        const ok = (b.token && tk && same(b.token, tk)) || (b.password && pw && same(b.password, pw));
        if (!ok) { recent.push(Date.now()); fails.set(ip, recent); return send(res, 401, { error: b.token ? 'That join link is old. Ask the GM for the current one.' : 'Wrong password.' }); }
        const sid = crypto.randomBytes(18).toString('base64url');
        sessions.set(sid, { sid, name: cleanName(b.name), at: Date.now() });
        const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || Boolean(req.headers['cf-ray']);
        return send(res, 200, { ok: true, name: cleanName(b.name) }, { 'Set-Cookie': `dt_play=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 3600}${secure ? '; Secure' : ''}` });
      }
      const me = who(req);
      if (!me) return send(res, 401, { error: 'Log in first.', login: true, needsPassword: Boolean(password()) });
      me.at = Date.now();

      if (p[1] === 'me' && req.method === 'POST') { const b = await readJson(req); me.name = cleanName(b.name); return send(res, 200, { name: me.name }); }
      if (p[1] === 'logout' && req.method === 'POST') { sessions.delete(me.sid); return send(res, 200, { ok: true }, { 'Set-Cookie': 'dt_play=; Path=/; Max-Age=0' }); }

      // ---------- home: lobbies and runs ----------
      if (p[1] === 'home' && req.method === 'GET') {
        return send(res, 200, {
          me: { name: me.name }, noteTiger: delve.nt.ok, edition: delve.edition,
          lobbies: [...lobbies.values()].filter((lb) => !lb.runId).map((lb) => lobbyView(lb, me)),
          runs: delve.list().filter((r) => r.state !== 'ended' || Date.now() - r.started < 3 * 3600_000).map((r) => ({
            id: r.id, title: r.title, state: r.state, floor: r.floorN, source: r.source, outcome: r.outcome,
            party: r.heroes.map((h) => `${h.name}${h.playerName ? ` (${h.playerName})` : ''}`), mine: r.heroes.some((h) => h.player === pid(me)),
          })).reverse(),
        });
      }
      if (p[1] === 'lobbies' && !p[2] && req.method === 'POST') {
        const b = await readJson(req);
        const lb = { id: crypto.randomBytes(6).toString('base64url'), host: me.sid, level: Math.max(1, Math.min(10, Number(b.level) || 3)),
          edition: b.edition === '2014' ? '2014' : b.edition === '2024' ? '2024' : delve.edition, party: Math.max(1, Math.min(6, Number(b.party) || 3)), players: [], at: Date.now() };
        lobbies.set(lb.id, lb);
        const pl = { sid: me.sid, name: me.name, hero: null };
        lb.players.push(pl);
        rollHero(lb, pl, b.cls).catch((e) => console.error('[players]', e.message));
        return send(res, 200, lobbyView(lb, me));
      }
      if (p[1] === 'lobbies' && p[2]) {
        const lb = lobbies.get(p[2]);
        if (!lb) return send(res, 404, { error: 'That lobby is gone.' });
        if (req.method === 'GET' && p[3] === 'hero' && p[4]) {
          const h = lb.players[parseInt(p[4], 10)]?.hero;
          if (!h) return send(res, 404, { error: 'No character yet' });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
          return res.end(heroPng(h));
        }
        if (req.method === 'GET') return send(res, 200, lobbyView(lb, me));
        const b = await readJson(req);
        const mine = lb.players.find((x) => x.sid === me.sid);
        const what = p[3];
        if (lb.runId && what !== 'leave') return send(res, 400, { error: 'This run has started.', runId: lb.runId });
        if (what === 'join') {
          if (mine) return send(res, 200, lobbyView(lb, me));
          if (lb.players.length >= 6) return send(res, 400, { error: 'The party is full (6).' });
          const pl = { sid: me.sid, name: me.name, hero: null };
          lb.players.push(pl);
          await rollHero(lb, pl, b.cls);
        } else if (what === 'reroll') {
          if (!mine) return send(res, 400, { error: 'Join first.' });
          if (mine.hero) delve.nt.remove(mine.hero.id);
          await rollHero(lb, mine, b.cls);
        } else if (what === 'leave') {
          if (mine) { lb.players = lb.players.filter((x) => x !== mine); if (mine.hero && !lb.runId) delve.nt.remove(mine.hero.id); }
          if (!lb.players.length && !lb.runId) lobbies.delete(lb.id);
          else if (lb.host === me.sid && lb.players[0]) lb.host = lb.players[0].sid;
        } else if (what === 'start') {
          if (lb.host !== me.sid) return send(res, 403, { error: 'Only the one who opened the lobby can start it.' });
          if (lb.players.some((x) => !x.hero)) return send(res, 400, { error: 'Still rolling a character, one moment.' });
          await startLobby(lb);
          return send(res, 200, { ...lobbyView(lb, me), started: lb.runId });
        } else if (what === 'cancel') {
          if (lb.host !== me.sid) return send(res, 403, { error: 'Only the one who opened the lobby can cancel it.' });
          lb.players.forEach((x) => x.hero && delve.nt.remove(x.hero.id));
          lobbies.delete(lb.id);
          return send(res, 200, { ok: true });
        } else return send(res, 404, { error: 'Unknown' });
        return send(res, 200, lobbies.has(lb.id) ? lobbyView(lb, me) : { gone: true });
      }

      // ---------- playing a run ----------
      if (p[1] === 'runs' && p[2]) {
        const run = delve.get(p[2]);
        if (!run) return send(res, 404, { error: 'That run is over (runs are kept for an hour).' });
        if (req.method === 'GET' && !p[3]) {
          if (url.searchParams.get('v') && Number(url.searchParams.get('v')) === (run.version || 0)) return send(res, 200, { same: true, version: run.version || 0 });
          return send(res, 200, runView(run, me));
        }
        if (req.method === 'GET' && p[3] === 'battle.png') {
          if (!run.combat) return send(res, 404, { error: 'No fight' });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          return res.end(battlePng(run.combat.field, run.heroes, run.combat.monsters, { scale: 2, current: run.current()?.id }));
        }
        if (req.method === 'GET' && p[3] === 'hero' && p[4]) {
          const h = run.hero(decodeURIComponent(p[4]).replace(/\.png$/, ''));
          if (!h) return send(res, 404, { error: 'No such hero' });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
          return res.end(heroPng(h));
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
        const b = await readJson(req);
        const mine = run.heroes.filter((h) => h.player === pid(me));
        if (!mine.length) return send(res, 403, { error: 'You\'re watching this run, not playing in it.' });
        const a = p[3];
        if (a === 'act') {
          const h = run.hero(b.heroId);
          if (!h || h.player !== pid(me)) return send(res, 403, { error: 'That\'s not your character.' });
          const { type, weapon, spell, target, to, at } = b;
          if (!['move', 'attack', 'cast', 'dodge', 'dash', 'disengage', 'potion', 'retreat', 'end'].includes(type)) return send(res, 400, { error: 'Unknown action' });
          if (type === 'cast' && !castable(h).some((s) => s.name === spell)) return send(res, 400, { error: 'You can\'t cast that right now.' });
          run.act(h.id, { type, weapon, spell, target, to, at: Array.isArray(at) ? at.slice(0, 2).map(Number) : undefined }, { keepTurn: true });
        } else if (a === 'auto') {
          if (!run.waiting || !mine.some((h) => h.id === run.waiting.heroId)) return send(res, 400, { error: 'It isn\'t your turn.' });
          run.autoTurn();
        } else if (a === 'go') run.move(String(b.dir));
        else if (a === 'loot') run.loot();
        else if (a === 'rest') run.shortRest();
        else if (a === 'breather') run.breather();
        else if (a === 'down') run.descend();
        else if (a === 'drink') { if (run.state !== 'explore') throw new Error('In a fight, use the Potion button on your turn.'); run.drink(mine.find((h) => !h.dead && h.potions && h.hp < h.maxHp)); }
        else if (a === 'leave') {
          // Hand your character to the game (it plays them from now on).
          mine.forEach((h) => { h.player = null; h.playerName = `${h.playerName} (left)`; });
          if (run.waiting && mine.some((h) => h.id === run.waiting.heroId)) run.autoTurn();
        } else return send(res, 404, { error: 'Unknown action' });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });
  server.on('error', (err) => console.error(`[players] couldn't open port ${port}:`, err.message));
  server.listen(port, '127.0.0.1', () => console.log(`[players] players' site on http://localhost:${port}`));
  // Forget idle logins and old lobbies.
  setInterval(() => {
    for (const [k, s] of sessions) if (Date.now() - s.at > 14 * DAY) sessions.delete(k);
    for (const [k, lb] of lobbies) if (!lb.runId && Date.now() - lb.at > 6 * 3600_000) lobbies.delete(k);
  }, 3600_000).unref();
  return { server, sessionsCount: () => sessions.size };
}
