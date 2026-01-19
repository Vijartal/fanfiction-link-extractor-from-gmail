// progress.js
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const detailsEl = document.getElementById('details');
const currentContainer = document.getElementById('currentLinks');
document.getElementById('abort').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ABORT' }));

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]);
  });
}

function renderCurrent(current) {
  // current may be: undefined, '', string, or array of strings
  currentContainer.innerHTML = '';
  if (!current || (Array.isArray(current) && current.length === 0) || (typeof current === 'string' && current.trim() === '')) {
    currentContainer.textContent = '—';
    return;
  }

  const items = Array.isArray(current) ? current : [current];

  // Display up to 12 items, collapse otherwise with "... and N more"
  const maxShow = 12;
  const toShow = items.slice(0, maxShow);
  for (const u of toShow) {
    const div = document.createElement('div');
    div.className = 'current-item';
    const text = (u && u.length > 220) ? (u.slice(0, 120) + '…' + u.slice(-80)) : u;
    div.innerHTML = escapeHtml(text);
    // clickable — open in new tab for inspection
    div.addEventListener('click', () => {
      try { window.open(u, '_blank'); } catch (e) {}
    });
    currentContainer.appendChild(div);
  }
  if (items.length > maxShow) {
    const more = document.createElement('div');
    more.className = 'small';
    more.style.marginTop = '6px';
    more.textContent = `… and ${items.length - maxShow} more`;
    currentContainer.appendChild(more);
  }
}

function applyState(s) {
  statusEl.textContent = (s.message||'Status') + ' (' + (s.status||'') + ')';
  progressEl.textContent = 'Resolved: ' + (s.completed||0) + ' / ' + (s.total||0);
  // Accept s.current as either string or array
  if (s.current !== undefined) renderCurrent(s.current);
  else currentContainer.textContent = '—';
  if (s.linksFound && s.linksFound.length) detailsEl.textContent = 'Links: ' + s.linksFound.length;
  else detailsEl.textContent = '';
}

chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'STATUS' && msg.state) applyState(msg.state); });
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res => { if (res && res.status) applyState(res.status); });
