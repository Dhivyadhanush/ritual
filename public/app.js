const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const RING_C = 2 * Math.PI * 56;

let state = null;
let monthKey = null;
let monthData = null;
let lastSig = '';
let lastMonthSig = '';
let lastWater = null;
let settingsFilled = false;
let settingsDirty = false;
let toastTimer = null;

/* ---------- helpers ---------- */

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const nf = new Intl.NumberFormat('en-IN');

function fmtSleep(mins) {
  if (mins == null) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function countTo(el, to, ms = 650) {
  if (!el) return;
  const from = Number(el.dataset.value ?? 0);
  el.dataset.value = String(to);
  if (reduced || from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Login required');
  }
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- data ---------- */

async function boot() {
  try {
    const data = await api('/api/bootstrap');
    monthKey = data.month.month;
    monthData = data.month;
    apply(data, true);
  } catch (err) {
    setMode('off', 'Server unreachable');
    toast(err.message, true);
  }
}

async function poll() {
  if (document.visibilityState !== 'visible') return;
  try {
    const data = await api('/api/bootstrap');
    if (monthKey === data.month.month) monthData = data.month;
    apply(data, false);
  } catch {
    setMode('off', 'Server unreachable');
  }
}

async function afterMutation() {
  const data = await api('/api/bootstrap');
  if (monthKey === data.month.month) monthData = data.month;
  else monthData = await loadMonth(monthKey);
  apply(data, true);
}

async function loadMonth(key) {
  const data = await api(`/api/month?month=${encodeURIComponent(key)}`);
  return { month: data.month, days: data.days };
}

function apply(data, force) {
  state = data;
  renderAll(force);
}

/* ---------- render ---------- */

function renderAll(force = false) {
  if (!state) return;
  const sig = JSON.stringify({
    s: state.state,
    sum: state.summary,
    up: state.upcoming,
    p: state.pending,
    w: state.weather,
    m: state.meta,
    cfg: state.config,
    logs: state.logs.map((l) => l.id).slice(0, 8),
  });
  renderClock();
  if (!force && sig === lastSig) return;
  lastSig = sig;

  setMode(state.meta);
  renderMotivation();
  renderWater();
  renderStreak();
  renderWatch();
  renderHabits();
  renderPending();
  renderUpNext();
  renderMonth(force);
  renderLogs();
  if (!settingsFilled) {
    fillSettings();
    settingsFilled = true;
  }
}

function setMode(meta, labelOverride) {
  const logout = $('#logoutForm');
  if (logout) logout.hidden = !meta?.authEnabled;

  const el = $('#modePill');
  if (!meta) {
    el.className = 'pill pill-off';
    el.innerHTML = '<i></i> Offline';
    return;
  }
  if (labelOverride) {
    el.className = 'pill pill-off';
    el.innerHTML = `<i></i> ${esc(labelOverride)}`;
    return;
  }
  const { dryRun, ntfyConfigured } = meta;
  if (dryRun) {
    el.className = 'pill pill-dry';
    el.innerHTML = '<i></i> Dry run';
    el.title = 'Notifications are written to the log but not sent. Turn dry run off in settings.';
  } else if (!ntfyConfigured) {
    el.className = 'pill pill-off';
    el.innerHTML = '<i></i> No ntfy topic';
    el.title = 'Add an ntfy topic in settings to reach your phone and watch.';
  } else {
    el.className = 'pill pill-live';
    el.innerHTML = '<i></i> Live · ntfy';
    el.title = `Publishing to ${meta.ntfyConfigured ? 'your topic' : 'ntfy'}`;
  }
}

function renderClock() {
  const el = $('#nextText');
  if (!el) return;
  const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const next = state?.upcoming?.[0];
  el.textContent = next ? `${now} · next ${next.at} ${next.label}` : `${now} · nothing queued`;
}

function renderMotivation() {
  const m = state.motivation;
  $('#dateLabel').textContent = new Date(state.state.date + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  $('#quote').textContent = `“${m.quote}”`;
  $('#focus').textContent = m.focus;

  const chips = [];
  const w = state.weather;
  if (w?.tempC != null) {
    chips.push(
      `<span class="chip"><span>${esc(w.emoji ?? '🌤️')}</span> ${Math.round(w.tempC)}°C · ${esc(
        w.description ?? '',
      )}</span>`,
    );
    if ((w.rainChance ?? 0) >= 40) {
      chips.push(`<span class="chip">🌧️ ${Math.round(w.rainChance)}% rain next 3h</span>`);
    }
  } else {
    chips.push('<span class="chip">🌤️ Weather not linked (optional)</span>');
  }
  if (state.state.streak > 0) {
    chips.push(`<span class="chip">🔥 ${state.state.streak}-day streak</span>`);
  }
  $('#weatherChip').innerHTML = chips.join('');
}

function renderWater() {
  const { goal, glassMl } = state.config.water;
  const current = state.state.water;
  const pct = Math.max(0, Math.min(1, current / goal));
  const fill = $('#ringFill');
  if (fill) fill.style.strokeDashoffset = String(RING_C * (1 - pct));

  countTo($('#ringCount'), current);
  $('#ringGoal').textContent = `/ ${goal}`;
  $('#waterPct').textContent = `${Math.round(pct * 100)}%`;
  const size = (ml) => (ml >= 1000 ? `${Number((ml / 1000).toFixed(2))} L` : `${ml} ml`);
  $('#waterMl').textContent = `${size(current * glassMl)} of ${size(goal * glassMl)}`;

  const wrap = $('.ring-wrap');
  if (lastWater !== null && current !== lastWater && wrap) {
    wrap.classList.remove('bump');
    void wrap.offsetWidth;
    wrap.classList.add('bump');
  }
  lastWater = current;

  const cups = [];
  for (let i = 0; i < goal; i += 1) {
    cups.push(`<span class="glass ${i < current ? 'filled' : ''}" title="Glass ${i + 1}"></span>`);
  }
  $('#glasses').innerHTML = cups.join('');
}

function renderStreak() {
  const s = state.summary;
  countTo($('#streak'), state.state.streak);
  $('#best').textContent = `best ${s.bestStreak}`;
  $('#avg').textContent = `${s.daysTracked} days tracked · 7-day average ${s.avgWater7} glasses`;

  const days = [...(s.last14 ?? [])];
  const today = {
    date: state.state.date,
    water: state.state.water,
    goal: state.config.water.goal,
  };
  days.push(today);
  const shown = days.slice(-14);

  $('#bars').innerHTML = shown
    .map((d) => {
      const ratio = Math.max(0, Math.min(1, (d.water ?? 0) / (d.goal || 1)));
      const cls = ratio >= 1 ? 'done' : ratio > 0 ? 'partial' : '';
      const isToday = d.date === state.state.date ? 'today' : '';
      return `<span class="bar ${cls} ${isToday}" data-h="${Math.round(ratio * 100)}" title="${esc(
        d.date,
      )} · ${d.water ?? 0}/${d.goal ?? 0} glasses"></span>`;
    })
    .join('');

  requestAnimationFrame(() => {
    $$('#bars .bar').forEach((bar) => {
      bar.style.height = `${Math.max(4, Number(bar.dataset.h ?? 0))}%`;
    });
  });
}

function renderWatch() {
  const w = state.state.watch;
  const body = $('#watchBody');
  const when = $('#watchWhen');

  if (!w?.updatedAt) {
    when.textContent = 'no data yet';
    body.innerHTML = `<div class="watch-empty">
      Push steps, sleep and heart rate from Apple Health or your watch export.
      <code>curl -X POST /api/watch -d '{"steps":6400,"sleepMinutes":402,"restingHr":54}'</code>
    </div>`;
    return;
  }

  when.textContent = timeAgo(w.updatedAt);
  const steps = w.steps ?? 0;
  const goal = state.config.movement.stepGoal;
  const pct = Math.max(0, Math.min(100, Math.round((steps / goal) * 100)));
  const rows = [];

  if (w.steps != null) {
    rows.push(`<div class="watch-stat">
      <span class="label">Steps</span><span class="value">${nf.format(steps)} <small class="micro">/ ${nf.format(goal)}</small></span>
      <div class="meter"><span data-w="${pct}"></span></div>
    </div>`);
  }
  if (w.sleepMinutes != null) {
    rows.push(
      `<div class="watch-stat"><span class="label">Sleep</span><span class="value">${fmtSleep(
        w.sleepMinutes,
      )}</span></div>`,
    );
  }
  if (w.restingHr != null) {
    rows.push(
      `<div class="watch-stat"><span class="label">Resting HR</span><span class="value">${w.restingHr} bpm</span></div>`,
    );
  }
  if (w.activeCalories != null) {
    rows.push(
      `<div class="watch-stat"><span class="label">Active calories</span><span class="value">${nf.format(
        w.activeCalories,
      )}</span></div>`,
    );
  }
  body.innerHTML = rows.join('');
  requestAnimationFrame(() => {
    $$('#watchBody .meter span').forEach((el) => {
      el.style.width = `${el.dataset.w}%`;
    });
  });
}

function renderHabits() {
  const list = state.config.habits.filter((h) => h.enabled);
  const values = state.state.habits;
  const done = list.filter((h) => values[h.id]).length;
  $('#habitCount').textContent = `${done}/${list.length}`;

  $('#habitList').innerHTML = list
    .map((h) => {
      const v = values[h.id];
      const time = `<span class="habit-time">${esc(h.time)}${h.checkin ? ' · check-in' : ''}</span>`;
      if (h.checkin) {
        return `<div class="habit-row ${v === true ? 'done' : ''} ${v === false ? 'no' : ''}">
          <span class="habit-emoji">${esc(h.emoji)}</span>
          <span class="habit-main"><span class="habit-label">${esc(h.label)}</span>${time}</span>
          <span class="habit-checkin">
            <button class="mini-btn yes ${v === true ? 'active' : ''}" data-checkin="${esc(
              h.id,
            )}" data-done="1" aria-pressed="${v === true}">Yes</button>
            <button class="mini-btn no ${v === false ? 'active' : ''}" data-checkin="${esc(
              h.id,
            )}" data-done="0" aria-pressed="${v === false}">No</button>
          </span>
        </div>`;
      }
      return `<button class="habit-row ${v ? 'done' : ''}" data-toggle="${esc(h.id)}" aria-pressed="${
        v ? 'true' : 'false'
      }">
        <span class="habit-check" aria-hidden="true"></span>
        <span class="habit-main"><span class="habit-label">${esc(h.emoji)} ${esc(h.label)}</span>${time}</span>
      </button>`;
    })
    .join('') || '<p class="micro">No habits enabled. Add some in settings.</p>';
}

function renderPending() {
  const el = $('#pending');
  const pending = state.pending ?? [];
  if (!pending.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = pending
    .map(
      (p) => `<div class="pending-card">
        <div class="q">
          <span>${esc(p.emoji)}</span>
          <div>
            <strong>Did you keep “${esc(p.label)}” today?</strong>
            <div class="micro">Check-in at ${esc(p.time)} · answering ticks today’s box</div>
          </div>
        </div>
        <div class="pending-actions">
          <button class="btn btn-primary" data-checkin="${esc(p.id)}" data-done="1">Yes, done</button>
          <button class="btn btn-ghost" data-checkin="${esc(p.id)}" data-done="0">Not today</button>
        </div>
      </div>`,
    )
    .join('');
}

function renderUpNext() {
  const items = state.upcoming ?? [];
  if (!items.length) {
    const cfg = state.config;
    const first = cfg.motivation.enabled ? cfg.motivation.time : cfg.water.start;
    $('#upnext').innerHTML = `<div class="quiet">
      <span class="moon">🌙</span>
      <strong>Quiet hours</strong>
      <span>Nothing else queued today. First up tomorrow at ${esc(first)}.</span>
    </div>`;
    return;
  }
  $('#upnext').innerHTML = items
    .map(
      (i, index) => `<div class="next-item" style="animation-delay:${index * 45}ms">
        <span>${esc(i.emoji)}</span>
        <span>${esc(i.label)}</span>
        <span class="at">${esc(i.at)}</span>
        <span class="in">${i.inMinutes <= 0 ? 'now' : `${i.inMinutes}m`}</span>
      </div>`,
    )
    .join('');
}

function renderMonth(force = false) {
  const md = monthData ?? state.month;
  if (!md) return;
  const sig = JSON.stringify({ md, habits: state.config.habits });
  if (!force && sig === lastMonthSig && $('#monthGrid').children.length) return;
  lastMonthSig = sig;

  const label = new Date(`${md.month}-01T00:00:00`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
  $('#monthLabel').textContent = label;

  const todayKey = state.state.date;
  const present = new Set();
  for (const day of md.days) for (const id of Object.keys(day.habits ?? {})) present.add(id);

  const rows = state.config.habits.filter((h) => h.enabled || present.has(h.id));
  const dayCount = md.days.length;

  const head = [`<th aria-label="Habit"></th>`]
    .concat(
      md.days.map((d) => {
        const dayNum = Number(d.date.slice(-2));
        const dow = new Date(`${d.date}T00:00:00`).getDay();
        const weekend = dow === 0 || dow === 6 ? 'weekend' : '';
        const today = d.date === todayKey ? 'today' : '';
        return `<th class="${weekend} ${today}">${dayNum}</th>`;
      }),
    )
    .join('');

  const waterCells = md.days
    .map((d) => {
      const ratio = Math.max(0, Math.min(1, (d.water ?? 0) / (d.goal || state.config.water.goal || 1)));
      let cls = '';
      let mark = '';
      if (ratio >= 1) {
        cls = 'water-done';
        mark = '✓';
      } else if (ratio > 0) {
        cls = 'partial';
        mark = '';
      }
      if (d.future) cls += ' future';
      if (d.date === todayKey) cls += ' today';
      return `<td class="cell ${cls}" title="${esc(d.date)} · ${d.water ?? 0}/${d.goal ?? 0} glasses">${mark}</td>`;
    })
    .join('');

  const habitRows = rows
    .map((h) => {
      let total = 0;
      const cells = md.days
        .map((d) => {
          const v = d.habits?.[h.id];
          if (v === true) total += 1;
          let cls = v === true ? 'done' : v === false ? 'no' : '';
          let mark = v === true ? '✓' : v === false ? '·' : '';
          if (d.future) cls += ' future';
          if (d.date === todayKey) cls += ' today';
          return `<td class="cell ${cls} ${d.future ? '' : 'clickable'}" data-habit="${esc(
            h.id,
          )}" data-date="${esc(d.date)}" data-done="${v === true ? '1' : '0'}" title="${esc(
            d.date,
          )} · ${esc(h.label)}${v === true ? ' · done' : v === false ? ' · not done' : ''}">${mark}</td>`;
        })
        .join('');
      return `<tr><th>${esc(h.emoji)} ${esc(h.label)}<span class="row-total">${total}</span></th>${cells}</tr>`;
    })
    .join('');

  const html = `<table class="monthgrid">
    <thead><tr>${head}</tr></thead>
    <tbody>
      <tr><th>💧 Water goal<span class="row-total">${md.days.filter((d) => (d.water ?? 0) >= (d.goal || 1)).length}</span></th>${waterCells}</tr>
      ${habitRows}
    </tbody>
  </table>`;

  $('#monthGrid').innerHTML = html;

  const currentMonth = state.month?.month;
  $('#nextMonth').disabled = md.month >= currentMonth;
  $('#nextMonth').style.opacity = md.month >= currentMonth ? '0.35' : '';
}

function renderLogs() {
  const logs = state.logs ?? [];
  $('#logs').innerHTML =
    logs
      .slice(0, 14)
      .map((l) => {
        const time = new Date(l.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        return `<div class="log-item ${esc(l.kind)}">
          <span class="log-dot"></span>
          <div>
            <div class="log-title">${esc(l.title ?? l.kind)}</div>
            <div class="log-msg">${esc(l.message ?? '')}</div>
          </div>
          <span class="log-time">${time}</span>
        </div>`;
      })
      .join('') || '<p class="micro">Nothing has fired yet.</p>';
}

/* ---------- settings ---------- */

function habitRowHtml(h) {
  return `<div class="habit-edit" data-id="${esc(h.id)}">
    <input class="h-emoji" value="${esc(h.emoji)}" maxlength="4" aria-label="Emoji" />
    <input class="h-label" value="${esc(h.label)}" maxlength="80" aria-label="Habit name" />
    <input class="h-time" type="time" value="${esc(h.time)}" aria-label="Habit time" />
    <select class="h-type" aria-label="Habit type">
      <option value="nudge" ${h.checkin ? '' : 'selected'}>Nudge</option>
      <option value="checkin" ${h.checkin ? 'selected' : ''}>Check-in</option>
    </select>
    <label class="mini-check"><input type="checkbox" class="h-enabled" ${h.enabled ? 'checked' : ''} /> on</label>
    <button type="button" class="icon-btn remove" aria-label="Remove habit">×</button>
  </div>`;
}

function fillSettings() {
  const form = $('#settingsForm');
  const c = state.config;
  const f = form.elements;

  f.name.value = c.profile.name;
  f.topic.value = c.ntfy.topic;
  f.server.value = c.ntfy.server;
  f.token.value = '';
  f.token.placeholder = c.ntfy.tokenSet ? '•••••• saved' : 'optional';
  f.baseUrl.value = c.ntfy.baseUrl ?? '';
  f.dryRun.checked = c.ntfy.dryRun;
  f.minPriority.value = String(c.ntfy.minPriority);

  f.wake.value = c.day.wake;
  f.sleep.value = c.day.sleep;
  f.motivationTime.value = c.motivation.time;
  f.motivationEnabled.checked = c.motivation.enabled;
  f.recapTime.value = c.recap.time;
  f.recapEnabled.checked = c.recap.enabled;

  f.waterEnabled.checked = c.water.enabled;
  f.waterGoal.value = String(c.water.goal);
  f.glassMl.value = String(c.water.glassMl);
  f.waterInterval.value = String(c.water.intervalMinutes);
  f.waterStart.value = c.water.start;
  f.waterEnd.value = c.water.end;

  f.moveEnabled.checked = c.movement.enabled;
  f.moveInterval.value = String(c.movement.intervalMinutes);
  f.moveStart.value = c.movement.start;
  f.moveEnd.value = c.movement.end;
  f.stepGoal.value = String(c.movement.stepGoal);

  f.watchToken.value = '';
  f.watchToken.placeholder = c.watch.tokenSet ? '•••••• saved' : 'optional';

  $('#habitEditor').innerHTML = c.habits.map(habitRowHtml).join('');
  $('#saveNote').textContent = '';
}

function collectHabits() {
  const rows = $$('.habit-edit', $('#habitEditor'));
  const seen = new Set();
  return rows.map((row, index) => {
    const label = row.querySelector('.h-label').value.trim() || `Habit ${index + 1}`;
    let id = row.dataset.id || slug(label) || `habit-${index}`;
    while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
    seen.add(id);
    return {
      id,
      emoji: row.querySelector('.h-emoji').value.trim() || '✅',
      label,
      time: row.querySelector('.h-time').value || '09:00',
      enabled: row.querySelector('.h-enabled').checked,
      checkin: row.querySelector('.h-type').value === 'checkin',
    };
  });
}

function serializeConfig() {
  const f = $('#settingsForm').elements;
  const num = (el, fallback) => {
    const n = Number(el.value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    profile: { name: f.name.value.trim() || 'there' },
    ntfy: {
      server: f.server.value.trim() || 'https://ntfy.sh',
      topic: f.topic.value.trim(),
      token: f.token.value,
      baseUrl: f.baseUrl.value.trim(),
      dryRun: f.dryRun.checked,
      minPriority: Number(f.minPriority.value),
    },
    day: { wake: f.wake.value, sleep: f.sleep.value },
    water: {
      enabled: f.waterEnabled.checked,
      goal: num(f.waterGoal, 8),
      glassMl: num(f.glassMl, 250),
      intervalMinutes: num(f.waterInterval, 60),
      start: f.waterStart.value,
      end: f.waterEnd.value,
    },
    movement: {
      enabled: f.moveEnabled.checked,
      intervalMinutes: num(f.moveInterval, 90),
      start: f.moveStart.value,
      end: f.moveEnd.value,
      stepGoal: num(f.stepGoal, 8000),
    },
    motivation: { enabled: f.motivationEnabled.checked, time: f.motivationTime.value },
    recap: { enabled: f.recapEnabled.checked, time: f.recapTime.value },
    habits: collectHabits(),
    watch: { token: f.watchToken.value },
  };
}

/* ---------- events ---------- */

async function toggleWater(delta) {
  try {
    await api(`/api/water?delta=${encodeURIComponent(delta)}`, { method: 'POST' });
    await afterMutation();
  } catch (err) {
    toast(err.message, true);
  }
}

async function setCheckin(id, done) {
  try {
    await api(`/api/checkin?id=${encodeURIComponent(id)}&done=${done ? 1 : 0}&date=${state.state.date}`, {
      method: 'POST',
    });
    await afterMutation();
    toast(done ? 'Ticked for today.' : 'Recorded honestly.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleHabit(id, done) {
  try {
    await api('/api/habit', {
      method: 'PUT',
      body: JSON.stringify({ id, done, date: state.state.date }),
    });
    await afterMutation();
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleMonthCell(cell) {
  const { habit: id, date, done } = cell.dataset;
  try {
    await api('/api/habit', {
      method: 'PUT',
      body: JSON.stringify({ id, done: done !== '1', date }),
    });
    await afterMutation();
  } catch (err) {
    toast(err.message, true);
  }
}

function bind() {
  document.addEventListener('click', async (event) => {
    const water = event.target.closest('[data-water]');
    if (water) return toggleWater(Number(water.dataset.water));

    const checkin = event.target.closest('[data-checkin]');
    if (checkin) return setCheckin(checkin.dataset.checkin, checkin.dataset.done === '1');

    const habit = event.target.closest('[data-toggle]');
    if (habit) {
      const id = habit.dataset.toggle;
      return toggleHabit(id, !state.state.habits[id]);
    }

    const cell = event.target.closest('td.cell[data-habit]');
    if (cell && !cell.classList.contains('future')) return toggleMonthCell(cell);

    const remove = event.target.closest('.habit-edit .remove');
    if (remove) {
      remove.closest('.habit-edit').remove();
      markDirty();
      return;
    }

    if (event.target.closest('#checkNow')) {
      try {
        const res = await api('/api/check', { method: 'POST' });
        const mode = res.snapshot?.meta?.dryRun ? 'logged (dry run)' : 'sent';
        toast(res.sent ? `${res.sent} notification${res.sent > 1 ? 's' : ''} ${mode}.` : 'Nothing due right now.');
        await afterMutation();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (event.target.closest('#testBtn')) {
      try {
        const res = await api('/api/test', { method: 'POST' });
        if (res.delivery?.dryRun) toast('Dry run: test logged but not sent. Turn dry run off to reach the watch.');
        else if (res.delivery?.ok) toast('Test sent to ntfy. Check your phone (and Zepp mirroring).');
        else toast(res.delivery?.error ?? 'Could not send test', true);
        await afterMutation();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (event.target.closest('#clearLogs')) {
      try {
        await api('/api/logs', { method: 'DELETE' });
        await afterMutation();
        toast('Activity cleared.');
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (event.target.closest('#addHabit')) {
      const row = document.createElement('div');
      row.innerHTML = habitRowHtml({
        id: '',
        emoji: '✅',
        label: '',
        time: '09:00',
        enabled: true,
        checkin: false,
      });
      $('#habitEditor').append(row.firstElementChild);
      markDirty();
      return;
    }

    if (event.target.closest('#prevMonth') || event.target.closest('#nextMonth')) {
      const delta = event.target.closest('#prevMonth') ? -1 : 1;
      const [y, m] = monthKey.split('-').map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      try {
        monthData = await loadMonth(monthKey);
        renderMonth(true);
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  const form = $('#settingsForm');
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const res = await api('/api/config', {
        method: 'PUT',
        body: JSON.stringify(serializeConfig()),
      });
      settingsDirty = false;
      settingsFilled = false;
      monthKey = res.month.month;
      monthData = res.month;
      apply(res, true);
      fillSettings();
      settingsFilled = true;
      toast('Settings saved.');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function markDirty() {
  settingsDirty = true;
  $('#saveNote').textContent = 'unsaved changes';
}

/* ---------- start ---------- */

setMode(null);
bind();
boot();
renderClock();
setInterval(renderClock, 15_000);
setInterval(poll, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') poll();
});
