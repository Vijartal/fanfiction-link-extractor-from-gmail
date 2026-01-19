// background.js (concurrency-enabled, corrected)
// Default configuration. Options page overrides via chrome.storage.local.CONFIG
const DEFAULT_CONFIG = {
  FILE_FETCH_URL: '', // set in Options
  POST_BACK_URL: '',  // set in Options
  INITIAL_DELAY_MIN: 5,
  MAX_CONCURRENT: 3   // default concurrency
};

const DEFAULT_STATE = {
  status: 'idle', // idle, fetching, opened, waiting, polling, verifying, completed, aborted, error, done
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

// runtime link regex
const RUNTIME_LINK_REGEX = /https?:\/\/(?:www\.)?(?:forums?\.(?:sufficientvelocity|spacebattles)\.com|forum\.questionablequesting\.com)\/posts\/(\d{5,12})(?:\/[^\s]*)?/ig;

// Message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) { sendResponse({ ok: false }); return; }
  if (msg.type === 'START') { startProcess(); sendResponse({ ok: true }); }
  else if (msg.type === 'ABORT') { abortFlag = true; setState({ status: 'aborting', message: 'Abort requested' }); sendResponse({ ok: true }); }
  else if (msg.type === 'GET_STATUS') {
    chrome.storage.local.get('EXT_STATUS', data => {
      sendResponse({ status: data.EXT_STATUS || state });
    });
    return true; // async
  } else sendResponse({ ok: false });
});

// transform Drive view -> raw download
function transformDriveViewUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (/drive\.google\.com\/uc\?export=download/i.test(url)) return url;
  const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return `https://drive.google.com/uc?export=download&id=${m1[1]}`;
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return `https://drive.google.com/uc?export=download&id=${m2[1]}`;
  return url;
}

// ---------- startProcess (creates window & initial tabs) ----------
async function startProcess() {
  abortFlag = false;
  // reset runtime structures
  inProgress.clear();
  linksQueue = [];
  resolvedUrls = [];

  const { cfg, token, debug } = await readConfig();

  if (!cfg.FILE_FETCH_URL) {
    setState({ status: 'error', message: 'No FILE_FETCH_URL set in Options' });
    return;
  }

  setState({ status: 'fetching', message: 'Fetching link file...', total: 0, completed: 0, linksFound: [], lastErrorSample: '' });

  // FETCH BLOCK (header first, fallback to ?token)
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
        if (debug) console.log('[LR] Fallback URL:', fallbackUrl);
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

  // detect HTML (login page)
  const sample = (typeof text === 'string') ? text.slice(0, 2000) : '';
  if (/<!doctype html|<html|<head|<body/i.test(sample)) {
    setState({ status: 'error', message: 'Fetched content appears to be HTML (login page). Use a public endpoint.', lastErrorSample: sample });
    if (debug) console.error('[LR] HTML-like content fetched:', sample);
    return;
  }

  // extract links (one per line OR using regex)
  // Prefer treating file as newline-separated URLs; fallback to regex if lines include other content
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let found = lines.filter(l => {
    RUNTIME_LINK_REGEX.lastIndex = 0;
    return RUNTIME_LINK_REGEX.test(l);
  });
  RUNTIME_LINK_REGEX.lastIndex = 0;
  if (found.length === 0) {
    // fallback: run regex across full text
    let m;
    while ((m = RUNTIME_LINK_REGEX.exec(text)) !== null) {
      found.push(m[0]);
    }
    RUNTIME_LINK_REGEX.lastIndex = 0;
  }

  if (found.length === 0) {
    setState({ status: 'error', message: 'No SV/SB/QQ links found in file', lastErrorSample: sample });
    if (debug) console.warn('[LR] No matches; file sample:', sample.slice(0,800));
    return;
  }

  // initialize queue and UI
  linksQueue = [...found]; // clone
  setState({ status: 'opened', message: `Found ${found.length} links. Opening window...`, linksFound: found, total: found.length, completed: 0 });

  // create popup window with first link and create up to MAX_CONCURRENT tabs total
  const maxConc = Number(cfg.MAX_CONCURRENT) || 3;
  let initialUrl = linksQueue.shift(); // first
  try {
    const win = await chrome.windows.create({ url: initialUrl, type: 'popup' });
    targetWinId = win.id;
    // register the first tab(s) by querying tabs in the window
    // Wait a tick for tabs to settle
    await new Promise(r => setTimeout(r, 300));
    const tabsInWin = await chrome.tabs.query({ windowId: targetWinId });
    // find the tab corresponding to initialUrl (choose first tab)
    if (tabsInWin && tabsInWin.length > 0) {
      const firstTab = tabsInWin[0];
      inProgress.set(firstTab.id, { intendedUrl: initialUrl, checks: 0, lastUrl: '' });
    }
    // create additional initial tabs up to maxConc
    const toCreate = Math.min(maxConc - 1, linksQueue.length);
    for (let i = 0; i < toCreate; i++) {
      const nextUrl = linksQueue.shift();
      try {
        const newTab = await chrome.tabs.create({ windowId: targetWinId, url: nextUrl });
        inProgress.set(newTab.id, { intendedUrl: nextUrl, checks: 0, lastUrl: '' });
      } catch (err) {
        if (debug) console.warn('[LR] Failed to create tab for', nextUrl, err);
        linksQueue.unshift(nextUrl);
      }
    }
  } catch (err) {
    setState({ status: 'error', message: 'Failed to open target window: ' + err.message });
    if (debug) console.error('[LR] open target window error:', err);
    return;
  }

  // Open progress UI (best-effort)
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

  // start immediate polling loop that checks per-tab and manages queue
  startPerTabPolling(maxConc);
}
// ---------- end startProcess ----------

// ---------- per-tab polling and queue manager ----------
// Helper: ensure the popup window exists. If not, create one using fallbackUrl (if given).
async function ensureTargetWindow(fallbackUrl) {
  if (targetWinId) {
    try {
      await chrome.windows.get(targetWinId);
      return targetWinId;
    } catch (e) {
      // window missing
      targetWinId = null;
    }
  }

  // Create a new popup window. Use fallbackUrl if provided, otherwise use a blank page.
  const createUrl = fallbackUrl || chrome.runtime.getURL('progress.html');
  const win = await chrome.windows.create({ url: createUrl, type: 'popup' });
  targetWinId = win.id;
  // Wait a short moment for tabs to appear
  await new Promise(r => setTimeout(r, 300));
  return targetWinId;
}

// Replace your previous startPerTabPolling(...) with this function.
function startPerTabPolling(maxConcurrent) {
  const checkIntervalMs = 8_000;   // poll every 8s
  const requiredChecks = 2;        // need consecutive stable checks
  const maxWaitMs = 30 * 60_000;   // hard timeout

  const startedAt = Date.now();

  // interval callback
  let intervalId = setInterval(async () => {
    // Abort handling
    if (abortFlag) {
      clearInterval(intervalId);
      setState({ status: 'aborted', message: 'Aborted by user' });
      cleanup();
      return;
    }

    // Timeout safety
    if (Date.now() - startedAt > maxWaitMs) {
      clearInterval(intervalId);
      setState({ status: 'warning', message: 'Max wait reached — proceeding with current loaded tabs' });
      try {
        // Grab whatever is currently resolved in popup (if exists)
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

    // If the target window was closed, recover: move any tracked inProgress URLs back into the queue
    try {
      if (targetWinId) {
        await chrome.windows.get(targetWinId);
      } else {
        throw new Error('no target window id');
      }
    } catch (winErr) {
      // window invalid -> re-queue inProgress URLs (so we won't lose them)
      const pending = [];
      for (const [tid, rec] of inProgress.entries()) pending.push(rec.intendedUrl || rec.lastUrl || '');
      inProgress.clear();
      // Prepend pending to the front of linksQueue so they get processed next
      linksQueue = pending.concat(linksQueue);
      // Recreate window with next URL if we have one (ensureTargetWindow will create it)
      if (linksQueue.length > 0) {
        const first = linksQueue.shift();
        await ensureTargetWindow(first);
        // register the first tab in new window
        const tabsNow = await chrome.tabs.query({ windowId: targetWinId });
        if (tabsNow && tabsNow.length > 0) {
          // mark the first tab as inProgress
          const firstTab = tabsNow[0];
          inProgress.set(firstTab.id, { intendedUrl: first, checks: 0, lastUrl: '' });
        }
        // create additional initial tabs up to concurrency (if any left)
        const toMake = Math.min(maxConcurrent - inProgress.size, linksQueue.length);
        for (let i = 0; i < toMake; i++) {
          const next = linksQueue.shift();
          try {
            const nt = await chrome.tabs.create({ windowId: targetWinId, url: next });
            inProgress.set(nt.id, { intendedUrl: next, checks: 0, lastUrl: '' });
          } catch (err) {
            linksQueue.unshift(next);
            if (await readDebugFlag()) console.error('[LR] Failed to create tab during recovery for', next, err);
          }
        }
      } else {
        // nothing to do; continue waiting for abort or timeout
      }
      // continue to next interval iteration
      return;
    }

    // Normal polling path: query tabs inside the popup window
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

      // iterate tabs we are tracking
      for (const tab of tabs) {
        if (abortFlag) break;
        if (!inProgress.has(tab.id)) continue;

        const rec = inProgress.get(tab.id);
        const currUrl = tab.url || '';

        // if complete, update consecutive checks
        if (tab.status === 'complete') {
          if (rec.lastUrl && rec.lastUrl === currUrl) {
            rec.checks = Math.min(rec.checks + 1, requiredChecks);
          } else {
            rec.checks = 1;
            rec.lastUrl = currUrl;
          }
          inProgress.set(tab.id, rec);

          if (rec.checks >= requiredChecks) {
            // confirmed resolved
            const resolved = currUrl;
            resolvedUrls.push(resolved);
            setState({
              status: 'processing',
              message: `Tab resolved: ${resolved} — reusing or closing tab and opening next`,
              completed: resolvedUrls.length
            });

            // remove tracking for this tab
            inProgress.delete(tab.id);

            // if we have another link queued, reuse this tab
            if (linksQueue.length > 0) {
              const nextUrl = linksQueue.shift();

              // ensure target window exists (create it if somehow missing)
              await ensureTargetWindow(nextUrl);

              // try to reuse the same tab
              try {
                await chrome.tabs.update(tab.id, { url: nextUrl });
                inProgress.set(tab.id, { intendedUrl: nextUrl, checks: 0, lastUrl: '' });
              } catch (updateErr) {
                // update failed (tab could be gone). Create a new tab in the popup and register it.
                if (await readDebugFlag()) console.warn('[LR] tabs.update failed, creating new tab:', updateErr);
                try {
                  const newTab = await chrome.tabs.create({ windowId: targetWinId, url: nextUrl });
                  inProgress.set(newTab.id, { intendedUrl: nextUrl, checks: 0, lastUrl: '' });
                } catch (createErr) {
                  // push back on queue and continue
                  linksQueue.unshift(nextUrl);
                  if (await readDebugFlag()) console.error('[LR] Failed to create fallback tab for', nextUrl, createErr);
                }
                // attempt to remove the old tab if still present
                try { await chrome.tabs.remove(tab.id); } catch (e) {}
              }
            } else {
              // nothing left to process — close this tab
              try { await chrome.tabs.remove(tab.id); } catch (e) { if (await readDebugFlag()) console.warn('[LR] Failed to close finished tab', tab.id, e); }
            }

            // check final completion
            if (linksQueue.length === 0 && inProgress.size === 0) {
              clearInterval(intervalId);
              await finalizeAndPost([]);
              return;
            }
          } // end confirmed branch

        } else {
          // not yet complete; reset consecutive checks
          rec.checks = 0;
          inProgress.set(tab.id, rec);
        }
      } // end for tabs

    } catch (err) {
      clearInterval(intervalId);
      setState({ status: 'error', message: 'Error during polling: ' + err.message });
      if (await readDebugFlag()) console.error('[LR] pollCycle error:', err);
      cleanup();
    }
  }, checkIntervalMs);
}

// ---------- end polling ----------

async function finalizeAndPost(passedTabs) {
  try {
    if (passedTabs && passedTabs.length > 0) {
      for (const t of passedTabs) {
        if (inProgress.has(t.id) && t.status === 'complete') {
          const rec = inProgress.get(t.id);
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
    setState({ status: 'completed', message: `Posting ${resolvedUrls.length} resolved urls...`, completed: resolvedUrls.length, total: (resolvedUrls.length) });

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

// cleanup: close windows and clear state
function cleanup() {
  if (targetWinId) { chrome.windows.remove(targetWinId).catch(()=>{}); targetWinId = null; }
  if (progressWinId) { chrome.windows.remove(progressWinId).catch(()=>{}); progressWinId = null; }
  chrome.alarms.clear('startPolling');
  abortFlag = false;
  inProgress.clear();
  linksQueue = [];
  setTimeout(()=> setState({ status: 'idle', message: 'Ready.' }), 2000);
}

