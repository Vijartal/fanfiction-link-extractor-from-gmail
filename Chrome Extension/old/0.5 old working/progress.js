// progress.js
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const detailsEl = document.getElementById('details');
const currentEl = document.getElementById('currentLink');
document.getElementById('abort').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ABORT' }));

function applyState(s) {
  statusEl.textContent = (s.message||'Status') + ' (' + (s.status||'') + ')';
  progressEl.textContent = 'Resolved: ' + (s.completed||0) + ' / ' + (s.total||0);
  if (s.current) currentEl.textContent = s.current;
  else currentEl.textContent = '—';
  if (s.linksFound && s.linksFound.length) detailsEl.textContent = 'Links: ' + s.linksFound.length;
  else detailsEl.textContent = '';
}

chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'STATUS' && msg.state) applyState(msg.state); });
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res => { if (res && res.status) applyState(res.status); });
