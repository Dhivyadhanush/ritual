import { readFileSync } from 'node:fs';

/**
 * Reads the sibling weather-ntfy app's last observation, if it is fresh enough.
 * The sibling weather job polls every 3 hours, so allow 4 hours here.
 * Entirely optional: the reminder engine works without it.
 */
export function readWeather(file, now = Date.now()) {
  if (!file) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const w = state?.lastWeather;
    if (!w?.current) return null;
    const fetched = new Date(w.fetchedAt).getTime();
    if (!Number.isFinite(fetched) || now - fetched > 4 * 60 * 60_000) return null;

    return {
      location: w.location ?? '',
      tempC: w.current.temperature,
      feelsC: w.current.apparent,
      humidity: w.current.humidity,
      description: w.current.description,
      emoji: w.current.emoji,
      isDay: w.current.isDay,
      rainChance: w.window?.maxProbability ?? 0,
      raining: (w.current.precipitation ?? 0) > 0 || (w.current.rain ?? 0) > 0 || (w.current.showers ?? 0) > 0,
      fetchedAt: w.fetchedAt,
    };
  } catch {
    return null;
  }
}
