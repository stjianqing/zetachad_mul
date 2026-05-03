// Frozen weakness-cluster definitions. Single source of truth for both
// the analyzer (which buckets attempts) and the generator (which biases
// question selection within a cluster's bounds).
//
// GLOBAL_P50 values are population-wide medians per op, frozen from the
// 2026-05-03 production dataset (8 users, 4332 attempts). Re-derive when
// the dataset 10×s. The values are subtracted in scoring to normalize
// across ops (mul is inherently slower than add, etc.).

export const GLOBAL_P50 = Object.freeze({
  add: 2125,
  sub: 1898,
  mul: 2661,
  div: 2820
});

// Times-table difficulty groups (apply to mul lhs and div divisor).
const EASY_TABLES = new Set([2, 5, 10]);
const MED_TABLES  = new Set([3, 4, 6, 11]);
const HARD_TABLES = new Set([7, 8, 9, 12]);

function tableGroup(n) {
  if (EASY_TABLES.has(n)) return 'easy';
  if (MED_TABLES.has(n))  return 'med';
  if (HARD_TABLES.has(n)) return 'hard';
  return null;
}

// Cluster bounds — used by the generator to sample operands within a cluster.
// For mul: lhsValues = the small "table" operand, rhsRange = the partner.
// For div: lhsValues = the divisor, rhsRange = the dividend (presented as dividend ÷ divisor).
// For add/sub: maxRange = bound on max(lhs, rhs); both operands sampled in [2, max].
export const CLUSTER_BOUNDS = Object.freeze({
  // Multiplication
  mul_easy_small: { op: 'mul', lhsValues: [2, 5, 10],     rhsMin: 2,  rhsMax: 30  },
  mul_easy_large: { op: 'mul', lhsValues: [2, 5, 10],     rhsMin: 31, rhsMax: 100 },
  mul_med_small:  { op: 'mul', lhsValues: [3, 4, 6, 11],  rhsMin: 2,  rhsMax: 30  },
  mul_med_large:  { op: 'mul', lhsValues: [3, 4, 6, 11],  rhsMin: 31, rhsMax: 100 },
  mul_hard_small: { op: 'mul', lhsValues: [7, 8, 9, 12],  rhsMin: 2,  rhsMax: 30  },
  mul_hard_large: { op: 'mul', lhsValues: [7, 8, 9, 12],  rhsMin: 31, rhsMax: 100 },
  // Division
  div_easy_small: { op: 'div', divisorValues: [2, 5, 10],     dividendMin: 2,   dividendMax: 300  },
  div_easy_large: { op: 'div', divisorValues: [2, 5, 10],     dividendMin: 301, dividendMax: 1200 },
  div_med_small:  { op: 'div', divisorValues: [3, 4, 6, 11],  dividendMin: 2,   dividendMax: 300  },
  div_med_large:  { op: 'div', divisorValues: [3, 4, 6, 11],  dividendMin: 301, dividendMax: 1200 },
  div_hard_small: { op: 'div', divisorValues: [7, 8, 9, 12],  dividendMin: 2,   dividendMax: 300  },
  div_hard_large: { op: 'div', divisorValues: [7, 8, 9, 12],  dividendMin: 301, dividendMax: 1200 },
  // Addition
  add_small: { op: 'add', maxMin: 2,  maxMax: 20  },
  add_med:   { op: 'add', maxMin: 21, maxMax: 50  },
  add_large: { op: 'add', maxMin: 51, maxMax: 100 },
  // Subtraction
  sub_small: { op: 'sub', maxMin: 2,  maxMax: 20  },
  sub_med:   { op: 'sub', maxMin: 21, maxMax: 50  },
  sub_large: { op: 'sub', maxMin: 51, maxMax: 100 }
});

export const CLUSTER_LABELS = Object.freeze({
  mul_easy_small: 'Multiplying 2, 5 or 10 by numbers up to 30',
  mul_easy_large: 'Multiplying 2, 5 or 10 by numbers above 30',
  mul_med_small:  'Multiplying 3, 4, 6 or 11 by numbers up to 30',
  mul_med_large:  'Multiplying 3, 4, 6 or 11 by numbers above 30',
  mul_hard_small: 'Multiplying 7, 8, 9 or 12 by numbers up to 30',
  mul_hard_large: 'Multiplying 7, 8, 9 or 12 by numbers above 30',
  div_easy_small: 'Dividing by 2, 5 or 10, dividends up to 300',
  div_easy_large: 'Dividing by 2, 5 or 10, dividends above 300',
  div_med_small:  'Dividing by 3, 4, 6 or 11, dividends up to 300',
  div_med_large:  'Dividing by 3, 4, 6 or 11, dividends above 300',
  div_hard_small: 'Dividing by 7, 8, 9 or 12, dividends up to 300',
  div_hard_large: 'Dividing by 7, 8, 9 or 12, dividends above 300',
  add_small: 'Adding numbers up to 20',
  add_med:   'Adding numbers between 21 and 50',
  add_large: 'Adding numbers above 50',
  sub_small: 'Subtracting numbers up to 20',
  sub_med:   'Subtracting numbers between 21 and 50',
  sub_large: 'Subtracting numbers above 50'
});

/**
 * Map a single attempt (op, lhs, rhs) to a cluster id, or null if it doesn't
 * belong to any defined cluster (e.g. div with divisor>12 — out of default config).
 *
 * For mul: the "table" operand is whichever of (lhs, rhs) falls in 2..12.
 * For div: lhs=dividend, rhs=divisor (per generator.js convention).
 * For add/sub: bucketed by max(lhs, rhs).
 */
export function bucketize(op, lhs, rhs) {
  if (op === 'mul') {
    // Determine which operand is the "table" (small) and which is the partner.
    let table, partner;
    if (lhs >= 2 && lhs <= 12) { table = lhs; partner = rhs; }
    else if (rhs >= 2 && rhs <= 12) { table = rhs; partner = lhs; }
    else return null;
    const grp = tableGroup(table);
    if (!grp) return null;
    const sizeBucket = partner <= 30 ? 'small' : 'large';
    return `mul_${grp}_${sizeBucket}`;
  }

  if (op === 'div') {
    // attempts.lhs=dividend, attempts.rhs=divisor
    const divisor = rhs;
    if (divisor < 2 || divisor > 12) return null;
    const grp = tableGroup(divisor);
    if (!grp) return null;
    const sizeBucket = lhs <= 300 ? 'small' : 'large';
    return `div_${grp}_${sizeBucket}`;
  }

  if (op === 'add' || op === 'sub') {
    const m = Math.max(lhs, rhs);
    let bucket;
    if (m <= 20) bucket = 'small';
    else if (m <= 50) bucket = 'med';
    else bucket = 'large';
    return `${op}_${bucket}`;
  }

  return null;
}
