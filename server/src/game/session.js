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
    return generate(session.config, session.rng, session.weighting);
  }

  function publicQuestion(q) {
    return { prompt: q.prompt, op: q.op, answer: q.answer };
  }

  function recordsAttempts(session) {
    return session.userId != null && isDefaultConfig(session.config);
  }

  return {
    start({ userId, config, practice = false, weighting = null }) {
      const sessionId = makeId();
      const startedAt = now();
      const rng = makeRng(nextSeed());
      const session = {
        id: sessionId,
        userId: userId ?? null,
        config,
        practice,
        weighting,
        startedAt,
        lastTouchedAt: startedAt,
        durationMs: config.durationMs,
        score: 0,
        currentQuestion: null,
        peekQuestion: null,
        rng,
        finalized: false,
        attempts: [],
        lastQuestionAskedAt: startedAt,
        runId: null
      };
      session.currentQuestion = generate(session.config, session.rng, session.weighting);
      session.peekQuestion = generate(session.config, session.rng, session.weighting);
      sessions.set(sessionId, session);
      return {
        sessionId,
        question: publicQuestion(session.currentQuestion),
        peekQuestion: publicQuestion(session.peekQuestion),
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
      if (recordsAttempts(session)) {
        const q = session.currentQuestion;
        session.attempts.push({
          qIndex: session.attempts.length,
          op: q.op,
          lhs: q.a,
          rhs: q.b,
          answer: q.answer,
          userAnswer,
          responseMs: t - session.lastQuestionAskedAt,
          correct,
          askedAt: new Date(session.lastQuestionAskedAt)
        });
      }
      session.lastQuestionAskedAt = t;
      // Advance: the previous peek becomes the new current; generate a fresh peek.
      session.currentQuestion = session.peekQuestion;
      session.peekQuestion = newQuestion(session);
      return {
        correct,
        nextQuestion: publicQuestion(session.currentQuestion),
        peekQuestion: publicQuestion(session.peekQuestion),
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

    takeRunRecord(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      const attempts = session.attempts;
      session.attempts = [];
      return {
        userId: session.userId,
        score: session.score,
        durationMs: session.durationMs,
        practice: session.practice === true,
        attempts
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
