import { api } from './api.js';
import { createGhostTicker } from './ghost-ticker.js';

const WORSHIP_FIRST = ["ALL HAIL", "BEHOLD", "KNEEL BEFORE", "PRAISE BE TO", "GLORY TO", "WITNESS"];
const WORSHIP_OTHER = ["BEHOLD", "WITNESS", "PRESENTING", "ENTER"];
const POST_DONE = [
  "see you tomorrow.",
  "today's run: locked.",
  "the overlords have seen enough.",
  "you've been counted.",
  "go touch grass."
];

function todaySgtDateString() {
  const now = new Date();
  const sgtMs = now.getTime() + 8 * 60 * 60 * 1000;
  return new Date(sgtMs).toISOString().slice(0, 10);
}

function dateStringToSeed(s) { return Number(s.replace(/-/g, '')); }
function pickByDate(table, dateString) { return table[dateStringToSeed(dateString) % table.length]; }

function formatTimeMs(ms) {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

const params = new URLSearchParams(location.search);
const challengeId = params.has('challenge') ? Number(params.get('challenge')) : null;
const rematchTarget = params.get('rematch_target');

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
  playAgain: () => document.getElementById('play-again'),
  modePill: () => document.getElementById('mode-pill')
};

const state = {
  sessionId: null,
  config: null,
  mode: 'guest',
  dailyGauntlet: false,
  authedUser: null,
  isDefaultConfig: true,
  timeLimitMs: 0,
  startedAt: 0,
  finished: false,
  finalScore: 0,
  currentAnswer: null,
  peekQuestion: null,
  timerExpired: false,
  practice: false,
  totalQuestions: null,
  questionIndex: 0,
  isChallenge: false,
  challengeId: null,
  ghostTicker: null,
  lastRunId: null
};

function readPracticeSession() {
  try {
    const raw = sessionStorage.getItem('zc_practice_session');
    if (!raw) return null;
    sessionStorage.removeItem('zc_practice_session');
    return JSON.parse(raw);
  } catch { return null; }
}

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
  if (state.dailyGauntlet) {
    els.timer().textContent = formatTimeMs(elapsed);
    const frac = state.questionIndex / state.totalQuestions;
    els.bar().style.transform = `scaleX(${frac})`;
    requestAnimationFrame(tickClock);
    return;
  }
  const remaining = Math.max(0, state.timeLimitMs - elapsed);
  els.timer().textContent = Math.ceil(remaining / 1000);
  els.bar().style.transform = `scaleX(${remaining / state.timeLimitMs})`;
  if (remaining <= 10_000) els.timer().classList.add('low');
  if (remaining > 0) {
    requestAnimationFrame(tickClock);
  } else if (!state.timerExpired) {
    state.timerExpired = true;
    finalizeOnTimeout();
  }
}

async function finalizeOnTimeout() {
  let r;
  try { r = await api.answer(state.sessionId, ''); }
  catch (ex) { finish({ final_score: state.finalScore }); return; }
  if (r && r.time_up) finish(r);
  else finish({ final_score: state.finalScore });
}

async function startDailyGauntlet() {
  state.dailyGauntlet = true;
  state.mode = 'user';
  state.isDefaultConfig = true;

  let r;
  try { r = await api.startDailyGauntlet(); }
  catch (e) {
    if (e.status === 401) { location.href = 'register.html'; return; }
    alert('Could not start daily gauntlet: ' + e.message);
    location.href = 'index.html';
    return;
  }

  if (r.already_completed) {
    location.href = 'index.html';
    return;
  }
  if (r.already_started) {
    location.href = 'index.html?forfeit=1';
    return;
  }

  state.sessionId = r.session_id;
  state.totalQuestions = r.total_questions;
  state.questionIndex = r.question_index;
  state.timeLimitMs = null;
  state.startedAt = performance.now();

  els.modePill().classList.remove('hidden');
  els.prompt().textContent = r.question.prompt;
  els.timer().textContent = '0:00';
  els.score().textContent = `${state.questionIndex} / ${state.totalQuestions}`;
  state.currentAnswer = r.question.answer;
  state.peekQuestion = r.peek_question;
  requestAnimationFrame(tickClock);
}

async function startChallenge(id) {
  // Verify auth, then accept the challenge to get the ghost data + seed.
  try { state.authedUser = (await api.me()).user; } catch { state.authedUser = null; }
  if (!state.authedUser) {
    location.href = `register.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }

  let acceptPayload;
  const stashed = sessionStorage.getItem(`zc_challenge_${id}_redeem`);
  if (stashed) {
    sessionStorage.removeItem(`zc_challenge_${id}_redeem`);
    acceptPayload = JSON.parse(stashed);
  } else {
    try {
      acceptPayload = await api.challenges.accept(id);
    } catch (e) {
      if (e.status === 404) {
        // Already accepted/declined/etc. — bounce to result page.
        location.href = `result.html?id=${id}`;
        return;
      }
      alert('Could not accept challenge: ' + e.message);
      location.href = 'index.html';
      return;
    }
  }

  let startRes;
  try { startRes = await api.startChallenge(id); }
  catch (e) {
    alert('Could not start challenge: ' + e.message);
    location.href = 'index.html';
    return;
  }

  state.isChallenge = true;
  state.challengeId = id;
  state.mode = 'user';
  state.isDefaultConfig = true;
  state.sessionId = startRes.session_id;
  state.timeLimitMs = startRes.time_limit_ms;
  state.currentAnswer = startRes.question.answer;
  state.peekQuestion = startRes.peek_question;
  state.startedAt = performance.now();

  els.prompt().textContent = startRes.question.prompt;
  els.timer().textContent = Math.ceil(startRes.time_limit_ms / 1000);

  // Set up ghost ticker.
  const ghostRow = document.getElementById('ghost-row');
  ghostRow.hidden = false;
  const ghostScoreEl = document.getElementById('ghost-score');
  const ghostDiffEl = document.getElementById('ghost-diff');
  state.ghostTicker = createGhostTicker({
    attempts: acceptPayload.challenger_attempts,
    getElapsedMs: () => performance.now() - state.startedAt,
    onUpdate({ ghostScore, recipientScore, diff }) {
      ghostScoreEl.textContent = String(ghostScore);
      ghostDiffEl.textContent = diff > 0 ? `+${diff}` : String(diff);
      ghostDiffEl.classList.toggle('ahead', diff > 0);
      ghostDiffEl.classList.toggle('behind', diff < 0);
    }
  });
  state.ghostTicker.start();
  requestAnimationFrame(tickClock);
}

async function start() {
  if (challengeId !== null) {
    return startChallenge(challengeId);
  }

  const url = new URL(location.href);
  if (url.searchParams.get('mode') === 'daily-gauntlet') {
    try { state.authedUser = (await api.me()).user; } catch {}
    if (!state.authedUser) { location.href = 'register.html'; return; }
    return startDailyGauntlet();
  }

  const practice = readPracticeSession();
  if (practice) {
    try { state.authedUser = (await api.me()).user; } catch { state.authedUser = null; }
    state.practice = true;
    state.mode = 'user';
    state.isDefaultConfig = true;
    state.sessionId = practice.sessionId;
    state.timeLimitMs = practice.timeLimitMs;
    state.startedAt = performance.now();
    els.prompt().textContent = practice.question.prompt;
    els.timer().textContent = Math.ceil(practice.timeLimitMs / 1000);
    state.currentAnswer = practice.question.answer;
    state.peekQuestion = practice.peekQuestion;
    document.getElementById('practice-badge').classList.remove('hidden');
    requestAnimationFrame(tickClock);
    return;
  }

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
  state.currentAnswer = r.question.answer;
  state.peekQuestion = r.peek_question;
  requestAnimationFrame(tickClock);
}

function submitCorrectAnswer(value) {
  if (state.peekQuestion == null) {
    return submitAnswerAwaited(value);
  }
  const advancedTo = state.peekQuestion;
  state.currentAnswer = advancedTo.answer;
  state.peekQuestion = null;
  els.input().value = '';
  els.prompt().textContent = advancedTo.prompt;
  els.input().classList.add('correct');
  setTimeout(() => els.input().classList.remove('correct'), 220);
  postAnswer(value);
}

async function postAnswer(value) {
  let r;
  try { r = await api.answer(state.sessionId, value); }
  catch (ex) {
    if (ex.status === 404) { alert('Server hiccuped — please start a new run.'); location.href = 'index.html'; return; }
    return;
  }
  if (r.time_up) return finish(r);
  if (state.dailyGauntlet && typeof r.question_index === 'number') {
    state.questionIndex = r.question_index;
    els.score().textContent = `${state.questionIndex} / ${state.totalQuestions}`;
  } else {
    els.score().textContent = r.score;
    state.finalScore = r.score;
    if (state.isChallenge && state.ghostTicker) {
      state.ghostTicker.tick(state.finalScore);
    }
  }
  state.peekQuestion = r.peek_question;
}

async function submitAnswerAwaited(value) {
  if (state.finished || state.timerExpired) return;
  els.input().value = '';
  let r;
  try { r = await api.answer(state.sessionId, value); }
  catch (ex) {
    if (ex.status === 404) { alert('Server hiccuped — please start a new run.'); location.href = 'index.html'; return; }
    return;
  }
  if (r.time_up) return finish(r);
  if (state.dailyGauntlet && typeof r.question_index === 'number') {
    state.questionIndex = r.question_index;
    els.score().textContent = `${state.questionIndex} / ${state.totalQuestions}`;
  } else {
    els.score().textContent = r.score;
    state.finalScore = r.score;
    if (state.isChallenge && state.ghostTicker) {
      state.ghostTicker.tick(state.finalScore);
    }
  }
  els.prompt().textContent = r.next_question.prompt;
  state.currentAnswer = r.next_question.answer;
  state.peekQuestion = r.peek_question;
  if (r.correct) {
    els.input().classList.add('correct');
    setTimeout(() => els.input().classList.remove('correct'), 220);
  }
}

function onInput() {
  if (state.finished || state.timerExpired) return;
  if (state.currentAnswer == null) return;
  const value = els.input().value;
  if (!/^-?\d+$/.test(value)) return;
  if (Number(value) !== state.currentAnswer) return;
  submitCorrectAnswer(value);
}

async function finish(payload) {
  state.finished = true;
  state.lastRunId = payload?.run_id ?? null;
  document.body.classList.remove('drilling');
  els.form().classList.add('hidden');
  document.querySelector('.drill-bar').classList.add('hidden');
  document.querySelector('.time-bar').classList.add('hidden');
  els.scoreScreen().classList.remove('hidden');

  if (state.isChallenge) {
    state.ghostTicker?.stop();
    if (payload.run_id != null) {
      api.challenges.submitRun(state.challengeId, payload.run_id)
        .catch(err => console.error('submitRun failed', err))
        .finally(() => { location.href = `result.html?id=${state.challengeId}`; });
      return;
    }
    // No run_id — something went wrong. Bounce home.
    location.href = 'index.html';
    return;
  }

  if (state.dailyGauntlet && payload.daily_gauntlet) {
    await renderDailyGauntletScoreView(payload);
    return;
  }

  state.finalScore = payload.final_score ?? state.finalScore;
  els.finalScore().textContent = state.finalScore;

  // Difficulty for practice runs comes from the implicit submit below; for normal
  // runs it comes from the user's manual submit. In both cases we wait for the
  // submit response. Until then, hide the row.
  showDifficulty(null);

  if (state.practice) {
    els.postNote().textContent = 'Practice complete — your updated weak spots will be ready next time you visit Practice.';
    const actions = els.scoreScreen().querySelector('.actions');
    actions.innerHTML = '';
    const a1 = document.createElement('a');
    a1.className = 'primary';
    a1.href = 'practice.html';
    a1.textContent = 'Practice again';
    const a2 = document.createElement('a');
    a2.className = 'secondary';
    a2.href = 'index.html';
    a2.textContent = 'Play normally';
    actions.appendChild(a1);
    actions.appendChild(a2);
    api.submit(state.sessionId).then((r) => {
      showDifficulty(r?.difficulty ?? null);
    }).catch(() => {});
    return;
  }

  if (state.authedUser && state.isDefaultConfig) {
    showSubmitModal();
  } else if (!state.authedUser) {
    els.postNote().textContent = 'Log in to submit scores to the leaderboard.';
  } else {
    els.postNote().textContent = 'Custom runs aren\'t eligible for the leaderboard.';
  }

  maybeShowChallengeBlock();

  els.playAgain().addEventListener('click', () => { location.href = 'index.html'; });
}

function setChallengeStatus(msg) {
  const el = document.getElementById('challenge-status');
  if (el) el.textContent = msg;
}

function maybeShowChallengeBlock() {
  const eligible = state.authedUser != null
    && state.isDefaultConfig
    && !state.practice
    && !state.dailyGauntlet
    && !state.isChallenge
    && state.lastRunId != null;
  if (!eligible) return;
  const block = document.getElementById('challenge-block');
  if (!block) return;
  block.hidden = false;

  if (rematchTarget) {
    const usernameInput = document.getElementById('challenge-username');
    if (usernameInput) usernameInput.value = rematchTarget;
    const header = block.querySelector('h3');
    if (header) header.textContent = `REMATCH: ${rematchTarget}`;
    setTimeout(() => document.getElementById('challenge-send')?.focus(), 0);
  }

  document.getElementById('challenge-send').onclick = async () => {
    const username = document.getElementById('challenge-username').value.trim();
    if (!username) return;
    if (username.toLowerCase() === state.authedUser.username.toLowerCase()) {
      setChallengeStatus("can't challenge yourself.");
      return;
    }
    try {
      await api.challenges.create({ challenger_run_id: state.lastRunId, recipient_username: username });
      block.querySelector('#challenge-form').remove();
      block.querySelector('.or-sep').remove();
      block.querySelector('#challenge-share-link').remove();
      setChallengeStatus(`challenge sent to ${username}. they'll see it next time they're here.`);
    } catch (e) {
      if (e.status === 404) setChallengeStatus(`no user named "${username}".`);
      else if (e.status === 400) setChallengeStatus(e.body?.error ?? 'cannot send challenge.');
      else setChallengeStatus('something broke. try again.');
    }
  };

  document.getElementById('challenge-share-link').onclick = async () => {
    try {
      const r = await api.challenges.create({ challenger_run_id: state.lastRunId, share_link: true });
      const url = window.location.origin + r.share_url;
      const ok = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
      setChallengeStatus(ok
        ? `link copied — anyone with this link gets one shot at your run.`
        : url);
    } catch (e) {
      setChallengeStatus('failed to generate link.');
    }
  };
}

async function renderDailyGauntletScoreView(payload) {
  const today = todaySgtDateString();
  const username = state.authedUser?.username ?? 'you';

  const screen = els.scoreScreen();

  const verb = payload.rank === 1
    ? pickByDate(WORSHIP_FIRST, today)
    : pickByDate(WORSHIP_OTHER, today);
  const subtitle = payload.rank === 1
    ? `today's arithmetic overlord · cleared in ${formatTimeMs(payload.time_ms)}`
    : `cleared in ${formatTimeMs(payload.time_ms)} · #${payload.rank} today`;

  screen.innerHTML = `
    <h1 class="daily-finish-headline">${escapeHtml(verb)} ${escapeHtml(username)}</h1>
    <p class="daily-finish-sub">${escapeHtml(subtitle)}</p>
    <div class="daily-finish-time">[ ${formatTimeMs(payload.time_ms)} ]</div>
    <h2>TODAY'S DAILY LEADERBOARD</h2>
    <ol class="daily-board-list" id="score-daily-board"><li class="dim">Loading…</li></ol>
    <div class="actions">
      <a class="secondary" href="index.html">← Back to drill</a>
      <a class="primary" href="leaderboard.html#daily">View all rankings →</a>
    </div>
  `;

  let board;
  try { board = await api.dailyBoard(); }
  catch { document.getElementById('score-daily-board').innerHTML = '<li class="dim">Could not load leaderboard.</li>'; return; }

  const list = document.getElementById('score-daily-board');
  const items = board.entries.slice(0, 5).map((e, i) => {
    if (i === 0) {
      const v = pickByDate(WORSHIP_FIRST, today);
      return `<li class="overlord">${v} <strong>${escapeHtml(e.username)}</strong> · today's arithmetic overlord · ${formatTimeMs(e.time_ms)}</li>`;
    }
    const isYou = e.username === username;
    return `<li${isYou ? ' class="you"' : ''}>${i + 1}. ${escapeHtml(e.username)} <span class="dim">·</span> ${formatTimeMs(e.time_ms)}</li>`;
  });

  if (payload.rank > 5) {
    items.push(`<li class="you">${payload.rank}. you <span class="dim">·</span> ${formatTimeMs(payload.time_ms)}</li>`);
  }

  list.innerHTML = items.join('');
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
      showDifficulty(r?.difficulty ?? null);
    } catch (ex) {
      if (ex.status === 401) {
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

function showDifficulty(d) {
  const el = document.getElementById('run-difficulty');
  if (!el) return;
  if (d == null) {
    el.classList.add('hidden');
    return;
  }
  const tier = d <= 4 ? 'easy' : d <= 6 ? 'mid' : d <= 8 ? 'hard' : 'extreme';
  el.className = `run-difficulty diff-${tier}`;
  el.textContent = `Run difficulty: ${d.toFixed(1)} / 10`;
}

document.addEventListener('DOMContentLoaded', () => {
  els.form().addEventListener('submit', (e) => e.preventDefault());
  els.input().addEventListener('input', onInput);
  start();
});
