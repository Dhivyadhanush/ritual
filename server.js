import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store, dayKey } from './src/store.js';
import { ReminderEngine } from './src/reminders.js';
import { normalizeConfig } from './src/config.js';
import { sendNtfy } from './src/ntfy.js';
import { motivationFor } from './src/motivation.js';
import { readWeather } from './src/weather.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4322;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const WEATHER_FILE = process.env.WEATHER_STATE_FILE
  ? path.resolve(process.env.WEATHER_STATE_FILE)
  : path.resolve(__dirname, '../weather-ntfy/data/state.json');
const AUTH_HASH = process.env.AUTH_PASSWORD_HASH || '';
const AUTH_USER = process.env.AUTH_USER || process.env.DASHBOARD_USER || (AUTH_HASH ? 'admin' : '');
const AUTH_PASS = process.env.DASHBOARD_PASS || '';
const AUTH_ENABLED = Boolean(AUTH_USER && (AUTH_HASH || AUTH_PASS));
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

const store = new Store(DATA_DIR);
await store.init();
const engine = new ReminderEngine(store, WEATHER_FILE);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const rawUser = params.get('username') ?? '';
  const rawPass = params.get('password') ?? '';

  // Accept the whole "username: … / password: …" lines from the credentials file.
  const userLine = rawUser.split(/\r?\n/).find((l) => /^\s*username\s*:/i.test(l)) ?? rawUser;
  const passLine = rawPass.split(/\r?\n/).find((l) => /^\s*password\s*:/i.test(l)) ?? rawPass;

  return {
    user: userLine.replace(/^\s*username\s*:\s*/i, '').trim(),
    password: passLine.replace(/^\s*password\s*:\s*/i, '').trim(),
    next: safeNext(params.get('next')),
  };
}

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  const sid = parseCookies(req).ritual_session;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...session };
}

function isSecure(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket.encrypted);
}

function sessionCookie(req, sid, maxAge) {
  const parts = [`ritual_session=${sid}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function verifyPassword(password) {
  if (AUTH_HASH) {
    const [scheme, saltB64, hashB64] = AUTH_HASH.split(':');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    try {
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const actual = crypto.scryptSync(password, salt, expected.length);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  if (AUTH_PASS) {
    const a = Buffer.from(password);
    const b = Buffer.from(AUTH_PASS);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}

function clientIp(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function loginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.reset < Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= 8;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.reset < now) {
    loginAttempts.set(ip, { count: 1, reset: now + 15 * 60_000 });
  } else {
    entry.count += 1;
  }
}

function authorized(req) {
  if (!AUTH_ENABLED) return true;
  return Boolean(getSession(req));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function publicConfig() {
  const config = structuredClone(store.config);
  config.ntfy.tokenSet = Boolean(config.ntfy.token);
  config.ntfy.token = '';
  config.watch.tokenSet = Boolean(config.watch.token);
  config.watch.token = '';
  config.security = config.security ?? { actionToken: '' };
  config.security.tokenSet = Boolean(config.security.actionToken);
  config.security.actionToken = '';
  return config;
}

function snapshot() {
  const now = new Date();
  return {
    ok: true,
    config: publicConfig(),
    state: {
      date: store.state.date,
      water: store.state.water,
      habits: { ...store.state.habits },
      streak: store.state.streak,
      bestStreak: store.state.bestStreak,
      watch: store.state.watch,
    },
    summary: store.summary(now),
    motivation: motivationFor(now),
    weather: readWeather(WEATHER_FILE, now.getTime()),
    upcoming: engine.upcoming(now),
    pending: engine.pendingCheckins(now),
    month: store.month(dayKey(now).slice(0, 7), now),
    logs: store.logs.slice(0, 40),
    meta: {
      serverTime: now.toISOString(),
      version: '1.0.0',
      authEnabled: AUTH_ENABLED,
      ntfyConfigured: Boolean(store.config.ntfy.topic),
      dryRun: store.config.ntfy.dryRun,
      watchIngestEnabled: Boolean(store.config.watch.token),
      actionTokenSet: Boolean(store.config.security?.actionToken),
      weatherLinked: Boolean(readWeather(WEATHER_FILE, now.getTime())),
      port: PORT,
    },
  };
}

async function deliver(rem, trigger = 'schedule') {
  const ntfy = store.config.ntfy;
  const payload = {
    ...rem,
    priority: Math.max(rem.priority ?? 3, ntfy.minPriority ?? 0),
  };
  const delivery = await sendNtfy(ntfy, payload);
  engine.markSent(rem, new Date());
  await store.saveState();
  await store.appendLog({
    kind: delivery.ok ? (delivery.dryRun ? 'dry-run' : 'sent') : 'error',
    title: rem.title,
    message: rem.message,
    alerts: rem.kinds ?? [rem.kind],
    delivery,
    trigger,
  });
  return delivery;
}

let ticking = false;
async function tick(trigger = 'schedule') {
  if (ticking) return { ok: true, skipped: true, sent: 0 };
  ticking = true;
  try {
    await store.rollover();
    const due = engine.due(new Date());
    const results = [];
    for (const rem of due) results.push({ title: rem.title, ...(await deliver(rem, trigger)) });
    return { ok: true, sent: results.length, results };
  } finally {
    ticking = false;
  }
}

const timer = setInterval(() => {
  tick('schedule').catch((err) => console.error('[tick]', err));
}, 30_000);

async function serveStatic(req, res, pathname) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden', 'text/plain');

  try {
    const data = await readFile(file);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found', 'text/plain');
  }
}

function habitIds() {
  return store.config.habits.map((h) => h.id);
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function exportCsv() {
  const ids = habitIds();
  const header = [
    'date',
    'water',
    'goal',
    'habits_done',
    'habits_total',
    'complete',
    'steps',
    'sleep_minutes',
    'resting_hr',
    'active_calories',
    ...ids,
  ];
  const rows = [];
  for (const d of store.history) {
    rows.push([
      d.date,
      d.water ?? '',
      d.goal ?? '',
      d.habitsDone ?? '',
      d.habitsTotal ?? '',
      d.complete ? 1 : 0,
      d.steps ?? '',
      d.sleepMinutes ?? '',
      d.restingHr ?? '',
      d.activeCalories ?? '',
      ...ids.map((id) => (d.habits?.[id] ? 1 : 0)),
    ]);
  }
  const today = store.state;
  rows.push([
    today.date,
    today.water,
    store.config.water.goal,
    store.config.habits.filter((h) => h.enabled && today.habits[h.id]).length,
    store.config.habits.filter((h) => h.enabled).length,
    '',
    today.watch?.steps ?? '',
    today.watch?.sleepMinutes ?? '',
    today.watch?.restingHr ?? '',
    today.watch?.activeCalories ?? '',
    ...ids.map((id) => (today.habits[id] ? 1 : 0)),
  ]);
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
}

/** Notification action links carry ?t=…; no token configured means open (LAN only). */
function actionAuthorized(req, url) {
  const token = store.config.security?.actionToken;
  if (!token) return true;
  const supplied = url.searchParams.get('t') ?? req.headers['x-action-token'];
  return supplied === token;
}

async function handleWater(res, url) {
  const delta = Number(url.searchParams.get('delta') ?? 1);
  const water = await store.addWater(Number.isFinite(delta) ? delta : 1);
  const goal = store.config.water.goal;

  if (water === goal) {
    const key = `${dayKey()}:goal`;
    if (!store.state.sent[key]) {
      store.state.sent[key] = new Date().toISOString();
      await deliver(
        {
          kind: 'goal',
          title: `💧 ${goal} of ${goal}. Goal done.`,
          message: 'That is the whole target. Anything after this is a bonus — well played.',
          tags: ['tada', 'droplet'],
          priority: 3,
        },
        'goal',
      );
    }
  }
  return sendJson(res, 200, { ok: true, water, goal, snapshot: snapshot() });
}

async function handleCheckin(req, res, url) {
  const id = url.searchParams.get('id') ?? '';
  const doneRaw = url.searchParams.get('done');
  const date = url.searchParams.get('date') ?? dayKey();
  if (doneRaw === null) return sendJson(res, 400, { ok: false, error: 'Missing done=1|0' });
  const done = doneRaw === '1' || doneRaw === 'true';
  const saved = await store.setHabit(id, done, date);
  if (!saved) return sendJson(res, 404, { ok: false, error: 'Unknown habit or date' });

  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  if (wantsHtml) {
    const label = store.config.habits.find((h) => h.id === id)?.label ?? id;
    return sendText(
      res,
      200,
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0b101c;color:#eef2ff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px">${done ? '✅' : '📝'}</div><h2>${done ? 'Ticked' : 'Recorded'}</h2><p style="color:#8d97b2">${label} · ${date}</p></div></body>`,
    );
  }
  return sendJson(res, 200, { ok: true, id, done, date, snapshot: snapshot() });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    const isActionPath = pathname.startsWith('/a/');

    // ---- public routes (no session required) ----

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === 'GET' && (pathname === '/login' || pathname === '/login.html')) {
      if (!AUTH_ENABLED || authorized(req)) return redirect(res, '/');
      try {
        const html = await readFile(path.join(PUBLIC_DIR, 'login.html'), 'utf8');
        const user = AUTH_USER.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html.replaceAll('{{USERNAME}}', user));
      } catch {
        return sendText(res, 500, 'Login page missing', 'text/plain');
      }
    }

    if (req.method === 'POST' && pathname === '/login') {
      if (!AUTH_ENABLED) return redirect(res, '/');
      const ip = clientIp(req);
      if (loginBlocked(ip)) return redirect(res, '/login?error=rate');
      const form = await readForm(req);
      if (form.user !== AUTH_USER || !verifyPassword(form.password)) {
        noteLoginFailure(ip);
        return redirect(res, `/login?error=1&next=${encodeURIComponent(form.next)}`);
      }
      loginAttempts.delete(ip);
      const sid = crypto.randomBytes(32).toString('base64url');
      sessions.set(sid, { expires: Date.now() + SESSION_TTL_MS, user: AUTH_USER });
      res.writeHead(302, {
        Location: form.next,
        'Set-Cookie': sessionCookie(req, sid, Math.floor(SESSION_TTL_MS / 1000)),
        'Cache-Control': 'no-store',
      });
      return res.end();
    }

    if (req.method === 'POST' && pathname === '/logout') {
      const session = getSession(req);
      if (session) sessions.delete(session.sid);
      res.writeHead(302, {
        Location: '/login',
        'Set-Cookie': sessionCookie(req, '', 0),
        'Cache-Control': 'no-store',
      });
      return res.end();
    }

    // ---- auth gate ----

    // /a/* is token-protected (notification buttons) and intentionally bypasses login.
    if (isActionPath && !actionAuthorized(req, url)) {
      return sendJson(res, 401, { ok: false, error: 'Bad action token' });
    }

    const publicAsset = pathname === '/icon.svg';
    if (!isActionPath && !publicAsset && !pathname.startsWith('/api/') && !authorized(req)) {
      const next = encodeURIComponent(pathname + url.search);
      return redirect(res, `/login?next=${next}`);
    }
    if (!isActionPath && !publicAsset && pathname.startsWith('/api/') && !authorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Login required' });
    }

    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      return sendJson(res, 200, snapshot());
    }

    if (req.method === 'PUT' && pathname === '/api/config') {
      const body = await readBody(req);
      const incoming = body.config ?? body;
      // Empty token fields mean "keep what is stored", not "clear it".
      if (incoming.ntfy && !incoming.ntfy.token && store.config.ntfy.token) {
        incoming.ntfy.token = store.config.ntfy.token;
      }
      if (incoming.watch && !incoming.watch.token && store.config.watch.token) {
        incoming.watch.token = store.config.watch.token;
      }
      if (incoming.security && !incoming.security.actionToken && store.config.security?.actionToken) {
        incoming.security.actionToken = store.config.security.actionToken;
      }
      store.config = normalizeConfig(incoming, store.config);
      await store.saveConfig();
      await store.appendLog({ kind: 'config', title: 'Settings updated', message: 'Dashboard saved new settings.', trigger: 'manual' });
      return sendJson(res, 200, snapshot());
    }

    if (
      (req.method === 'POST' || req.method === 'GET') &&
      (pathname === '/api/water' || pathname === '/a/water')
    ) {
      return handleWater(res, url);
    }

    if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/habit') {
      const body = await readBody(req);
      const done = Boolean(body.done);
      const date = typeof body.date === 'string' ? body.date : dayKey();
      const saved = await store.setHabit(String(body.id ?? ''), done, date);
      if (!saved) return sendJson(res, 404, { ok: false, error: 'Unknown habit' });
      return sendJson(res, 200, { ok: true, snapshot: snapshot() });
    }

    if (
      (req.method === 'POST' || req.method === 'GET') &&
      (pathname === '/api/checkin' || pathname === '/a/checkin')
    ) {
      return handleCheckin(req, res, url);
    }

    if (req.method === 'POST' && pathname === '/api/watch') {
      const token = store.config.watch.token;
      if (token) {
        const supplied = req.headers['x-watch-token'] ?? url.searchParams.get('token');
        if (supplied !== token) return sendJson(res, 401, { ok: false, error: 'Bad watch token' });
      }
      const body = await readBody(req);
      const metrics = {
        steps: body.steps != null ? Math.max(0, Math.round(Number(body.steps))) : null,
        sleepMinutes: body.sleepMinutes != null ? Math.max(0, Math.round(Number(body.sleepMinutes))) : null,
        restingHr: body.restingHr != null ? Math.max(0, Math.round(Number(body.restingHr))) : null,
        activeCalories: body.activeCalories != null ? Math.max(0, Math.round(Number(body.activeCalories))) : null,
      };
      const watch = await store.recordWatch(metrics);
      await store.appendLog({
        kind: 'watch',
        title: 'Watch data received',
        message: `steps=${watch.steps ?? '—'} sleep=${watch.sleepMinutes ?? '—'}m hr=${watch.restingHr ?? '—'}`,
        trigger: 'watch',
      });
      return sendJson(res, 200, { ok: true, watch });
    }

    if (req.method === 'POST' && pathname === '/api/check') {
      const result = await tick('manual');
      return sendJson(res, 200, { ...result, snapshot: snapshot() });
    }

    if (req.method === 'POST' && pathname === '/api/test') {
      const delivery = await deliver(
        {
          kind: 'test',
          title: '🔔 Health reminder test',
          message: `If this lands on your phone, the watch is one mirror-toggle away.\nDry run: ${store.config.ntfy.dryRun ? 'on' : 'off'} · ${new Date().toLocaleTimeString('en-IN')}`,
          tags: ['bell'],
          priority: Math.max(3, store.config.ntfy.minPriority ?? 0),
        },
        'test',
      );
      return sendJson(res, 200, { ok: delivery.ok, delivery, snapshot: snapshot() });
    }

    if (req.method === 'GET' && pathname === '/api/month') {
      const month = url.searchParams.get('month') ?? dayKey().slice(0, 7);
      return sendJson(res, 200, { ok: true, ...store.month(month) });
    }

    if (req.method === 'GET' && pathname === '/api/history') {
      const days = Math.min(730, Math.max(1, Number(url.searchParams.get('days') ?? 60)));
      return sendJson(res, 200, { ok: true, history: store.history.slice(-days) });
    }

    if (req.method === 'GET' && pathname === '/api/export.csv') {
      const csv = exportCsv();
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="health-${dayKey()}.csv"`,
      });
      return res.end(csv);
    }

    if (req.method === 'DELETE' && pathname === '/api/logs') {
      await store.clearLogs();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });

    return serveStatic(req, res, pathname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, 400, { ok: false, error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`health-reminder listening on http://${HOST}:${PORT}`);
  console.log(`data: ${DATA_DIR}`);
  console.log(`ntfy: ${store.config.ntfy.server}/${store.config.ntfy.topic || '<set a topic>'}`);
  console.log(`dry run: ${store.config.ntfy.dryRun ? 'on' : 'off'}`);
  console.log(`login: ${AUTH_ENABLED ? `enabled (${AUTH_USER})` : 'disabled'}`);
});

function shutdown() {
  clearInterval(timer);
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
