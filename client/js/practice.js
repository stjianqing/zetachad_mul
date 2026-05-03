const els = {
  loading: () => document.getElementById('loading'),
  ready: () => document.getElementById('ready'),
  needMore: () => document.getElementById('need-more'),
  authRequired: () => document.getElementById('auth-required'),
  error: () => document.getElementById('error'),
  weakList: () => document.getElementById('weak-list'),
  startBtn: () => document.getElementById('start-btn'),
  retryBtn: () => document.getElementById('retry-btn')
};

function show(id) {
  for (const k of ['loading', 'ready', 'needMore', 'authRequired', 'error']) {
    els[k]().classList.toggle('hidden', k !== id);
  }
}

function formatMs(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

async function loadDiagnosis() {
  show('loading');
  let res;
  try {
    res = await fetch('/api/practice/diagnose', { credentials: 'same-origin' });
  } catch {
    show('error');
    return;
  }
  if (res.status === 401) { show('authRequired'); return; }
  if (!res.ok) { show('error'); return; }

  const data = await res.json();
  if (!data.topWeak || data.topWeak.length === 0) {
    show('needMore');
    return;
  }

  const ul = els.weakList();
  ul.innerHTML = '';
  for (const c of data.topWeak) {
    const li = document.createElement('li');
    li.className = 'weak-spot-row';
    const label = document.createElement('div');
    label.className = 'weak-label';
    label.textContent = c.label;
    const meta = document.createElement('div');
    meta.className = 'weak-meta muted';
    meta.textContent = `${c.n} attempts`;
    const time = document.createElement('div');
    time.className = 'weak-time';
    time.textContent = `${formatMs(c.avgMs)} avg`;
    const left = document.createElement('div');
    left.className = 'weak-left';
    left.appendChild(label);
    left.appendChild(meta);
    li.appendChild(left);
    li.appendChild(time);
    ul.appendChild(li);
  }
  show('ready');
}

async function startPractice() {
  els.startBtn().disabled = true;
  els.startBtn().textContent = 'Starting…';
  let res;
  try {
    res = await fetch('/api/practice/start', { method: 'POST', credentials: 'same-origin' });
  } catch {
    els.startBtn().disabled = false;
    els.startBtn().textContent = 'Start practice';
    show('error');
    return;
  }
  if (res.status === 401) { show('authRequired'); return; }
  if (res.status === 422) { show('needMore'); return; }
  if (!res.ok) { show('error'); return; }

  const data = await res.json();
  sessionStorage.setItem('zc_practice_session', JSON.stringify({
    sessionId: data.session_id,
    clusters: data.clusters,
    question: data.question,
    peekQuestion: data.peek_question,
    timeLimitMs: data.time_limit_ms
  }));
  window.location.href = '/play.html';
}

document.addEventListener('DOMContentLoaded', () => {
  els.startBtn()?.addEventListener('click', startPractice);
  els.retryBtn()?.addEventListener('click', loadDiagnosis);
  loadDiagnosis();
});
