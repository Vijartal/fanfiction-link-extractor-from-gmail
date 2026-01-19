// progress.js
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const detailsEl = document.getElementById('details');
document.getElementById('abort').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ABORT' }));
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'STATUS' && msg.state) { const s=msg.state; statusEl.textContent=(s.message||'Status')+' ('+(s.status||'')+')'; progressEl.textContent='Resolved: '+(s.completed||0)+' / '+(s.total||0); if (s.linksFound && s.linksFound.length) detailsEl.textContent='Links: '+s.linksFound.length; } });
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res => { if (res && res.status) { const s=res.status; statusEl.textContent=(s.message||'Status')+' ('+(s.status||'')+')'; progressEl.textContent='Resolved: '+(s.completed||0)+' / '+(s.total||0); if (s.linksFound && s.linksFound.length) detailsEl.textContent='Links: '+s.linksFound.length; } });
