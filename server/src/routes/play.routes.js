import { computeRunDifficulty } from '../run-difficulty/compute.js';
import { requireAuth } from '../auth.js';
import { todaySgtDateString, dateStringToSeed } from '../game/sgt-date.js';
import { DEFAULT_CONFIG } from '../config.js';

export default async function playRoutes(fastify, { sessionStore, pool, medianCache, nowFn = () => new Date() }) {
  const answerLimit = {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => `play-answer:${req.body?.session_id ?? req.ip}`
  };

  fastify.post('/api/play/start', async (req, reply) => {
    const mode = req.body?.mode;

    if (mode === 'challenge') {
      if (!req.user) return reply.code(401).send({ error: 'register-to-play' });
      const challengeId = Number(req.body?.challenge_id);
      if (!Number.isInteger(challengeId)) {
        return reply.code(400).send({ error: 'invalid_challenge_id' });
      }

      // Atomic claim: set recipient_started_at iff the caller is the recipient,
      // status='accepted', and nobody has started yet. Returns the challenger's
      // run id if we won the lock; rowCount=0 if we didn't.
      const claim = await pool.query(
        `UPDATE challenges
         SET recipient_started_at = now()
         WHERE id = $1
           AND recipient_id = $2
           AND status = 'accepted'
           AND recipient_started_at IS NULL
         RETURNING challenger_run_id`,
        [challengeId, req.user.id]
      );

      if (claim.rowCount === 0) {
        // Diagnose why: load the row to distinguish not_found vs not_recipient
        // vs not_accepted vs already_started.
        const c = await pool.query(
          `SELECT recipient_id, status, recipient_started_at
           FROM challenges WHERE id = $1`,
          [challengeId]
        );
        if (c.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
        const row = c.rows[0];
        if (Number(row.recipient_id) !== req.user.id) {
          return reply.code(403).send({ error: 'not_recipient' });
        }
        if (row.status !== 'accepted') {
          return reply.code(409).send({ error: 'challenge_not_accepted' });
        }
        // status=accepted, recipient_id matches, but recipient_started_at is set → already started.
        return { already_started: true };
      }

      const challengerRunId = Number(claim.rows[0].challenger_run_id);
      const seedRes = await pool.query('SELECT seed FROM runs WHERE id=$1', [challengerRunId]);
      if (seedRes.rowCount === 0) {
        // Should be impossible under FK constraints, but if it happens we'd rather
        // surface a 500 than throw a bare TypeError on undefined.
        req.log.error({ challengeId, challengerRunId }, 'challenge: challenger_run_id references missing runs row');
        return reply.code(500).send({ error: 'internal_error' });
      }
      const seed = Number(seedRes.rows[0].seed);
      const r = sessionStore.start({
        userId: req.user.id,
        config: DEFAULT_CONFIG,
        explicitSeed: seed
      });
      return {
        session_id: r.sessionId,
        question: { prompt: r.question.prompt, op: r.question.op, answer: r.question.answer },
        peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
        time_limit_ms: r.timeLimitMs,
        challenge_id: challengeId
      };
    }

    if (mode === 'daily-gauntlet') {
      if (!req.user) {
        return reply.code(401).send({ error: 'register-to-play' });
      }
      const today = todaySgtDateString(nowFn());

      // Look up any existing daily-gauntlet row for this user/day — completed or lock.
      const existing = await pool.query(
        `SELECT id, duration_ms, played_at, submitted_to_leaderboard
         FROM runs
         WHERE user_id = $1
           AND daily_gauntlet_date = $2
         LIMIT 1`,
        [req.user.id, today]
      );

      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row.submitted_to_leaderboard === true) {
          const rank = await computeDailyRank(pool, today, row.duration_ms, row.played_at);
          return {
            already_completed: true,
            time_ms: Number(row.duration_ms),
            rank
          };
        }
        // Lock row exists but no completion — user already started today and abandoned (or is in another tab).
        return { already_started: true, forfeited: true };
      }

      // No row yet — create the lock row first, then the in-memory session.
      // The UNIQUE index protects against concurrent /start races; we catch 23505 below.
      const seedNum = dateStringToSeed(today);
      let lockRunId;
      try {
        const ins = await pool.query(
          `INSERT INTO runs (user_id, score, duration_ms, practice, daily_gauntlet_date, submitted_to_leaderboard, seed)
           VALUES ($1, 0, 0, false, $2, false, $3)
           RETURNING id`,
          [req.user.id, today, seedNum]
        );
        lockRunId = Number(ins.rows[0].id);
      } catch (err) {
        if (err.code === '23505') {
          // Race: another /start beat us. We can't tell from here whether the
          // winner is still mid-run or already abandoned. forfeited:false here
          // means "unknown" — not "confirmed clean." The caller treats this the
          // same as a real abandon (redirect to landing) since we have no UX
          // distinction between "you opened two tabs" and "you used your shot."
          req.log.info({ err, userId: req.user.id, today }, 'daily-gauntlet: /start race lost');
          return { already_started: true, forfeited: false };
        }
        throw err;
      }

      const r = sessionStore.start({
        userId: req.user.id,
        config: DEFAULT_CONFIG,
        mode: 'daily-gauntlet',
        seedDate: today
      });
      // Stash the lock-row id on the session so the finish path UPDATEs it instead of INSERTing.
      // sessionStore.start() is synchronous and stores the session before returning;
      // get() immediately after cannot return null. If a future refactor breaks this,
      // fail loudly here rather than silently leaving the lock row orphaned.
      sessionStore.get(r.sessionId).runId = lockRunId;

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
      const live = sessionStore.get(session_id);
      return {
        time_up: true,
        final_score: r.finalScore,
        run_id: live?.runId ?? null,
        difficulty: live?.difficulty ?? null
      };
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
    const live = sessionStore.get(sessionId);
    const preExistingRunId = live?.runId ?? null;

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

      let runId;
      if (preExistingRunId != null) {
        // Daily-gauntlet path: the lock row already exists from /start. UPDATE it.
        const upd = await client.query(
          `UPDATE runs
           SET score = $2,
               duration_ms = $3,
               practice = $4,
               difficulty = $5,
               submitted_to_leaderboard = $6,
               played_at = now()
           WHERE id = $1
           RETURNING id`,
          [preExistingRunId, rec.score, rec.durationMs, rec.practice, difficulty, rec.submittedToLeaderboard]
        );
        if (upd.rowCount === 0) {
          // Lock row missing — should never happen in normal operation. Log and bail.
          await client.query('ROLLBACK');
          req.log.error({ sessionId, preExistingRunId }, 'daily-gauntlet: lock row missing on finish');
          return;
        }
        runId = preExistingRunId;
      } else {
        // Normal/practice path: insert a fresh run row.
        const insRun = await client.query(
          `INSERT INTO runs (user_id, score, duration_ms, practice, difficulty, daily_gauntlet_date, submitted_to_leaderboard, seed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [rec.userId, rec.score, rec.durationMs, rec.practice, difficulty, rec.dailyGauntletDate, rec.submittedToLeaderboard, rec.seed]
        );
        runId = Number(insRun.rows[0].id);
      }

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

      const liveAfter = sessionStore.get(sessionId);
      if (liveAfter) {
        // No-op on the UPDATE branch (runId already matches), live assignment on the
        // INSERT branch where this is the first time the session learns its runId.
        liveAfter.runId = runId;
        liveAfter.difficulty = difficulty;
      }
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      req.log.error({ err }, 'analytics: failed to persist run + attempts');
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
