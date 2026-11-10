import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4650 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct-horse-battery';
const ACTION = 'action-secret';

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(PASSWORD, salt, 32);
const HASH = `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;

let proc;
let dir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('auth test server did not start');
}

function post(pathname, fields, cookie) {
  return fetch(BASE + pathname, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

test.before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ritual-auth-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      NTFY_DRY_RUN: 'true',
      AUTH_USER: 'tester',
      AUTH_PASSWORD_HASH: HASH,
      ACTION_TOKEN: ACTION,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitForServer();
});

test.after(async () => {
  proc?.kill('SIGTERM');
  await sleep(150);
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('login page is public and API is not', async () => {
  const root = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.match(root.headers.get('location'), /^\/login\?next=/);

  const page = await fetch(`${BASE}/login`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Sign in/);
  assert.match(html, /value="tester"/);
  assert.match(html, /togglePassword/);

  const health = await fetch(`${BASE}/api/health`);
  assert.equal(health.status, 200);

  const api = await fetch(`${BASE}/api/bootstrap`);
  assert.equal(api.status, 401);

  const css = await fetch(`${BASE}/styles.css`, { redirect: 'manual' });
  assert.equal(css.status, 302);
});

test('bad password is rejected and rate-limit-safe', async () => {
  const res = await post('/login', { username: 'tester', password: 'wrong', next: '/' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\?error=1/);
});

test('correct password creates a session that unlocks the app', async () => {
  const res = await post('/login', { username: 'tester', password: PASSWORD, next: '/' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const setCookie = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  assert.match(setCookie, /ritual_session=/);
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(';')[0];

  const api = await fetch(`${BASE}/api/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(api.status, 200);
  const body = await api.json();
  assert.equal(body.meta.authEnabled, true);

  const css = await fetch(`${BASE}/styles.css`, { headers: { Cookie: cookie } });
  assert.equal(css.status, 200);

  const loginAgain = await fetch(`${BASE}/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(loginAgain.status, 302);
  assert.equal(loginAgain.headers.get('location'), '/');

  // Pasting the whole "username: … / password: …" lines also works.
  const pasted = await post('/login', {
    username: 'username: tester',
    password: `password: ${PASSWORD}`,
    next: '/',
  });
  assert.equal(pasted.status, 302);
  assert.equal(pasted.headers.get('location'), '/');

  // Action buttons bypass the login but still need the action token.
  const noToken = await fetch(`${BASE}/a/water?delta=0`, { method: 'POST' });
  assert.equal(noToken.status, 401);
  const withToken = await fetch(`${BASE}/a/water?delta=0&t=${ACTION}`, { method: 'POST' });
  assert.equal(withToken.status, 200);

  const logout = await post('/logout', {}, cookie);
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), '/login');

  const after = await fetch(`${BASE}/api/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});
