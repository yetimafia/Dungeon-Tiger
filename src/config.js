// Settings live in .env next to the app (app\.env when installed). The settings page reads and writes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = path.join(APP_DIR, '.env');
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
export const UPDATE_REPO = 'yetimafia/Dungeon-Tiger';

const lines = (file) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; } };
export function readEnv(file = ENV_FILE) {
  const out = {};
  for (const line of lines(file)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) out[m[1]] = m[2].trim(); }
  return out;
}
export function writeEnv(changes, file = ENV_FILE) {
  const done = new Set();
  const updated = lines(file).map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && m[1] in changes) { done.add(m[1]); return `${m[1]}=${changes[m[1]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(changes)) if (!done.has(k)) updated.push(`${k}=${v}`);
  fs.writeFileSync(file, updated.join('\n').replace(/^\n+/, ''));
}
// Settings with their defaults. Secret ones are never sent back to the page.
export const SETTINGS = [
  { key: 'DISCORD_TOKEN', secret: true, def: '' },
  { key: 'NOTE_TIGER_URL', def: 'http://localhost:3081/v1' },
  { key: 'NOTE_TIGER_KEY', secret: true, def: '' },
  { key: 'NOTE_TIGER_SERVER', def: '' },
  { key: 'EDITION', def: '2024' },
  { key: 'TURN_SECONDS', def: '120' },
  { key: 'KEEP_CHARACTERS', def: 'false' },
  { key: 'PORT', def: '3090' },
  { key: 'GM_LAN', def: 'false' },
  { key: 'UPDATE_CHECK', def: 'true' },
];
export function settings() {
  const env = readEnv();
  return Object.fromEntries(SETTINGS.map((s) => [s.key, env[s.key] ?? s.def]));
}

// Note Tiger on this same PC: its settings file has the connection key and port.
const NT_ENV = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Note Tiger', 'app', '.env');
export function findNoteTiger() {
  if (!fs.existsSync(NT_ENV)) return { found: false };
  const env = readEnv(NT_ENV);
  return { found: true, key: env.CONNECT_KEY || '', port: Number(env.CONNECT_PORT || 3081), enabled: env.CONNECT_ENABLED === 'true' && Boolean(env.CONNECT_KEY) };
}
// Turns on Note Tiger's connection (it reads its settings fresh, so no restart is needed) and copies the key here.
export function linkNoteTiger() {
  const nt = findNoteTiger();
  if (!nt.found) throw new Error('Note Tiger isn\'t installed on this PC. Paste its key and address by hand instead.');
  let key = nt.key;
  if (!key) key = crypto.randomBytes(24).toString('base64url');
  writeEnv({ CONNECT_ENABLED: 'true', CONNECT_KEY: key }, NT_ENV);
  writeEnv({ NOTE_TIGER_KEY: key, NOTE_TIGER_URL: `http://localhost:${nt.port}/v1` });
  return { key, port: nt.port };
}
