import { api } from './api.js';
import { initChallengesHome } from './challenges-home.js';

const DEFAULT_CONFIG = {
  ops: {
    add: { enabled: true, min: 2, max: 100 },
    sub: { enabled: true, min: 2, max: 100 },
    mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
    div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
  },
  durationMs: 120_000
};

// Mirror of server/src/copy/gauntlet-copy.js — kept in sync manually.
const PRE_TAUNTS = [
  "Don't choke.",
  "Try not to embarrass yourself.",
  "Show us your worth.",
  "Pretend you can do math.",
  "One shot. Make it count.",
  "Time to find out who you really are.",
  "The numbers are watching.",
  "No second chances. No mercy.",
  "Step up or step aside.",
  "Today's not the day to be average.",
  "Math waits for no one.",
  "Prove you deserve to be here.",
  "The overlords demand tribute.",
  "Glory or shame. Pick one.",
  "Today's questions don't care about your feelings.",
  "Sixty problems. One you. Good luck.",
  "Whatever you do, don't second-guess yourself.",
  "The leaderboard hungers."
];

const POST_DONE = [
  "see you tomorrow.",
  "today's run: locked.",
  "the overlords have seen enough.",
  "you've been counted.",
  "go touch grass."
];

const WORSHIP_FIRST = ["ALL HAIL", "BEHOLD", "KNEEL BEFORE", "PRAISE BE TO", "GLORY TO", "WITNESS"];

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

function readCustomConfig() {
  const v = (name) => Number(document.querySelector(`[name="${name}"]`).value);
  const c = (name) => document.querySelector(`[name="${name}"]`).checked;
  const duration = v('duration');
  return {
    ops: {
      add: { enabled: c('add_enabled'), min: v('add_min'), max: v('add_max') },
      sub: { enabled: c('sub_enabled'), min: v('sub_min'), max: v('sub_max') },
      mul: { enabled: c('mul_enabled'), lhsMin: v('mul_lhsMin'), lhsMax: v('mul_lhsMax'), rhsMin: v('mul_rhsMin'), rhsMax: v('mul_rhsMax') },
      div: { enabled: c('div_enabled'), lhsMin: v('div_lhsMin'), lhsMax: v('div_lhsMax'), rhsMin: v('div_rhsMin'), rhsMax: v('div_rhsMax') }
    },
    durationMs: duration * 1000
  };
}

function renderUserArea(user) {
  const el = document.getElementById('user-area');
  if (user) {
    el.innerHTML = `<span class="user-chip">${user.username} <a href="#" id="logout">log out</a></span>`;
    document.getElementById('logout').addEventListener('click', async (e) => {
      e.preventDefault();
      const link = e.currentTarget;
      if (link.dataset.busy === '1') return;
      link.dataset.busy = '1';
      link.textContent = 'logging out…';
      link.style.pointerEvents = 'none';
      try { await api.logout(); }
      catch (ex) { console.warn('logout request failed; navigating anyway', ex); }
      location.href = location.pathname;
    });
  } else {
    el.innerHTML = `<a href="login.html">Log in</a> <a href="register.html">Register</a>`;
  }
}

function setEligibility(advancedOpen) {
  const badge = document.getElementById('eligibility');
  if (!badge) return;
  if (advancedOpen) {
    badge.textContent = 'custom run — not eligible';
    badge.classList.add('dim');
  } else {
    badge.textContent = 'leaderboard-eligible';
    badge.classList.remove('dim');
  }
}

function startGame(mode /* 'user' | 'guest' */) {
  const advancedOpen = document.getElementById('advanced').open;
  const config = advancedOpen ? readCustomConfig() : DEFAULT_CONFIG;
  sessionStorage.setItem('zc_config', JSON.stringify(config));
  sessionStorage.setItem('zc_mode', mode);
  location.href = 'play.html';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

async function renderDailyHero(user) {
  const hero = document.getElementById('daily-hero');
  const titleEl = document.getElementById('daily-hero-title');
  const subEl = document.getElementById('daily-hero-sub');
  const btn = document.getElementById('daily-hero-btn');
  const today = todaySgtDateString();

  if (!user) {
    hero.dataset.state = 'guest';
    titleEl.textContent = 'DAILY CHALLENGE — register to play.';
    subEl.textContent = 'One shot a day. Worldwide ranking.';
    btn.textContent = 'REGISTER →';
    btn.disabled = false;
    btn.addEventListener('click', () => { location.href = 'register.html'; });
    return;
  }

  let me = null;
  try { me = await api.dailyMe(); } catch { /* default to "ready" */ }

  if (me && me.played) {
    hero.dataset.state = 'completed';
    titleEl.textContent = `CLEARED IN ${formatTimeMs(me.time_ms)} — ${pickByDate(POST_DONE, today)}`;
    try {
      const board = await api.dailyBoard();
      if (board.entries.length > 0) {
        const top = board.entries[0];
        const verb = pickByDate(WORSHIP_FIRST, today);
        subEl.textContent = `Today's overlord: ${verb} ${top.username} · ${formatTimeMs(top.time_ms)}`;
      } else {
        subEl.textContent = 'You posted today\'s only run. Lonely at the top.';
      }
    } catch { subEl.textContent = ''; }
    btn.textContent = '✓ DONE';
    btn.disabled = true;
    return;
  }

  hero.dataset.state = 'ready';
  titleEl.textContent = `DAILY CHALLENGE — ${pickByDate(PRE_TAUNTS, today)}`;
  subEl.textContent = '60 questions, 1 shot. Same drill worldwide today.';
  btn.textContent = 'START';
  btn.disabled = false;
  btn.addEventListener('click', () => { location.href = 'play.html?mode=daily-gauntlet'; });
}

async function renderDailyBoardWidget(user) {
  const list = document.getElementById('daily-board-list');
  let board, me;
  try {
    board = await api.dailyBoard();
    if (user) {
      try { me = await api.dailyMe(); } catch {}
    }
  } catch (ex) {
    list.innerHTML = `<li class="dim">Could not load today's leaderboard.</li>`;
    return;
  }

  if (board.entries.length === 0) {
    list.innerHTML = `<li class="dim">Nobody's stepped up yet today.</li>`;
    return;
  }

  const today = todaySgtDateString();
  const top5 = board.entries.slice(0, 5);
  const items = top5.map((e, i) => {
    if (i === 0) {
      const verb = pickByDate(WORSHIP_FIRST, today);
      return `<li class="overlord">${verb} <strong>${escapeHtml(e.username)}</strong> · today's arithmetic overlord · ${formatTimeMs(e.time_ms)}</li>`;
    }
    return `<li>${i + 1}. ${escapeHtml(e.username)} <span class="dim">·</span> ${formatTimeMs(e.time_ms)}</li>`;
  });

  if (me && me.played && me.rank > 5) {
    items.push(`<li class="you">${me.rank}. you <span class="dim">·</span> ${formatTimeMs(me.time_ms)}</li>`);
  }

  list.innerHTML = items.join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.duration-card .quick-picks button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector('[name="duration"]').value = b.dataset.secs;
    });
  });

  const adv = document.getElementById('advanced');
  if (adv) adv.addEventListener('toggle', () => setEligibility(adv.open));

  document.getElementById('start-guest').addEventListener('click', () => startGame('guest'));
  document.getElementById('start-user').addEventListener('click', async () => {
    const advancedOpen = document.getElementById('advanced').open;
    const config = advancedOpen ? readCustomConfig() : DEFAULT_CONFIG;
    sessionStorage.setItem('zc_config', JSON.stringify(config));
    sessionStorage.setItem('zc_mode', 'user');
    let me = null;
    try { me = (await api.me()).user; } catch {}
    if (!me) {
      location.href = `login.html?next=${encodeURIComponent('play')}`;
      return;
    }
    location.href = 'play.html';
  });

  let user = null;
  try { user = (await api.me()).user; } catch {}
  renderUserArea(user);
  await renderDailyHero(user);
  await renderDailyBoardWidget(user);
  if (user) {
    initChallengesHome().catch(err => console.error('challenges-home init failed', err));
  }
});
