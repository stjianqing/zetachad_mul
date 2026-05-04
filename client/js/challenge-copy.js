// Voice-copy table for challenge results. Picks deterministically from challengeId
// so the same challenge shows the same caption every time you visit it.

const WIN_LINES = [
  "STILL HAIL.",
  "Got served.",
  "Crushed.",
  "Math gods nodded.",
  "Numbers obeyed.",
  "Quietly devastating.",
  "Filed under: dominance.",
  "Decisive.",
  "No notes.",
  "The bar wasn't on the floor."
];

const LOSS_LINES = [
  "Outpaced.",
  "Ceiling was lower than you thought.",
  "The numbers picked them.",
  "Skill issue.",
  "Beaten on your own questions.",
  "Disrespected.",
  "Practice mode is one tab over.",
  "RNG was fine. You weren't.",
  "Filed under: cope."
];

const DECLINE_LINES = [
  "{name} chickened out.",
  "{name} declined.",
  "{name} doesn't want the smoke.",
  "{name} folded."
];

const FORFEIT_LINES = [
  "{name} quit halfway through.",
  "{name} ghosted mid-run.",
  "{name} ran out of stamina.",
  "{name} surrendered to the questions."
];

const READY_SUBTITLES = [
  "No do-overs.",
  "Don't fumble it.",
  "Refresh = forfeit.",
  "One attempt. Make it count.",
  "No mercy mode."
];

function pick(arr, seed) { return arr[Math.abs(seed | 0) % arr.length]; }

export function captionForResult({ status, viewerWon, otherUsername, challengeId }) {
  const seed = challengeId | 0;
  if (status === 'declined')  return pick(DECLINE_LINES, seed).replace('{name}', otherUsername ?? 'they');
  if (status === 'forfeited') return pick(FORFEIT_LINES, seed).replace('{name}', otherUsername ?? 'they');
  if (status !== 'completed') return '';
  return viewerWon ? pick(WIN_LINES, seed) : pick(LOSS_LINES, seed);
}

export function readySubtitle(challengeId) {
  return pick(READY_SUBTITLES, challengeId | 0);
}
