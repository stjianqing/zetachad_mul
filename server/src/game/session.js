import { randomBytes } from 'node:crypto';
import { generate, makeRng } from './generator.js';
import { grade } from './grader.js';
import { isDefaultConfig } from '../config.js';
import { dateStringToSeed } from './sgt-date.js';

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
    start({ userId, config, practice = false, weighting = null, mode = 'normal', seedDate = null }) {
      const sessionId = makeId();
      const startedAt = now();
      const isDailyGauntlet = mode === 'daily-gauntlet';
      const rng = isDailyGauntlet
        ? makeRng(dateStringToSeed(seedDate))
        : makeRng(nextSeed());
      const session = {
        id: sessionId,
        userId: userId ?? null,
        config,
        practice,
        weighting,
        mode,
        seedDate,                              // null for normal sessions
        totalQuestions: isDailyGauntlet ? 60 : null,
        currentQuestionIndex: isDailyGauntlet ? 0 : null,
        startTimeMs: startedAt,                // wall-clock start; used for daily-gauntlet duration
        startedAt,
        lastTouchedAt: startedAt,
        durationMs: isDailyGauntlet ? null : config.durationMs,
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
        timeLimitMs: session.durationMs,                 // null for daily-gauntlet
        mode: session.mode,
        totalQuestions: session.totalQuestions,
        questionIndex: session.currentQuestionIndex
      };
    },

    answer(sessionId, userAnswer) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      const t = now();
      session.lastTouchedAt = t;

      // Time-up branch: only for non-daily-gauntlet sessions.
      if (session.mode !== 'daily-gauntlet') {
        const elapsed = t - session.startedAt;
        if (elapsed >= session.durationMs) {
          session.finalized = true;
          return { timeUp: true, finalScore: session.score };
        }
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

      // Daily-gauntlet completion: 60 correct = run done.
      if (session.mode === 'daily-gauntlet' && correct) {
        session.currentQuestionIndex += 1;
        if (session.currentQuestionIndex >= session.totalQuestions) {
          session.finalized = true;
          const durationMs = t - session.startTimeMs;
          session.durationMs = durationMs; // stamp it so flushRunIfRecording can use the right value
          return {
            timeUp: true,                  // reuse the existing "run-ended" signal
            finalScore: session.score,
            dailyGauntlet: true,
            durationMs
          };
        }
      }

      // Advance: previous peek becomes current; generate fresh peek.
      session.currentQuestion = session.peekQuestion;
      session.peekQuestion = newQuestion(session);
      return {
        correct,
        nextQuestion: publicQuestion(session.currentQuestion),
        peekQuestion: publicQuestion(session.peekQuestion),
        score: session.score,
        timeRemainingMs: session.mode === 'daily-gauntlet'
          ? null
          : Math.max(0, session.durationMs - (t - session.startedAt)),
        questionIndex: session.mode === 'daily-gauntlet' ? session.currentQuestionIndex : null,
        totalQuestions: session.totalQuestions
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
        dailyGauntletDate: session.mode === 'daily-gauntlet' ? session.seedDate : null,
        submittedToLeaderboard: session.mode === 'daily-gauntlet',
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
