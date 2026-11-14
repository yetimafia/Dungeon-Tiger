// Puts the players' website online without opening ports on your router: a free Cloudflare "quick tunnel"
// (cloudflared). The first time, cloudflared is downloaded from Cloudflare's official GitHub releases.
// Each time it starts you get a new https://….trycloudflare.com address (Note Tiger's site is updated with it).
// The join code stays the same until Dungeon Tiger restarts or you press New link.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { APP_DIR } from './config.js';

const BIN_DIR = path.join(APP_DIR, 'bin');
const ASSET = process.platform === 'win32' ? 'cloudflared-windows-amd64.exe' : process.platform === 'darwin' ? null : 'cloudflared-linux-amd64';
const BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

export class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.state = 'off'; this.url = ''; this.token = crypto.randomBytes(16).toString('base64url'); this.error = ''; this.child = null; this.wanted = false; this.port = 3091; this.tries = 0;
  }
  status() { return { state: this.state, url: this.url, token: this.token, error: this.error, joinLink: this.url && this.token ? `${this.url}/#t=${this.token}` : '' }; }
  set(state, extra = {}) { Object.assign(this, { state, ...extra }); this.emit('change', this.status()); }

  async download() {
    if (fs.existsSync(BIN)) return;
    if (!ASSET) throw new Error('Going online works on Windows and Linux.');
    this.set('downloading');
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${ASSET}`, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`Couldn't download cloudflared (${res.status}).`);
    const tmp = `${BIN}.part`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    if (fs.statSync(tmp).size < 5e6) throw new Error('The cloudflared download looks broken; try again.');
    fs.renameSync(tmp, BIN);
    if (process.platform !== 'win32') fs.chmodSync(BIN, 0o755);
  }

  async start(port) {
    this.wanted = true; this.port = port || this.port;
    if (this.child) return this.status();
    try {
      await this.download();
    } catch (err) { this.set('error', { error: err.message }); return this.status(); }
    if (!this.wanted) return this.status();
    this.set('starting', { url: '', error: '' });
    const child = spawn(BIN, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let seen = '';
    const onData = (buf) => {
      seen = (seen + buf.toString()).slice(-4000);
      const m = seen.match(/https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
      if (m && this.state !== 'online' && this.child === child) { this.tries = 0; this.set('online', { url: m[0] }); console.log(`[online] players' site: ${m[0]}`); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timeout = setTimeout(() => { if (this.child === child && this.state !== 'online') { this.set('error', { error: 'Cloudflare didn\'t answer. Check the internet connection, then try again.' }); child.kill(); } }, 60_000);
    child.on('error', (err) => { clearTimeout(timeout); if (this.child === child) { this.child = null; this.set('error', { error: err.message }); } });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) return this.set('off', { url: '' });
      // Dropped: try again a few times, waiting a bit longer each time.
      this.tries++;
      if (this.tries > 5) return this.set('error', { error: `The tunnel keeps stopping (code ${code}).`, url: '' });
      this.set('starting', { url: '' });
      setTimeout(() => { if (this.wanted) this.start(); }, 5000 * this.tries);
    });
    return this.status();
  }
  stop() {
    this.wanted = false;
    if (this.child) { this.child.kill(); this.child = null; }
    this.set('off', { url: '', error: '' });
    return this.status();
  }
  // A new join code: links shared before stop working.
  newToken() { this.token = crypto.randomBytes(16).toString('base64url'); this.set(this.state); return this.status(); }
}
