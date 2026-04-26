const API_BASE = '/api';

async function request(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
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
  answer:    (session_id, answer) => request('POST', '/play/answer', { session_id, answer }),
  submit:    (session_id) => request('POST', '/leaderboard/submit', { session_id }),
  board:     () => request('GET',  '/leaderboard')
};
