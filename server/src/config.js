export const DEFAULT_CONFIG = Object.freeze({
  ops: Object.freeze({
    add: Object.freeze({ enabled: true, min: 2, max: 100 }),
    sub: Object.freeze({ enabled: true, min: 2, max: 100 }),
    mul: Object.freeze({ enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }),
    div: Object.freeze({ enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 })
  }),
  durationMs: 120_000
});

export function isDefaultConfig(config) {
  if (!config || typeof config !== 'object') return false;
  try {
    return JSON.stringify(canonicalize(config)) === JSON.stringify(canonicalize(DEFAULT_CONFIG));
  } catch {
    return false;
  }
}

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}
