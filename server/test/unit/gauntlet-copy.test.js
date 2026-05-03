import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPreTaunt,
  pickWorshipFirst,
  pickWorshipOther,
  pickPostDone,
  PRE_TAUNTS,
  WORSHIP_FIRST_PLACE,
  WORSHIP_OTHER,
  POST_DONE
} from '../../src/copy/gauntlet-copy.js';

test('pickPreTaunt returns a string from the table', () => {
  const r = pickPreTaunt('2026-05-04');
  assert.equal(typeof r, 'string');
  assert.ok(PRE_TAUNTS.includes(r));
});

test('pickPreTaunt is idempotent for the same date', () => {
  assert.equal(pickPreTaunt('2026-05-04'), pickPreTaunt('2026-05-04'));
});

test('pickPreTaunt varies across dates', () => {
  // Sample 60 consecutive days; expect at least 2 distinct lines.
  const set = new Set();
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    set.add(pickPreTaunt(d.toISOString().slice(0, 10)));
  }
  assert.ok(set.size >= 2, `expected variation, got ${set.size} unique lines`);
});

test('all PRE_TAUNTS entries reachable across a year', () => {
  const seen = new Set();
  for (let i = 0; i < 365; i++) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    seen.add(pickPreTaunt(d.toISOString().slice(0, 10)));
  }
  assert.equal(seen.size, PRE_TAUNTS.length, 'every taunt should be hit at least once across 365 days');
});

test('pickWorshipFirst returns from WORSHIP_FIRST_PLACE table', () => {
  const r = pickWorshipFirst('2026-05-04');
  assert.ok(WORSHIP_FIRST_PLACE.includes(r));
});

test('pickWorshipOther returns from WORSHIP_OTHER table', () => {
  const r = pickWorshipOther('2026-05-04');
  assert.ok(WORSHIP_OTHER.includes(r));
});

test('pickPostDone returns from POST_DONE table', () => {
  const r = pickPostDone('2026-05-04');
  assert.ok(POST_DONE.includes(r));
});

test('PRE_TAUNTS has at least 14 entries', () => {
  assert.ok(PRE_TAUNTS.length >= 14, `got ${PRE_TAUNTS.length}`);
});
