// Renders a (lhs × rhs) grid of mean response times on a canvas.
// lhs range 2..12 (11 rows), rhs range 2..100 (99 cols). Cell = 10×10 px.
const LHS_MIN = 2, LHS_MAX = 12, RHS_MIN = 2, RHS_MAX = 100;
const CELL = 10;
const ROWS = LHS_MAX - LHS_MIN + 1;
const COLS = RHS_MAX - RHS_MIN + 1;

export function renderHeatmap(canvas, tipEl, cells) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (cells.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px system-ui';
    ctx.fillText('No data', 8, 20);
    return;
  }

  const sorted = cells.map(c => c.mean_response_ms).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? sorted[0];
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
  const span = Math.max(1, p90 - p10);

  // Build a map for hover lookup
  const cellMap = new Map();
  for (const c of cells) cellMap.set(`${c.lhs},${c.rhs}`, c);

  for (const c of cells) {
    const x = (c.rhs - RHS_MIN) * CELL;
    const y = (c.lhs - LHS_MIN) * CELL;
    const t = Math.max(0, Math.min(1, (c.mean_response_ms - p10) / span));
    // Green (fast) → red (slow)
    const r = Math.round(60 + 195 * t);
    const g = Math.round(180 - 130 * t);
    const b = 60;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y, CELL, CELL);
  }

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const rhs = Math.floor(px / CELL) + RHS_MIN;
    const lhs = Math.floor(py / CELL) + LHS_MIN;
    if (lhs < LHS_MIN || lhs > LHS_MAX || rhs < RHS_MIN || rhs > RHS_MAX) {
      tipEl.textContent = '';
      return;
    }
    const c = cellMap.get(`${lhs},${rhs}`);
    if (!c) {
      tipEl.textContent = `${lhs} × ${rhs}: no data`;
    } else {
      tipEl.textContent = `${lhs} × ${rhs}: ${c.mean_response_ms}ms · ${c.attempts} attempts · ${c.accuracy_pct}%`;
    }
  };
  canvas.onmouseleave = () => { tipEl.textContent = ''; };
}
