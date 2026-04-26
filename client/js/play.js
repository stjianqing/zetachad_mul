import { api } from './api.js';

const els = {
  score: () => document.getElementById('score'),
  timer: () => document.getElementById('timer'),
  bar: () => document.getElementById('time-bar-fill'),
  prompt: () => document.getElementById('prompt-text'),
  form: () => document.getElementById('answer-form'),
  input: () => document.getElementById('answer'),
  scoreScreen: () => document.getElementById('score-screen'),
  finalScore: () => document.getElementById('final-score'),
  postNote: () => document.getElementById('post-note'),
  modalRoot: () => document.getElementById('modal-root'),
  playAgain: () => document.getElementById('play-again')
};

const state = {
  sessionId: null,
  config: null,
  mode: 'guest',  // 'user' | 'guest'
  authedUser: null,
  isDefaultConfig: true,
  timeLimitMs: 0,
  startedAt: 0,
  finished: false,
  finalScore: 0
};

function isDefaultConfig(c) {
  if (!c) return false;
  const D = {
    ops: {
      add: { enabled: true, min: 2, max: 100 },
      sub: { enabled: true, min: 2, max: 100 },
      mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
      div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
    },
    durationMs: 120_000
  };
  return JSON.stringify(c) === JSON.stringify(D);
}

function tickClock() {
  if (state.finished) return;
  const elapsed = performance.now() - state.startedAt;
  const remaining = Math.max(0, state.timeLimitMs - elapsed);
  els.timer().textContent = Math.ceil(remaining / 1000);
  els.bar().style.transform = `scaleX(${remaining / state.timeLimitMs})`;
  if (remaining <= 10_000) els.timer().classList.add('low');
  if (remaining > 0) requestAnimationFrame(tickClock);
}

async function start() {
  const cfg = JSON.parse(sessionStorage.getItem('zc_config') || 'null');
  state.config = cfg;
  state.mode = sessionStorage.getItem('zc_mode') || 'guest';
  state.isDefaultConfig = isDefaultConfig(cfg);

  if (!cfg) { location.href = 'index.html'; return; }

  try { state.authedUser = (await api.me()).user; } catch { state.authedUser = null; }

  let r;
  try { r = await api.startPlay(cfg); }
  catch (e) { alert('Could not start: ' + e.message); location.href = 'index.html'; return; }

  state.sessionId = r.session_id;
  state.timeLimitMs = r.time_limit_ms;
  state.startedAt = performance.now();
  els.prompt().textContent = r.question.prompt;
  els.timer().textContent = Math.ceil(r.time_limit_ms / 1000);
  requestAnimationFrame(tickClock);
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.finished) return;
  const value = els.input().value;
  els.input().value = '';
  let r;
  try { r = await api.answer(state.sessionId, value); }
  catch (ex) {
    if (ex.status === 404) { alert('Server hiccuped — please start a new run.'); location.href = 'index.html'; return; }
    return;
  }
  if (r.time_up) return finish(r.final_score);
  els.score().textContent = r.score;
  els.prompt().textContent = r.next_question.prompt;
  if (r.correct) {
    els.input().classList.add('correct');
    setTimeout(() => els.input().classList.remove('correct'), 220);
  }
}

function finish(finalScore) {
  state.finished = true;
  state.finalScore = finalScore;
  els.finalScore().textContent = finalScore;
  // Hide drill UI, show score screen.
  document.body.classList.remove('drilling');
  els.form().classList.add('hidden');
  document.querySelector('.drill-bar').classList.add('hidden');
  document.querySelector('.time-bar').classList.add('hidden');
  els.scoreScreen().classList.remove('hidden');

  if (state.authedUser && state.isDefaultConfig) {
    showSubmitModal();
  } else if (!state.authedUser) {
    els.postNote().textContent = 'Log in to submit scores to the leaderboard.';
  } else {
    els.postNote().textContent = 'Custom runs aren\'t eligible for the leaderboard.';
  }

  els.playAgain().addEventListener('click', () => { location.href = 'index.html'; });
}

function showSubmitModal() {
  const root = els.modalRoot();
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-bd">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">Submit score?</h2>
        <p>Submit ${state.finalScore} to the leaderboard? Your username and score will appear publicly.</p>
        <div class="actions">
          <button class="secondary" id="modal-no">No thanks</button>
          <button class="primary" id="modal-yes">Submit</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  document.getElementById('modal-no').addEventListener('click', close);
  document.getElementById('modal-yes').addEventListener('click', async () => {
    try {
      const r = await api.submit(state.sessionId);
      els.postNote().textContent = `Submitted! You are #${r.rank}.`;
    } catch (ex) {
      if (ex.status === 401) {
        // Cookie expired between play and submit. Stash for one retry.
        localStorage.setItem('zc_pending_submit', state.sessionId);
        els.postNote().textContent = 'You got logged out — log back in to submit.';
      } else if (ex.status === 422) {
        els.postNote().textContent = 'This run is not eligible for the leaderboard.';
      } else {
        els.postNote().textContent = 'Submit failed: ' + ex.message;
      }
    }
    close();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  els.form().addEventListener('submit', onSubmit);
  start();
});
