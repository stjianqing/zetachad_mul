import { api } from './api.js';

export async function initChallengesHome() {
  const [incoming, outgoing] = await Promise.all([
    api.challenges.incoming().catch(() => []),
    api.challenges.outgoing().catch(() => [])
  ]);

  const unread = outgoing.filter(o =>
    !o.challenger_seen_result &&
    (o.status === 'completed' || o.status === 'forfeited' || o.status === 'declined')
  );
  renderResultsBanner(unread);
  renderOutgoing(outgoing);
  showNextIncomingModal(incoming.slice());
}

function showNextIncomingModal(queue) {
  if (queue.length === 0) return;
  const c = queue[0];
  const root = document.getElementById('challenge-modal-root');
  root.innerHTML = `
    <div class="challenge-modal-backdrop">
      <div class="challenge-modal">
        <h2>${esc(c.challenger.username)} CHALLENGES YOU</h2>
        <p>${c.challenger_score} to beat — on the exact same questions they got.</p>
        <p><strong>One attempt. No retries.</strong></p>
        <div class="actions">
          <button data-act="accept">ACCEPT</button>
          <button data-act="decline">DECLINE</button>
          <button data-act="later">LATER</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-act="accept"]').onclick = () => {
    location.href = `play.html?challenge=${c.id}`;
  };
  root.querySelector('[data-act="decline"]').onclick = async () => {
    if (!confirm(`Decline ${c.challenger.username}'s challenge? They'll know.`)) return;
    await api.challenges.decline(c.id).catch(() => {});
    close();
    showNextIncomingModal(queue.slice(1));
  };
  root.querySelector('[data-act="later"]').onclick = () => {
    close();
    showNextIncomingModal(queue.slice(1));
  };
}

function renderResultsBanner(unreadResults) {
  const root = document.getElementById('challenge-results-banner');
  root.innerHTML = '';
  if (unreadResults.length === 0) return;
  root.classList.add('results-banner');
  for (const r of unreadResults) {
    const line = document.createElement('div');
    line.className = 'result-line';
    let txt;
    if (r.status === 'completed') {
      const verb = r.recipient_score > r.challenger_score ? 'beat'
        : r.recipient_score < r.challenger_score ? 'fell short of'
        : 'tied';
      txt = `${r.recipient_username ?? 'someone'} ${verb} your ${r.challenger_score} with ${r.recipient_score}.`;
    } else if (r.status === 'declined') {
      txt = `${r.recipient_username ?? 'they'} chickened out.`;
    } else if (r.status === 'forfeited') {
      txt = `${r.recipient_username ?? 'someone'} quit halfway through.`;
    }
    const rematchLink = r.status === 'completed' && r.recipient_username && r.recipient_score > r.challenger_score
      ? `<a href="play.html?rematch_target=${encodeURIComponent(r.recipient_username)}">REMATCH</a>`
      : '';
    line.innerHTML = `<span>${esc(txt)}</span>
      <span class="actions">
        <a href="result.html?id=${r.id}">VIEW</a>
        ${rematchLink}
      </span>`;
    root.appendChild(line);
  }
}

function renderOutgoing(outgoing) {
  const details = document.getElementById('outgoing-challenges');
  document.getElementById('outgoing-count').textContent = String(outgoing.length);
  if (outgoing.length === 0) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  const list = document.getElementById('outgoing-list');
  list.innerHTML = outgoing.map(o => {
    const target = o.recipient_username ?? `Anon link (${o.share_token?.slice(0, 6) ?? '?'}…)`;
    const age = relTime(new Date(o.created_at));
    return `<div class="outgoing-row">
      <span>${esc(target)}</span>
      <span>— ${esc(o.status)}</span>
      <span class="muted">${age}</span>
    </div>`;
  }).join('');
}

function relTime(d) {
  const diffMs = Date.now() - d.getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
