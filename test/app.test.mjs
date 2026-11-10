import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReminderEngine } from '../src/reminders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4450 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let dir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(pathname, options) {
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json();
  return { status: res.status, body };
}

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
  throw new Error('server did not start');
}

test.before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ritual-test-'));
  const cleanEnv = { ...process.env };
  for (const key of [
    'NTFY_URL',
    'NTFY_TOPIC',
    'NTFY_TOKEN',
    'NTFY_MIN_PRIORITY',
    'HEALTH_BASE_URL',
    'HEALTH_NAME',
    'ACTION_TOKEN',
    'AUTH_USER',
    'AUTH_PASSWORD_HASH',
    'DASHBOARD_USER',
    'DASHBOARD_PASS',
    'WEATHER_STATE_FILE',
  ]) {
    delete cleanEnv[key];
  }

  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...cleanEnv, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, NTFY_DRY_RUN: 'true' },
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

test('bootstrap has the expected shape', async () => {
  const { status, body } = await json('/api/bootstrap');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.state.date.match(/^\d{4}-\d{2}-\d{2}$/));
  assert.ok(Array.isArray(body.month.days));
  assert.ok(body.month.days.length >= 28);
  assert.ok(Array.isArray(body.config.habits));
  assert.equal(body.meta.dryRun, true);
});

test('water logging updates state and the ring data', async () => {
  const { body } = await json('/api/water?delta=2', { method: 'POST' });
  assert.equal(body.ok, true);
  assert.equal(body.water, 2);
  const boot = await json('/api/bootstrap');
  assert.equal(boot.body.state.water, 2);
});

test('a check-in is recorded for that exact date', async () => {
  const boot = await json('/api/bootstrap');
  const date = boot.body.state.date;
  const res = await json(`/api/checkin?id=no-fap&done=1&date=${date}`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshot.state.habits['no-fap'], true);

  const month = await json(`/api/month?month=${date.slice(0, 7)}`);
  const day = month.body.days.find((d) => d.date === date);
  assert.equal(day.habits['no-fap'], true);
});

test('monthly backfill edits a past day', async () => {
  const past = '2026-10-15';
  const res = await json('/api/habit', {
    method: 'PUT',
    body: JSON.stringify({ id: 'no-fap', done: true, date: past }),
  });
  assert.equal(res.body.ok, true);
  const month = await json('/api/month?month=2026-10');
  const day = month.body.days.find((d) => d.date === past);
  assert.equal(day.habits['no-fap'], true);
});

test('watch ingest accepts metrics and enforces the token', async () => {
  const boot = await json('/api/bootstrap');
  const cfg = boot.body.config;
  cfg.watch = { token: 'secret-watch' };
  const saved = await json('/api/config', { method: 'PUT', body: JSON.stringify(cfg) });
  assert.equal(saved.body.config.watch.tokenSet, true);

  const denied = await json('/api/watch', {
    method: 'POST',
    body: JSON.stringify({ steps: 10 }),
  });
  assert.equal(denied.status, 401);

  const ok = await json('/api/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Watch-Token': 'secret-watch' },
    body: JSON.stringify({ steps: 6412, sleepMinutes: 402, restingHr: 54, activeCalories: 380 }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.watch.steps, 6412);

  const after = await json('/api/bootstrap');
  assert.equal(after.body.state.watch.sleepMinutes, 402);
  assert.equal(after.body.meta.watchIngestEnabled, true);
});

test('dry-run test notification is logged, not sent', async () => {
  const res = await json('/api/test', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery.dryRun, true);
  assert.equal(res.body.delivery.ok, true);
  const boot = await json('/api/bootstrap');
  assert.ok(boot.body.logs.some((l) => l.kind === 'dry-run'));
});

test('CSV export contains today and the habit columns', async () => {
  const res = await fetch(`${BASE}/api/export.csv`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text.split('\n')[0], /^date,water,goal,habits_done/);
  assert.ok(text.includes('no-fap'));
  assert.ok(text.split('\n').length >= 2);
});

test('token-protected notification actions work and /api stays dashboard-only', async () => {
  const saved = await json('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ security: { actionToken: 'secret-action' } }),
  });
  assert.equal(saved.body.meta.actionTokenSet, true);
  assert.equal(saved.body.config.security.actionToken, '');
  assert.equal(saved.body.config.security.tokenSet, true);

  const denied = await json('/a/water?delta=1');
  assert.equal(denied.status, 401);

  const ok = await json('/a/water?delta=1&t=secret-action', { method: 'POST' });
  assert.equal(ok.status, 200);

  const dash = await json('/api/water?delta=1', { method: 'POST' });
  assert.equal(dash.status, 200);

  const boot = await json('/api/bootstrap');
  const date = boot.body.state.date;
  const bad = await json(`/a/checkin?id=no-fap&done=1&date=${date}&t=wrong`);
  assert.equal(bad.status, 401);
  const good = await json(`/a/checkin?id=no-fap&done=1&date=${date}&t=secret-action`, { method: 'POST' });
  assert.equal(good.status, 200);
  assert.equal(good.body.done, true);
});

test('notification actions use /a/ and carry the action token', () => {
  const engine = new ReminderEngine(
    {
      config: {
        ntfy: { baseUrl: 'https://ritual.example' },
        security: { actionToken: 's3cret' },
      },
      state: {},
    },
    null,
  );
  const checkin = engine.buildCheckin({ id: 'no-fap', emoji: '🚫', label: 'No Fap' }, new Date());
  assert.match(checkin.actions[0].url, /^https:\/\/ritual\.example\/a\/checkin\?/);
  assert.match(checkin.actions[0].url, /[?&]t=s3cret/);
  const water = engine.actionsFor(new Date(), true);
  assert.match(water[1].url, /\/a\/water\?delta=1&t=s3cret$/);
});

test('unknown endpoints and habits fail cleanly', async () => {
  const missing = await json('/api/nope');
  assert.equal(missing.status, 404);
  const badHabit = await json('/api/habit', {
    method: 'PUT',
    body: JSON.stringify({ id: 'not-a-habit', done: true }),
  });
  assert.equal(badHabit.status, 404);
});
