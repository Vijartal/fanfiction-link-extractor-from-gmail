// popup.js
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const messageEl = document.getElementById('message');
const logEl = document.getElementById('log');
const debugContainer = document.getElementById('debugContainer');

document.getElementById('start').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'START' }));
document.getElementById('abort').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ABORT' }));
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('refresh').addEventListener('click', requestStatus);

function updateUI(s) {
  statusEl.textContent = 'Status: ' + (s.status || 'idle');
  progressEl.textContent = 'Resolved: ' + (s.completed || 0) + ' / ' + (s.total || 0);
  messageEl.textContent = s.message || '';
  if (s.lastErrorSample) appendLog('SAMPLE: ' + s.lastErrorSample.slice(0,800));
}

function appendLog(line) {
  const now = new Date().toISOString();
  logEl.textContent = now + '  ' + line + '\n' + logEl.textContent;
}

function requestStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res => {
    const s = (res && res.status) ? res.status : null;
    if (s) updateUI(s);
    chrome.storage.local.get('DEBUG', data => {
      const debug = !!data.DEBUG;
      debugContainer.style.display = debug ? 'block' : 'none';
      if (debug) appendLog('Refreshed status.');
    });
  });
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'STATUS' && msg.state) {
    updateUI(msg.state);
    chrome.storage.local.get('DEBUG', data => { if (data.DEBUG) appendLog(JSON.stringify(msg.state).slice(0,400)); });
  }
});
// Trigger configured Apps Script that runs the extractor (no prompt)
document.getElementById('triggerScript').addEventListener('click', () => {
  if (!confirm('Trigger the Apps Script that runs the extractor now?')) return;
  messageEl.textContent = 'Triggering Apps Script...';
  chrome.runtime.sendMessage({ type: 'CALL_RUN_SCRIPT' }, (res) => {
    if (!res) { messageEl.textContent = 'No response.'; return; }
    if (res.ok) messageEl.textContent = 'Run triggered: ' + (res.text || '(no response body)');
    else messageEl.textContent = 'Trigger failed: ' + (res.error || 'unknown');
  });
});

// Clear drive documents — destructive, asks for confirmation
document.getElementById('clearDrive').addEventListener('click', () => {
  if (!confirm('This will clear the Drive documents containing links. Are you sure?')) return;
  messageEl.textContent = 'Sending clear request...';
  chrome.runtime.sendMessage({ type: 'CALL_CLEAR_DRIVE' }, (res) => {
    if (!res) { messageEl.textContent = 'No response.'; return; }
    if (res.ok) messageEl.textContent = 'Clear request OK: ' + (res.text || '');
    else messageEl.textContent = 'Clear failed: ' + (res.error || 'unknown');
  });
});
requestStatus();