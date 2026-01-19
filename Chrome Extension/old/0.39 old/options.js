// options.js
const fileUrlEl = document.getElementById('fileUrl');
const postUrlEl = document.getElementById('postUrl');
const delayEl = document.getElementById('delay');
const maxConcEl = document.getElementById('maxConcurrent');
const tokenEl = document.getElementById('token');
const debugEl = document.getElementById('debug');
const statusEl = document.getElementById('status');

document.getElementById('save').addEventListener('click', () => {
  const cfg = {
    FILE_FETCH_URL: fileUrlEl.value.trim(),
    POST_BACK_URL: postUrlEl.value.trim(),
    INITIAL_DELAY_MIN: Number(delayEl.value) || 5,
    MAX_CONCURRENT: Number(maxConcEl.value) || 3
  };
  const token = tokenEl.value.trim();
  const debug = !!debugEl.checked;
  chrome.storage.local.set({ CONFIG: cfg, AUTH_TOKEN: token, DEBUG: debug }, () => {
    statusEl.textContent = 'Saved.';
    setTimeout(()=>statusEl.textContent='',2000);
  });
});

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.local.remove(['CONFIG','AUTH_TOKEN','DEBUG'], () => { loadValues(); statusEl.textContent='Reset.'; setTimeout(()=>statusEl.textContent='',2000); });
});

function loadValues() {
  chrome.storage.local.get(['CONFIG','AUTH_TOKEN','DEBUG'], res => {
    const cfg = res.CONFIG || {};
    fileUrlEl.value = cfg.FILE_FETCH_URL || '';
    postUrlEl.value = cfg.POST_BACK_URL || '';
    delayEl.value = (cfg.INITIAL_DELAY_MIN !== undefined) ? cfg.INITIAL_DELAY_MIN : 5;
    maxConcEl.value = (cfg.MAX_CONCURRENT !== undefined) ? cfg.MAX_CONCURRENT : 3;
    tokenEl.value = res.AUTH_TOKEN || '';
    debugEl.checked = !!res.DEBUG;
  });
}
loadValues();