import { api } from './api.js';

function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimeMs(ms) {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function rowsHtml(entries, me) {
  if (entries.length === 0) {
    return `<tr><td colspan="5">No scores yet — be the first.</td></tr>`;
  }
  return entries.map((e) => {
    const youClass = me && e.username === me.username ? ' class="you"' : '';
    const diffCell = formatDiff(e.difficulty);
    return `<tr${youClass}>
      <td data-label="#">${e.rank}</td>
      <td data-label="Player">${escapeHtml(e.username)}</td>
      <td data-label="Score">${e.score}</td>
      <td data-label="Diff">${diffCell}</td>
      <td data-label="Played">${fmtDate(e.played_at)}</td>
    </tr>`;
  }).join('');
}

function formatDiff(d) {
  if (d == null) return `<span class="diff-cell diff-na">—</span>`;
  const tier = d <= 4 ? 'easy' : d <= 6 ? 'mid' : d <= 8 ? 'hard' : 'extreme';
  return `<span class="diff-cell diff-${tier}">${d.toFixed(1)}</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderUserArea(user) {
  const el = document.getElementById('user-area');
  if (user) {
    el.innerHTML = `<span class="user-chip">${escapeHtml(user.username)} <a href="#" id="logout">log out</a></span>`;
    document.getElementById('logout').addEventListener('click', async (e) => {
      e.preventDefault();
      await api.logout();
      location.reload();
    });
  } else {
    el.innerHTML = `<a href="login.html">Log in</a> <a href="register.html">Register</a>`;
  }
}

function showTab(name) {
  document.querySelectorAll('#board-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('all-time-board').classList.toggle('hidden', name !== 'all-time');
  document.getElementById('daily-board-section').classList.toggle('hidden', name !== 'daily');
}

let dailyLoaded = false;
async function loadDailyBoard() {
  if (dailyLoaded) return;
  dailyLoaded = true;
  const tbody = document.querySelector('#daily-board-table tbody');
  let board;
  try { board = await api.dailyBoard(); }
  catch { tbody.innerHTML = '<tr><td colspan="4" class="dim">Could not load.</td></tr>'; return; }
  document.getElementById('daily-board-heading').textContent = `Daily Leaderboard — ${board.date}`;
  if (board.entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="dim">Nobody has played today yet.</td></tr>';
    return;
  }
  tbody.innerHTML = board.entries.map(e => `
    <tr>
      <td data-label="#">${e.rank}</td>
      <td data-label="Player">${escapeHtml(e.username)}</td>
      <td data-label="Time">${formatTimeMs(e.time_ms)}</td>
      <td data-label="Played" class="dim">${new Date(e.played_at).toLocaleTimeString()}</td>
    </tr>
  `).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  let me = null;
  try { me = (await api.me()).user; } catch {}
  renderUserArea(me);

  document.querySelectorAll('#board-tabs .tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.tab;
      showTab(name);
      if (name === 'daily') await loadDailyBoard();
    });
  });

  if (location.hash === '#daily') {
    showTab('daily');
    loadDailyBoard();
  }

  try {
    const { entries } = await api.board();
    document.getElementById('rows').innerHTML = rowsHtml(entries, me);
  } catch (e) {
    document.getElementById('rows').innerHTML = `<tr><td colspan="5">Could not load: ${escapeHtml(e.message)}</td></tr>`;
  }
});
