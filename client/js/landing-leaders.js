import { api } from './api.js';

const OP_META = {
  add: { sym: '+', label: 'Addition' },
  sub: { sym: '−', label: 'Subtraction' },
  mul: { sym: '×', label: 'Multiplication' },
  div: { sym: '÷', label: 'Division' }
};

const RANK_TITLES = ['ZETA', 'BETA', 'GAMMA'];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderChampion(champ) {
  const el = document.getElementById('champion-banner');
  if (!el) return;
  if (!champ) {
    el.innerHTML = `
      <div class="champ-crown">_/^^^\\_</div>
      <div class="champ-body">
        <div class="champ-title">THE THRONE IS VACANT</div>
        <div class="champ-sub">first to score wins it</div>
      </div>`;
    el.classList.add('vacant');
    return;
  }
  el.innerHTML = `
    <div class="champ-crown">_/^^^\\_</div>
    <div class="champ-body">
      <div class="champ-title">ALL HAIL <span class="champ-name">${escapeHtml(champ.username)}</span></div>
      <div class="champ-sub">supreme arithmetic overlord · ${champ.score} pts</div>
    </div>`;
}

function renderSpeed(speed) {
  const grid = document.getElementById('speed-grid');
  if (!grid) return;
  grid.innerHTML = ['add', 'sub', 'mul', 'div'].map((op) => {
    const meta = OP_META[op];
    const list = (speed[op] ?? []);
    const rows = list.length === 0
      ? `<li class="speed-empty">no qualifiers yet</li>`
      : list.map((e, i) => `
          <li class="speed-row">
            <span class="speed-rank">${RANK_TITLES[i] ?? '#' + (i + 1)}</span>
            <span class="speed-name">${escapeHtml(e.username)}</span>
            <span class="speed-time">${(e.avgMs / 1000).toFixed(2)}s</span>
          </li>`).join('');
    return `
      <div class="speed-card" data-op="${op}">
        <div class="speed-head"><span class="speed-sym">${meta.sym}</span> ${meta.label}</div>
        <ol class="speed-list">${rows}</ol>
      </div>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  const [champRes, speedRes] = await Promise.allSettled([api.champion(), api.speed()]);
  if (champRes.status === 'fulfilled') renderChampion(champRes.value.champion);
  else document.getElementById('champion-banner')?.classList.add('hidden');
  if (speedRes.status === 'fulfilled') renderSpeed(speedRes.value);
  else document.getElementById('speed-kings')?.classList.add('hidden');
});
