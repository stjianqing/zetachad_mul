// Tiny SVG line chart for score-over-time. One <path> per series.
// Input: { points: [{ played_at, score, username }] } already sorted ascending.
// Multi-player: groups by username.
export function renderChart(container, points) {
  container.innerHTML = '';
  if (points.length === 0) {
    container.textContent = 'No runs yet.';
    return;
  }

  const W = container.clientWidth || 800;
  const H = 200;
  const PAD_L = 32, PAD_R = 8, PAD_T = 8, PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const ts = points.map(p => +new Date(p.played_at));
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const tSpan = Math.max(1, tMax - tMin);
  const sMax = Math.max(1, ...points.map(p => p.score));

  const x = (t) => PAD_L + ((t - tMin) / tSpan) * innerW;
  const y = (s) => PAD_T + innerH - (s / sMax) * innerH;

  // Group by username
  const series = new Map();
  for (const p of points) {
    if (!series.has(p.username)) series.set(p.username, []);
    series.get(p.username).push(p);
  }

  const colors = ['#58a6ff', '#56d364', '#f1e05a', '#ff7b72', '#bc8cff', '#79c0ff'];

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
  // Y axis ticks (0 and sMax)
  svg += `<text x="4" y="${y(0) + 4}" fill="#8b949e" font-size="11">0</text>`;
  svg += `<text x="4" y="${y(sMax) + 4}" fill="#8b949e" font-size="11">${sMax}</text>`;
  // Lines
  let cIdx = 0;
  for (const [name, pts] of series) {
    const color = colors[cIdx++ % colors.length];
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(+new Date(p.played_at)).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
    svg += `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" />`;
    for (const p of pts) {
      svg += `<circle cx="${x(+new Date(p.played_at)).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="3" fill="${color}" />`;
    }
    if (series.size > 1) {
      svg += `<text x="${PAD_L + 4}" y="${PAD_T + 12 + (cIdx - 1) * 14}" fill="${color}" font-size="11">${name}</text>`;
    }
  }
  svg += '</svg>';
  container.innerHTML = svg;
}
