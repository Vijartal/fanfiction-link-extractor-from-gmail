// Runs in the progress.html window
const statusEl = document.getElementById('status');
document.getElementById('abort').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ABORT' });
  statusEl.textContent = 'Aborting…';
});

// Listen for progress updates
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'PROGRESS') {
    const { completed, total } = msg;
    statusEl.textContent = `Resolved ${completed} / ${total} tabs…`;
    if (completed === total) {
      statusEl.textContent = `All ${total} tabs loaded. Finishing up…`;
    }
  }
});
