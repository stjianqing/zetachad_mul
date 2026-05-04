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
  startChallenge: (challengeId) => request('POST', '/play/start', { mode: 'challenge', challenge_id: challengeId }),
  answer:    (session_id, answer) => request('POST', '/play/answer', { session_id, answer }),
  submit:    (session_id) => request('POST', '/leaderboard/submit', { session_id }),
  board:     () => request('GET',  '/leaderboard'),
  champion:  () => request('GET',  '/leaderboard/champion'),
  speed:     () => request('GET',  '/leaderboard/speed'),
  dailyBoard: (date) => request('GET', '/leaderboard/daily' + (date ? `?date=${date}` : '')),
  dailyMe:   () => request('GET', '/leaderboard/daily/me'),
  challenges: {
    create:       (body) => request('POST', '/challenges', body),
    incoming:     () => request('GET',  '/challenges/incoming'),
    outgoing:     () => request('GET',  '/challenges/outgoing'),
    accept:       (id) => request('POST', `/challenges/${id}/accept`),
    decline:      (id) => request('POST', `/challenges/${id}/decline`),
    submitRun:    (id, recipientRunId) => request('POST', `/challenges/${id}/submit-run`, { recipient_run_id: recipientRunId }),
    byToken:      (token) => request('GET',  `/challenges/by-token/${encodeURIComponent(token)}`),
    redeemToken:  (token) => request('POST', `/challenges/by-token/${encodeURIComponent(token)}/redeem`),
    result:       (id) => request('GET',  `/challenges/${id}/result`)
  }
};
