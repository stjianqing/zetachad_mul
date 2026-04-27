import { adminApi, sgtDate } from './admin-api.js';
import { renderHeatmap } from './heatmap.js';
import { renderChart } from './chart.js';

const els = {
  playerPicker: document.getElementById('player-picker'),
  windowPicker: document.getElementById('window-picker'),
  activitySection: document.getElementById('activity-section'),
  activityTable: document.getElementById('activity-table'),
  scoreChart: document.getElementById('score-chart'),
  perOpCards: document.getElementById('per-op-cards'),
  slowest: document.getElementById('slowest-table'),
  leastAccurate: document.getElementById('least-accurate-table'),
  heatmapMul: document.getElementById('heatmap-mul'),
  heatmapMulTip: document.getElementById('heatmap-mul-tip'),
  heatmapDiv: document.getElementById('heatmap-div'),
  heatmapDivTip: document.getElementById('heatmap-div-tip'),
  sessionsTable: document.getElementById('sessions-table'),
  sessionDetail: document.getElementById('session-detail')
};

const state = { userId: null, window: 'all' };

async function loadPlayers() {
  const { players } = await adminApi.players();
  els.playerPicker.innerHTML = '<option value="">All players</option>' +
    players.map(p => `<option value="${p.user_id}">${escape(p.username)} (${p.run_count})</option>`).join('');
  // Activity table for "All players"
  els.activityTable.innerHTML =
    '<thead><tr><th>Player</th><th>Runs</th><th>Best</th><th>Last played (SGT)</th><th>Attempts</th></tr></thead>' +
    '<tbody>' + players.map(p =>
      `<tr><td>${escape(p.username)}</td><td>${p.run_count}</td><td>${p.best_score}</td><td>${p.last_played_at ? sgtDate(p.last_played_at) : ''}</td><td>${p.total_attempts}</td></tr>`
    ).join('') + '</tbody>';
}

async function refresh() {
  const userId = state.userId;
  els.activitySection.classList.toggle('hidden', userId != null);

  const [chart, perOp, weak, mul, div, runs] = await Promise.all([
    adminApi.scoreTimeSeries({ user_id: userId, window: state.window }),
    adminApi.perOp({ user_id: userId }),
    adminApi.weakSpots({ user_id: userId }),
    adminApi.heatmap('mul', { user_id: userId }),
    adminApi.heatmap('div', { user_id: userId }),
    adminApi.runs({ user_id: userId, limit: 100 })
  ]);

  renderChart(els.scoreChart, chart.points);
  renderPerOp(perOp.per_op);
  renderWeakSpots(weak);
  renderHeatmap(els.heatmapMul, els.heatmapMulTip, mul.cells);
  renderHeatmap(els.heatmapDiv, els.heatmapDivTip, div.cells);
  renderSessions(runs.runs);

  els.sessionDetail.innerHTML = '';
}

function renderPerOp(rows) {
  const byOp = new Map(rows.map(r => [r.op, r]));
  const ops = ['add', 'sub', 'mul', 'div'];
  els.perOpCards.innerHTML = ops.map(op => {
    const r = byOp.get(op);
    if (!r) return `<div class="op-card"><h4>${op}</h4><dl><dt>—</dt><dd>no data</dd></dl></div>`;
    return `<div class="op-card">
      <h4>${op}</h4>
      <dl>
        <dt>Attempts</dt><dd>${r.attempts}</dd>
        <dt>Accuracy</dt><dd>${r.accuracy_pct}%</dd>
        <dt>Mean</dt><dd>${r.mean_response_ms}ms</dd>
        <dt>Median</dt><dd>${r.median_response_ms}ms</dd>
      </dl>
    </div>`;
  }).join('');
}

function renderWeakSpots({ slowest, least_accurate }) {
  els.slowest.innerHTML =
    '<thead><tr><th>Op</th><th>L</th><th>R</th><th>n</th><th>Mean ms</th></tr></thead>' +
    '<tbody>' + (slowest.length ? slowest.map(r =>
      `<tr><td>${r.op}</td><td>${r.lhs}</td><td>${r.rhs}</td><td>${r.attempts}</td><td>${r.mean_response_ms}</td></tr>`
    ).join('') : '<tr><td colspan="5">No buckets with ≥10 attempts yet.</td></tr>') + '</tbody>';
  els.leastAccurate.innerHTML =
    '<thead><tr><th>Op</th><th>L</th><th>R</th><th>n</th><th>Acc %</th></tr></thead>' +
    '<tbody>' + (least_accurate.length ? least_accurate.map(r =>
      `<tr><td>${r.op}</td><td>${r.lhs}</td><td>${r.rhs}</td><td>${r.attempts}</td><td>${r.accuracy_pct}</td></tr>`
    ).join('') : '<tr><td colspan="5">No buckets with ≥10 attempts yet.</td></tr>') + '</tbody>';
}

function renderSessions(runs) {
  els.sessionsTable.innerHTML =
    '<thead><tr><th>Played (SGT)</th><th>Player</th><th>Score</th><th>Acc %</th><th>Mean ms</th><th>On board</th></tr></thead>' +
    '<tbody>' + runs.map(r =>
      `<tr class="expandable" data-run-id="${r.run_id}">
        <td>${sgtDate(r.played_at)}</td>
        <td>${escape(r.username)}</td>
        <td>${r.score}</td>
        <td>${r.accuracy_pct}</td>
        <td>${r.mean_response_ms}</td>
        <td>${r.submitted_to_leaderboard ? '✓' : ''}</td>
      </tr>`
    ).join('') + '</tbody>';
  els.sessionsTable.querySelectorAll('tr.expandable').forEach(row => {
    row.addEventListener('click', () => loadDetail(Number(row.dataset.runId)));
  });
}

async function loadDetail(runId) {
  const { run, attempts } = await adminApi.attempts(runId);
  els.sessionDetail.innerHTML =
    `<h3>Run ${run.run_id} — ${escape(run.username)} — ${sgtDate(run.played_at)}</h3>
     <table>
       <thead><tr><th>#</th><th>Prompt</th><th>Answer</th><th>You typed</th><th>ms</th><th>OK</th></tr></thead>
       <tbody>` +
       attempts.map(a =>
         `<tr><td>${a.q_index + 1}</td><td>${escape(promptFor(a))}</td><td>${a.answer}</td><td>${escape(a.user_answer ?? '')}</td><td>${a.response_ms}</td><td>${a.correct ? '✓' : '✗'}</td></tr>`
       ).join('') +
     '</tbody></table>';
}

function promptFor(a) {
  const sym = { add: '+', sub: '−', mul: '×', div: '÷' }[a.op] || '?';
  return `${a.lhs} ${sym} ${a.rhs}`;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

els.playerPicker.addEventListener('change', () => {
  const v = els.playerPicker.value;
  state.userId = v === '' ? null : Number(v);
  refresh();
});
els.windowPicker.addEventListener('change', () => {
  state.window = els.windowPicker.value;
  refresh();
});

(async () => {
  await loadPlayers();
  await refresh();
})();
