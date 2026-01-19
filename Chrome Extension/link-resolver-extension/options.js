// options.js — corrected and functional
const fileUrlEl = document.getElementById('fileUrl');
const postUrlEl = document.getElementById('postUrl');
const delayEl = document.getElementById('delay');
const maxConcEl = document.getElementById('maxConcurrent');
const windowModeEl = document.getElementById('windowMode');
const checkIntervalEl = document.getElementById('checkIntervalMs');
const tokenEl = document.getElementById('token');
const debugEl = document.getElementById('debug');
const statusEl = document.getElementById('status');
const runScriptEl = document.getElementById('runScriptUrl');
const clearDriveEl = document.getElementById('clearDriveUrl');

document.getElementById('save').addEventListener('click', () => {
  // Build config object from inputs
  const cfg = {
    FILE_FETCH_URL: fileUrlEl.value.trim(),
    POST_BACK_URL: postUrlEl.value.trim(),
    INITIAL_DELAY_MIN: Number(delayEl.value) || 5,
    MAX_CONCURRENT: Number(maxConcEl.value) || 3,
    WINDOW_MODE: windowModeEl.value || 'normal',
    CHECK_INTERVAL_MS: Number(checkIntervalEl.value) || 8000,
    RUN_SCRIPT_URL: runScriptEl.value.trim(),
    CLEAR_DRIVE_URL: clearDriveEl.value.trim()
  };

  const token = tokenEl.value.trim();
  const debug = !!debugEl.checked;

  // Persist to local storage
  chrome.storage.local.set({ CONFIG: cfg, AUTH_TOKEN: token, DEBUG: debug }, () => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = 'Save failed: ' + chrome.runtime.lastError.message;
      statusEl.style.color = '#b33';
    } else {
      statusEl.textContent = 'Saved.';
      statusEl.style.color = '#2a7';
      setTimeout(() => statusEl.textContent = '', 2000);
    }
  });
});

document.getElementById('reset').addEventListener('click', () => {
  if (!confirm('Reset settings to defaults?')) return;
  chrome.storage.local.remove(['CONFIG','AUTH_TOKEN','DEBUG'], () => {
    loadValues();
    statusEl.textContent = 'Reset.';
    setTimeout(() => statusEl.textContent = '', 2000);
  });
});

function loadValues() {
  chrome.storage.local.get(['CONFIG','AUTH_TOKEN','DEBUG'], res => {
    const cfg = res.CONFIG || {};
    fileUrlEl.value = cfg.FILE_FETCH_URL || '';
    postUrlEl.value = cfg.POST_BACK_URL || '';
    delayEl.value = (cfg.INITIAL_DELAY_MIN !== undefined) ? cfg.INITIAL_DELAY_MIN : 5;
    maxConcEl.value = (cfg.MAX_CONCURRENT !== undefined) ? cfg.MAX_CONCURRENT : 3;
    windowModeEl.value = (cfg.WINDOW_MODE !== undefined) ? cfg.WINDOW_MODE : 'normal';
    checkIntervalEl.value = (cfg.CHECK_INTERVAL_MS !== undefined) ? cfg.CHECK_INTERVAL_MS : 8000;
    tokenEl.value = res.AUTH_TOKEN || '';
    debugEl.checked = !!res.DEBUG;
    runScriptEl.value = cfg.RUN_SCRIPT_URL || '';
    clearDriveEl.value = cfg.CLEAR_DRIVE_URL || '';
  });
}

loadValues();
