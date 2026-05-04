// Drag race animation: ~20s total time-compressed regardless of input run length.

const TARGET_DURATION_MS = 20_000;

export function renderDragRace(container, { challenger, recipient, viewerIs }) {
  const challengerTimeline = buildTimeline(challenger.attempts);
  const recipientTimeline  = buildTimeline(recipient.attempts);
  const maxRunMs = Math.max(challengerTimeline.totalMs, recipientTimeline.totalMs, 1);
  const compress = TARGET_DURATION_MS / maxRunMs;

  const totalQuestions = Math.max(challenger.score, recipient.score, 1);

  container.innerHTML = `
    <div class="drag-race">
      <div class="lane ${viewerIs === 'challenger' ? 'self' : 'ghost'}" data-who="challenger">
        <div class="lane-label">${esc(challenger.username)}</div>
        <div class="lane-bar"><div class="lane-bar-fill"></div></div>
        <div class="lane-score" data-role="score">0</div>
        <div class="q-flash" data-role="flash"></div>
      </div>
      <div class="lane ${viewerIs === 'recipient' ? 'self' : 'ghost'}" data-who="recipient">
        <div class="lane-label">${esc(recipient.username)}</div>
        <div class="lane-bar"><div class="lane-bar-fill"></div></div>
        <div class="lane-score" data-role="score">0</div>
        <div class="q-flash" data-role="flash"></div>
      </div>
    </div>`;

  return play(container, challengerTimeline, recipientTimeline, totalQuestions, compress);
}

function buildTimeline(attempts) {
  let cumMs = 0;
  let cumScore = 0;
  const events = [];
  for (const a of attempts ?? []) {
    cumMs += a.response_ms;
    if (a.correct) cumScore += 1;
    events.push({ atRealMs: cumMs, score: cumScore, qIndex: a.q_index, correct: a.correct });
  }
  return { events, totalMs: cumMs };
}

function play(container, challengerTL, recipientTL, totalQuestions, compress) {
  const startedAt = performance.now();
  const lanes = {
    challenger: container.querySelector('[data-who="challenger"]'),
    recipient:  container.querySelector('[data-who="recipient"]')
  };
  const fills = {
    challenger: lanes.challenger.querySelector('.lane-bar-fill'),
    recipient:  lanes.recipient.querySelector('.lane-bar-fill')
  };
  const scoreEls = {
    challenger: lanes.challenger.querySelector('[data-role="score"]'),
    recipient:  lanes.recipient.querySelector('[data-role="score"]')
  };
  const flashEls = {
    challenger: lanes.challenger.querySelector('[data-role="flash"]'),
    recipient:  lanes.recipient.querySelector('[data-role="flash"]')
  };
  const lastFiredIdx = { challenger: -1, recipient: -1 };
  let stopped = false;
  let onDoneCb = null;

  function step() {
    if (stopped) return;
    const elapsed = performance.now() - startedAt;
    const realElapsed = elapsed / compress;

    for (const who of ['challenger', 'recipient']) {
      const tl = who === 'challenger' ? challengerTL : recipientTL;
      let latestIdx = -1;
      for (let i = 0; i < tl.events.length; i++) {
        if (tl.events[i].atRealMs <= realElapsed) latestIdx = i;
        else break;
      }
      while (lastFiredIdx[who] < latestIdx) {
        lastFiredIdx[who] += 1;
        const ev = tl.events[lastFiredIdx[who]];
        flashEls[who].textContent = `Q${ev.qIndex + 1}`;
        flashEls[who].classList.toggle('wrong', !ev.correct);
        flashEls[who].classList.add('show');
        const pinIdx = lastFiredIdx[who];
        setTimeout(() => {
          if (lastFiredIdx[who] === pinIdx) flashEls[who].classList.remove('show');
        }, 250);
      }
      const score = latestIdx >= 0 ? tl.events[latestIdx].score : 0;
      scoreEls[who].textContent = String(score);
      const widthPct = (score / Math.max(totalQuestions, 1)) * 100;
      fills[who].style.width = `${widthPct}%`;
    }

    const challengerDone = realElapsed >= challengerTL.totalMs;
    const recipientDone  = realElapsed >= recipientTL.totalMs;
    if (challengerDone && recipientDone) {
      scoreEls.challenger.textContent = String(challengerTL.events.at(-1)?.score ?? 0);
      scoreEls.recipient.textContent  = String(recipientTL.events.at(-1)?.score ?? 0);
      onDoneCb?.();
      return;
    }
    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);

  return {
    onDone(cb) { onDoneCb = cb; },
    stop() { stopped = true; }
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
