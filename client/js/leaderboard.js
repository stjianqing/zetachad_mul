import { api } from './api.js';

function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
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

document.addEventListener('DOMContentLoaded', async () => {
  let me = null;
  try { me = (await api.me()).user; } catch {}
  renderUserArea(me);

  try {
    const { entries } = await api.board();
    document.getElementById('rows').innerHTML = rowsHtml(entries, me);
  } catch (e) {
    document.getElementById('rows').innerHTML = `<tr><td colspan="5">Could not load: ${escapeHtml(e.message)}</td></tr>`;
  }
});
