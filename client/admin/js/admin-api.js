const BASE = '/admin/api';

async function get(path) {
  const res = await fetch(BASE + path, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = new Error(`http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const adminApi = {
  players:        ()                       => get('/players'),
  runs:           (q = {})                 => get('/runs' + qs(q)),
  attempts:       (runId)                  => get(`/runs/${runId}/attempts`),
  perOp:          (q = {})                 => get('/per-op' + qs(q)),
  heatmap:        (op, q = {})             => get('/heatmap' + qs({ op, ...q })),
  weakSpots:      (q = {})                 => get('/weak-spots' + qs(q)),
  scoreTimeSeries:(q = {})                 => get('/score-timeseries' + qs(q))
};

function qs(obj) {
  const parts = Object.entries(obj).filter(([, v]) => v != null && v !== '');
  return parts.length ? '?' + parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
}

const fmtSGT = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});

export function sgtDate(iso) {
  return fmtSGT.format(new Date(iso));
}
