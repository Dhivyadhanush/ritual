import { timeToMinutes } from './config.js';
import { dayKey } from './store.js';
import { readWeather } from './weather.js';
import { motivationFor } from './motivation.js';

const MINUTE = 60_000;

export function minutesOf(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

export function hhmm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Supports windows that wrap past midnight (e.g. 22:00 -> 06:00). */
export function inWindow(nowMinutes, start, end) {
  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes <= end;
  return nowMinutes >= start || nowMinutes <= end;
}

const fmtSteps = (n) => (n == null ? null : `${Number(n).toLocaleString('en-IN')} steps`);
const fmtSleep = (m) => {
  if (m == null) return null;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return h ? `${h}h ${min}m` : `${min}m`;
};

function minutesSince(iso, now) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / MINUTE)) : Infinity;
}

/** Deterministic per-habit encouragement, so it doesn't read like a robot. */
const HABIT_LINES = [
  'Two minutes now beats an hour someday.',
  'Future you is watching this one.',
  'Tiny rep. Real effect.',
  'You do not have to feel like it. Just do it once.',
  'This is the boring part that works.',
  'Make it easy on yourself: start smaller.',
];

function habitLine(id = '') {
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return HABIT_LINES[sum % HABIT_LINES.length];
}

export class ReminderEngine {
  constructor(store, weatherFile) {
    this.store = store;
    this.weatherFile = weatherFile;
  }

  isSent(now, kind) {
    return Boolean(this.store.state.sent[`${dayKey(now)}:${kind}`]);
  }

  watchFor(now) {
    const w = this.store.state.watch;
    return w?.date === dayKey(now) ? w : null;
  }

  actionsFor(now, includeWater = false) {
    const base = this.store.config.ntfy.baseUrl;
    if (!base) return [];
    const token = this.store.config.security?.actionToken ?? '';
    const suffix = token ? `&t=${encodeURIComponent(token)}` : '';
    const actions = [{ action: 'view', label: 'Open dashboard', url: base, clear: true }];
    if (includeWater) {
      actions.push({
        action: 'http',
        label: '+1 glass',
        url: `${base}/a/water?delta=1${suffix}`,
        method: 'POST',
        clear: true,
      });
    }
    return actions;
  }

  buildWater(now, watch, weather) {
    const { water } = this.store.config;
    const state = this.store.state;
    const remaining = Math.max(0, water.goal - state.water);
    const minutesLeft = timeToMinutes(water.end) - minutesOf(now);
    const lines = [];

    if (remaining === 1) lines.push(`One glass to go. Finish the day clean.`);
    else if (remaining <= 3) lines.push(`${remaining} glasses left. You are close — one now, one soon.`);
    else lines.push(`${remaining} to go before ${water.end}. Start with one, right now.`);

    if (minutesLeft > 0 && minutesLeft <= 240) lines.push(`About ${Math.round(minutesLeft / 60)}h left in the window.`);

    if (weather?.tempC != null && weather.tempC >= 32) {
      lines.push(`${weather.emoji ?? '🌡️'} ${Math.round(weather.tempC)}°C outside — you will need more than usual.`);
    }
    if (watch?.steps != null) lines.push(`Watch: ${fmtSteps(watch.steps)} so far.`);

    return {
      kind: 'water',
      title: `💧 ${state.water} of ${water.goal} glasses`,
      message: lines.join('\n'),
      tags: ['droplet'],
      priority: 3,
      actions: this.actionsFor(now, true),
    };
  }

  buildMovement(now, watch, weather) {
    const { movement } = this.store.config;
    const lines = [];

    if (watch?.steps != null) {
      const pct = Math.round((watch.steps / movement.stepGoal) * 100);
      if (pct < 40) lines.push(`Only ${fmtSteps(watch.steps)} so far (${pct}% of ${movement.stepGoal.toLocaleString('en-IN')}). A 10-minute walk fixes a lot.`);
      else lines.push(`${fmtSteps(watch.steps)} — ${pct}% of today's goal. A short walk keeps the streak alive.`);
    } else {
      lines.push('You have been sitting a while. Stand, roll your shoulders, walk for five minutes.');
    }

    if (weather?.raining || (weather?.rainChance ?? 0) >= 60) {
      lines.push(`Rain likely (${weather.rainChance ?? 0}%). Do it indoors if you need to.`);
    } else if (weather?.tempC != null && weather.tempC >= 34) {
      lines.push(`${Math.round(weather.tempC)}°C outside — move indoors or wait for the evening.`);
    } else if (weather?.isDay) {
      lines.push(`${weather.emoji ?? '☀️'} Good conditions out there right now.`);
    }

    return {
      kind: 'move',
      title: '🚶 Time to move',
      message: lines.join('\n'),
      tags: ['walking'],
      priority: 2,
      actions: this.actionsFor(now),
    };
  }

  buildHabit(habit, now) {
    return {
      kind: `habit:${habit.id}`,
      title: `${habit.emoji} ${habit.label}`,
      message: habitLine(habit.id),
      tags: ['white_check_mark'],
      priority: 2,
      actions: this.actionsFor(now),
    };
  }

  /** A yes/no check-in: answering ticks that date in the monthly grid. */
  buildCheckin(habit, now) {
    const base = this.store.config.ntfy.baseUrl;
    const token = this.store.config.security?.actionToken ?? '';
    const suffix = token ? `&t=${encodeURIComponent(token)}` : '';
    const date = dayKey(now);
    const id = encodeURIComponent(habit.id);
    const actions = base
      ? [
          {
            action: 'http',
            label: '✅ Yes',
            url: `${base}/a/checkin?id=${id}&done=1&date=${date}${suffix}`,
            method: 'POST',
            clear: true,
          },
          {
            action: 'http',
            label: '❌ Not today',
            url: `${base}/a/checkin?id=${id}&done=0&date=${date}${suffix}`,
            method: 'POST',
            clear: true,
          },
        ]
      : [];

    const message = base
      ? 'Answer on this notification and it is ticked off for today. Either answer is fine — the point is the honest record.'
      : 'Open the dashboard and answer today’s check-in. (Set a dashboard URL in settings to answer straight from this notification.)';

    return {
      kind: `checkin:${habit.id}`,
      title: `${habit.emoji} Did you keep “${habit.label}” today?`,
      message,
      tags: ['ballot_box_with_check'],
      priority: 3,
      actions,
    };
  }

  pendingCheckins(now = new Date()) {
    const nowMin = minutesOf(now);
    return this.store.config.habits
      .filter(
        (h) =>
          h.enabled &&
          h.checkin &&
          nowMin >= timeToMinutes(h.time) &&
          this.store.state.habits[h.id] === undefined,
      )
      .map((h) => ({
        id: h.id,
        emoji: h.emoji,
        label: h.label,
        time: h.time,
        answered: false,
      }));
  }

  buildMotivation(now, watch, weather) {
    const { quote, focus } = motivationFor(now);
    const lines = [`“${quote}”`, '', focus];
    if (watch?.sleepMinutes != null && watch.sleepMinutes < 360) {
      lines.push('', `You slept ${fmtSleep(watch.sleepMinutes)}. Today's win is an easier pace, not a harder one.`);
    } else if (watch?.sleepMinutes != null) {
      lines.push('', `Sleep: ${fmtSleep(watch.sleepMinutes)}. Good base to build on.`);
    }
    if (weather?.tempC != null) {
      lines.push(`${weather.emoji ?? '🌤️'} ${Math.round(weather.tempC)}°C, ${weather.description?.toLowerCase() ?? 'outside'}.`);
    }
    return {
      kind: 'motivation',
      title: `☀️ Good morning, ${this.store.config.profile.name}`,
      message: lines.join('\n'),
      tags: ['sunny'],
      priority: 3,
      actions: this.actionsFor(now, true),
    };
  }

  _motivation(now) {
    return motivationFor(now);
  }

  buildRecap(now, watch) {
    const { water } = this.store.config;
    const state = this.store.state;
    const done = this.store.config.habits.filter((h) => h.enabled && state.habits[h.id]).length;
    const total = this.store.config.habits.filter((h) => h.enabled).length;

    const lines = [
      `💧 Water: ${state.water} of ${water.goal} glasses`,
      `✅ Habits: ${done} of ${total}`,
    ];
    if (watch?.steps != null) lines.push(`🚶 Steps: ${fmtSteps(watch.steps)}`);
    if (watch?.sleepMinutes != null) lines.push(`😴 Last night: ${fmtSleep(watch.sleepMinutes)}`);
    if (watch?.restingHr != null) lines.push(`❤️ Resting HR: ${watch.restingHr} bpm`);

    const pending = this.pendingCheckins(now);
    if (pending.length) {
      lines.push('', `Still open: ${pending.map((p) => p.label).join(', ')}. Tick it before bed.`);
    }

    if (state.water >= water.goal && done >= Math.ceil(total / 2)) {
      lines.push('', 'That was a good day. Close the laptop and go to bed.');
    } else if (state.water < water.goal) {
      lines.push('', 'Not perfect, still yours. One glass before bed and tomorrow starts better.');
    } else {
      lines.push('', 'Decent day. Protect the sleep and run it back tomorrow.');
    }

    return {
      kind: 'recap',
      title: '🌙 Day in review',
      message: lines.join('\n'),
      tags: ['crescent_moon'],
      priority: 2,
      actions: this.actionsFor(now, true),
    };
  }

  /** Everything that should fire on this tick, at most 2 notifications. */
  due(now = new Date()) {
    const cfg = this.store.config;
    const state = this.store.state;
    const nowMin = minutesOf(now);
    const watch = this.watchFor(now);
    const weather = readWeather(this.weatherFile, now.getTime());
    const standalone = [];
    const combinable = [];

    // Morning motivation
    const mStart = timeToMinutes(cfg.motivation.time);
    if (
      cfg.motivation.enabled &&
      !this.isSent(now, 'motivation') &&
      nowMin >= mStart &&
      nowMin <= mStart + 180
    ) {
      standalone.push(this.buildMotivation(now, watch, weather));
    }

    // Water
    const w = cfg.water;
    const wStart = timeToMinutes(w.start);
    const wEnd = timeToMinutes(w.end);
    if (
      w.enabled &&
      state.water < w.goal &&
      inWindow(nowMin, wStart, wEnd) &&
      minutesSince(state.lastNudge.water, now) >= w.intervalMinutes
    ) {
      combinable.push(this.buildWater(now, watch, weather));
    }

    // Movement
    const m = cfg.movement;
    const stepsDone = watch?.steps != null && watch.steps >= m.stepGoal;
    if (
      m.enabled &&
      !stepsDone &&
      inWindow(nowMin, timeToMinutes(m.start), timeToMinutes(m.end)) &&
      minutesSince(state.lastNudge.move, now) >= m.intervalMinutes
    ) {
      combinable.push(this.buildMovement(now, watch, weather));
    }

    // Habit nudges + check-ins
    const checkins = [];
    for (const habit of cfg.habits) {
      if (!habit.enabled) continue;
      const at = timeToMinutes(habit.time);

      if (habit.checkin) {
        // Unanswered and inside the ask window: one confirmation notification.
        if (state.habits[habit.id] !== undefined) continue;
        if (this.isSent(now, `checkin:${habit.id}`)) continue;
        if (nowMin >= at && nowMin - at <= 180) checkins.push(this.buildCheckin(habit, now));
        continue;
      }

      if (state.habits[habit.id] || this.isSent(now, `habit:${habit.id}`)) continue;
      if (nowMin >= at && nowMin - at <= 90) combinable.push(this.buildHabit(habit, now));
    }

    // Evening recap
    const rStart = timeToMinutes(cfg.recap.time);
    if (
      cfg.recap.enabled &&
      !this.isSent(now, 'recap') &&
      nowMin >= rStart &&
      nowMin <= timeToMinutes(cfg.day.sleep)
    ) {
      standalone.push(this.buildRecap(now, watch));
    }

    const out = standalone.slice(0, 1);
    if (checkins.length) out.push(checkins[0]);
    if (out.length >= 2) return out;

    if (combinable.length === 1) out.push(combinable[0]);
    else if (combinable.length > 1) out.push(this.combine(combinable));
    return out;
  }

  combine(list) {
    const kinds = list.map((r) => r.kind);
    return {
      kind: 'combined',
      kinds,
      title: '🌿 A few small things',
      message: list
        .map((r) => `• ${r.title.replace(/^[^\s]+\s/, '')} — ${r.message.split('\n')[0]}`)
        .join('\n'),
      tags: ['herb'],
      priority: Math.max(...list.map((r) => r.priority ?? 3)),
      actions: list.find((r) => r.actions?.length)?.actions ?? [],
    };
  }

  markSent(rem, now = new Date()) {
    const state = this.store.state;
    const iso = now.toISOString();
    for (const kind of rem.kinds ?? [rem.kind]) {
      state.sent[`${dayKey(now)}:${kind}`] = iso;
      if (kind === 'water' || kind === 'move') state.lastNudge[kind] = iso;
    }
  }

  upcoming(now = new Date()) {
    const cfg = this.store.config;
    const state = this.store.state;
    const nowMin = minutesOf(now);
    const watch = this.watchFor(now);
    const items = [];
    const add = (minutes, emoji, label) => {
      if (minutes == null || minutes < nowMin) return;
      items.push({ emoji, label, at: hhmm(minutes), inMinutes: Math.max(0, Math.round(minutes - nowMin)) });
    };

    if (cfg.motivation.enabled && !this.isSent(now, 'motivation')) {
      add(timeToMinutes(cfg.motivation.time), '☀️', 'Morning motivation');
    }

    if (cfg.water.enabled && state.water < cfg.water.goal) {
      const last = state.lastNudge.water ? new Date(state.lastNudge.water).getTime() : 0;
      const raw = last ? Math.round((last - now.getTime()) / MINUTE) + cfg.water.intervalMinutes : nowMin;
      const next = Math.max(raw, nowMin);
      if (inWindow(next, timeToMinutes(cfg.water.start), timeToMinutes(cfg.water.end))) {
        add(next, '💧', `Water — ${cfg.water.glassMl} ml`);
      }
    }

    const stepsDone = watch?.steps != null && watch.steps >= cfg.movement.stepGoal;
    if (cfg.movement.enabled && !stepsDone) {
      const last = state.lastNudge.move ? new Date(state.lastNudge.move).getTime() : 0;
      const raw = last ? Math.round((last - now.getTime()) / MINUTE) + cfg.movement.intervalMinutes : nowMin;
      const next = Math.max(raw, nowMin);
      if (inWindow(next, timeToMinutes(cfg.movement.start), timeToMinutes(cfg.movement.end))) {
        add(next, '🚶', 'Move for a few minutes');
      }
    }

    for (const habit of cfg.habits) {
      if (!habit.enabled) continue;
      if (habit.checkin) {
        if (state.habits[habit.id] !== undefined || this.isSent(now, `checkin:${habit.id}`)) continue;
        add(timeToMinutes(habit.time), habit.emoji, `Check-in — ${habit.label}`);
        continue;
      }
      if (state.habits[habit.id] || this.isSent(now, `habit:${habit.id}`)) continue;
      add(timeToMinutes(habit.time), habit.emoji, habit.label);
    }

    if (cfg.recap.enabled && !this.isSent(now, 'recap')) {
      add(timeToMinutes(cfg.recap.time), '🌙', 'Day in review');
    }

    return items.filter((i) => i.inMinutes >= 0).sort((a, b) => a.inMinutes - b.inMinutes).slice(0, 7);
  }
}
