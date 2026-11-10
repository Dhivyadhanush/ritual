# Amazfit Helio Strap — what it is, and what else you can track with it

> The request said “healio strap”; the product is the **Amazfit Helio Strap** (and the
> Helio Strap Pro). This document covers the standard $99.99 model unless noted.

## Short version

The Helio Strap is a **screenless** 20 g band built around Amazfit’s **BioTracker 6.0 PPG**
sensor. It is not a smartwatch and not a notification device: it is a 24/7 sensor with a
clip/velcro strap that you can wear on the wrist or upper arm (the upper-arm position is
the point for lifting and intervals).

It is interesting here because it is the one Amazfit wearable that can **broadcast live
heart rate over standard Bluetooth**, which a phone app can read directly. Everything else
arrives through the Zepp app / cloud / Apple Health.

## Specs that matter

| | Helio Strap |
| --- | --- |
| Price | $99.99 (Pro: $199.99, adds muscle-load analysis + multi-position mount) |
| Display | none |
| Sensor | BioTracker 6.0 PPG |
| Heart rate | continuous, every second |
| Also tracks | SpO2, stress, sleep stages/REM/naps, breathing quality, sleep score, sleep HRV, resting HR, BioCharge recovery, VO2 max, training load/effect, recovery time |
| Workouts | 50+ modes, 25 strength movements, HYROX race mode, rep/set/rest tracking |
| Live output | Bluetooth heart-rate broadcast to phones, watches, gym equipment, apps |
| Offline storage | up to 21 days of HR without the phone |
| Battery | 232 mAh, rated ~10 days (reviews often exceed it) |
| Water | 5 ATM |
| Connectivity | Bluetooth 5.2 / BLE, 32 MB storage |
| App | Zepp (iOS 15+ / Android 7+) |
| Subscription | none required |
| Syncs out | Strava, TrainingPeaks, adidas Running, komoot, Relive, Google Fit, Apple Health |

## What you actually get (and don’t)

**You get:** derived metrics, not raw PPG. Sleep HRV, resting HR, SpO2 samples, stress,
sleep stages, breathing quality, training load, recovery, and a live HR stream while
broadcast is on.

**You don’t get:**

- An official public API for continuous raw data.
- A continuous all-day HRV stream (HRV is surfaced mainly around sleep/recovery).
- ECG, blood pressure, skin temperature, or GPS.
- A screen or reliable notification surface. Reviews specifically complain that it does
  not behave like a vibrating reminder band. Treat it as a **sensor**, not a notifier —
  send reminders to your phone/watch and use the strap to decide *whether* to send them.

## Four ways to get the data out

1. **Zepp GDPR export** — the complete history, delivered as CSV/ZIP. Best for backfill
   and for “all the days since I bought it”. Import into `data/history.json` with
   `npm run import -- export.csv`.
2. **Apple Health / Health Connect** — Zepp writes steps, sleep, HR, SpO2 and workouts.
   A Shortcut or exporter app can POST them to `/api/watch`.
3. **Live BLE heart rate** — while the strap is broadcasting, it advertises the standard
   Heart Rate service (`0x180D`, characteristic `0x2A37`). An iOS/macOS app can subscribe
   with CoreBluetooth **without any Amazfit SDK**. This is the only true real-time route,
   and it works while the strap is in broadcast mode.
4. **Third-party sync** — Strava/TrainingPeaks etc. for workouts, but those lose the
   health context (HRV/sleep), so they’re less useful here.

---

# Beyond the basics: things worth tracking

These are wellness experiments, roughly ordered by how well the Helio’s signals support
them. “Confidence” means how much I trust the signal from a consumer PPG band, not medical
validity.

## 1. Orthostatic stand test (autonomic response)

**Track:** HR at rest (5 min lying/seated) → stand → HR at 1, 2, 3 minutes. Compute the
rise and how quickly it settles.

**Why:** a large, sustained rise can reflect dehydration, heat, poor sleep, illness, or
autonomic strain. It is a daily “how much reserve do I have?” signal.

**How:** needs live HR (BLE) or a manual HR reading at fixed times. A tiny app/shortcut can
prompt the three readings.

**Confidence:** medium. **Effort:** medium (needs live HR or manual entry).

## 2. Resonance breathing biofeedback

**Track:** guide 6 breaths/min (inhale 4 s, exhale 6 s) for 5 minutes while showing live HR.
Measure HR drop / HRV-ish variability before vs after.

**Why:** a concrete, testable wind-down intervention. It also gives you a “did this
actually calm me down?” record instead of guessing.

**How:** live BLE HR + a timer + before/after averages. No new hardware.

**Confidence:** medium-high for the acute effect. **Effort:** medium.

## 3. Strength-set recovery (HRR)

**Track:** peak HR during a set → HR after 60/120 s. Trend it across weeks.

**Why:** the Helio is explicitly built for lifting. Recovery between sets is a useful
proxy for conditioning and fatigue, and it is invisible in step/calorie data.

**How:** log set start/end in the app; read live HR or use the workout HR curve afterwards.

**Confidence:** medium. **Effort:** low-medium (manual set markers).

## 4. Heat strain and hydration debt

**Track:** HR drift at a similar effort + ambient temperature/humidity from your
`weather-ntfy` server. Flag “hot + elevated RHR + low water” days.

**Why:** this is the natural bridge to Ritual: the app already knows the weather and your
water. On a 35 °C day with 3 glasses logged, the nudge can be specific instead of generic.

**How:** weather integration already exists; add an HR-drift metric and a hydration
multiplier. **Confidence:** medium. **Effort:** low.

## 5. Sleep regularity index (not just duration)

**Track:** standard deviation of sleep midpoint, weekday vs weekend midpoint (“social
jetlag”), and how often bedtime moves by more than 60 minutes.

**Why:** regularity predicts how you feel better than a single “sleep score”. It is also
easy to compute from dates you already export.

**How:** sleep start/end from Zepp export or Apple Health; pure math.

**Confidence:** high (as a behavioural metric). **Effort:** low.

## 6. Illness radar (early-warning, not diagnosis)

**Track:** a 3-day rolling deviation score: resting HR up, HRV down, SpO2 down,
breathing-quality down, sleep worse. Require 2+ signals before flagging.

**Why:** people often notice “something is coming” from wearables before symptoms. A
careful composite is more useful than a single threshold.

**How:** daily metrics already in the export; add a baseline and z-scores.

**Confidence:** low-medium; false positives are common. **Effort:** low. **Never** use it
as a diagnosis or to decide about medical care.

## 7. Alcohol and caffeine response ledger

**Track:** tag evenings (“2 drinks”, “coffee after 4pm”) and compare that night’s HR,
HRV, sleep midpoint and next-morning resting HR.

**Why:** the effect is personal and often larger than people expect. A simple correlation
is enough to change behaviour.

**How:** add tags to the daily check-in; join with sleep/HR data.

**Confidence:** medium-high for the pattern, low for causation. **Effort:** low.

## 8. Stress → breath intervention loop

**Track:** when stress is high or HR is elevated while still, prompt one minute of slow
breathing, then re-check HR. Record whether it dropped.

**Why:** closes the loop between “the strap says stressed” and “here is something that
helped”. Over time you learn which intervention works for *you*.

**Confidence:** medium. **Effort:** medium (needs live HR).

## 9. Breathing-disturbance / apnoea proxy

**Track:** overnight SpO2 dips + breathing-quality score + awakenings. Show a weekly
“breathing disturbance” trend, never a diagnosis.

**Why:** if the trend is consistently poor, that is a concrete reason to discuss a sleep
study with a clinician.

**Confidence:** low for screening, high for “worth mentioning”. **Effort:** low.

## 10. Cycle-phase estimate (with caveats)

**Track:** resting HR and HRV across the month; estimate phases from the pattern.

**Why:** some people see a clear luteal-phase RHR rise and HRV drop; adjusting training and
hydration accordingly can help.

**How:** needs 2–3 months of baseline and a way to log cycle start. PPG alone is not a
reliable phase detector.

**Confidence:** low-medium. **Effort:** medium.

## 11. Travel and altitude adaptation

**Track:** SpO2, resting HR and sleep around flights / altitude changes.

**Why:** a clean use of SpO2 that isn’t “daily wellness”: see how your body responds to a
new elevation or a red-eye, and time hard sessions accordingly.

**Confidence:** medium. **Effort:** low.

## 12. Deload gate

**Track:** training load vs HRV/BioCharge trend for 7 days. If load rises while recovery
falls for 3+ days, suggest an easy day.

**Why:** turns “listen to your body” into a rule you can inspect. Pair with Ritual by
switching movement nudges from “go walk” to “mobility only” on red days.

**Confidence:** medium. **Effort:** low-medium (needs load + recovery series).

## 13. Focus guard (HR + stillness + time)

**Track:** elevated HR while steps are flat for 45+ minutes → offer a 2-minute breathing or
stand-up break.

**Why:** a different use of the same signals: not fitness, but attention and stress.

**Confidence:** low-medium (HR is noisy). **Effort:** low.

## 14. Hydration estimation (experimental)

**Track:** morning RHR, orthostatic rise, urine-colour log, water intake, weather. Fit a
personal “dehydration score”.

**Why:** the strap can’t measure hydration directly, but the combination is better than
counting glasses alone.

**Confidence:** low. **Effort:** medium.

## 15. Annual review / data art

**Track:** a year of sleep regularity, streak calendars, training load, HRV bands.

**Why:** the export is yours and Ritual already has a monthly grid. A year-in-review page
is a nice payoff and makes the data feel owned.

**Confidence:** high (it’s just your data). **Effort:** low.

---

## Feasibility matrix

| Idea | Data needed | Real-time? | Effort | Confidence |
| --- | --- | --- | --- | --- |
| Orthostatic test | live HR or manual HR | yes | M | M |
| Resonance breathing | live HR | yes | M | M-H |
| Set recovery (HRR) | live HR / workout HR | yes | M | M |
| Heat + hydration | HR, weather, water | no | L | M |
| Sleep regularity | sleep start/end | no | L | H |
| Illness radar | RHR, HRV, SpO2, breathing | no | L | L-M |
| Alcohol/caffeine | tags + sleep/HR | no | L | M-H |
| Stress→breath | stress/HR | yes | M | M |
| Apnoea proxy | overnight SpO2/breathing | no | L | L |
| Cycle estimate | RHR/HRV 2-3 months | no | M | L-M |
| Altitude/travel | SpO2, RHR, sleep | no | L | M |
| Deload gate | load + recovery | no | L-M | M |
| Focus guard | HR + steps | yes | L | L-M |
| Hydration score | multiple + logs | no | M | L |
| Year in review | history | no | L | H |

## How to wire these into Ritual

The current `/api/watch` schema is deliberately small. A next version can accept optional
fields without breaking anything:

```json
{
  "steps": 6840,
  "sleepMinutes": 455,
  "restingHr": 53,
  "activeCalories": 388,
  "hrv": 42,
  "spo2": 97,
  "stress": 31,
  "biocharge": 74,
  "sleepStart": "2026-11-08T23:40:00+05:30",
  "sleepEnd": "2026-11-09T07:15:00+05:30",
  "breathingQuality": 88,
  "trainingLoad": 52
}
```

Then add derived daily fields (`sleepMidpoint`, `sleepRegularity7`, `rhrDelta7`,
`readiness`) and let the reminder engine use them:

- low readiness → swap the movement nudge for mobility/breathing
- high heat + low water → earlier, more specific hydration nudge
- poor sleep regularity → earlier wind-down nudge
- illness score high → mute “push harder” language and suggest rest

Live HR is a separate path: a small BLE client (CoreBluetooth on iOS/macOS) that subscribes
to `0x2A37` while the strap broadcasts, then posts short sessions to the server. Do not try
to pair to the strap as a normal Amazfit device from iOS; broadcast mode is the supported
route.

## Safety

This band is not a medical device. PPG heart rate and SpO2 are estimates and degrade with
motion, cold, tattoos, poor fit, and low battery (users report accuracy issues below ~60%).
Never use these ideas to diagnose arrhythmia, sleep apnoea, or any condition. If something
looks persistently abnormal, take the data to a clinician — don’t let an algorithm decide.

## Sources

- [Amazfit Helio Strap product page](https://us.amazfit.com/products/helio-strap) — official specs, sensors, BioTracker, broadcast, battery, 5 ATM.
- [GearBrain: one month with the Helio Strap](https://www.gearbrain.com/amazfit-helio-strap-fitness-tracker-review-2677906907.html) — BioTracker 6.0, sleep/HRV, BioCharge, 50+ modes, 21-day offline HR, 32 MB, trade-offs.
- [Zepp privacy / export](https://www.zepp.com/privacy-support) — data export process.
- [Zepp ↔ Apple Health](https://trainconstant.com/blog/amazfit-zepp-apple-health) — metrics that sync.
- [Zepp OS architecture](https://docs.zepp.com/docs/guides/architecture/arc/) — side service and Fetch API, for a future wrist UI.
- [Bluetooth Heart Rate Service](https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/) — `0x180D` / `0x2A37`, the live broadcast path.
