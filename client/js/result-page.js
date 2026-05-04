import { api } from './api.js';
import { renderDragRace } from './drag-race.js';
import { renderHeadToHead } from './head-to-head.js';
import { captionForResult } from './challenge-copy.js';

const params = new URLSearchParams(window.location.search);
const id = Number(params.get('id'));

const els = {
  loading:  document.getElementById('loading'),
  content:  document.getElementById('content'),
  error:    document.getElementById('error'),
  title:    document.getElementById('result-title'),
  caption:  document.getElementById('result-caption'),
  dragRace: document.getElementById('drag-race'),
  h2h:      document.getElementById('head-to-head'),
  replay:   document.getElementById('replay'),
  viewQuestions: document.getElementById('view-questions'),
  rematch:  document.getElementById('rematch')
};

(async () => {
  if (!Number.isInteger(id)) {
    show(els.error, 'invalid challenge id.');
    return;
  }
  let result;
  try {
    result = await api.challenges.result(id);
  } catch (e) {
    show(els.error, e.status === 403 ? 'not yours to see.' : 'failed to load result.');
    return;
  }

  let me = null;
  try { me = (await api.me())?.user ?? null; } catch {}
  const myUsername = me?.username ?? null;
  const viewerIs = myUsername === result.challenger.username
    ? 'challenger'
    : (myUsername === result.recipient?.username ? 'recipient' : 'unknown');

  els.title.textContent = `${result.challenger.username} vs ${result.recipient?.username ?? 'someone'}`;

  hide(els.loading);
  show(els.content);

  if (result.status === 'completed') {
    renderDragRace(els.dragRace, { challenger: result.challenger, recipient: result.recipient, viewerIs });
    els.replay.onclick = () => renderDragRace(els.dragRace, { challenger: result.challenger, recipient: result.recipient, viewerIs });
    renderHeadToHead(els.h2h, { challenger: result.challenger, recipient: result.recipient, viewerIs });

    els.viewQuestions.onclick = () => {
      els.h2h.hidden = !els.h2h.hidden;
      els.viewQuestions.textContent = els.h2h.hidden ? 'VIEW QUESTIONS' : 'HIDE QUESTIONS';
    };

    const youWon = (viewerIs === 'challenger' && result.winner === 'challenger')
      || (viewerIs === 'recipient' && result.winner === 'recipient');
    const otherUsername = viewerIs === 'challenger' ? result.recipient?.username : result.challenger.username;
    els.caption.textContent = captionForResult({
      status: result.status,
      viewerWon: youWon,
      otherUsername,
      challengeId: id
    });

    if (viewerIs === 'challenger' && result.winner === 'recipient') {
      els.rematch.hidden = false;
      els.rematch.href = `play.html?rematch_target=${encodeURIComponent(result.recipient.username)}`;
    }
  } else {
    els.replay.hidden = true;
    els.viewQuestions.hidden = true;
    els.dragRace.hidden = true;
    els.caption.textContent = captionForResult({
      status: result.status,
      viewerWon: false,
      otherUsername: result.recipient?.username,
      challengeId: id
    });
  }
})();

function show(el, msg) { el.hidden = false; if (msg !== undefined) el.textContent = msg; }
function hide(el) { el.hidden = true; }
