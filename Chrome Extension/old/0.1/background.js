// === CONFIG ===
const FILE_FETCH_URL    = 'https://your_server_or_drive_link/FF%20links%20extracted%20from%20gmail.txt';
const POST_BACK_URL     = 'https://script.google.com/macros/s/your-deployment-id/exec';
const INITIAL_DELAY_MIN = 5;

let abortFlag      = false;
let progressWinId  = null;
let targetWinId    = null;

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'ABORT') abortFlag = true;
});

chrome.action.onClicked.addListener(async () => {
  abortFlag = false;

  // 1) Fetch & filter SV/SB/QQ links
  const resp = await fetch(FILE_FETCH_URL);
  const text = await resp.text();
  const links = text
    .split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => l.split('|').pop().trim())
    .filter(url => /https?:\/\/(?:forums\.(?:sufficientvelocity|spacebattles)\.com\/posts\/\d{6,9}|forum\.questionablequesting\.com\/posts\/\d{6,9})/i.test(url));

  if (!links.length) {
    console.warn('No SV/SB/QQ links found.');
    return;
  }

  // 2) Open the target popup window
  const targetWin = await chrome.windows.create({
    url: links,
    type: 'popup'
  });
  targetWinId = targetWin.id;

  // 3) Open the progress UI window
  const progWin = await chrome.windows.create({
    url: chrome.runtime.getURL('progress.html'),
    type: 'popup',
    width: 300,
    height: 150
  });
  progressWinId = progWin.id;

  // 4) After INITIAL_DELAY_MIN, start polling
  chrome.alarms.create('startPolling', { delayInMinutes: INITIAL_DELAY_MIN });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'startPolling') return;
  pollTabs();
});

async function pollTabs() {
  if (abortFlag) {
    cleanup();
    return;
  }

  const tabs      = await chrome.tabs.query({ windowId: targetWinId });
  const total     = tabs.length;
  const completed = tabs.filter(t => t.status === 'complete').length;

  // Update the progress UI
  chrome.runtime.sendMessage({ type: 'PROGRESS', completed, total });

  if (abortFlag) {
    cleanup();
  }
  else if (completed === total) {
    // All done → post & cleanup
    const resolved = tabs.map(t => t.url);
    await fetch(POST_BACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved })
    });
    cleanup();
  }
  else {
    // Not all done → re-check in 1 minute
    setTimeout(pollTabs, 60_000);
  }
}

function cleanup() {
  if (targetWinId)   chrome.windows.remove(targetWinId).catch(() => {});
  if (progressWinId) chrome.windows.remove(progressWinId).catch(() => {});
  targetWinId   = null;
  progressWinId = null;
}
