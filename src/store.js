import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, configFromEnv, hasEnvConfig, normalizeConfig } from './config.js';

const MAX_LOGS = 200;
const MAX_HISTORY = 730;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Local (not UTC) YYYY-MM-DD, so "today" flips at midnight where you live. */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function freshWatch() {
  return {
    date: null,
    steps: null,
    sleepMinutes: null,
    restingHr: null,
    activeCalories: null,
    updatedAt: null,
  };
}

function freshState(today) {
  return {
    date: today,
    water: 0,
    habits: {},
    streak: 0,
    bestStreak: 0,
    lastNudge: {},
    sent: {},
    watch: freshWatch(),
    startedAt: new Date().toISOString(),
  };
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.configPath = path.join(dir, 'config.json');
    this.statePath = path.join(dir, 'state.json');
    this.historyPath = path.join(dir, 'history.json');
    this.logPath = path.join(dir, 'logs.json');

    this.config = structuredClone(DEFAULT_CONFIG);
    this.state = freshState(dayKey());
    this.history = [];
    this.logs = [];
  }

  async init() {
    await mkdir(this.dir, { recursive: true });

    const savedConfig = await readJson(this.configPath, null);
    if (savedConfig) {
      this.config = normalizeConfig(savedConfig, DEFAULT_CONFIG);
    } else if (hasEnvConfig()) {
      this.config = configFromEnv(process.env, DEFAULT_CONFIG);
      await this.saveConfig();
    }

    const savedState = await readJson(this.statePath, null);
    if (savedState && typeof savedState === 'object') {
      this.state = {
        ...freshState(dayKey()),
        ...savedState,
        habits: { ...(savedState.habits ?? {}) },
        lastNudge: { ...(savedState.lastNudge ?? {}) },
        sent: { ...(savedState.sent ?? {}) },
        watch: { ...freshWatch(), ...(savedState.watch ?? {}) },
      };
    }

    const savedHistory = await readJson(this.historyPath, []);
    if (Array.isArray(savedHistory)) this.history = savedHistory.slice(-MAX_HISTORY);

    const savedLogs = await readJson(this.logPath, []);
    if (Array.isArray(savedLogs)) this.logs = savedLogs.slice(0, MAX_LOGS);

    await this.rollover();
  }

  async writeAtomic(file, data, mode = 0o644) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
    await rename(tmp, file);
    await chmod(file, mode).catch(() => {});
  }

  async saveConfig() {
    await this.writeAtomic(this.configPath, this.config, 0o600);
  }

  async saveState() {
    await this.writeAtomic(this.statePath, this.state);
  }

  async saveHistory() {
    await this.writeAtomic(this.historyPath, this.history);
  }

  async appendLog(entry) {
    const log = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...entry,
    };
    this.logs.unshift(log);
    if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS;
    await this.writeAtomic(this.logPath, this.logs);
    return log;
  }

  async clearLogs() {
    this.logs = [];
    await this.writeAtomic(this.logPath, this.logs);
  }

  /** Archives yesterday and resets counters when the calendar day changes. */
  async rollover(now = new Date()) {
    const today = dayKey(now);
    if (this.state.date === today) return false;

    const prev = this.state;
    const habitEntries = Object.values(prev.habits ?? {});
    const habitsTotal = this.config.habits.filter((h) => h.enabled).length;
    const habitsDone = habitEntries.filter(Boolean).length;
    const complete = prev.water >= this.config.water.goal && habitsDone >= Math.ceil(habitsTotal / 2);

    if (prev.date && (prev.water > 0 || habitsDone > 0 || prev.watch?.steps != null)) {
      const summary = {
        date: prev.date,
        water: prev.water,
        goal: this.config.water.goal,
        habitsDone,
        habitsTotal,
        habits: { ...(prev.habits ?? {}) },
        steps: prev.watch?.steps ?? null,
        sleepMinutes: prev.watch?.sleepMinutes ?? null,
        restingHr: prev.watch?.restingHr ?? null,
        activeCalories: prev.watch?.activeCalories ?? null,
        complete,
      };
      const idx = this.history.findIndex((d) => d.date === prev.date);
      if (idx >= 0) this.history[idx] = summary;
      else this.history.push(summary);
      this.history = this.history.slice(-MAX_HISTORY);
      await this.saveHistory();
    }

    this.state = {
      ...freshState(today),
      streak: complete ? prev.streak + 1 : 0,
      bestStreak: Math.max(prev.bestStreak ?? 0, complete ? prev.streak + 1 : 0),
      watch: prev.watch?.date === today ? prev.watch : freshWatch(),
    };
    await this.saveState();
    return true;
  }

  async addWater(delta = 1) {
    const next = Math.max(0, Math.min(this.config.water.goal + 12, this.state.water + delta));
    this.state.water = next;
    // Logging a glass resets the clock, so the next nudge is a full interval away.
    this.state.lastNudge.water = new Date().toISOString();
    await this.saveState();
    return next;
  }

  async setHabit(id, done, date = dayKey()) {
    const habit = this.config.habits.find((h) => h.id === id);
    if (!habit) return false;

    if (date === dayKey()) {
      this.state.habits[id] = Boolean(done);
      await this.saveState();
      return true;
    }

    // Backfilling a past day edits (or creates) the archived history entry.
    let entry = this.history.find((d) => d.date === date);
    if (!entry) {
      if (date > dayKey()) return false;
      entry = {
        date,
        water: 0,
        goal: this.config.water.goal,
        habits: {},
        habitsDone: 0,
        habitsTotal: this.config.habits.filter((h) => h.enabled).length,
        steps: null,
        sleepMinutes: null,
        restingHr: null,
        activeCalories: null,
        complete: false,
      };
      this.history.push(entry);
      this.history.sort((a, b) => a.date.localeCompare(b.date));
      this.history = this.history.slice(-MAX_HISTORY);
      entry = this.history.find((d) => d.date === date);
    }
    if (!entry.habits) entry.habits = {};
    entry.habits[id] = Boolean(done);
    entry.habitsDone = Object.values(entry.habits).filter(Boolean).length;
    entry.complete =
      (entry.water ?? 0) >= (entry.goal ?? this.config.water.goal) &&
      entry.habitsDone >= Math.ceil((entry.habitsTotal ?? this.config.habits.length) / 2);
    await this.saveHistory();
    return true;
  }

  /** Days of one month, today included, for the check-in grid. */
  month(monthKey, now = new Date()) {
    const match = /^(\d{4})-(\d{2})$/.exec(monthKey ?? '');
    const y = match ? Number(match[1]) : now.getFullYear();
    const m = match ? Number(match[2]) : now.getMonth() + 1;
    const daysInMonth = new Date(y, m, 0).getDate();
    const today = dayKey(now);
    const days = [];

    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (key === today) {
        days.push({
          date: key,
          water: this.state.water,
          goal: this.config.water.goal,
          habits: { ...this.state.habits },
          future: false,
          today: true,
        });
        continue;
      }
      const entry = this.history.find((h) => h.date === key);
      days.push(
        entry
          ? { date: key, water: entry.water, goal: entry.goal, habits: { ...(entry.habits ?? {}) }, future: false, today: false }
          : { date: key, water: 0, goal: this.config.water.goal, habits: {}, future: key > today, today: false },
      );
    }

    return { month: `${y}-${String(m).padStart(2, '0')}`, days };
  }

  async recordWatch(metrics, now = new Date()) {
    const existing = this.state.watch?.date === dayKey(now) ? this.state.watch : freshWatch();
    this.state.watch = {
      ...existing,
      date: dayKey(now),
      steps: metrics.steps ?? existing.steps,
      sleepMinutes: metrics.sleepMinutes ?? existing.sleepMinutes,
      restingHr: metrics.restingHr ?? existing.restingHr,
      activeCalories: metrics.activeCalories ?? existing.activeCalories,
      updatedAt: now.toISOString(),
    };
    await this.saveState();
    return this.state.watch;
  }

  /** Totals + streaks for the dashboard, derived from history so imports count. */
  summary(now = new Date()) {
    const today = dayKey(now);
    const last14 = this.history.slice(-14);
    const last7 = this.history.slice(-7);
    const avgWater = last7.length
      ? last7.reduce((sum, d) => sum + (d.water ?? 0), 0) / last7.length
      : 0;

    const map = new Map(this.history.map((d) => [d.date, d]));
    map.set(today, {
      date: today,
      water: this.state.water,
      goal: this.config.water.goal,
      habits: this.state.habits,
    });

    const enabled = this.config.habits.filter((h) => h.enabled).length;
    const habitFloor = Math.ceil(enabled / 2);
    const isComplete = (d) => {
      if (!d) return false;
      if (d.complete != null) return d.complete;
      const goal = d.goal ?? this.config.water.goal;
      const done = Object.values(d.habits ?? {}).filter(Boolean).length;
      return (d.water ?? 0) >= goal && done >= habitFloor;
    };

    const dates = [...map.keys()].filter((d) => d <= today).sort();
    let best = 0;
    let run = 0;
    let prev = null;
    for (const key of dates) {
      const complete = isComplete(map.get(key));
      if (complete) {
        const contiguous = prev && new Date(`${key}T00:00:00`) - new Date(`${prev}T00:00:00`) === 86_400_000;
        run = contiguous ? run + 1 : 1;
        best = Math.max(best, run);
      } else {
        run = 0;
      }
      prev = key;
    }

    let streak = 0;
    const cursor = new Date(`${today}T00:00:00`);
    if (!isComplete(map.get(today))) cursor.setDate(cursor.getDate() - 1);
    for (;;) {
      const key = dayKey(cursor);
      if (!isComplete(map.get(key))) break;
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    this.state.streak = streak;
    this.state.bestStreak = best;

    return {
      today,
      streak,
      bestStreak: best,
      avgWater7: Math.round(avgWater * 10) / 10,
      daysTracked: this.history.length,
      last14,
    };
  }
}
