// Defense-in-depth check for /admin/api/* routes.
// Primary auth is nginx Basic Auth at the edge. This handler refuses requests
// that lack any Authorization: Basic header — meaning the request bypassed
// nginx (e.g., direct hit to the Node port from inside the VPS).
// We do NOT validate the password here; nginx already did.
// Must be async: Fastify v5's hook runner only advances on a returned Promise
// or invoked done callback. A sync no-done preHandler hangs every authenticated
// request — see commit edee926 for the same bug class fixed in requireAuth.
export async function requireAdmin(req, reply) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string' || !h.toLowerCase().startsWith('basic ')) {
    reply.code(401).send({ error: 'admin_auth_required' });
    return reply;
  }
}
