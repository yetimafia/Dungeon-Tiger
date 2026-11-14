// Dungeon Tiger: starts the GM page and (if a token is set) the Discord bot. Settings changed on the page take effect
// right away: the Note Tiger link and rules at once, the bot restarts if its token changed.
import { NoteTiger } from './notetiger.js';
import { Delve } from './delve.js';
import { startWeb } from './web.js';
import { settings, findNoteTiger, linkNoteTiger, VERSION } from './config.js';
import { startUpdateChecks } from './updater.js';
import { startPlayers } from './players.js';
import { Tunnel } from './tunnel.js';

console.log(`[dungeon tiger] ${VERSION} starting`);
let s = settings();

// Installed copy on the same PC as Note Tiger, and no key yet: link them up by itself.
if (!s.NOTE_TIGER_KEY) {
  const nt = findNoteTiger();
  if (nt.found && nt.enabled) { try { linkNoteTiger(); s = settings(); console.log('[note tiger] found it on this PC and linked up'); } catch { /* fine */ } }
}

const nt = new NoteTiger({ url: s.NOTE_TIGER_URL, key: s.NOTE_TIGER_KEY, server: s.NOTE_TIGER_SERVER });
const delve = new Delve({ nt, edition: s.EDITION === '2014' ? '2014' : '2024', deleteAfter: s.KEEP_CHARACTERS !== 'true' });

const bot = { client: null, state: 'off', error: '', token: '' };
async function startDiscord(token) {
  if (bot.client) { try { await bot.client.destroy(); } catch { /* gone */ } bot.client = null; }
  bot.token = token;
  if (!token) { bot.state = 'off'; bot.error = ''; return; }
  bot.state = 'starting'; bot.error = '';
  const { startBot } = await import('./bot.js');
  const client = startBot({ token, delve, turnSeconds: () => settings().TURN_SECONDS });
  bot.client = client;
  client.on('clientReady', () => { if (bot.client === client) { bot.state = 'on'; bot.name = client.user.tag; } });
  client.on('error', (e) => { if (bot.client === client) { bot.state = 'error'; bot.error = e.message; } });
  client.on('invalidated', () => { if (bot.client === client) { bot.state = 'error'; bot.error = 'Discord logged the bot out.'; } });
  setTimeout(() => { if (bot.client === client && bot.state === 'starting') { bot.state = 'error'; bot.error = bot.error || 'Couldn\'t log in. Check the bot token.'; } }, 30_000);
}

// Called after the settings page saves.
async function apply() {
  const now = settings();
  Object.assign(nt, { url: (now.NOTE_TIGER_URL || 'http://localhost:3081/v1').replace(/\/+$/, ''), key: now.NOTE_TIGER_KEY, server: now.NOTE_TIGER_SERVER, ok: false });
  delve.edition = now.EDITION === '2014' ? '2014' : '2024';
  delve.deleteAfter = now.KEEP_CHARACTERS !== 'true';
  await nt.check();
  if (now.DISCORD_TOKEN !== bot.token) await startDiscord(now.DISCORD_TOKEN);
  return now;
}

// The players' website (localhost only; the tunnel puts it online).
const tunnel = new Tunnel();
const players = startPlayers({
  delve, port: Number(s.PLAYER_PORT) || 3091,
  password: () => settings().PLAYER_PASSWORD, token: () => tunnel.token, turnSeconds: () => settings().TURN_SECONDS,
});
const online = { publish: { state: 'off', error: '', siteUrl: '' } };
async function publishLink() {
  const st = tunnel.status();
  if (!nt.ok && !(await nt.check())) { online.publish = { state: 'off', error: 'Note Tiger isn\'t connected, so share the join link yourself.', siteUrl: '' }; return; }
  try {
    online.publish = { state: 'sending', error: '', siteUrl: '' };
    const r = await nt.publishLive(st.state === 'online' ? { url: st.url, token: st.token, title: 'Dungeon Tiger' } : { offline: true });
    online.publish = { state: st.state === 'online' ? 'published' : 'off', error: '', siteUrl: r.siteUrl || '' };
  } catch (err) { online.publish = { state: 'failed', error: err.message, siteUrl: '' }; }
}
tunnel.on('change', (st) => { if (st.state === 'online' || st.state === 'off') publishLink(); });
online.status = () => ({ ...tunnel.status(), publish: online.publish, players: players.sessionsCount(), passwordSet: Boolean(settings().PLAYER_PASSWORD), port: Number(settings().PLAYER_PORT) || 3091 });
online.start = async () => { await tunnel.start(Number(settings().PLAYER_PORT) || 3091); return online.status(); };
online.stop = () => { tunnel.stop(); return online.status(); };
online.newLink = () => { tunnel.newToken(); if (tunnel.state === 'online') publishLink(); return online.status(); };
if (s.PLAYER_ONLINE === 'true') online.start();

startWeb({
  delve, port: Number(s.PORT) || 3090, lan: s.GM_LAN === 'true',
  app: {
    apply,
    discord: () => ({ state: bot.state, error: bot.error, name: bot.name || '' }),
    stop: async () => { tunnel.stop(); if (bot.client) await bot.client.destroy().catch(() => {}); setTimeout(() => process.exit(0), 200); },
    online,
  },
});
startUpdateChecks();

// Paint every monster's 256×256 sprite in the background (once; they're kept on disk after that).
{
  const { MONSTERS } = await import('./dungeon.js');
  const { spritePng } = await import('./sprites.js');
  const todo = [...new Map([...MONSTERS['2024'], ...MONSTERS['2014']].map((m) => [m.n, m])).values()];
  const step = () => { const m = todo.shift(); if (!m) return; try { spritePng(m); } catch (err) { console.error('[sprites]', m.n, err.message); } setTimeout(step, 20); };
  setTimeout(step, 5000);
}

const info = await nt.check();
console.log(info ? `[note tiger] connected (${nt.url})` : `[note tiger] not reachable: ${nt.lastError} (the game still works, with stand-in characters)`);
startDiscord(s.DISCORD_TOKEN);
process.on('unhandledRejection', (err) => console.error('[error]', err?.message || err));
