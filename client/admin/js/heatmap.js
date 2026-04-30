// Renders an 11x11 (rows × cols, both 2..12) grid of mean response times.
// For mul: rows = multiplicand (lhs), cols = multiplier (rhs).
// For div: rows = quotient, cols = divisor. Caller transforms data before passing.
//
// cells: [{ row: 2..12, col: 2..12, mean_response_ms, accuracy_pct, attempts }]
// options: { onCellClick?: (row, col) => void, highlightedCell?: {row,col}|null, label: (row,col)=>string }
//
// The label function returns the human-readable fact text shown in the tooltip.

const MIN = 2, MAX = 12;
const N = MAX - MIN + 1;        // 11
const CELL = 25;
const PAD_TOP = 18, PAD_LEFT = 22;

export function renderHeatmap(canvas, tipEl, cells, options = {}) {
  const { onCellClick, highlightedCell, label } = options;
  canvas.width = PAD_LEFT + N * CELL;
  canvas.height = PAD_TOP + N * CELL;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (cells.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px system-ui';
    ctx.fillText('No data', PAD_LEFT + 4, PAD_TOP + 16);
    return;
  }

  // Color scale anchored at P10/P90 of mean response times.
  const sorted = cells.map(c => c.mean_response_ms).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? sorted[0];
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
  const span = Math.max(1, p90 - p10);

  const cellMap = new Map();
  for (const c of cells) cellMap.set(`${c.row},${c.col}`, c);

  // Axis labels
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let col = MIN; col <= MAX; col++) {
    const x = PAD_LEFT + (col - MIN) * CELL + CELL / 2;
    ctx.fillText(String(col), x, PAD_TOP - 2);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let row = MIN; row <= MAX; row++) {
    const y = PAD_TOP + (row - MIN) * CELL + CELL / 2;
    ctx.fillText(String(row), PAD_LEFT - 4, y);
  }

  // Cells
  for (let row = MIN; row <= MAX; row++) {
    for (let col = MIN; col <= MAX; col++) {
      const x = PAD_LEFT + (col - MIN) * CELL;
      const y = PAD_TOP + (row - MIN) * CELL;
      const c = cellMap.get(`${row},${col}`);

      if (!c) {
        ctx.fillStyle = '#1c2128'; // empty
      } else {
        const t = Math.max(0, Math.min(1, (c.mean_response_ms - p10) / span));
        const r = Math.round(60 + 195 * t);
        const g = Math.round(180 - 130 * t);
        const b = 60;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      }
      ctx.fillRect(x, y, CELL - 1, CELL - 1);

      // Neutral overlay on trivial facts (diagonal where row==col, and *10 row/col)
      if (row === col || row === 10 || col === 10) {
        ctx.fillStyle = 'rgba(139, 148, 158, 0.55)';
        ctx.fillRect(x, y, CELL - 1, CELL - 1);
      }
    }
  }

  // Highlight outline (driven by list hover)
  if (highlightedCell) {
    const { row, col } = highlightedCell;
    if (row >= MIN && row <= MAX && col >= MIN && col <= MAX) {
      const x = PAD_LEFT + (col - MIN) * CELL;
      const y = PAD_TOP + (row - MIN) * CELL;
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, CELL - 3, CELL - 3);
    }
  }

  // Hover tooltip
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD_LEFT;
    const py = e.clientY - rect.top - PAD_TOP;
    if (px < 0 || py < 0) { tipEl.textContent = ''; return; }
    const col = Math.floor(px / CELL) + MIN;
    const row = Math.floor(py / CELL) + MIN;
    if (row < MIN || row > MAX || col < MIN || col > MAX) { tipEl.textContent = ''; return; }
    const c = cellMap.get(`${row},${col}`);
    const factText = label ? label(row, col) : `${row}/${col}`;
    if (!c) {
      tipEl.textContent = `${factText}: no data`;
    } else {
      tipEl.textContent = `${factText}: ${c.mean_response_ms}ms · ${c.attempts} attempts · ${c.accuracy_pct}%`;
    }
  };
  canvas.onmouseleave = () => { tipEl.textContent = ''; };

  // Click → cell coordinate
  canvas.onclick = (e) => {
    if (!onCellClick) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD_LEFT;
    const py = e.clientY - rect.top - PAD_TOP;
    if (px < 0 || py < 0) return;
    const col = Math.floor(px / CELL) + MIN;
    const row = Math.floor(py / CELL) + MIN;
    if (row < MIN || row > MAX || col < MIN || col > MAX) return;
    onCellClick(row, col);
  };
}
