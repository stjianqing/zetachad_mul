import { adminApi, sgtDate } from './admin-api.js';
import { renderHeatmap } from './heatmap.js';
import { renderChart } from './chart.js';

const els = {
  playerPicker: document.getElementById('player-picker'),
  windowPicker: document.getElementById('window-picker'),
  engagementStrip: document.getElementById('engagement-strip'),
  scoreChart: document.getElementById('score-chart'),
  playerChips: document.getElementById('player-chips'),
  troubleMul: document.getElementById('trouble-mul'),
  troubleDiv: document.getElementById('trouble-div'),
  heatmapMul: document.getElementById('heatmap-mul'),
  heatmapMulTip: document.getElementById('heatmap-mul-tip'),
  heatmapDiv: document.getElementById('heatmap-div'),
  heatmapDivTip: document.getElementById('heatmap-div-tip'),
  weaknessMulSummary: document.getElementById('weakness-mul-summary'),
  weaknessDivSummary: document.getElementById('weakness-div-summary'),
  addsubCards: document.getElementById('addsub-cards'),
  sessionsTable: document.getElementById('sessions-table'),
  sessionDetail: document.getElementById('session-detail')
};

const state = {
  userId: null,
  window: 'all',
  visiblePlayers: new Set(),
  scorePoints: [],
  highlight: { mul: null, div: null }  // { row, col } for currently outlined cell
};

const PLAYER_COLORS = ['#58a6ff', '#56d364', '#f1e05a', '#ff7b72', '#bc8cff', '#79c0ff'];

async function loadPlayers() {
  const { players } = await adminApi.players();
  els.playerPicker.innerHTML = '<option value="">All players</option>' +
    players.map(p => `<option value="${p.user_id}">${escape(p.username)} (${p.run_count})</option>`).join('');
  // Build chip list (one per player)
  els.playerChips.innerHTML = players.map((p, i) => {
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    return `<span class="player-chip" data-username="${escape(p.username)}" data-color="${color}" style="--chip-color:${color}">${escape(p.username)}</span>`;
  }).join('');
  els.playerChips.querySelectorAll('.player-chip').forEach(chip => {
    chip.addEventListener('click', () => togglePlayer(chip));
  });
}

function togglePlayer(chip) {
  const name = chip.dataset.username;
  if (state.visiblePlayers.has(name)) {
    state.visiblePlayers.delete(name);
    chip.classList.remove('active');
    chip.style.background = '';
  } else {
    state.visiblePlayers.add(name);
    chip.classList.add('active');
    chip.style.background = chip.dataset.color;
  }
  renderChart(els.scoreChart, state.scorePoints, { visiblePlayers: state.visiblePlayers, sgtDate });
}

async function refresh() {
  const userId = state.userId;

  const [engagement, chart, perOp, mulFacts, divFacts, mulCells, divCells, runs] = await Promise.all([
    adminApi.engagement({ user_id: userId }),
    adminApi.scoreTimeSeries({ user_id: userId, window: state.window }),
    adminApi.perOp({ user_id: userId }),
    adminApi.troubleFacts('mul', { user_id: userId }),
    adminApi.troubleFacts('div', { user_id: userId }),
    adminApi.heatmap('mul', { user_id: userId }),
    adminApi.heatmap('div', { user_id: userId }),
    adminApi.runs({ user_id: userId, limit: 100 })
  ]);

  renderEngagement(engagement);
  state.scorePoints = chart.points;
  renderChart(els.scoreChart, chart.points, { visiblePlayers: state.visiblePlayers, sgtDate });
  renderWeaknessPanel('mul', mulFacts, mulCells, perOp.per_op);
  renderWeaknessPanel('div', divFacts, divCells, perOp.per_op);
  renderAddSubCards(perOp.per_op);
  renderSessions(runs.runs);

  els.sessionDetail.innerHTML = '';
}

function renderEngagement(d) {
  const tiles = [
    { label: 'Total runs',       value: d.total_runs.toLocaleString() },
    { label: 'DAU',              value: d.dau },
    { label: 'WAU',              value: d.wau },
    { label: 'New players (7d)', value: d.new_players_7d },
    { label: 'Median score (30d)', value: d.median_score_30d ?? '—' }
  ];
  const tilesHtml = tiles.map(t => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value">${t.value}</div></div>`).join('');
  els.engagementStrip.innerHTML = tilesHtml + sparklineSvg(d.runs_per_day_30d);
}

function sparklineSvg(daily) {
  const W = 140, H = 36;
  const max = Math.max(1, ...daily.map(d => d.count));
  const bw = W / daily.length;
  const bars = daily.map((d, i) => {
    const h = (d.count / max) * (H - 2);
    return `<rect x="${i * bw}" y="${H - h}" width="${Math.max(1, bw - 1)}" height="${h}" fill="#56d364" opacity="0.8"><title>${d.date}: ${d.count}</title></rect>`;
  }).join('');
  return `<svg class="engagement-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bars}</svg>`;
}

function renderWeaknessPanel(op, troubleResp, heatmapResp, perOpRows) {
  const summaryEl = op === 'mul' ? els.weaknessMulSummary : els.weaknessDivSummary;
  const listEl    = op === 'mul' ? els.troubleMul         : els.troubleDiv;
  const canvasEl  = op === 'mul' ? els.heatmapMul         : els.heatmapDiv;
  const tipEl     = op === 'mul' ? els.heatmapMulTip      : els.heatmapDivTip;

  // Summary line: attempts · accuracy · mean ms (from per-op aggregate, not range-clipped)
  const opStat = perOpRows.find(r => r.op === op);
  if (opStat) {
    summaryEl.textContent = `${opStat.attempts.toLocaleString()} attempts · ${opStat.accuracy_pct}% accuracy · ${opStat.mean_response_ms}ms mean`;
  } else {
    summaryEl.textContent = 'No attempts yet.';
  }

  // Trouble-facts list
  const facts = troubleResp.facts;
  if (facts.length === 0) {
    listEl.innerHTML = `<div class="trouble-empty">More data needed — currently ${troubleResp.total_attempts} attempts on ${op} buckets.</div>`;
  } else {
    listEl.innerHTML = facts.map((f, i) => {
      const factText = op === 'mul'
        ? `${f.lhs} × ${f.rhs}`
        : `${f.lhs} ÷ ${f.rhs}`;  // for div, lhs=dividend, rhs=divisor
      const badgeClass = f.attempts >= 10 ? 'n-badge solid' : 'n-badge';
      // Cell coords for linking with heatmap:
      //   mul: row=lhs, col=rhs
      //   div: row=quotient=lhs/rhs, col=divisor=rhs
      const row = op === 'mul' ? f.lhs : Math.floor(f.lhs / f.rhs);
      const col = op === 'mul' ? f.rhs : f.rhs;
      return `<div class="trouble-row" data-row="${row}" data-col="${col}" data-idx="${i}">
        <span class="trouble-fact">${factText}</span>
        <span class="trouble-stat">${f.mean_response_ms}ms</span>
        <span class="trouble-stat">${f.accuracy_pct}%</span>
        <span class="${badgeClass}">n=${f.attempts}</span>
      </div>`;
    }).join('');

    // Hover row → outline cell
    listEl.querySelectorAll('.trouble-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        state.highlight[op] = { row: Number(row.dataset.row), col: Number(row.dataset.col) };
        drawHeatmap(op, heatmapResp);
      });
      row.addEventListener('mouseleave', () => {
        state.highlight[op] = null;
        drawHeatmap(op, heatmapResp);
      });
    });
  }

  drawHeatmap(op, heatmapResp);

  function drawHeatmap(opK, heatResp) {
    if (opK !== op) return;
    const cells = transformCells(op, heatResp.cells);
    const label = op === 'mul'
      ? (row, col) => `${row} × ${col}`
      : (row, col) => `${row * col} ÷ ${col}`;  // dividend ÷ divisor
    renderHeatmap(canvasEl, tipEl, cells, {
      highlightedCell: state.highlight[op],
      label,
      onCellClick: (row, col) => {
        // Find matching list row, scroll into view, flash
        const target = listEl.querySelector(`.trouble-row[data-row="${row}"][data-col="${col}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          target.classList.remove('flash');
          // Force reflow so the animation restarts
          // eslint-disable-next-line no-unused-expressions
          target.offsetWidth;
          target.classList.add('flash');
        }
      }
    });
  }
}

// Transform raw API heatmap cells into the (row, col) shape the redesigned heatmap expects.
//   mul: row = lhs (multiplicand), col = rhs (multiplier). Clip to 2..12 × 2..12.
//   div: row = quotient = lhs/rhs, col = divisor = rhs. Aggregate cells with same (row,col)
//        if multiple raw cells map to the same divisor/quotient (shouldn't happen since
//        the generator produces unique (lhs,rhs) per quotient — but defensive).
function transformCells(op, raw) {
  if (op === 'mul') {
    return raw
      .filter(c => c.lhs >= 2 && c.lhs <= 12 && c.rhs >= 2 && c.rhs <= 12)
      .map(c => ({ row: c.lhs, col: c.rhs, mean_response_ms: c.mean_response_ms, accuracy_pct: c.accuracy_pct, attempts: c.attempts }));
  }
  // div
  const out = new Map();
  for (const c of raw) {
    if (c.rhs < 2 || c.rhs > 12) continue;
    if (c.lhs % c.rhs !== 0) continue;
    const q = c.lhs / c.rhs;
    if (q < 2 || q > 12) continue;
    const key = `${q},${c.rhs}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { row: q, col: c.rhs, mean_response_ms: c.mean_response_ms, accuracy_pct: c.accuracy_pct, attempts: c.attempts });
    } else {
      const total = prev.attempts + c.attempts;
      prev.mean_response_ms = Math.round((prev.mean_response_ms * prev.attempts + c.mean_response_ms * c.attempts) / total);
      prev.accuracy_pct = Math.round(((prev.accuracy_pct * prev.attempts + c.accuracy_pct * c.attempts) / total) * 10) / 10;
      prev.attempts = total;
    }
  }
  return [...out.values()];
}

function renderAddSubCards(rows) {
  const byOp = new Map(rows.map(r => [r.op, r]));
  const ops = ['add', 'sub'];
  els.addsubCards.innerHTML = ops.map(op => {
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
