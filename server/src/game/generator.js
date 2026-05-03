import { CLUSTER_BOUNDS } from '../practice/clusters.js';

// Mulberry32 PRNG — deterministic, fast, good enough for question generation.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intInRange(rng, lo, hi) {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

function pickFromArray(rng, arr) {
  return arr[intInRange(rng, 0, arr.length - 1)];
}

export function generate(config, rng, weighting) {
  if (weighting && weighting.clusters && weighting.clusters.length > 0) {
    if (rng() < weighting.weakBias) {
      const clusterId = pickFromArray(rng, weighting.clusters);
      return generateFromCluster(rng, clusterId);
    }
  }
  return generateFromConfig(config, rng);
}

function generateFromConfig(config, rng) {
  const enabled = Object.entries(config.ops)
    .filter(([, v]) => v && v.enabled)
    .map(([k]) => k);
  if (enabled.length === 0) throw new Error('no ops enabled');

  const op = enabled[intInRange(rng, 0, enabled.length - 1)];

  switch (op) {
    case 'add': {
      const { min, max } = config.ops.add;
      const a = intInRange(rng, min, max);
      const b = intInRange(rng, min, max);
      return { op, a, b, answer: a + b, prompt: `${a} + ${b}` };
    }
    case 'sub': {
      const { min, max } = config.ops.sub;
      let a = intInRange(rng, min, max);
      let b = intInRange(rng, min, max);
      if (a < b) [a, b] = [b, a];
      return { op, a, b, answer: a - b, prompt: `${a} − ${b}` };
    }
    case 'mul': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.mul;
      const a = intInRange(rng, lhsMin, lhsMax);
      const b = intInRange(rng, rhsMin, rhsMax);
      return { op, a, b, answer: a * b, prompt: `${a} × ${b}` };
    }
    case 'div': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.div;
      const quotient = intInRange(rng, rhsMin, rhsMax);
      const divisor = intInRange(rng, lhsMin, lhsMax);
      const dividend = quotient * divisor;
      return { op, a: dividend, b: divisor, answer: quotient, prompt: `${dividend} ÷ ${divisor}` };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

function generateFromCluster(rng, clusterId) {
  const c = CLUSTER_BOUNDS[clusterId];
  if (!c) throw new Error(`unknown cluster: ${clusterId}`);

  switch (c.op) {
    case 'mul': {
      const a = pickFromArray(rng, c.lhsValues);
      const b = intInRange(rng, c.rhsMin, c.rhsMax);
      return { op: 'mul', a, b, answer: a * b, prompt: `${a} × ${b}` };
    }
    case 'div': {
      const divisor = pickFromArray(rng, c.divisorValues);
      const minQ = Math.ceil(c.dividendMin / divisor);
      const maxQ = Math.floor(c.dividendMax / divisor);
      const lo = Math.max(minQ, 2);
      const hi = Math.min(maxQ, 100);
      const quotient = intInRange(rng, lo, hi);
      const dividend = quotient * divisor;
      return { op: 'div', a: dividend, b: divisor, answer: quotient, prompt: `${dividend} ÷ ${divisor}` };
    }
    case 'add': {
      const big = intInRange(rng, c.maxMin, c.maxMax);
      const small = intInRange(rng, 2, big);
      const [a, b] = rng() < 0.5 ? [big, small] : [small, big];
      return { op: 'add', a, b, answer: a + b, prompt: `${a} + ${b}` };
    }
    case 'sub': {
      const a = intInRange(rng, c.maxMin, c.maxMax);
      const b = intInRange(rng, 2, a);
      return { op: 'sub', a, b, answer: a - b, prompt: `${a} − ${b}` };
    }
    default:
      throw new Error(`unsupported cluster op: ${c.op}`);
  }
}
