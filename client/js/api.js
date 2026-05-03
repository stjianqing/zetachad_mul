const API_BASE = '/api';

async function request(method, path, body) {
  const hasBody = body != null;
  const res = await fetch(API_BASE + path, {
    method,
    credentials: 'same-origin',
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  me:        () => request('GET',  '/me'),
  register:  ({ username, password }) => request('POST', '/register', { username, password }),
  login:     ({ username, password }) => request('POST', '/login',    { username, password }),
  logout:    () => request('POST', '/logout'),
  startPlay: (config) => request('POST', '/play/start',  { config }),
  startDailyGauntlet: () => request('POST', '/play/start', { mode: 'daily-gauntlet' }),
  answer:    (session_id, answer) => request('POST', '/play/answer', { session_id, answer }),
  submit:    (session_id) => request('POST', '/leaderboard/submit', { session_id }),
  board:     () => request('GET',  '/leaderboard'),
  champion:  () => request('GET',  '/leaderboard/champion'),
  speed:     () => request('GET',  '/leaderboard/speed'),
  dailyBoard: (date) => request('GET', '/leaderboard/daily' + (date ? `?date=${date}` : '')),
  dailyMe:   () => request('GET', '/leaderboard/daily/me')
};
