// background.js — reuse-only strategy (no single-tab creates after initial batch)
// Robust popup/tab creation: create N tabs atomically, reuse them, avoid stray tabs.
// Configurable: MAX_CONCURRENT, debug mode, token fallback.

const DEFAULT_CONFIG = {
  FILE_FETCH_URL: '',
  POST_BACK_URL: '',
  INITIAL_DELAY_MIN: 5,
  MAX_CONCURRENT: 3
};

const DEFAULT_STATE = {
  status: 'idle',
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

// per-tab tracking
const inProgress = new Map(); // tabId -> { intendedUrl, checks, lastUrl }
let linksQueue = [];          // queue of remaining links (strings)
let resolvedUrls = [];        // collected resolved URLs
let creatingPopup = false;    // guard to avoid concurrent creations

function setState(updates) {
  state = Object.assign({}, state, updates);
  try { chrome.storage.local.set({ EXT_STATUS: state }, () => {}); } catch (e) {}
  try {
    chrome.runtime.sendMessage({ type: 'STATUS', state });
  } catch (e) {
    // receiver may be gone — ignore
    readDebugFlag().then(d => { if (d) console.warn('[LR] sendMessage no receiver:', e && e.message); });
  }
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

const RUNTIME_LINK_REGEX = /https?:\/\/(?:www\.)?(?:forums?\.(?:sufficientvelocity|spacebattles)\.com|forum\.questionablequesting\.com)\/posts\/(\d{5,12})(?:\/[^\s]*)?/ig;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) { sendResponse({ ok: false }); return; }
  if (msg.type === 'START') { startProcess(); sendResponse({ ok: true }); }
  else if (msg.type === 'ABORT') { abortFlag = true; setState({ status: 'aborting', message: 'Abort requested' }); sendResponse({ ok: true }); }
  else if (msg.type === 'GET_STATUS') {
    chrome.storage.local.get('EXT_STATUS', data => { sendResponse({ status: data.EXT_STATUS || state }); });
    return true;
  } else sendResponse({ ok: false });
});

// transform Drive view -> direct download
function transformDriveViewUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (/drive\.google\.com\/uc\?export=download/i.test(url)) return url;
  const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return `https://drive.google.com/uc?export=download&id=${m1[1]}`;
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return `https://drive.google.com/uc?export=download&id=${m2[1]}`;
  return url;
}

// Create a popup window with an array of URLs (atomic). Uses mutex to avoid concurrent creators.
async function createPopupWithUrls(urls) {
  const arr = Array.isArray(urls) ? urls.filter(Boolean) : [];

  // if creation in progress wait
  if (creatingPopup) {
    try { await creatingPopup; } catch (e) {}
    // if targetWinId now exists, we can continue
    if (targetWinId) return { id: targetWinId };
  }

  // if a valid popup exists, just create/replace tabs inside it using update (we will prefer reuse)
  if (targetWinId) {
    try {
      await chrome.windows.get(targetWinId);
      // existing popup: if arr has entries, create tabs by navigating existing or adding if necessary.
      // We'll return the window and let caller register tabs to inProgress.
      return { id: targetWinId };
    } catch (e) {
      targetWinId = null;
    }
  }

  // create popup (guarded)
  creatingPopup = (async () => {
    try {
      const createArg = arr.length ? arr : chrome.runtime.getURL('progress.html');
      const win = await chrome.windows.create({ url: createArg, type: 'popup' });
      targetWinId = win.id;
      // wait for tabs to settle
      await new Promise(r => setTimeout(r, 350));
      return win;
    } finally {
      creatingPopup = false;
    }
  })();

  return creatingPopup;
}

// Close stray tabs in normal windows that match any of the given original URLs (prevent initial leaks)
async function sweepAndCloseStrayTabs(urlsToMatch) {
  if (!Array.isArray(urlsToMatch) || urlsToMatch.length === 0) return;
  const urlSet = new Set(urlsToMatch.map(u => u.split('#')[0])); // basic normalize: remove fragment
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (!t.url) continue;
      const base = t.url.split('#')[0];
      if (urlSet.has(base) && t.windowId !== targetWinId) {
        // this is a stray tab that was created in another window — remove it
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

// Main
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

  setState({ status: 'fetching', message: 'Fetching link file...', total: 0, completed: 0, linksFound: [], lastErrorSample: '' });

  // fetch file with token fallback
  let text;
  try {
    const fetchUrl = transformDriveViewUrl(cfg.FILE_FETCH_URL);
    if (debug) console.log('[LR] Fetch URL used:', fetchUrl);
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let resp = await fetch(fetchUrl, { method: 'GET', cache: 'no-store', headers, credentials: 'omit' });
    text = await resp.text();
    const lower = (text || '').trim().toLowerCase();
    if (resp.status === 401 || lower === 'unauthorized') {
      if (debug) console.warn('[LR] Primary fetch unauthorized. Trying fallback with token query param.');
      if (token) {
        const sep = fetchUrl.includes('?') ? '&' : '?';
        const fallbackUrl = fetchUrl + sep + 'token=' + encodeURIComponent(token);
        const resp2 = await fetch(fallbackUrl, { method: 'GET', cache: 'no-store', credentials: 'omit' });
        text = await resp2.text();
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
  } catch (err) {
    setState({ status: 'error', message: 'Fetch error: ' + err.message });
    if (debug) console.error('[LR] fetch error:', err);
    return;
  }

  const sample = (typeof text === 'string') ? text.slice(0, 2000) : '';
  if (/<!doctype html|<html|<head|<body/i.test(sample)) {
    setState({ status: 'error', message: 'Fetched content appears to be HTML (login page). Use a public endpoint.', lastErrorSample: sample });
    if (debug) console.error('[LR] HTML-like content fetched:', sample);
    return;
  }

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let found = lines.filter(l => {
    RUNTIME_LINK_REGEX.lastIndex = 0;
    return RUNTIME_LINK_REGEX.test(l);
  });
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

  // populate queue and UI
  linksQueue = [...found];
  setState({ status: 'opened', message: `Found ${found.length} links. Opening window...`, linksFound: found, total: found.length, completed: 0 });

  // Build initial batch of up to MAX_CONCURRENT
  const maxConc = Number(cfg.MAX_CONCURRENT) || 3;
  const initialBatch = [];
  initialBatch.push(linksQueue.shift());
  for (let i = 1; i < maxConc && linksQueue.length > 0; i++) initialBatch.push(linksQueue.shift());

  // Create popup atomically with initialBatch
  try {
    await createPopupWithUrls(initialBatch);
    // remove stray tabs created by races (if any)
    await sweepAndCloseStrayTabs(initialBatch);

    // register first N tabs in the popup by position
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

  // open progress UI
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

  setState({ status: 'waiting', message: 'Polling tabs for load completion...' });

  // start polling/reuse loop
  startPerTabPolling(maxConc);
}

// polling loop that reuses tabs (never creates single tabs)
function startPerTabPolling(maxConcurrent) {
  const checkIntervalMs = 8_000;
  const requiredChecks = 2;
  const maxWaitMs = 30 * 60_000;
  const startedAt = Date.now();

  let intervalId = setInterval(async () => {
    if (abortFlag) {
      clearInterval(intervalId);
      setState({ status: 'aborted', message: 'Aborted by user' });
      cleanup();
      return;
    }

    if (Date.now() - startedAt > maxWaitMs) {
      clearInterval(intervalId);
      setState({ status: 'warning', message: 'Max wait reached — proceeding with current loaded tabs' });
      try {
        if (targetWinId) {
          const tabsNow = await chrome.tabs.query({ windowId: targetWinId });
          await finalizeAndPost(tabsNow);
        } else {
          await finalizeAndPost([]);
        }
      } catch (err) {
        setState({ status: 'error', message: 'Error during timeout finalization: ' + err.message });
        cleanup();
      }
      return;
    }

    // ensure popup exists - if missing, recover by re-queuing inProgress and recreating a fresh popup
    try {
      if (!targetWinId) throw new Error('no target');
      await chrome.windows.get(targetWinId);
    } catch (winErr) {
      // requeue any inProgress intended urls
      const pending = [];
      for (const [tid, rec] of inProgress.entries()) pending.push(rec.intendedUrl || rec.lastUrl || '');
      inProgress.clear();
      linksQueue = pending.concat(linksQueue);

      if (linksQueue.length > 0) {
        // create a fresh popup with up to maxConcurrent items
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
      // continue to next interval
      return;
    }

    try {
      const tabs = await chrome.tabs.query({ windowId: targetWinId });
      const inProgressCount = inProgress.size;
      const completedCount = resolvedUrls.length;
      const totalToProcess = completedCount + inProgressCount + linksQueue.length;
      setState({
        status: 'polling',
        message: `Processing: ${completedCount} done, ${inProgressCount} active, ${linksQueue.length} queued`,
        total: totalToProcess,
        completed: completedCount
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
            // confirmed resolved
            const resolved = currUrl;
            resolvedUrls.push(resolved);
            setState({ status: 'processing', message: `Tab resolved: ${resolved}`, completed: resolvedUrls.length });

            // remove tracking for this tab — we'll reuse it if we have more links
            inProgress.delete(tab.id);

            if (linksQueue.length > 0) {
              // REUSE this same tab for next URL (NO create calls)
              const nextUrl = linksQueue.shift();
              try {
                const updated = await chrome.tabs.update(tab.id, { url: nextUrl });
                // if the updated tab still exists and is inside the popup, re-register it
                if (updated && updated.windowId === targetWinId) {
                  inProgress.set(updated.id, { intendedUrl: nextUrl, checks: 0, lastUrl: '' });
                } else {
                  // if update led to weird state, requeue the link and attempt recovery in next loop
                  linksQueue.unshift(nextUrl);
                  if (await readDebugFlag()) console.warn('[LR] tabs.update returned tab not in popup; requeued', updated && updated.windowId);
                }
              } catch (updErr) {
                // If updating fails (tab vanished), put the URL back and it will be created during recovery popup creation
                linksQueue.unshift(nextUrl);
                if (await readDebugFlag()) console.warn('[LR] tabs.update failed for reuse; requeued', updErr);
              }
            } else {
              // nothing left: close the tab
              try { await chrome.tabs.remove(tab.id); } catch (e) {}
            }

            // finalization check
            if (linksQueue.length === 0 && inProgress.size === 0) {
              clearInterval(intervalId);
              await finalizeAndPost([]);
              return;
            }
          }

        } else {
          // not yet done loading
          rec.checks = 0;
          inProgress.set(tab.id, rec);
        }
      } // for tabs

    } catch (err) {
      clearInterval(intervalId);
      setState({ status: 'error', message: 'Error during polling: ' + err.message });
      if (await readDebugFlag()) console.error('[LR] pollCycle error:', err);
      cleanup();
    }
  }, checkIntervalMs);
}

async function finalizeAndPost(passedTabs) {
  try {
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
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    setState({ status: 'completed', message: `Posting ${resolvedUrls.length} resolved urls...`, completed: resolvedUrls.length, total: resolvedUrls.length });

    if (!cfg.POST_BACK_URL) {
      setState({ status: 'done', message: `Collected ${resolvedUrls.length} resolved urls (no POST URL configured).` });
      cleanup();
      return;
    }

    const resp = await fetch(cfg.POST_BACK_URL, { method: 'POST', headers, body: JSON.stringify({ resolved: resolvedUrls }) });
    const bodyTxt = await resp.text().catch(()=> '');
    if (!resp.ok) {
      setState({ status: 'error', message: `POST failed: ${resp.status} ${resp.statusText} ${bodyTxt}` });
      if (debug) console.error('[LR] POST failed:', resp.status, resp.statusText, bodyTxt);
    } else {
      setState({ status: 'done', message: `Posted ${resolvedUrls.length}. Server: ${bodyTxt}` });
      if (debug) console.log('[LR] Posted resolved URLs:', resolvedUrls);
    }
  } catch (err) {
    setState({ status: 'error', message: 'POST error: ' + err.message });
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
  setTimeout(()=> setState({ status: 'idle', message: 'Ready.' }), 2000);
}
