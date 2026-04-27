import { api } from './api.js';

const DEFAULT_CONFIG = {
  ops: {
    add: { enabled: true, min: 2, max: 100 },
    sub: { enabled: true, min: 2, max: 100 },
    mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
    div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
  },
  durationMs: 120_000
};

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
      const original = link.textContent;
      link.textContent = 'logging out…';
      link.style.pointerEvents = 'none';
      try {
        await api.logout();
      } catch (ex) {
        console.warn('logout request failed; navigating anyway', ex);
      }
      // Hard navigation rather than location.reload() to avoid any cached document state.
      location.href = location.pathname;
    });
  } else {
    el.innerHTML = `<a href="login.html">Log in</a> <a href="register.html">Register</a>`;
  }
}

function setEligibility(advancedOpen) {
  const badge = document.getElementById('eligibility');
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

document.addEventListener('DOMContentLoaded', async () => {
  // Wire quick-pick duration buttons.
  document.querySelectorAll('.duration-card .quick-picks button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector('[name="duration"]').value = b.dataset.secs;
    });
  });

  // Eligibility badge tracks the advanced disclosure state.
  const adv = document.getElementById('advanced');
  adv.addEventListener('toggle', () => setEligibility(adv.open));

  // Buttons.
  document.getElementById('start-guest').addEventListener('click', () => startGame('guest'));
  document.getElementById('start-user').addEventListener('click', async () => {
    let me = null;
    try { me = (await api.me()).user; } catch { /* network */ }
    if (!me) {
      location.href = `login.html?next=${encodeURIComponent('play')}`;
      return;
    }
    startGame('user');
  });

  // Top-right user area.
  try {
    const { user } = await api.me();
    renderUserArea(user);
  } catch {
    renderUserArea(null);
  }
});
