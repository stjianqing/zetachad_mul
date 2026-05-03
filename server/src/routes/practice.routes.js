import { requireAuth } from '../auth.js';
import { analyzeUser, TOP_N } from '../practice/analyzer.js';
import { DEFAULT_CONFIG } from '../config.js';

const WEAK_BIAS = 0.7;

export default async function practiceRoutes(fastify, { pool, sessionStore }) {
  fastify.get('/api/practice/diagnose', { preHandler: requireAuth }, async (req) => {
    return await analyzeUser(req.user.id, pool);
  });

  fastify.post('/api/practice/start', { preHandler: requireAuth }, async (req, reply) => {
    const result = await analyzeUser(req.user.id, pool);
    if (result.topWeak.length === 0) {
      return reply.code(422).send({ reason: result.reason ?? 'no_weak_clusters' });
    }
    const clusterIds = result.topWeak.slice(0, TOP_N).map((c) => c.id);
    const r = sessionStore.start({
      userId: req.user.id,
      config: DEFAULT_CONFIG,
      practice: true,
      weighting: { clusters: clusterIds, weakBias: WEAK_BIAS }
    });
    return {
      session_id: r.sessionId,
      question: { prompt: r.question.prompt, op: r.question.op, answer: r.question.answer },
      peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
      time_limit_ms: r.timeLimitMs,
      practice: true,
      clusters: clusterIds
    };
  });
}
