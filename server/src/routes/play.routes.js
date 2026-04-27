export default async function playRoutes(fastify, { sessionStore, pool }) {
  const answerLimit = {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => `play-answer:${req.body?.session_id ?? req.ip}`
  };

  fastify.post('/api/play/start', async (req, reply) => {
    const config = req.body?.config;
    if (!config || typeof config !== 'object') {
      return reply.code(400).send({ error: 'invalid_config' });
    }
    const r = sessionStore.start({ userId: req.user?.id ?? null, config });
    return {
      session_id: r.sessionId,
      question: {
        prompt: r.question.prompt,
        op: r.question.op,
        answer: r.question.answer
      },
      peek_question: {
        prompt: r.peekQuestion.prompt,
        op: r.peekQuestion.op,
        answer: r.peekQuestion.answer
      },
      time_limit_ms: r.timeLimitMs
    };
  });

  fastify.post('/api/play/answer', { config: { rateLimit: answerLimit } }, async (req, reply) => {
    const { session_id, answer } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });
    const r = sessionStore.answer(session_id, typeof answer === 'string' ? answer : '');
    if (r === null) return reply.code(404).send({ error: 'unknown_session' });
    if (r.timeUp) {
      await flushRunIfRecording(req, session_id);
      return { time_up: true, final_score: r.finalScore };
    }
    return {
      correct: r.correct,
      next_question: {
        prompt: r.nextQuestion.prompt,
        op: r.nextQuestion.op,
        answer: r.nextQuestion.answer
      },
      peek_question: {
        prompt: r.peekQuestion.prompt,
        op: r.peekQuestion.op,
        answer: r.peekQuestion.answer
      },
      score: r.score,
      time_remaining_ms: r.timeRemainingMs
    };
  });

  async function flushRunIfRecording(req, sessionId) {
    const rec = sessionStore.takeRunRecord(sessionId);
    if (!rec || rec.userId == null || rec.attempts.length === 0) return;

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const insRun = await client.query(
        'INSERT INTO runs (user_id, score, duration_ms) VALUES ($1, $2, $3) RETURNING id',
        [rec.userId, rec.score, rec.durationMs]
      );
      const runId = Number(insRun.rows[0].id);
      // Bulk insert attempts. Build the VALUES clause with placeholders.
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

      // Stamp runId on the live in-memory session so submit can find it.
      const live = sessionStore.get(sessionId);
      if (live) live.runId = runId;
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      req.log.error({ err }, 'analytics: failed to persist run + attempts');
    } finally {
      if (client) client.release();
    }
  }
}
