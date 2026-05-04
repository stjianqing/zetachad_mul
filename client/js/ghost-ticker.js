// Wall-clock-paced ghost-score advancer for challenge runs.
//
// Usage:
//   const ticker = createGhostTicker({ attempts, onUpdate, getElapsedMs });
//   ticker.start();          // begins advancing the ghost score
//   ticker.tick(myScore);    // call this whenever the recipient answers
//   ticker.stop();           // when the run ends

export function createGhostTicker({ attempts, onUpdate, getElapsedMs }) {
  const boundaries = [];
  let cumMs = 0;
  let cumScore = 0;
  for (const a of attempts) {
    cumMs += a.response_ms;
    if (a.correct) cumScore += 1;
    boundaries.push({ atMs: cumMs, score: cumScore });
  }

  let ghostScore = 0;
  let recipientScore = 0;
  let raf = null;
  let stopped = false;

  function ghostScoreAt(elapsedMs) {
    let s = 0;
    for (const b of boundaries) {
      if (b.atMs <= elapsedMs) s = b.score;
      else break;
    }
    return s;
  }

  function fire() {
    if (stopped) return;
    const elapsed = getElapsedMs();
    const newGhost = ghostScoreAt(elapsed);
    if (newGhost !== ghostScore) {
      ghostScore = newGhost;
      onUpdate({ ghostScore, recipientScore, diff: recipientScore - ghostScore });
    }
    raf = requestAnimationFrame(fire);
  }

  return {
    start() {
      stopped = false;
      raf = requestAnimationFrame(fire);
      onUpdate({ ghostScore, recipientScore, diff: 0 });
    },
    tick(newRecipientScore) {
      recipientScore = newRecipientScore;
      onUpdate({ ghostScore, recipientScore, diff: recipientScore - ghostScore });
    },
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    }
  };
}
