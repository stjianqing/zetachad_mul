import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../../src/game/session.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

function fakeClock(initial) {
  let now = initial;
  return {
    now: () => now,
    advance: (ms) => { now += ms; }
  };
}

test('start returns a session id, first question, and time_limit_ms', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const r = store.start({ userId: null, config: DEFAULT_CONFIG });
  assert.equal(typeof r.sessionId, 'string');
  assert.ok(r.sessionId.length >= 16);
  assert.ok(r.question && typeof r.question.prompt === 'string');
  assert.equal(r.timeLimitMs, 120_000);
});

test('answer grades, increments score, returns next question and remaining time', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });

  clock.advance(1500);
  const correctAnswer = String(store.get(sessionId).currentQuestion.answer);
  const r = store.answer(sessionId, correctAnswer);
  assert.equal(r.correct, true);
  assert.equal(r.score, 1);
  assert.ok(r.nextQuestion);
  assert.equal(r.timeRemainingMs, 120_000 - 1500);
});

test('wrong answer leaves score unchanged', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const r = store.answer(sessionId, 'definitely-not-a-number');
  assert.equal(r.correct, false);
  assert.equal(r.score, 0);
});

test('answer after time_up returns time_up:true and final_score', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });

  // Answer one correctly inside the time window
  store.answer(sessionId, String(store.get(sessionId).currentQuestion.answer));

  clock.advance(120_001);
  const r = store.answer(sessionId, '0');
  assert.equal(r.timeUp, true);
  assert.equal(r.finalScore, 1);
});

test('answer with unknown sessionId returns null', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  assert.equal(store.answer('nope', '1'), null);
});

test('finish returns finalScore, durationMs, qualifies (default config + userId)', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  store.answer(sessionId, String(store.get(sessionId).currentQuestion.answer));
  clock.advance(120_001);
  const r = store.finish(sessionId);
  assert.equal(r.finalScore, 1);
  assert.equal(r.durationMs, 120_000);
  assert.equal(r.qualifies, true);
});

test('finish on a non-default config returns qualifies:false', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 60_000;
  const { sessionId } = store.start({ userId: 7, config: cfg });
  clock.advance(60_001);
  const r = store.finish(sessionId);
  assert.equal(r.qualifies, false);
});

test('finish with no userId returns qualifies:false', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: null, config: DEFAULT_CONFIG });
  clock.advance(120_001);
  const r = store.finish(sessionId);
  assert.equal(r.qualifies, false);
});

test('idle TTL evicts old sessions', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1, idleTtlMs: 5 * 60 * 1000 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  clock.advance(6 * 60 * 1000);
  store.evictExpired();
  assert.equal(store.get(sessionId), null);
});

test('get returns the session record while active', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const s = store.get(sessionId);
  assert.equal(s.userId, 7);
  assert.equal(s.score, 0);
});

test('start returns answer on the first question', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const r = store.start({ userId: null, config: DEFAULT_CONFIG });
  const session = store.get(r.sessionId);
  assert.equal(r.question.answer, session.currentQuestion.answer);
  assert.equal(typeof r.question.answer, 'number');
});

test('answer returns answer on next question', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const r = store.answer(sessionId, '0');
  assert.equal(typeof r.nextQuestion.answer, 'number');
});

test('start returns a peek question alongside the current question', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const r = store.start({ userId: null, config: DEFAULT_CONFIG });
  assert.equal(typeof r.peekQuestion.answer, 'number');
  assert.equal(typeof r.peekQuestion.prompt, 'string');
});

test('answer returns a fresh peek alongside the next question', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const r = store.answer(sessionId, '0');
  assert.equal(typeof r.peekQuestion.answer, 'number');
});

test('peek returned by start matches next_question returned by the next answer', () => {
  // Critical contract: the client renders peek synchronously when the user
  // solves the current question, then expects the server to confirm that
  // peek as the new current question on the next /answer response.
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const startResult = store.start({ userId: null, config: DEFAULT_CONFIG });
  const peekFromStart = startResult.peekQuestion;
  const answerResult = store.answer(startResult.sessionId, '0');
  assert.deepEqual(answerResult.nextQuestion, peekFromStart);
});

test('attempts not staged for guest sessions', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: null, config: DEFAULT_CONFIG });
  store.answer(sessionId, '0');
  const s = store.get(sessionId);
  assert.equal(s.attempts.length, 0);
});

test('attempts not staged for custom-config sessions', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 60_000;
  const { sessionId } = store.start({ userId: 7, config: cfg });
  store.answer(sessionId, '0');
  const s = store.get(sessionId);
  assert.equal(s.attempts.length, 0);
});

test('attempts staged for logged-in default-config sessions with correct fields', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const q1 = store.get(sessionId).currentQuestion;
  clock.advance(1500);
  store.answer(sessionId, String(q1.answer));
  const s = store.get(sessionId);
  assert.equal(s.attempts.length, 1);
  const a = s.attempts[0];
  assert.equal(a.qIndex, 0);
  assert.equal(a.op, q1.op);
  assert.equal(a.lhs, q1.a);
  assert.equal(a.rhs, q1.b);
  assert.equal(a.answer, q1.answer);
  assert.equal(a.userAnswer, String(q1.answer));
  assert.equal(a.responseMs, 1500);
  assert.equal(a.correct, true);
  assert.ok(a.askedAt instanceof Date);
});

test('takeRunRecord returns staged data and clears attempts', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  clock.advance(1500);
  store.answer(sessionId, String(store.get(sessionId).currentQuestion.answer));

  const rec = store.takeRunRecord(sessionId);
  assert.equal(rec.userId, 7);
  assert.equal(rec.score, 1);
  assert.equal(rec.attempts.length, 1);
  assert.equal(typeof rec.durationMs, 'number');

  // Subsequent call returns empty attempts
  assert.equal(store.takeRunRecord(sessionId).attempts.length, 0);
});

test('takeRunRecord returns null for unknown session', () => {
  const store = createSessionStore({ rngSeed: 1 });
  assert.equal(store.takeRunRecord('nope'), null);
});

test('session.start captures the seed used for normal runs', () => {
  const store = createSessionStore({ rngSeed: 12345 });
  const r = store.start({ userId: 1, config: DEFAULT_CONFIG });
  const sess = store.get(r.sessionId);
  assert.equal(typeof sess.seed, 'number');
  assert.ok(Number.isInteger(sess.seed));
});

test('session.start uses date-derived seed for daily-gauntlet, exposes it', () => {
  const store = createSessionStore({});
  const r = store.start({
    userId: 1,
    config: DEFAULT_CONFIG,
    mode: 'daily-gauntlet',
    seedDate: '2026-05-04'
  });
  const sess = store.get(r.sessionId);
  assert.equal(typeof sess.seed, 'number');
});

test('takeRunRecord includes seed', () => {
  const store = createSessionStore({ rngSeed: 99 });
  const r = store.start({ userId: 1, config: DEFAULT_CONFIG });
  const rec = store.takeRunRecord(r.sessionId);
  assert.equal(typeof rec.seed, 'number');
});
