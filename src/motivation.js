export const QUOTES = [
  'Small hinges swing big doors.',
  'You do not rise to the level of your goals; you fall to the level of your systems.',
  'The body keeps the score. Give it a good one.',
  'Discipline is choosing what you want most over what you want now.',
  'A little every day beats a lot someday.',
  'Your future self is watching. Make them proud.',
  'Energy is earned, not found.',
  'Drink the water. Take the walk. Send the message.',
  'Consistency is a superpower disguised as boredom.',
  'Rest is part of the training, not a break from it.',
  'The best workout is the one you actually do.',
  'One percent better is still better.',
  'You cannot pour from an empty glass — literally, drink something.',
  'Sleep is the cheapest performance enhancer there is.',
  'Stand up. Breathe. Begin again.',
  'Health is a relationship, not a project.',
  'Slow is smooth, smooth is fast.',
  'Do the boring thing well, for a long time.',
  'Protect your mornings and the day protects you.',
  'Motion creates emotion.',
  'The walk you do not want to take is usually the one you need.',
  'Eat like you are worth the effort.',
  'Your spine called. It wants a stretch.',
  'Hydration is the lowest-effort upgrade you have.',
  'Finish the day lighter than you started it.',
  'Strong is built on ordinary Tuesdays.',
  'Breathe out longer than you breathe in.',
  'You are allowed to rest without earning it first.',
  'Sunlight before screens.',
  'Tomorrow starts tonight.',
];

export const FOCUS = [
  'One thing today: keep the water bottle in sight.',
  'One thing today: a 10-minute walk after a meal.',
  'One thing today: lights out 30 minutes earlier.',
  'One thing today: five slow breaths before the next task.',
  'One thing today: stand up every hour, no exceptions.',
  'One thing today: one proper meal, sitting down.',
  'One thing today: no screens for the last 30 minutes.',
  'One thing today: stretch your hips and shoulders.',
  'One thing today: get outside before noon.',
  'One thing today: say no to one thing that drains you.',
];

export function dayOfYear(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86_400_000);
}

/** Deterministic: the same day always gives the same line. */
export function motivationFor(date = new Date()) {
  const n = dayOfYear(date);
  return {
    quote: QUOTES[n % QUOTES.length],
    focus: FOCUS[(n * 7) % FOCUS.length],
  };
}
