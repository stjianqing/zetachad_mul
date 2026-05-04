import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runForfeitSweep } from '../../src/jobs/forfeit-sweep.js';

test('runForfeitSweep: WHERE clause uses COALESCE(recipient_started_at, responded_at)', async () => {
  let capturedSql = null;
  const fakePool = {
    async query(sql) {
      capturedSql = sql;
      return { rowCount: 0 };
    }
  };

  await runForfeitSweep(fakePool);

  assert.ok(capturedSql, 'should have invoked pool.query');
  assert.match(capturedSql, /COALESCE\(recipient_started_at,\s*responded_at\)/);
  assert.match(capturedSql, /status='accepted'/);
  assert.match(capturedSql, /recipient_run_id IS NULL/);
});
