// Defense-in-depth check for /admin/api/* routes.
// Primary auth is nginx Basic Auth at the edge. This handler refuses requests
// that lack any Authorization: Basic header — meaning the request bypassed
// nginx (e.g., direct hit to the Node port from inside the VPS).
// We do NOT validate the password here; nginx already did.
export function requireAdmin(req, reply) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string' || !h.toLowerCase().startsWith('basic ')) {
    reply.code(401).send({ error: 'admin_auth_required' });
    return reply;
  }
}
