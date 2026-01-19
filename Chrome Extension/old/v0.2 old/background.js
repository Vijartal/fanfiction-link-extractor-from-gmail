// background.js (robust, debug-enabled)
// Default configuration. Options page overrides via chrome.storage.local.CONFIG
const DEFAULT_CONFIG = {
  FILE_FETCH_URL: '', // set in Options
  POST_BACK_URL: '',  // set in Options
  INITIAL_DELAY_MIN: 5
};

const DEFAULT_STATE = {
  status: 'idle', // idle, fetching, opened, waiting, polling, completed, aborted, error
  message: 'Ready.',
  total: 0,
  completed: 0,
  linksFound: [],
  lastErrorSample: ''
};

let state = Object.assign({}, DEFAULT_STATE);
let targetWinId = null;
let progressWinId = null;
let abortFlag = false;

// Utility: persist and broadcast state
function setState(updates) {
  state = Object.assign({}, state, updates);
  chrome.storage.local.set({ EXT_STATUS: state }, () => {});
  chrome.runtime.sendMessage({ type: 'STATUS', state });
  readDebugFlag().then(debug => {
    if (debug) console.log('[LR] STATE:', state);
  });
}

// Read config & token & debug flag
function readConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['CONFIG','AUTH_TOKEN','DEBUG'], res => {
      resolve({
        cfg: Object.assign({}, DEFAULT_CONFIG, res.CONFIG || {}),
        token: res.AUTH_TOKEN || '',
        debug: !!res.DEBUG
      });
    });
  });
}

function readDebugFlag() {
  return new Promise(resolve => {
    chrome.storage.local.get('DEBUG', res => resolve(!!res.DEBUG));
  });
}

// Resilient link regex: account for forum / forums and optional www
const LINK_REGEX = /https?:\/\/(?:www\.)?(?:forums?\.(?:sufficientvelocity|spacebattles)\.com|forum\.questionablequesting\.com)\/posts\/(\d{5,12})(?:\/[^\s]*)?/ig;

// Message listener (Start, Abort, GET_STATUS)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false });
    return;
  }
  if (msg.type === 'START') {
    startProcess();
    sendResponse({ ok: true });
  } else if (msg.type === 'ABORT') {
    abortFlag = true;
    setState({ status: 'aborting', message: 'Abort requested' });
    sendResponse({ ok: true });
  } else if (msg.type === 'GET_STATUS') {
    chrome.storage.local.get('EXT_STATUS', data => {
      sendResponse({ status: data.EXT_STATUS || state });
    });
    return true; // asynchronous response
  } else {
    sendResponse({ ok: false });
  }
});

// Main entry
async function startProcess() {
  abortFlag = false;

  // read config, token & debug flag
  const { cfg, token, debug } = await readConfig();

  if (!cfg.FILE_FETCH_URL) {
    setState({ status: 'error', message: 'No FILE_FETCH_URL set in Options' });
    return;
  }

  setState({ status: 'fetching', message: 'Fetching link file...', total: 0, completed: 0, linksFound: [], lastErrorSample: '' });

  // Helper: convert Drive "view" URLs to raw download URLs
  function transformDriveViewUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (/drive\.google\.com\/uc\?export=download/i.test(url)) return url;
    const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1 && m1[1]) return `https://drive.google.com/uc?export=download&id=${m1[1]}`;
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2 && m2[1]) return `https://drive.google.com/uc?export=download&id=${m2[1]}`;
    return url;
  }

  // --- FETCH BLOCK ---
  let text;
  try {
    const fetchUrl = transformDriveViewUrl(cfg.FILE_FETCH_URL);
    if (debug) console.log('[LR] Fetch URL used:', fetchUrl);

    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const resp = await fetch(fetchUrl, {
      method: 'GET',
      cache: 'no-store',
      headers,
      credentials: 'omit'
    });

    if (!resp.ok) {
      setState({ status: 'error', message: `Fetch failed: ${resp.status} ${resp.statusText}` });
      if (debug) console.error('[LR] fetch response not ok:', resp.status, resp.statusText);
      return;
    }

    text = await resp.text();
  } catch (err) {
    setState({ status: 'error', message: 'Fetch error: ' + err.message });
    if (debug) console.error('[LR] fetch error:', err);
    return;
  }
  // --- END FETCH BLOCK ---

  // Quick content check: if it looks like HTML, fail with sample
  const sample = (typeof text === 'string') ? text.slice(0, 2000) : '';
  if (/<!doctype html|<html|<head|<body/i.test(sample)) {
    setState({
      status: 'error',
      message: 'Fetched content appears to be HTML (likely a login page). Make the file public or use a public endpoint.',
      lastErrorSample: sample
    });
    if (debug) console.error('[LR] HTML-like content fetched:', sample);
    return;
  }

  // Extract links using existing LINK_REGEX
  const found = [];
  let m;
  while ((m = LINK_REGEX.exec(text)) !== null) {
    found.push(m[0]);
  }

  if (found.length === 0) {
    setState({ status: 'error', message: 'No SV/SB/QQ links found in file', lastErrorSample: sample });
    if (debug) console.warn('[LR] No matches; file sample:', sample.slice(0, 800));
    return;
  }

  setState({
    status: 'opened',
    message: `Found ${found.length} links. Opening popup...`,
    linksFound: found,
    total: found.length,
    completed: 0
  });

  // Open target window
  try {
    const targetWin = await chrome.windows.create({ url: found, type: 'popup' });
    targetWinId = targetWin.id;
  } catch (err) {
    setState({ status: 'error', message: 'Failed to open target window: ' + err.message });
    if (debug) console.error('[LR] open target window error:', err);
    return;
  }

  // Open progress UI (non-fatal)
  try {
    const progWin = await chrome.windows.create({
      url: chrome.runtime.getURL('progress.html'),
      type: 'popup',
      width: 380,
      height: 160
    });
    progressWinId = progWin.id;
  } catch (err) {
    if (debug) console.warn('[LR] Failed to open progress window:', err);
  }

  setState({ status: 'waiting', message: `Waiting ${cfg.INITIAL_DELAY_MIN} minute(s) before polling.` });

  // schedule poll alarm (single alarm)
  chrome.alarms.clear('startPolling');
  chrome.alarms.create('startPolling', { delayInMinutes: Number(cfg.INITIAL_DELAY_MIN) || 5 });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'startPolling') {
    pollTabs();
  }
});

async function pollTabs() {
  if (abortFlag) {
    setState({ status: 'aborted', message: 'Aborted by user' });
    cleanup();
    return;
  }
  if (!targetWinId) {
    setState({ status: 'error', message: 'Target window not found' });
    cleanup();
    return;
  }

  const { cfg, token, debug } = await readConfig();

  try {
    const tabs = await chrome.tabs.query({ windowId: targetWinId });
    const total = tabs.length;
    const completed = tabs.filter(t => t.status === 'complete').length;
    setState({ status: 'polling', message: `Checking tabs: ${completed}/${total} loaded`, total, completed });

    if (abortFlag) {
      setState({ status: 'aborted', message: 'Aborted by user' });
      cleanup();
      return;
    }

    if (completed === total) {
      // gather resolved URLs
      const resolved = tabs.map(t => t.url);
      setState({ status: 'completed', message: `All tabs loaded. Posting ${resolved.length} urls...`, completed, total });

      // POST back with optional token header
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const resp = await fetch(cfg.POST_BACK_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ resolved })
        });
        if (!resp.ok) {
          const txt = await resp.text().catch(()=> '');
          setState({ status: 'error', message: `POST failed: ${resp.status} ${resp.statusText} ${txt}` });
        } else {
          const txt = await resp.text().catch(()=> '');
          setState({ status: 'done', message: `Posted ${resolved.length}. Server: ${txt}` });
        }
      } catch (postErr) {
        setState({ status: 'error', message: 'POST error: ' + postErr.message });
        if (debug) console.error('[LR] POST error:', postErr);
      }

      cleanup();
      return;
    }

    // Not all complete -> wait 60s and re-check
    setTimeout(() => {
      pollTabs();
    }, 60_000);

  } catch (err) {
    setState({ status: 'error', message: 'Error polling tabs: ' + err.message });
    if (await readDebugFlag()) console.error('[LR] pollTabs error:', err);
    cleanup();
  }
}

function cleanup() {
  if (targetWinId) {
    chrome.windows.remove(targetWinId).catch(()=>{});
    targetWinId = null;
  }
  if (progressWinId) {
    chrome.windows.remove(progressWinId).catch(()=>{});
    progressWinId = null;
  }
  chrome.alarms.clear('startPolling');
  abortFlag = false;
  // leave last state for UI; revert to idle after short delay
  setTimeout(()=> setState({ status: 'idle', message: 'Ready.' }), 2000);
}
