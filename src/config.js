export const DEFAULT_CONFIG = {
  profile: { name: 'there' },
  ntfy: {
    server: 'https://ntfy.sh',
    topic: '',
    token: '',
    dryRun: true,
    minPriority: 3,
    // Reachable address of this dashboard (e.g. http://your-host:4322).
    // Only needed for the "+1 glass" button inside the notification.
    baseUrl: '',
  },
  day: { wake: '07:00', sleep: '22:30' },
  water: {
    enabled: true,
    goal: 8,
    glassMl: 250,
    intervalMinutes: 60,
    start: '08:00',
    end: '21:30',
  },
  movement: {
    enabled: true,
    intervalMinutes: 90,
    start: '09:00',
    end: '20:30',
    stepGoal: 8000,
  },
  motivation: { enabled: true, time: '08:00' },
  recap: { enabled: true, time: '21:15' },
  habits: [
    { id: 'sunlight', emoji: '🌞', label: '10 minutes of morning light', time: '08:15', enabled: true, checkin: false },
    { id: 'stretch', emoji: '🧘', label: 'Stretch for 5 minutes', time: '11:00', enabled: true, checkin: false },
    { id: 'walk', emoji: '🚶', label: 'Walk after lunch', time: '14:00', enabled: true, checkin: false },
    { id: 'veggies', emoji: '🥗', label: 'Eat something green', time: '13:30', enabled: true, checkin: false },
    { id: 'posture', emoji: '🪑', label: 'Stand up and reset posture', time: '16:30', enabled: true, checkin: false },
    { id: 'screens', emoji: '📵', label: 'Screens off, wind down', time: '22:00', enabled: true, checkin: false },
    { id: 'no-fap', emoji: '🚫', label: 'No Fap', time: '21:00', enabled: true, checkin: true },
  ],
  watch: { token: '' },
  security: { actionToken: '' },
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function str(value, fallback, maxLength = 300) {
  if (typeof value !== 'string') return fallback;
  const t = value.trim();
  return t ? t.slice(0, maxLength) : fallback;
}

/** "7:05" / "07:05" -> "07:05"; returns fallback for anything invalid. */
export function normalizeTime(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function timeToMinutes(value, fallback = 0) {
  const t = normalizeTime(value, null);
  if (!t) return fallback;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function cleanTopic(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^\/+/, '').replace(/\s+/g, '-').slice(0, 64);
}

function cleanServer(value, fallback) {
  const server = str(value, fallback, 300).replace(/\/+$/, '');
  return /^https?:\/\//i.test(server) ? server : fallback;
}

function cleanBaseUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const url = value.trim().replace(/\/+$/, '');
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url.slice(0, 300) : '';
}

function cleanHabits(input, prev) {
  if (!Array.isArray(input)) return prev;
  return input
    .slice(0, 12)
    .map((h, i) => {
      if (!h || typeof h !== 'object') return null;
      const id = str(h.id, `habit-${i}`, 40).replace(/[^a-z0-9-]/gi, '');
      return {
        id: id || `habit-${i}`,
        emoji: str(h.emoji, '✅', 8),
        label: str(h.label, 'Healthy habit', 80),
        time: normalizeTime(h.time, '09:00'),
        enabled: bool(h.enabled, true),
        checkin: bool(h.checkin, false),
      };
    })
    .filter(Boolean);
}

/** Merges an untrusted payload onto the current config, clamping everything. */
export function normalizeConfig(input, prev = DEFAULT_CONFIG) {
  const base = structuredClone(prev);
  const src = input && typeof input === 'object' ? input : {};

  if (src.profile && typeof src.profile === 'object') {
    base.profile = { name: str(src.profile.name, base.profile.name, 40) };
  }

  if (src.ntfy && typeof src.ntfy === 'object') {
    const n = src.ntfy;
    base.ntfy = {
      server: cleanServer(n.server, base.ntfy.server),
      topic: cleanTopic(n.topic ?? base.ntfy.topic),
      token: typeof n.token === 'string' ? n.token.trim().slice(0, 500) : base.ntfy.token,
      dryRun: bool(n.dryRun, base.ntfy.dryRun),
      minPriority: Math.round(num(n.minPriority, base.ntfy.minPriority, 0, 5)),
      baseUrl: cleanBaseUrl(n.baseUrl, base.ntfy.baseUrl),
    };
  }

  if (src.day && typeof src.day === 'object') {
    base.day = {
      wake: normalizeTime(src.day.wake, base.day.wake),
      sleep: normalizeTime(src.day.sleep, base.day.sleep),
    };
  }

  if (src.water && typeof src.water === 'object') {
    const w = src.water;
    base.water = {
      enabled: bool(w.enabled, base.water.enabled),
      goal: Math.round(num(w.goal, base.water.goal, 1, 30)),
      glassMl: Math.round(num(w.glassMl, base.water.glassMl, 100, 1000)),
      intervalMinutes: Math.round(num(w.intervalMinutes, base.water.intervalMinutes, 10, 360)),
      start: normalizeTime(w.start, base.water.start),
      end: normalizeTime(w.end, base.water.end),
    };
  }

  if (src.movement && typeof src.movement === 'object') {
    const m = src.movement;
    base.movement = {
      enabled: bool(m.enabled, base.movement.enabled),
      intervalMinutes: Math.round(num(m.intervalMinutes, base.movement.intervalMinutes, 10, 360)),
      start: normalizeTime(m.start, base.movement.start),
      end: normalizeTime(m.end, base.movement.end),
      stepGoal: Math.round(num(m.stepGoal, base.movement.stepGoal, 1000, 50000)),
    };
  }

  if (src.motivation && typeof src.motivation === 'object') {
    base.motivation = {
      enabled: bool(src.motivation.enabled, base.motivation.enabled),
      time: normalizeTime(src.motivation.time, base.motivation.time),
    };
  }

  if (src.recap && typeof src.recap === 'object') {
    base.recap = {
      enabled: bool(src.recap.enabled, base.recap.enabled),
      time: normalizeTime(src.recap.time, base.recap.time),
    };
  }

  if (src.habits !== undefined) base.habits = cleanHabits(src.habits, base.habits);

  if (src.watch && typeof src.watch === 'object') {
    base.watch = {
      token: typeof src.watch.token === 'string' ? src.watch.token.trim().slice(0, 500) : base.watch.token,
    };
  }

  if (!base.security) base.security = { actionToken: '' };
  if (src.security && typeof src.security === 'object') {
    base.security = {
      actionToken:
        typeof src.security.actionToken === 'string'
          ? src.security.actionToken.trim().slice(0, 200)
          : base.security.actionToken,
    };
  }

  return base;
}

function envBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function hasEnvConfig(env = process.env) {
  return Boolean(
    env.NTFY_TOPIC ||
      env.NTFY_URL ||
      env.NTFY_SERVER ||
      env.HEALTH_NAME ||
      env.ACTION_TOKEN,
  );
}

export function configFromEnv(env = process.env, base = DEFAULT_CONFIG) {
  const config = structuredClone(base);
  if (env.NTFY_URL) config.ntfy.server = env.NTFY_URL;
  if (env.NTFY_SERVER) config.ntfy.server = env.NTFY_SERVER;
  if (env.NTFY_TOPIC) config.ntfy.topic = env.NTFY_TOPIC;
  if (env.NTFY_TOKEN) config.ntfy.token = env.NTFY_TOKEN;
  config.ntfy.dryRun = envBool(env.NTFY_DRY_RUN, config.ntfy.dryRun);
  if (env.NTFY_MIN_PRIORITY) config.ntfy.minPriority = Number(env.NTFY_MIN_PRIORITY);
  if (env.NTFY_MIN_PRIORITY) config.ntfy.minPriority = Number(env.NTFY_MIN_PRIORITY);
  if (env.HEALTH_BASE_URL) config.ntfy.baseUrl = env.HEALTH_BASE_URL;
  if (env.HEALTH_NAME) config.profile.name = env.HEALTH_NAME;
  if (env.HEALTH_WAKE) config.day.wake = env.HEALTH_WAKE;
  if (env.HEALTH_SLEEP) config.day.sleep = env.HEALTH_SLEEP;
  if (env.HEALTH_WATER_GOAL) config.water.goal = Number(env.HEALTH_WATER_GOAL);
  if (env.HEALTH_STEP_GOAL) config.movement.stepGoal = Number(env.HEALTH_STEP_GOAL);
  if (env.HEALTH_WATCH_TOKEN) config.watch.token = env.HEALTH_WATCH_TOKEN;
  if (env.ACTION_TOKEN) config.security.actionToken = env.ACTION_TOKEN;
  return normalizeConfig(config, base);
}
