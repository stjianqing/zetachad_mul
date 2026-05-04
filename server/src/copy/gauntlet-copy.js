import { dateStringToSeed } from '../game/sgt-date.js';

export const PRE_TAUNTS = [
  "Don't choke.",
  "Try not to embarrass yourself.",
  "Show us your worth.",
  "Pretend you can do math.",
  "One shot. Make it count.",
  "Time to find out who you really are.",
  "The numbers are watching.",
  "No second chances. No mercy.",
  "Step up or step aside.",
  "Today's not the day to be average.",
  "Math waits for no one.",
  "Prove you deserve to be here.",
  "The overlords demand tribute.",
  "Glory or shame. Pick one.",
  "Today's questions don't care about your feelings.",
  "Twenty problems. Don't waste them.",
  "Whatever you do, don't second-guess yourself.",
  "The leaderboard hungers."
];

export const WORSHIP_FIRST_PLACE = [
  "ALL HAIL",
  "BEHOLD",
  "KNEEL BEFORE",
  "PRAISE BE TO",
  "GLORY TO",
  "WITNESS"
];

export const WORSHIP_OTHER = [
  "BEHOLD",
  "WITNESS",
  "PRESENTING",
  "ENTER"
];

export const POST_DONE = [
  "see you tomorrow.",
  "today's run: locked.",
  "the overlords have seen enough.",
  "you've been counted.",
  "go touch grass."
];

function pickByDate(table, dateString) {
  const seed = dateStringToSeed(dateString);
  return table[seed % table.length];
}

export function pickPreTaunt(dateString)     { return pickByDate(PRE_TAUNTS, dateString); }
export function pickWorshipFirst(dateString) { return pickByDate(WORSHIP_FIRST_PLACE, dateString); }
export function pickWorshipOther(dateString) { return pickByDate(WORSHIP_OTHER, dateString); }
export function pickPostDone(dateString)     { return pickByDate(POST_DONE, dateString); }
