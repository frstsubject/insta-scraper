// background.js — MV3 service worker
// Routes downloads + forwards progress messages to popup

importScripts('background_th.js');

// ── SW Keepalive ─────────────────────────────────────────────
// Prevents the service worker from being killed during long scans.
let _keepaliveTimer = null;

function startKeepalive() {
  if (_keepaliveTimer) return;
  _keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {
      if (chrome.runtime.lastError) {
        console.error('[background][keepalive] Platform info error:', chrome.runtime.lastError);
      }
    });
  }, 20000);
}

function stopKeepalive() {
  if (_keepaliveTimer) {
    clearInterval(_keepaliveTimer);
    _keepaliveTimer = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let responded = false;
  function safeRespond(val) {
    if (responded) return;
    responded = true;
    sendResponse(val);
  }

  // ── Keepalive control from popup ─────────────────────────
  if (msg.action === 'SCAN_KEEPALIVE_START') {
    startKeepalive();
    safeRespond({ ok: true });
    return;
  }
  if (msg.action === 'SCAN_KEEPALIVE_STOP') {
    stopKeepalive();
    safeRespond({ ok: true });
    return;
  }

  // ── Generic Cross-Origin Fetch Proxy ──────────────────────────
  if (msg.action === 'FETCH_CROSS_ORIGIN') {
    const { url, options } = msg;
    fetch(url, options)
      .then(async (res) => {
        const text = await res.text();
        let data = text;
        try {
          data = JSON.parse(text);
        } catch (_) {}
        safeRespond({ ok: res.ok, status: res.status, data });
      })
      .catch((err) => {
        safeRespond({ ok: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }

  // ── Download a single file ───────────────────────────────────
  if (msg.action === 'DOWNLOAD_FILE') {
    const { url, filename } = msg;
    if (!url || !filename) {
      safeRespond({ ok: false, error: 'Missing url or filename' });
      return;
    }

    // Sanitize each path segment — Chrome rejects special chars in subdir names
    const parts = filename.split('/');
    const clean = parts.map((seg, i) => {
      if (i === parts.length - 1) return seg.replace(/[<>:"|?*\\]/g, '_');
      return seg.replace(/[<>:"|?*\\/]/g, '_');
    });
    const cleanFilename = clean.join('/');

    chrome.downloads.download(
      { url, filename: cleanFilename, conflictAction: 'uniquify', saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) {
          console.error('[background][DOWNLOAD_FILE] error:', chrome.runtime.lastError);
          safeRespond({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          safeRespond({ ok: true, id });
        }
      }
    );
    return true; // keep channel open for async callback
  }

  // ── Forward progress from content_bridge → popup ────────────
  if (msg.type === 'VS_PROGRESS') {
    chrome.runtime.sendMessage({ type: 'VS_PROGRESS', count: msg.count }, () => {
      if (chrome.runtime.lastError) {
        // Ignored. Expected if popup is closed.
      }
    });
    safeRespond({ ok: true });
    return;
  }

  // ── Threads Reference Clone triggers ─────────────────────────
  if (msg.action === 'bulkDownloadProfileMedia') {
    handleBulkDownloadProfileMedia(msg, sender.tab.id, safeRespond);
    return true; // async
  }
  if (msg.action === 'stopBulkCollect') {
    if (typeof th_active_scans !== 'undefined' && th_active_scans.has(msg.sessionId)) {
      th_active_scans.set(msg.sessionId, 'stopped');
    }
    safeRespond({ ok: true });
    return true;
  }

  // ── Zero state nav ──────────────────────────────────────────
  if (msg.action === 'OPEN_IG') {
    chrome.tabs.create({ url: 'https://www.instagram.com/' });
    safeRespond({ ok: true });
  }
  if (msg.action === 'OPEN_TT') {
    chrome.tabs.create({ url: 'https://www.tiktok.com/' });
    safeRespond({ ok: true });
  }
  if (msg.action === 'OPEN_TH') {
    chrome.tabs.create({ url: 'https://www.threads.net/' });
    safeRespond({ ok: true });
  }
});

// Always assign popup on tab update
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error('[background][onUpdated] query error:', chrome.runtime.lastError);
      return;
    }
    if (tabs[0]) {
      chrome.action.setPopup({ tabId: tabs[0].id, popup: 'popup.html' }, () => {
        if (chrome.runtime.lastError) {
          console.error('[background][onUpdated] setPopup error:', chrome.runtime.lastError);
        }
      });
    }
  });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.action.setPopup({ tabId: tab.id, popup: 'popup.html' }, () => {
    if (chrome.runtime.lastError) {
      console.error('[background][onClicked] setPopup error:', chrome.runtime.lastError);
    }
  });
});
