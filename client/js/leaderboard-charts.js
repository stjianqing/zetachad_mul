// Small, focused chart module for the leaderboard page.
// Pure render functions: each clears the passed SVG element and rewrites it.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = String(text);
  return e;
}

function clear(svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }

function centeredMessage(svg, text, viewBox) {
  clear(svg);
  svg.setAttribute('viewBox', viewBox);
  const [, , w, h] = viewBox.split(' ').map(Number);
  svg.appendChild(el('text', {
    x: w / 2, y: h / 2,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    class: 'chart-empty-text'
  }, text));
}

// Round n down (floor) to the nearest step.
function floorTo(n, step) { return Math.floor(n / step) * step; }
// Round n up (ceil) to the nearest step.
function ceilTo(n, step) { return Math.ceil(n / step) * step; }

// Pick ~5 nice integer ticks for a y-axis from 0 to maxValue.
function niceYTicks(maxValue) {
  if (maxValue <= 5) return [0, 1, 2, 3, 4, 5].slice(0, maxValue + 1).concat(maxValue < 5 ? [] : []);
  const targetTicks = 5;
  const rawStep = maxValue / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceStep = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const top = Math.ceil(maxValue / niceStep) * niceStep;
  const ticks = [];
  for (let v = 0; v <= top; v += niceStep) ticks.push(v);
  return ticks;
}

const BAR_VB_W = 720;
const BAR_VB_H = 240;
const BAR_PAD_L = 50;
const BAR_PAD_R = 20;
const BAR_PAD_T = 20;
const BAR_PAD_B = 40;

export function renderDifficultyBars(svg, runs) {
  const VB = `0 0 ${BAR_VB_W} ${BAR_VB_H}`;
  if (!runs || runs.length === 0) return centeredMessage(svg, 'No runs yet.', VB);
  const diffs = runs.map((r) => r.difficulty).filter((d) => typeof d === 'number');
  if (diffs.length === 0) return centeredMessage(svg, 'No difficulty data yet.', VB);

  // Axis range: data extent rounded out to 0.5, clamped to a minimum span of 0–4.
  const dataMin = floorTo(Math.min(...diffs), 0.5);
  const dataMax = ceilTo(Math.max(...diffs), 0.5);
  const xMin = Math.min(0, dataMin);
  const xMax = Math.max(4, dataMax);

  // 0.5-wide bins.
  const binSize = 0.5;
  const binCount = Math.round((xMax - xMin) / binSize);
  const bins = new Array(binCount).fill(0);
  for (const d of diffs) {
    let idx = Math.floor((d - xMin) / binSize);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  }
  const maxBin = Math.max(...bins, 1);
  const yTicks = niceYTicks(maxBin);
  const yTop = yTicks[yTicks.length - 1];

  clear(svg);
  svg.setAttribute('viewBox', VB);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const plotW = BAR_VB_W - BAR_PAD_L - BAR_PAD_R;
  const plotH = BAR_VB_H - BAR_PAD_T - BAR_PAD_B;
  const xToPx = (v) => BAR_PAD_L + ((v - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (v) => BAR_PAD_T + plotH - (v / yTop) * plotH;

  // Y-axis grid lines + tick labels.
  for (const t of yTicks) {
    const y = yToPx(t);
    svg.appendChild(el('line', { x1: BAR_PAD_L, y1: y, x2: BAR_PAD_L + plotW, y2: y, class: 'chart-grid' }));
    svg.appendChild(el('text', { x: BAR_PAD_L - 8, y: y + 3, 'text-anchor': 'end', class: 'chart-tick' }, String(t)));
  }

  // Bars.
  const barWidth = plotW / binCount;
  for (let i = 0; i < binCount; i++) {
    const count = bins[i];
    const x = xToPx(xMin + i * binSize) + 1;
    const w = barWidth - 2;
    if (count === 0) {
      svg.appendChild(el('rect', { x, y: yToPx(0) - 2, width: w, height: 2, class: 'chart-bar empty' }));
    } else {
      const y = yToPx(count);
      svg.appendChild(el('rect', { x, y, width: w, height: yToPx(0) - y, class: 'chart-bar' }));
      svg.appendChild(el('text', { x: x + w / 2, y: y - 4, 'text-anchor': 'middle', class: 'chart-bar-count' }, String(count)));
    }
  }

  // X-axis tick labels at every bin boundary, but skip every other if we have many bins.
  const skipEvery = binCount > 12 ? 2 : 1;
  for (let i = 0; i <= binCount; i++) {
    if (i % skipEvery !== 0) continue;
    const v = xMin + i * binSize;
    const x = xToPx(v);
    svg.appendChild(el('text', { x, y: BAR_PAD_T + plotH + 16, 'text-anchor': 'middle', class: 'chart-tick' }, v.toFixed(1)));
  }

  // Axis labels.
  svg.appendChild(el('text', {
    x: BAR_PAD_L + plotW / 2, y: BAR_VB_H - 6,
    'text-anchor': 'middle', class: 'chart-axis-label'
  }, 'DIFFICULTY'));
  svg.appendChild(el('text', {
    x: 14, y: BAR_PAD_T + plotH / 2,
    'text-anchor': 'middle', class: 'chart-axis-label',
    transform: `rotate(-90 14 ${BAR_PAD_T + plotH / 2})`
  }, 'RUNS'));
}

const SCAT_VB_W = 720;
const SCAT_VB_H = 280;
const SCAT_PAD_L = 50;
const SCAT_PAD_R = 20;
const SCAT_PAD_T = 20;
const SCAT_PAD_B = 50;

function ensureTooltip() {
  let tip = document.getElementById('chart-tooltip');
  if (tip) return tip;
  tip = document.createElement('div');
  tip.id = 'chart-tooltip';
  tip.className = 'chart-tooltip hidden';
  document.body.appendChild(tip);
  return tip;
}

function showTooltip(tip, text, evt) {
  tip.textContent = text;
  tip.classList.remove('hidden');
  const pad = 12;
  tip.style.left = `${evt.clientX + pad}px`;
  tip.style.top = `${evt.clientY + pad}px`;
}

function hideTooltip(tip) { tip.classList.add('hidden'); }

export function renderRunsScatter(svg, runs, currentUsername) {
  const VB = `0 0 ${SCAT_VB_W} ${SCAT_VB_H}`;
  if (!runs || runs.length === 0) return centeredMessage(svg, 'No runs yet.', VB);
  const usable = runs.filter((r) => typeof r.difficulty === 'number' && typeof r.score === 'number');
  if (usable.length === 0) return centeredMessage(svg, 'No difficulty data yet.', VB);

  // Y range: same auto-fit-with-min-0-to-4 as the bar chart.
  const diffs = usable.map((r) => r.difficulty);
  const yMin = Math.min(0, floorTo(Math.min(...diffs), 0.5));
  const yMax = Math.max(4, ceilTo(Math.max(...diffs), 0.5));

  // X range: 0 to ceil(max_score/5)*5.
  const scores = usable.map((r) => r.score);
  const xMin = 0;
  const xMax = Math.max(5, ceilTo(Math.max(...scores), 5));

  clear(svg);
  svg.setAttribute('viewBox', VB);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const plotW = SCAT_VB_W - SCAT_PAD_L - SCAT_PAD_R;
  const plotH = SCAT_VB_H - SCAT_PAD_T - SCAT_PAD_B;
  const xToPx = (v) => SCAT_PAD_L + ((v - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (v) => SCAT_PAD_T + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Y grid + ticks (every integer between yMin and yMax).
  for (let v = Math.ceil(yMin); v <= Math.floor(yMax); v++) {
    const y = yToPx(v);
    svg.appendChild(el('line', { x1: SCAT_PAD_L, y1: y, x2: SCAT_PAD_L + plotW, y2: y, class: 'chart-grid' }));
    svg.appendChild(el('text', { x: SCAT_PAD_L - 8, y: y + 3, 'text-anchor': 'end', class: 'chart-tick' }, String(v)));
  }

  // X grid + ticks at multiples of 5.
  const xStep = xMax > 60 ? 10 : 5;
  for (let v = 0; v <= xMax; v += xStep) {
    const x = xToPx(v);
    svg.appendChild(el('line', { x1: x, y1: SCAT_PAD_T, x2: x, y2: SCAT_PAD_T + plotH, class: 'chart-grid' }));
    svg.appendChild(el('text', { x, y: SCAT_PAD_T + plotH + 16, 'text-anchor': 'middle', class: 'chart-tick' }, String(v)));
  }

  // Axis labels.
  svg.appendChild(el('text', {
    x: SCAT_PAD_L + plotW / 2, y: SCAT_VB_H - 6,
    'text-anchor': 'middle', class: 'chart-axis-label'
  }, 'QUESTIONS COMPLETED'));
  svg.appendChild(el('text', {
    x: 14, y: SCAT_PAD_T + plotH / 2,
    'text-anchor': 'middle', class: 'chart-axis-label',
    transform: `rotate(-90 14 ${SCAT_PAD_T + plotH / 2})`
  }, 'DIFFICULTY'));

  // Sort: user's runs last, so they render on top.
  const sorted = usable.slice().sort((a, b) => {
    const au = a.username === currentUsername ? 1 : 0;
    const bu = b.username === currentUsername ? 1 : 0;
    return au - bu;
  });

  const tip = ensureTooltip();

  for (const run of sorted) {
    const isYou = run.username === currentUsername;
    const cx = xToPx(run.score);
    const cy = yToPx(run.difficulty);
    const c = el('circle', {
      cx, cy,
      r: isYou ? 5 : 4,
      class: isYou ? 'chart-dot you' : 'chart-dot'
    });
    const label = `${run.username} · ${run.score} pts · diff ${run.difficulty.toFixed(1)}`;
    c.addEventListener('mouseenter', (evt) => showTooltip(tip, label, evt));
    c.addEventListener('mousemove',  (evt) => showTooltip(tip, label, evt));
    c.addEventListener('mouseleave', () => hideTooltip(tip));
    svg.appendChild(c);
  }
}
