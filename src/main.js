// Dungeon Delve: starts the GM page and (if a token is set) the Discord bot.
import 'dotenv/config';
import { NoteTiger } from './notetiger.js';
import { Delve } from './delve.js';
import { startWeb } from './web.js';

const env = process.env;
const nt = new NoteTiger({ url: env.NOTE_TIGER_URL, key: env.NOTE_TIGER_KEY, server: env.NOTE_TIGER_SERVER });
const delve = new Delve({ nt, edition: env.EDITION === '2014' ? '2014' : '2024', deleteAfter: env.KEEP_CHARACTERS !== 'true' });

let discord = 'off (no token)';
startWeb({ delve, port: Number(env.PORT) || 3090, lan: env.GM_LAN === 'true', settings: { discord: () => discord } });

const info = await nt.check();
console.log(info ? `[note tiger] connected (${nt.url})` : `[note tiger] not reachable: ${nt.lastError} (the game still works, with stand-in characters)`);

if (env.DISCORD_TOKEN) {
  discord = 'starting';
  const { startBot } = await import('./bot.js');
  const client = startBot({ token: env.DISCORD_TOKEN, delve, turnSeconds: Number(env.TURN_SECONDS) || 120 });
  client.on('clientReady', () => { discord = 'on'; });
  client.on('error', (e) => { discord = `error: ${e.message}`; });
}
