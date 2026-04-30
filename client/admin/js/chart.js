// SVG line chart for score-over-time with cohort median + per-player toggleable series.
// points: [{ played_at, score, username }] — already sorted ascending
// options: { showCohort?: boolean (default true), visiblePlayers?: Set<string>, sgtDate?: (iso)=>string }

const COLORS = ['#58a6ff', '#56d364', '#f1e05a', '#ff7b72', '#bc8cff', '#79c0ff'];
const COHORT_COLOR = '#e6edf3';

export function renderChart(container, points, options = {}) {
  container.innerHTML = '';
  if (points.length === 0) {
    container.textContent = 'No runs yet.';
    return;
  }

  const showCohort = options.showCohort !== false;
  const visiblePlayers = options.visiblePlayers ?? new Set();
  const sgtDate = options.sgtDate ?? ((iso) => new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', month: 'short', day: '2-digit' }));

  const W = container.clientWidth || 800;
  const H = 240;
  const PAD_L = 44, PAD_R = 12, PAD_T = 12, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const ts = points.map(p => +new Date(p.played_at));
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const tSpan = Math.max(1, tMax - tMin);
  const sMax = Math.max(1, ...points.map(p => p.score));

  const x = (t) => PAD_L + ((t - tMin) / tSpan) * innerW;
  const y = (s) => PAD_T + innerH - (s / sMax) * innerH;

  // Group raw points by player
  const byPlayer = new Map();
  for (const p of points) {
    if (!byPlayer.has(p.username)) byPlayer.set(p.username, []);
    byPlayer.get(p.username).push(p);
  }

  // Build cohort median per SGT day
  const cohort = cohortMedianByDay(points);

  // Y gridlines: 0, 1/4, 1/2, 3/4, max
  const yTicks = [0, sMax * 0.25, sMax * 0.5, sMax * 0.75, sMax].map(v => Math.round(v));

  // X ticks: 5 evenly spaced timestamps
  const xTickCount = 5;
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) xTicks.push(tMin + (tSpan * i) / (xTickCount - 1));

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">`;

  // Y gridlines + labels
  for (const v of yTicks) {
    const yy = y(v);
    svg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="#21262d" stroke-width="1" />`;
    svg += `<text x="${PAD_L - 6}" y="${yy + 4}" fill="#8b949e" font-size="11" text-anchor="end">${v}</text>`;
  }
  // X ticks (date labels)
  for (const t of xTicks) {
    const xx = x(t);
    svg += `<text x="${xx}" y="${H - PAD_B + 16}" fill="#8b949e" font-size="11" text-anchor="middle">${sgtDate(new Date(t).toISOString())}</text>`;
  }

  const seriesIndex = []; // { name, color, points: [{x,y,score,date}] }

  // Cohort series (drawn first, drawn slightly thicker)
  if (showCohort && cohort.length > 1) {
    const pts = cohort.map(c => ({
      x: x(+new Date(c.day + 'T00:00:00+08:00')),
      y: y(c.median),
      score: c.median,
      date: c.day
    }));
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    svg += `<path d="${d}" stroke="${COHORT_COLOR}" stroke-width="2.5" fill="none" />`;
    for (const p of pts) {
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${COHORT_COLOR}" />`;
    }
    seriesIndex.push({ name: 'Cohort median', color: COHORT_COLOR, points: pts });
  }

  // Per-player series (only if visible)
  let cIdx = 0;
  for (const [name, pts] of byPlayer) {
    const color = COLORS[cIdx++ % COLORS.length];
    if (!visiblePlayers.has(name)) continue;
    const xy = pts.map(p => ({
      x: x(+new Date(p.played_at)),
      y: y(p.score),
      score: p.score,
      date: sgtDate(p.played_at)
    }));
    const d = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    svg += `<path d="${d}" stroke="${color}" stroke-width="1.5" fill="none" opacity="0.9" />`;
    for (const p of xy) {
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}" />`;
    }
    seriesIndex.push({ name, color, points: xy });
  }

  // Hover guideline + tooltip group (CSS-driven via JS later)
  svg += `<line id="chart-guideline" x1="0" y1="${PAD_T}" x2="0" y2="${H - PAD_B}" stroke="#30363d" stroke-width="1" style="display:none" />`;
  svg += `<g id="chart-tooltip" style="display:none"></g>`;
  svg += '</svg>';
  container.innerHTML = svg;

  // Wire hover behavior
  const svgEl = container.querySelector('svg');
  const guide = svgEl.querySelector('#chart-guideline');
  const tip = svgEl.querySelector('#chart-tooltip');
  svgEl.addEventListener('mousemove', (e) => {
    const rect = svgEl.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    if (px < PAD_L || px > W - PAD_R) { guide.style.display = 'none'; tip.style.display = 'none'; return; }
    guide.setAttribute('x1', px); guide.setAttribute('x2', px);
    guide.style.display = '';
    // Find nearest point in each series
    const lines = [];
    for (const s of seriesIndex) {
      let best = null, bestDist = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.x - px);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      if (best && bestDist < 30) lines.push({ name: s.name, color: s.color, score: best.score, date: best.date });
    }
    if (lines.length === 0) { tip.style.display = 'none'; return; }
    // Build tooltip
    const lineH = 14, padY = 6, padX = 8;
    const boxW = 160, boxH = padY * 2 + lines.length * lineH + (lines[0].date ? lineH : 0);
    let tx = px + 10;
    if (tx + boxW > W - PAD_R) tx = px - boxW - 10;
    const ty = PAD_T + 6;
    let inner = `<rect x="${tx}" y="${ty}" width="${boxW}" height="${boxH}" fill="#0d1117" stroke="#30363d" rx="4" />`;
    inner += `<text x="${tx + padX}" y="${ty + padY + lineH - 2}" fill="#8b949e" font-size="11">${lines[0].date}</text>`;
    lines.forEach((ln, i) => {
      const y0 = ty + padY + (i + 1) * lineH;
      inner += `<circle cx="${tx + padX + 4}" cy="${y0 - 4}" r="3" fill="${ln.color}" />`;
      inner += `<text x="${tx + padX + 14}" y="${y0}" fill="#e6edf3" font-size="11">${ln.name}: ${ln.score}</text>`;
    });
    tip.innerHTML = inner;
    tip.style.display = '';
  });
  svgEl.addEventListener('mouseleave', () => { guide.style.display = 'none'; tip.style.display = 'none'; });
}

function cohortMedianByDay(points) {
  const byDay = new Map();
  for (const p of points) {
    const day = sgtDateOnly(p.played_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p.score);
  }
  return [...byDay.entries()]
    .map(([day, scores]) => {
      scores.sort((a, b) => a - b);
      return { day, median: scores[Math.floor(scores.length / 2)], n: scores.length };
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

function sgtDateOnly(iso) {
  // YYYY-MM-DD in SGT
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date(iso));
}
