#!/usr/bin/env node
/**
 * Merge a Zepp / Apple Health export into data/history.json.
 *
 *   node scripts/import-health.mjs export.csv
 *   node scripts/import-health.mjs export.json
 *
 * Accepted columns (case-insensitive, spaces or underscores):
 *   date, steps, sleep_minutes, resting_hr, active_calories, water, goal,
 *   plus one column per habit id in data/config.json (1/0/true/false).
 *
 * Existing days are merged, not replaced. Stop the server first (or restart it
 * afterwards) because the running process keeps history in memory.
 */
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

const norm = (s) => String(s).trim().toLowerCase().replace(/[\s-]+/g, '_');
const numOf = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const boolOf = (v) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (['', 'null', 'undefined'].includes(s)) return undefined;
  return !['0', 'false', 'no', 'off', 'n'].includes(s);
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveHistory(history) {
  const file = path.join(DATA_DIR, 'history.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(history, null, 2), 'utf8');
  await rename(tmp, file);
  await chmod(file, 0o644).catch(() => {});
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/import-health.mjs <export.csv|export.json>');
  process.exit(1);
}

const raw = await readFile(path.resolve(file), 'utf8');
const config = await readJson(path.join(DATA_DIR, 'config.json'), {});
const configHabits = Array.isArray(config.habits) ? config.habits : [];

let records = [];
if (file.toLowerCase().endsWith('.json')) {
  const parsed = JSON.parse(raw);
  records = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.history ?? [];
  records = records.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), v])));
} else {
  const rows = parseCsv(raw);
  const header = rows.shift().map(norm);
  records = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const history = await readJson(path.join(DATA_DIR, 'history.json'), []);
const byDate = new Map(history.map((d) => [d.date, d]));
let imported = 0;

for (const record of records) {
  const date = String(record.date ?? record.day ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

  const previous = byDate.get(date) ?? {
    date,
    water: 0,
    goal: config.water?.goal ?? 8,
    habits: {},
    steps: null,
    sleepMinutes: null,
    restingHr: null,
    activeCalories: null,
  };

  const habits = { ...(previous.habits ?? {}) };
  for (const habit of configHabits) {
    const v = boolOf(record[norm(habit.id)]);
    if (v !== undefined) habits[habit.id] = v;
  }
  if (record.habits) {
    try {
      const obj = typeof record.habits === 'string' ? JSON.parse(record.habits) : record.habits;
      if (obj && typeof obj === 'object') Object.assign(habits, obj);
    } catch {
      /* ignore malformed habits cell */
    }
  }

  const water = numOf(record.water ?? record.glasses);
  const goal = numOf(record.goal ?? record.water_goal);
  const total = configHabits.filter((h) => h.enabled !== false).length || configHabits.length;
  const habitsDone = Object.values(habits).filter(Boolean).length;
  const effectiveWater = water ?? previous.water ?? 0;
  const effectiveGoal = goal ?? previous.goal ?? config.water?.goal ?? 8;

  byDate.set(date, {
    ...previous,
    date,
    water: effectiveWater,
    goal: effectiveGoal,
    habits,
    habitsDone,
    habitsTotal: total,
    complete: effectiveWater >= effectiveGoal && habitsDone >= Math.ceil(total / 2),
    steps: numOf(record.steps) ?? previous.steps,
    sleepMinutes: numOf(record.sleep_minutes ?? record.sleepminutes ?? record.sleep_min) ?? previous.sleepMinutes,
    restingHr: numOf(record.resting_hr ?? record.resting_heart_rate ?? record.rhr) ?? previous.restingHr,
    activeCalories:
      numOf(record.active_calories ?? record.calories ?? record.active_calories_kcal) ?? previous.activeCalories,
  });
  imported += 1;
}

const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
await saveHistory(merged);

const dates = merged.map((d) => d.date);
console.log(`imported/merged ${imported} day(s)`);
console.log(`history: ${merged.length} days (${dates[0] ?? '—'} → ${dates.at(-1) ?? '—'})`);
console.log(`file: ${path.join(DATA_DIR, 'history.json')}`);
if (imported) console.log('Restart the health-reminder server so it reloads history.');
