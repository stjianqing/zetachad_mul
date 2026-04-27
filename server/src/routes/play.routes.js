export default async function playRoutes(fastify, { sessionStore }) {
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
        expected_digits: r.question.expectedDigits
      },
      time_limit_ms: r.timeLimitMs
    };
  });

  fastify.post('/api/play/answer', { config: { rateLimit: answerLimit } }, async (req, reply) => {
    const { session_id, answer } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });
    const r = sessionStore.answer(session_id, typeof answer === 'string' ? answer : '');
    if (r === null) return reply.code(404).send({ error: 'unknown_session' });
    if (r.timeUp) return { time_up: true, final_score: r.finalScore };
    return {
      correct: r.correct,
      next_question: {
        prompt: r.nextQuestion.prompt,
        op: r.nextQuestion.op,
        expected_digits: r.nextQuestion.expectedDigits
      },
      score: r.score,
      time_remaining_ms: r.timeRemainingMs
    };
  });
}
