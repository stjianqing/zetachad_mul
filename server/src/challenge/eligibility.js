import { isDefaultConfig } from '../config.js';

/**
 * Check if a run is eligible to be a challenge source.
 * The runRow must include: id, user_id, seed, practice, daily_gauntlet_date, config.
 * Caller is responsible for hydrating `config` (the runs table doesn't store it).
 * For runs that have persisted attempts, config is always DEFAULT_CONFIG (see recordsAttempts in session.js).
 */
export function isRunChallengeEligible(runRow) {
  return ineligibleReason(runRow) === null;
}

export function assertEligible(runRow) {
  const reason = ineligibleReason(runRow);
  if (reason !== null) {
    const err = new Error(`run not challenge-eligible: ${reason}`);
    err.code = 'INELIGIBLE_RUN';
    err.reason = reason;
    throw err;
  }
}

function ineligibleReason(runRow) {
  if (!runRow) return 'missing';
  if (runRow.seed === null || runRow.seed === undefined) return 'no seed (legacy run)';
  if (runRow.practice === true) return 'practice run';
  if (runRow.daily_gauntlet_date != null) return 'daily-gauntlet run';
  if (!isDefaultConfig(runRow.config)) return 'non-default config';
  return null;
}
