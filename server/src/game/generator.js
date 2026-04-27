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

export function generate(config, rng) {
  const enabled = Object.entries(config.ops)
    .filter(([, v]) => v && v.enabled)
    .map(([k]) => k);
  if (enabled.length === 0) throw new Error('no ops enabled');

  const op = enabled[intInRange(rng, 0, enabled.length - 1)];

  let result;
  switch (op) {
    case 'add': {
      const { min, max } = config.ops.add;
      const a = intInRange(rng, min, max);
      const b = intInRange(rng, min, max);
      result = { op, a, b, answer: a + b, prompt: `${a} + ${b}` };
      break;
    }
    case 'sub': {
      const { min, max } = config.ops.sub;
      let a = intInRange(rng, min, max);
      let b = intInRange(rng, min, max);
      if (a < b) [a, b] = [b, a];
      result = { op, a, b, answer: a - b, prompt: `${a} − ${b}` };
      break;
    }
    case 'mul': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.mul;
      const a = intInRange(rng, lhsMin, lhsMax);
      const b = intInRange(rng, rhsMin, rhsMax);
      result = { op, a, b, answer: a * b, prompt: `${a} × ${b}` };
      break;
    }
    case 'div': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.div;
      // Generate quotient × divisor = dividend, present as dividend ÷ divisor.
      const quotient = intInRange(rng, rhsMin, rhsMax);
      const divisor = intInRange(rng, lhsMin, lhsMax);
      const dividend = quotient * divisor;
      result = { op, a: dividend, b: divisor, answer: quotient, prompt: `${dividend} ÷ ${divisor}` };
      break;
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }

  return { ...result, expectedDigits: String(result.answer).length };
}
