import { api } from './api.js';

const params = new URLSearchParams(location.search);
const token = params.get('t');

const els = {
  loading:    document.getElementById('loading'),
  ready:      document.getElementById('ready'),
  readyTitle: document.getElementById('ready-title'),
  readyBtn:   document.getElementById('ready-btn'),
  anonNote:   document.getElementById('anon-note'),
  claimed:    document.getElementById('claimed'),
  errorState: document.getElementById('error-state')
};

(async () => {
  if (!token) {
    els.loading.textContent = 'invalid link.';
    return;
  }

  let me = null;
  try { me = (await api.me())?.user ?? null; } catch {}

  let info;
  try {
    info = await api.challenges.byToken(token);
  } catch (e) {
    els.loading.hidden = true;
    if (e.status === 410) els.claimed.hidden = false;
    else els.errorState.hidden = false;
    return;
  }

  els.readyTitle.textContent = `${info.challenger.username} CHALLENGES YOU TO BEAT ${info.challenger_score}`;
  if (!me) els.anonNote.hidden = false;
  els.loading.hidden = true;
  els.ready.hidden = false;

  els.readyBtn.onclick = async () => {
    if (!me) {
      // Anonymous: stub — punt to register, sticking the token in the URL.
      // (The full anonymous play loop is Task 20.)
      location.href = `register.html?challenge_token=${encodeURIComponent(token)}`;
      return;
    }
    let redeem;
    try {
      redeem = await api.challenges.redeemToken(token);
    } catch (e) {
      if (e.status === 410) {
        els.ready.hidden = true;
        els.claimed.hidden = false;
        return;
      }
      els.ready.hidden = true;
      els.errorState.hidden = false;
      return;
    }
    // Stash the redeem payload so play.js can skip the accept call (already accepted by redeem).
    sessionStorage.setItem(`zc_challenge_${redeem.id}_redeem`, JSON.stringify(redeem));
    // Authed: redirect to play.html?challenge=:id — play.js will consume the stashed payload.
    location.href = `play.html?challenge=${redeem.id}`;
  };
})();
