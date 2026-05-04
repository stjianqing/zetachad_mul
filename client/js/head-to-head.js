const OP_GLYPH = { add: '+', sub: '−', mul: '×', div: '÷' };

export function renderHeadToHead(container, { challenger, recipient, viewerIs }) {
  const cAttempts = challenger.attempts ?? [];
  const rAttempts = recipient.attempts ?? [];
  const maxLen = Math.max(cAttempts.length, rAttempts.length);

  let html = `
    <table class="h2h-table">
      <thead>
        <tr>
          <th>Q#</th>
          <th>Question</th>
          <th>${esc(viewerIs === 'challenger' ? 'You' : challenger.username)} (ms)</th>
          <th>${esc(viewerIs === 'recipient' ? 'You' : recipient.username)} (ms)</th>
          <th>Δ</th>
        </tr>
      </thead>
      <tbody>`;

  for (let i = 0; i < maxLen; i++) {
    const ca = cAttempts.find(a => a.q_index === i);
    const ra = rAttempts.find(a => a.q_index === i);
    const ref = ca ?? ra;
    const question = ref ? `${ref.lhs} ${OP_GLYPH[ref.op] ?? ref.op} ${ref.rhs}` : '';
    const youAttempt  = viewerIs === 'challenger' ? ca : ra;
    const themAttempt = viewerIs === 'challenger' ? ra : ca;
    const youOk = youAttempt?.correct;
    const youMs = youAttempt?.response_ms;
    const themMs = themAttempt?.response_ms;
    const fasterCorrect = youOk && (themMs == null || (youMs != null && youMs < themMs));
    const slowerOrWrong = youAttempt && !youOk;
    const rowClass = fasterCorrect ? 'faster-correct' : (slowerOrWrong ? 'slower-or-wrong' : '');
    const delta = (youMs != null && themMs != null) ? (youMs - themMs) : '';
    html += `<tr class="${rowClass}">
      <td>${i + 1}</td>
      <td>${esc(question)}</td>
      <td>${cellTxt(viewerIs === 'challenger' ? ca : ra)}</td>
      <td>${cellTxt(viewerIs === 'challenger' ? ra : ca)}</td>
      <td>${delta === '' ? '' : (delta > 0 ? '+' : '') + delta}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function cellTxt(a) {
  if (!a) return '—';
  return `${a.response_ms} ${a.correct ? '✓' : '✗'}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
