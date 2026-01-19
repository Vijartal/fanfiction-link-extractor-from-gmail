// background.js — v5: configurable polling interval + publish current link in state
const DEFAULT_CONFIG = {
  FILE_FETCH_URL: '',
  POST_BACK_URL: '',
  INITIAL_DELAY_MIN: 5,
  MAX_CONCURRENT: 3,
  WINDOW_MODE: 'normal', // 'normal' or 'popup'
  CHECK_INTERVAL_MS: 8000  // default poll interval in milliseconds
};

const DEFAULT_STATE = {
  status: 'idle',
  message: 'Ready.',
  total: 0,
  completed: 0,
  linksFound: [],
  lastErrorSample: '',
  current: ''
};

let state = Object.assign({}, DEFAULT_STATE);
let targetWinId = null;
let progressWinId = null;
let abortFlag = false;
let creatingPopup = false;
let creatingPopupPromise = null;

// per-tab tracking
const inProgress = new Map();
let linksQueue = [];
let resolvedUrls = [];

function setState(updates) {
  state = Object.assign({}, state, updates);
  try { chrome.storage.local.set({ EXT_STATUS: state }, () => {}); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: 'STATUS', state }); } catch (e) { readDebugFlag().then(d => { if (d) console.warn('[LR] sendMessage no receiver:', e && e.message); }); }
  readDebugFlag().then(debug => { if (debug) console.log('[LR] STATE:', state); });
}

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

const RUNTIME_LINK_REGEX = /https?:\/\/(?:www\.)?(?:forums?\.(?:sufficientvelocity|spacebattles)\.com|forum\.questionablequesting\.com)\/posts\/(\d{5,12})(?:\/[\S]*)?/ig;

// background.js: message listener (replace existing chrome.runtime.onMessage.addListener block)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) { sendResponse({ ok: false }); return; }

  // start/abort/status (existing behaviour)
  if (msg.type === 'START') {
    startProcess();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'ABORT') {
    abortFlag = true;
    setState({ status: 'aborting', message: 'Abort requested' });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'GET_STATUS') {
    chrome.storage.local.get('EXT_STATUS', data => {
      sendResponse({ status: data.EXT_STATUS || state });
    });
    return true; // async response
  }

  // Trigger configured Apps Script: run extractor
  // CALL_RUN_SCRIPT — asks Apps Script to run extractor
  // CALL_RUN_SCRIPT — asks Apps Script to run extractor (robust token send + HTML/429 checks)
if (msg.type === 'CALL_RUN_SCRIPT') {
  (async () => {
    try {
      const { cfg, token, debug } = await readConfig();
      const url = (cfg && cfg.RUN_SCRIPT_URL) ? String(cfg.RUN_SCRIPT_URL).trim() : '';
      if (!url) { sendResponse({ ok: false, error: 'RUN_SCRIPT_URL not configured in Options' }); return; }

      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const urlWithToken = token ? (url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)) : url;
      const body = { action: 'run' };
      if (token) body.token = token;

      const r = await fetch(urlWithToken, { method: 'POST', headers, body: JSON.stringify(body) });
      const txt = await r.text().catch(() => '');
      const ctype = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';

      // If server returned HTML (login / docs / error page), treat as error
      if (ctype.toLowerCase().includes('text/html')) {
        const preview = txt.slice(0, 800).replace(/\s+/g, ' ');
        sendResponse({ ok: false, error: 'Server returned HTML (likely wrong URL or login). Preview: ' + preview });
        return;
      }

      if (r.status === 429) {
        sendResponse({ ok: false, error: 'Server returned 429 Too Many Requests. Try again later.' });
        return;
      }

      if (!r.ok) {
        sendResponse({ ok: false, error: `HTTP ${r.status}: ${txt}` });
        return;
      }

      sendResponse({ ok: true, text: txt });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // keep channel open for async sendResponse
}



  // CALL_CLEAR_DRIVE — asks Apps Script to clear/empty Drive files
  // CALL_CLEAR_DRIVE — asks Apps Script to clear/empty Drive files (robust token send + HTML/429 checks)
if (msg.type === 'CALL_CLEAR_DRIVE') {
  (async () => {
    try {
      const { cfg, token, debug } = await readConfig();
      const url = (cfg && cfg.CLEAR_DRIVE_URL) ? String(cfg.CLEAR_DRIVE_URL).trim() : '';
      if (!url) { sendResponse({ ok: false, error: 'CLEAR_DRIVE_URL not configured in Options' }); return; }

      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const urlWithToken = token ? (url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)) : url;
      const body = { action: 'clear' };
      if (token) body.token = token;

      const r = await fetch(urlWithToken, { method: 'POST', headers, body: JSON.stringify(body) });
      const txt = await r.text().catch(() => '');
      const ctype = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';

      if (ctype.toLowerCase().includes('text/html')) {
        const preview = txt.slice(0, 800).replace(/\s+/g, ' ');
        sendResponse({ ok: false, error: 'Server returned HTML (likely wrong URL or login). Preview: ' + preview });
        return;
      }

      if (r.status === 429) {
        sendResponse({ ok: false, error: 'Server returned 429 Too Many Requests. Try again later.' });
        return;
      }

      if (!r.ok) {
        sendResponse({ ok: false, error: `HTTP ${r.status}: ${txt}` });
        return;
      }

      sendResponse({ ok: true, text: txt });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
}

  // Unknown message
  sendResponse({ ok: false });
});

function transformDriveViewUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (/drive\.google\.com\/uc\?export=download/i.test(url)) return url;
  const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return `https://drive.google.com/uc?export=download&id=${m1[1]}`;
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return `https://drive.google.com/uc?export=download&id=${m2[1]}`;
  return url;
}

async function createPopupWithUrls(urls) {
  const arr = Array.isArray(urls) ? urls.filter(Boolean) : [];

  if (creatingPopup) {
    try { await creatingPopupPromise; } catch (e) {}
    if (targetWinId) return { id: targetWinId };
  }

  if (targetWinId) {
    try {
      await chrome.windows.get(targetWinId);
      return { id: targetWinId };
    } catch (e) {
      targetWinId = null;
    }
  }

  creatingPopup = true;
  creatingPopupPromise = (async () => {
    try {
      const first = arr.length ? arr[0] : chrome.runtime.getURL('progress.html');
      const { cfg } = await readConfig();
      const mode = (cfg && cfg.WINDOW_MODE) ? cfg.WINDOW_MODE : 'normal';
      let createOpts = { url: first };
      if (mode === 'popup') {
        createOpts.type = 'popup';
      } else {
        createOpts.type = 'normal';
        createOpts.state = 'minimized';
        createOpts.focused = false;
      }

      const win = await chrome.windows.create(createOpts);
      targetWinId = win.id;
      await new Promise(r => setTimeout(r, 350));

      for (let i = 1; i < arr.length; i++) {
        const u = arr[i];
        try {
          const t = await chrome.tabs.create({ windowId: targetWinId, url: u });
          if (await readDebugFlag()) console.log('[LR] createPopupWithUrls: created tab in window', { id: t.id, windowId: t.windowId, url: t.url });
        } catch (err) {
          if (await readDebugFlag()) console.warn('[LR] createPopupWithUrls: failed to create tab', u, err);
        }
      }

      return win;
    } finally {
      creatingPopup = false;
      creatingPopupPromise = null;
    }
  })();

  return creatingPopupPromise;
}

async function sweepAndCloseStrayTabs(urlsToMatch) {
  if (!Array.isArray(urlsToMatch) || urlsToMatch.length === 0) return;
  const urlSet = new Set(urlsToMatch.map(u => u.split('#')[0]));
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (!t.url) continue;
      const base = t.url.split('#')[0];
      if (urlSet.has(base) && t.windowId !== targetWinId) {
        try {
          await chrome.tabs.remove(t.id);
          if (await readDebugFlag()) console.warn('[LR] Removed stray tab', t.id, t.url);
        } catch (e) {
          if (await readDebugFlag()) console.warn('[LR] Failed to remove stray tab', t.id, e);
        }
      }
    }
  } catch (e) {
    if (await readDebugFlag()) console.warn('[LR] sweep failed', e);
  }
}

async function startProcess() {
  abortFlag = false;
  inProgress.clear();
  linksQueue = [];
  resolvedUrls = [];

  const { cfg, token, debug } = await readConfig();

  if (!cfg.FILE_FETCH_URL) {
    setState({ status: 'error', message: 'No FILE_FETCH_URL set in Options' });
    return;
  }

  setState({ status: 'fetching', message: 'Fetching link file...', total:0, completed:0, linksFound:[], lastErrorSample: '' });

  let text;
  try {
    // Build URL and headers for fetching the SV/SB/QQ list (include token header + token queryparam fallback)
    const fetchUrl = transformDriveViewUrl(cfg.FILE_FETCH_URL);
    if (debug) console.log('[LR] Fetch URL used:', fetchUrl);

    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    // Try single request with header + token query param (some endpoints accept one or the other)
    const fetchUrlWithToken = token ? (fetchUrl + (fetchUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)) : fetchUrl;

    let resp = await fetch(fetchUrlWithToken, { method: 'GET', cache: 'no-store', headers, credentials: 'omit' });
    text = await resp.text().catch(() => '');

    // If we got an HTML page back, treat as an error (likely wrong URL / login)
    const sampleGuess = (text || '').slice(0, 2000);
    if (/<!doctype html|<html|<head|<body/i.test(sampleGuess)) {
      // If initial attempt returned HTML, try a bare token-only URL fallback (no auth header)
      if (token) {
        if (debug) console.warn('[LR] initial fetch returned HTML. Retrying with token query-param only.');
        const urlOnlyToken = fetchUrl + (fetchUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
        const resp2 = await fetch(urlOnlyToken, { method: 'GET', cache: 'no-store', credentials: 'omit' });
        text = await resp2.text().catch(() => '');
        if (!resp2.ok) {
          setState({ status: 'error', message: `Fetch failed (fallback): ${resp2.status} ${resp2.statusText}` });
          if (debug) console.error('[LR] Fallback fetch not ok:', resp2.status, resp2.statusText, 'body:', text);
          return;
        }
        // still check for HTML after fallback
        if (/<!doctype html|<html|<head|<body/i.test((text||'').slice(0,2000))) {
          setState({ status: 'error', message: 'Fetched content appears to be HTML (login/page). Use a public endpoint.', lastErrorSample: (text||'').slice(0,2000) });
          if (debug) console.error('[LR] HTML-like content fetched even after fallback:', (text||'').slice(0,2000));
          return;
        }
      } else {
        setState({ status: 'error', message: 'Fetched HTML (login) and no token available' });
        if (debug) console.error('[LR] HTML-like content fetched and no token to retry:', sampleGuess);
        return;
      }
    } else {
      // not HTML — but also check for 401/unauthorized string
      const lower = (text || '').trim().toLowerCase();
      if (resp.status === 401 || lower === 'unauthorized') {
        if (debug) console.warn('[LR] Primary fetch unauthorized. Trying fallback with token query param.');
        if (token) {
          const sep = fetchUrl.includes('?') ? '&' : '?';
          const fallbackUrl = fetchUrl + sep + 'token=' + encodeURIComponent(token);
          const resp2 = await fetch(fallbackUrl, { method: 'GET', cache: 'no-store', credentials: 'omit' });
          text = await resp2.text().catch(() => '');
          if (!resp2.ok) {
            setState({ status: 'error', message: `Fetch failed (fallback): ${resp2.status} ${resp2.statusText}` });
            if (debug) console.error('[LR] Fallback fetch not ok:', resp2.status, resp2.statusText, 'body:', text);
            return;
          }
        } else {
          setState({ status: 'error', message: 'Unauthorized (no token present in extension options)' });
          return;
        }
      } else {
        if (!resp.ok) {
          setState({ status: 'error', message: `Fetch failed: ${resp.status} ${resp.statusText}` });
          if (debug) console.error('[LR] fetch response not ok:', resp.status, resp.statusText, 'body:', text);
          return;
        }
      }
    }
  } catch (err) {
    setState({ status: 'error', message: 'Fetch error: ' + err.message });
    if (debug) console.error('[LR] fetch error:', err);
    return;
  }

  // Normalize literal backslash-newlines into real newlines if needed
  if (typeof text === 'string') {
    if (text.indexOf('\\n') !== -1 && text.indexOf('\n') === -1) {
      text = text.replace(/\\r?\\n/g, '\n');
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  }

  // Trim BOM and prepare sample for HTML detection
  const sample = (typeof text === 'string') ? text.slice(0,2000) : '';
  if (/<!doctype html|<html|<head|<body/i.test(sample)) {
    setState({ status: 'error', message: 'Fetched content appears to be HTML (login page). Use a public endpoint.', lastErrorSample: sample });
    if (debug) console.error('[LR] HTML-like content fetched:', sample);
    return;
  }

  // Extract links: treat as newline-separated list, fallback to regex
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let found = lines.filter(l => { RUNTIME_LINK_REGEX.lastIndex = 0; return RUNTIME_LINK_REGEX.test(l); });
  RUNTIME_LINK_REGEX.lastIndex = 0;
  if (found.length === 0) {
    let m;
    while ((m = RUNTIME_LINK_REGEX.exec(text)) !== null) found.push(m[0]);
    RUNTIME_LINK_REGEX.lastIndex = 0;
  }

  if (found.length === 0) {
    setState({ status: 'error', message: 'No SV/SB/QQ links found in file', lastErrorSample: sample });
    if (debug) console.warn('[LR] No matches; file sample:', sample.slice(0,800));
    return;
  }

  linksQueue = [...found];
  setState({ status: 'opened', message: `Found ${found.length} links. Opening window...`, linksFound: found, total: found.length, completed: 0 });

  const maxConc = Number(cfg.MAX_CONCURRENT) || 3;
  const initialBatch = [];
  initialBatch.push(linksQueue.shift());
  for (let i=1;i<maxConc && linksQueue.length>0;i++) initialBatch.push(linksQueue.shift());

  try {
    await createPopupWithUrls(initialBatch);
    await sweepAndCloseStrayTabs(initialBatch);

    const tabsInWin = await chrome.tabs.query({ windowId: targetWinId });
    const n = Math.min(initialBatch.length, tabsInWin.length);
    for (let i = 0; i < n; i++) {
      const t = tabsInWin[i];
      const intended = initialBatch[i] || t.url || '';
      inProgress.set(t.id, { intendedUrl: intended, checks: 0, lastUrl: '' });
    }
  } catch (err) {
    setState({ status: 'error', message: 'Failed to open initial popup/tabs: ' + err.message });
    if (debug) console.error('[LR] createPopupWithUrls error:', err);
    return;
  }

  try {
    const progWin = await chrome.windows.create({ url: chrome.runtime.getURL('progress.html'), type: 'popup', width:380, height:160 });
    progressWinId = progWin.id;
  } catch (err) {
    if (debug) console.warn('[LR] Failed to open progress window:', err);
  }

  setState({ status: 'waiting', message: 'Polling tabs for load completion...' });

  startPerTabPolling(maxConc);
}


function startPerTabPolling(maxConcurrent) {
  // read configured interval, default to 8000ms
  let checkIntervalMs = 8000;
  return (async () => {
    const { cfg } = await readConfig();
    const v = Number(cfg.CHECK_INTERVAL_MS);
    if (!Number.isNaN(v) && v > 100) checkIntervalMs = v;
    const requiredChecks = 2;
    const maxWaitMs = 30 * 60_000;
    const startedAt = Date.now();

    let intervalId = setInterval(async () => {
      if (abortFlag) {
        clearInterval(intervalId);
        setState({ status: 'aborted', message: 'Abort requested', current: '' });
        cleanup();
        return;
      }

      if (Date.now() - startedAt > maxWaitMs) {
        clearInterval(intervalId);
        setState({ status: 'warning', message: 'Max wait reached — proceeding with current loaded tabs', current: '' });
        try {
          if (targetWinId) {
            const tabsNow = await chrome.tabs.query({ windowId: targetWinId });
            await finalizeAndPost(tabsNow);
          } else {
            await finalizeAndPost([]);
          }
        } catch (err) {
          setState({ status: 'error', message: 'Error during timeout finalization: ' + err.message, current: '' });
          cleanup();
        }
        return;
      }

      try {
        if (!targetWinId) throw new Error('no target');
        await chrome.windows.get(targetWinId);
      } catch (winErr) {
        const pending = [];
        for (const [tid, rec] of inProgress.entries()) pending.push(rec.intendedUrl || rec.lastUrl || '');
        inProgress.clear();
        linksQueue = pending.concat(linksQueue);

        if (linksQueue.length > 0) {
          const batch = [];
          for (let i = 0; i < Math.min(maxConcurrent, linksQueue.length); i++) batch.push(linksQueue.shift());
          try {
            await createPopupWithUrls(batch);
            await sweepAndCloseStrayTabs(batch);
            const tabsNow = await chrome.tabs.query({ windowId: targetWinId });
            for (let i = 0; i < Math.min(batch.length, tabsNow.length); i++) {
              const t = tabsNow[i];
              inProgress.set(t.id, { intendedUrl: batch[i] || t.url || '', checks: 0, lastUrl: '' });
            }
          } catch (err) {
            if (await readDebugFlag()) console.error('[LR] Recovery createPopupWithUrls failed:', err);
          }
        }
        return;
      }

      try {
        const tabs = await chrome.tabs.query({ windowId: targetWinId });
        const inProgressCount = inProgress.size;
        const completedCount = resolvedUrls.length;
        const totalToProcess = completedCount + inProgressCount + linksQueue.length;

        // publish first tracked intendedUrl as 'current' for UI
// --- Begin replacement: publish multiple current links for UI ---
const currentLinks = [];
for (const rec of inProgress.values()) {
  const link = rec.intendedUrl || rec.lastUrl || '';
  if (link) currentLinks.push(link);
}
// make unique, preserve order
const seen = new Set();
const uniqCurrent = currentLinks.filter(u => {
  if (seen.has(u)) return false;
  seen.add(u);
  return true;
});

setState({
  status: 'polling',
  message: `Processing: ${completedCount} done, ${inProgressCount} active, ${linksQueue.length} queued`,
  total: totalToProcess,
  completed: completedCount,
  // publish an array (can be empty); progress UI will accept array or string
  current: uniqCurrent
});

        for (const tab of tabs) {
          if (abortFlag) break;
          if (!inProgress.has(tab.id)) continue;

          const rec = inProgress.get(tab.id);
          const currUrl = tab.url || '';

          if (tab.status === 'complete') {
            if (rec.lastUrl && rec.lastUrl === currUrl) rec.checks = Math.min(rec.checks + 1, requiredChecks);
            else { rec.checks = 1; rec.lastUrl = currUrl; }
            inProgress.set(tab.id, rec);

            if (rec.checks >= requiredChecks) {
              const resolved = currUrl;
              resolvedUrls.push(resolved);
              setState({ status: 'processing', message: `Tab resolved: ${resolved}`, completed: resolvedUrls.length, current: '' });

              inProgress.delete(tab.id);

              if (linksQueue.length > 0) {
                const nextUrl = linksQueue.shift();
                try {
                  const updated = await chrome.tabs.update(tab.id, { url: nextUrl });
                  if (updated && updated.windowId === targetWinId) {
                    inProgress.set(updated.id, { intendedUrl: nextUrl, checks: 0, lastUrl: '' });
                  } else {
                    linksQueue.unshift(nextUrl);
                    if (await readDebugFlag()) console.warn('[LR] tabs.update returned tab not in popup; requeued', updated && updated.windowId);
                  }
                } catch (updErr) {
                  linksQueue.unshift(nextUrl);
                  if (await readDebugFlag()) console.warn('[LR] tabs.update failed for reuse; requeued', updErr);
                }
              } else {
                try { await chrome.tabs.remove(tab.id); } catch (e) {}
              }

              if (linksQueue.length === 0 && inProgress.size === 0) {
                clearInterval(intervalId);
                await finalizeAndPost([]);
                return;
              }
            }

          } else {
            rec.checks = 0;
            inProgress.set(tab.id, rec);
          }
        }

      } catch (err) {
        clearInterval(intervalId);
        setState({ status: 'error', message: 'Error during polling: ' + err.message, current: '' });
        if (await readDebugFlag()) console.error('[LR] pollCycle error:', err);
        cleanup();
      }
    }, checkIntervalMs);
  })();
}

async function finalizeAndPost(passedTabs) {
  try {
    // collect any remaining resolved URLs from passedTabs
    if (passedTabs && passedTabs.length > 0) {
      for (const t of passedTabs) {
        if (inProgress.has(t.id) && t.status === 'complete') {
          const currUrl = t.url || '';
          resolvedUrls.push(currUrl);
          try { await chrome.tabs.remove(t.id); } catch (e) {}
          inProgress.delete(t.id);
        }
      }
    }

    const { cfg, token, debug } = await readConfig();
    const bodyObj = { resolved: resolvedUrls };
    if (token) bodyObj.token = token;
    const body = JSON.stringify(bodyObj);

    let headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    setState({
      status: 'completed',
      message: `Posting ${resolvedUrls.length} resolved urls...`,
      completed: resolvedUrls.length,
      total: resolvedUrls.length,
      current: ''
    });

    if (!cfg.POST_BACK_URL) {
      setState({
        status: 'done',
        message: `Collected ${resolvedUrls.length} resolved urls (no POST URL configured).`,
        current: ''
      });
      cleanup();
      return;
    }

    // Primary attempt: include auth header + token query param
    let resp, bodyTxt;
    try {
      const urlWithToken = token ? (cfg.POST_BACK_URL + (cfg.POST_BACK_URL.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)) : cfg.POST_BACK_URL;
      resp = await fetch(urlWithToken, { method: 'POST', headers, body });
      bodyTxt = await resp.text().catch(() => '');
    } catch (err) {
      setState({ status: 'error', message: 'POST error: ' + err.message, current: '' });
      if (debug) console.error('[LR] POST fetch error:', err);
      cleanup();
      return;
    }

    // Defensive checks: HTML responses (login/page) or 429
    const ctype = (resp && resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : '';
    if (ctype.toLowerCase().includes('text/html')) {
      const preview = (bodyTxt || '').slice(0,800).replace(/\s+/g,' ');
      setState({ status: 'error', message: 'POST returned HTML (likely wrong URL or login). Preview: ' + preview, current: '' });
      if (debug) console.error('[LR] POST returned HTML preview:', preview);
      cleanup();
      return;
    }

    if (resp.status === 429) {
      setState({ status: 'error', message: 'POST failed: 429 Too Many Requests — try later', current: '' });
      if (debug) console.warn('[LR] POST 429 returned:', bodyTxt);
      cleanup();
      return;
    }

    if (!resp.ok) {
      setState({ status: 'error', message: `POST failed: ${resp.status} ${resp.statusText} ${bodyTxt}`, current: '' });
      if (debug) console.error('[LR] POST failed:', resp.status, resp.statusText, bodyTxt);
      cleanup();
      return;
    }

    // success
    setState({ status: 'done', message: `Posted ${resolvedUrls.length}. Server: ${bodyTxt}`, current: '' });
    if (debug) console.log('[LR] Posted resolved URLs:', resolvedUrls, 'server:', bodyTxt);
  } catch (err) {
    setState({ status: 'error', message: 'POST error: ' + err.message, current: '' });
    console.error('[LR] finalizeAndPost error:', err);
  } finally {
    cleanup();
  }
}

function cleanup() {
  if (targetWinId) { chrome.windows.remove(targetWinId).catch(()=>{}); targetWinId = null; }
  if (progressWinId) { chrome.windows.remove(progressWinId).catch(()=>{}); progressWinId = null; }
  chrome.alarms.clear('startPolling');
  abortFlag = false;
  inProgress.clear();
  linksQueue = [];
  setTimeout(()=> setState({ status: 'idle', message: 'Ready.', current: '' }), 2000);
}
