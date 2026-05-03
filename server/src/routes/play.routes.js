import { computeRunDifficulty } from '../run-difficulty/compute.js';
import { requireAuth } from '../auth.js';
import { todaySgtDateString } from '../game/sgt-date.js';
import { DEFAULT_CONFIG } from '../config.js';

export default async function playRoutes(fastify, { sessionStore, pool, medianCache, nowFn = () => new Date() }) {
  const answerLimit = {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => `play-answer:${req.body?.session_id ?? req.ip}`
  };

  fastify.post('/api/play/start', async (req, reply) => {
    const mode = req.body?.mode;

    if (mode === 'daily-gauntlet') {
      if (!req.user) {
        return reply.code(401).send({ error: 'register-to-play' });
      }
      const today = todaySgtDateString(nowFn());

      const existing = await pool.query(
        `SELECT id, duration_ms, played_at
         FROM runs
         WHERE user_id = $1
           AND daily_gauntlet_date = $2
           AND submitted_to_leaderboard = true
         LIMIT 1`,
        [req.user.id, today]
      );
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        const rank = await computeDailyRank(pool, today, row.duration_ms, row.played_at);
        return {
          already_completed: true,
          time_ms: Number(row.duration_ms),
          rank
        };
      }

      const r = sessionStore.start({
        userId: req.user.id,
        config: DEFAULT_CONFIG,
        mode: 'daily-gauntlet',
        seedDate: today
      });
      return {
        session_id: r.sessionId,
        mode: r.mode,
        total_questions: r.totalQuestions,
        question_index: r.questionIndex,
        question: r.question,
        peek_question: r.peekQuestion
      };
    }

    const config = req.body?.config;
    if (!config || typeof config !== 'object') {
      return reply.code(400).send({ error: 'invalid_config' });
    }
    const r = sessionStore.start({ userId: req.user?.id ?? null, config });
    return {
      session_id: r.sessionId,
      question: { prompt: r.question.prompt, op: r.question.op, answer: r.question.answer },
      peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
      time_limit_ms: r.timeLimitMs
    };
  });

  fastify.post('/api/play/answer', { config: { rateLimit: answerLimit } }, async (req, reply) => {
    const { session_id, answer } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });
    const session = sessionStore.get(session_id);
    const r = sessionStore.answer(session_id, typeof answer === 'string' ? answer : '');
    if (r === null) return reply.code(404).send({ error: 'unknown_session' });
    if (r.timeUp) {
      await flushRunIfRecording(req, session_id);
      if (r.dailyGauntlet) {
        const today = session?.seedDate;
        const live = sessionStore.get(session_id);
        const playedAtRow = await pool.query(
          'SELECT played_at FROM runs WHERE id = $1',
          [live?.runId]
        );
        const playedAt = playedAtRow.rows[0]?.played_at ?? new Date();
        const rank = await computeDailyRank(pool, today, r.durationMs, playedAt);
        const totalRow = await pool.query(
          `SELECT COUNT(*)::int AS n FROM runs
           WHERE daily_gauntlet_date = $1 AND submitted_to_leaderboard = true`,
          [today]
        );
        return {
          time_up: true,
          final_score: r.finalScore,
          daily_gauntlet: true,
          time_ms: r.durationMs,
          rank,
          total_today: totalRow.rows[0].n
        };
      }
      return { time_up: true, final_score: r.finalScore };
    }
    return {
      correct: r.correct,
      next_question: { prompt: r.nextQuestion.prompt, op: r.nextQuestion.op, answer: r.nextQuestion.answer },
      peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
      score: r.score,
      time_remaining_ms: r.timeRemainingMs,
      question_index: r.questionIndex,
      total_questions: r.totalQuestions
    };
  });

  async function flushRunIfRecording(req, sessionId) {
    const rec = sessionStore.takeRunRecord(sessionId);
    if (!rec || rec.userId == null || rec.attempts.length === 0) return;

    // Map session-store snake/camel to the shape computeRunDifficulty expects.
    const attemptsForDifficulty = rec.attempts.map(a => ({
      op: a.op, lhs: a.lhs, rhs: a.rhs,
      response_ms: a.responseMs, correct: a.correct
    }));
    const difficulty = medianCache
      ? computeRunDifficulty(attemptsForDifficulty, medianCache)
      : null;

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const insRun = await client.query(
        `INSERT INTO runs (user_id, score, duration_ms, practice, difficulty, daily_gauntlet_date, submitted_to_leaderboard)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [rec.userId, rec.score, rec.durationMs, rec.practice, difficulty, rec.dailyGauntletDate, rec.submittedToLeaderboard]
      );
      const runId = Number(insRun.rows[0].id);
      const cols = ['run_id', 'q_index', 'op', 'lhs', 'rhs', 'answer', 'user_answer', 'response_ms', 'correct', 'asked_at'];
      const values = [];
      const placeholders = rec.attempts.map((a, i) => {
        const off = i * cols.length;
        values.push(runId, a.qIndex, a.op, a.lhs, a.rhs, a.answer, a.userAnswer, a.responseMs, a.correct, a.askedAt);
        return `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, $${off + 8}, $${off + 9}, $${off + 10})`;
      });
      await client.query(
        `INSERT INTO attempts (${cols.join(',')}) VALUES ${placeholders.join(',')}`,
        values
      );
      await client.query('COMMIT');

      const live = sessionStore.get(sessionId);
      if (live) {
        live.runId = runId;
        live.difficulty = difficulty;
      }
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      if (err.code === '23505') {
        req.log.info({ err, sessionId }, 'daily-gauntlet: duplicate completion (race) ignored');
      } else {
        req.log.error({ err }, 'analytics: failed to persist run + attempts');
      }
    } finally {
      if (client) client.release();
    }
  }

  async function computeDailyRank(pool, dateString, myDurationMs, myPlayedAt) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) + 1 AS rank
       FROM runs
       WHERE daily_gauntlet_date = $1
         AND submitted_to_leaderboard = true
         AND (duration_ms < $2 OR (duration_ms = $2 AND played_at < $3))`,
      [dateString, myDurationMs, myPlayedAt]
    );
    return Number(rows[0].rank);
  }
}
