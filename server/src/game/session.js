import { randomBytes } from 'node:crypto';
import { generate, makeRng } from './generator.js';
import { grade } from './grader.js';
import { isDefaultConfig } from '../config.js';

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

export function createSessionStore({ now = () => Date.now(), rngSeed, idleTtlMs = DEFAULT_IDLE_TTL_MS } = {}) {
  const sessions = new Map();
  // A monotonically advanced seed source so different sessions don't share an RNG sequence.
  let seedCounter = (rngSeed != null ? rngSeed : Math.floor(Math.random() * 0xFFFFFFFF)) | 0;

  function nextSeed() {
    seedCounter = (seedCounter + 1) | 0;
    return seedCounter;
  }

  function makeId() {
    return randomBytes(16).toString('base64url');
  }

  function newQuestion(session) {
    return generate(session.config, session.rng);
  }

  return {
    start({ userId, config }) {
      const sessionId = makeId();
      const startedAt = now();
      const rng = makeRng(nextSeed());
      const session = {
        id: sessionId,
        userId: userId ?? null,
        config,
        startedAt,
        lastTouchedAt: startedAt,
        durationMs: config.durationMs,
        score: 0,
        currentQuestion: null,
        rng,
        finalized: false
      };
      session.currentQuestion = generate(session.config, session.rng);
      sessions.set(sessionId, session);
      return {
        sessionId,
        question: {
          prompt: session.currentQuestion.prompt,
          op: session.currentQuestion.op,
          answer: session.currentQuestion.answer
        },
        timeLimitMs: session.durationMs
      };
    },

    answer(sessionId, userAnswer) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      const t = now();
      session.lastTouchedAt = t;
      const elapsed = t - session.startedAt;
      if (elapsed >= session.durationMs) {
        session.finalized = true;
        return { timeUp: true, finalScore: session.score };
      }
      const { correct } = grade(session.currentQuestion, userAnswer);
      if (correct) session.score += 1;
      session.currentQuestion = newQuestion(session);
      return {
        correct,
        nextQuestion: {
          prompt: session.currentQuestion.prompt,
          op: session.currentQuestion.op,
          answer: session.currentQuestion.answer
        },
        score: session.score,
        timeRemainingMs: Math.max(0, session.durationMs - elapsed)
      };
    },

    finish(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      session.finalized = true;
      return {
        finalScore: session.score,
        durationMs: session.durationMs,
        qualifies: session.userId != null && isDefaultConfig(session.config)
      };
    },

    get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },

    delete(sessionId) {
      sessions.delete(sessionId);
    },

    evictExpired() {
      const t = now();
      for (const [id, s] of sessions) {
        if (t - s.lastTouchedAt > idleTtlMs) sessions.delete(id);
      }
    },

    size() { return sessions.size; }
  };
}
