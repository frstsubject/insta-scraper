// background.js — MV3 service worker
// Routes downloads + forwards progress messages to popup.

importScripts('background_th.js');

// ── SW Keepalive ─────────────────────────────────────────────
// MV3 service workers are killed after ~30s of inactivity.
// We keep them alive during long scans using a port-based heartbeat,
// which is more reliable than setInterval + getPlatformInfo.

let _keepalivePort = null;
let _keepaliveTimer = null;

function startKeepalive() {
  if (_keepaliveTimer) return;
  // Self-connect: opening a port to ourselves prevents the SW from being killed
  try {
    _keepalivePort = chrome.runtime.connect({ name: 'vs-keepalive' });
    _keepalivePort.onDisconnect.addListener(() => { _keepalivePort = null; });
  } catch (_) {}
  // Belt-and-suspenders: also ping chrome every 20s
  _keepaliveTimer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {
        if (chrome.runtime.lastError) {} // ignore
      });
    } catch (_) {}
  }, 20000);
}

function stopKeepalive() {
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
  try { if (_keepalivePort) { _keepalivePort.disconnect(); _keepalivePort = null; } } catch (_) {}
}

// Accept inbound keepalive connections from the popup (chrome.runtime.connect)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vs-keepalive') return;
  // Keep the port open until the popup disconnects; this holds the SW awake
  port.onDisconnect.addListener(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let responded = false;
  function safeRespond(val) {
    if (responded) return;
    responded = true;
    try { sendResponse(val); } catch (_) {}
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

  // ── SW wake-up ping ─────────────────────────────────────
  // popup.js sends this before any real message to ensure SW is alive
  if (msg.action === 'SW_PING') {
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
        try { data = JSON.parse(text); } catch (_) {}
        safeRespond({ ok: res.ok, status: res.status, data });
      })
      .catch((err) => safeRespond({ ok: false, error: err.message }));
    return true;
  }

  // ── Download a single file ───────────────────────────────────
  if (msg.action === 'DOWNLOAD_FILE') {
    const { url, filename } = msg;
    if (!url || !filename) {
      safeRespond({ ok: false, error: 'Missing url or filename' });
      return;
    }
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
          safeRespond({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          safeRespond({ ok: true, id });
        }
      }
    );
    return true;
  }

  // ── Forward progress from content_bridge → popup ────────────
  if (msg.type === 'VS_PROGRESS') {
    chrome.runtime.sendMessage({ type: 'VS_PROGRESS', count: msg.count }, () => {
      if (chrome.runtime.lastError) {} // popup may be closed
    });
    safeRespond({ ok: true });
    return;
  }

  // ── Threads bulk download ─────────────────────────────────────
  if (msg.action === 'TH_BULK_DOWNLOAD_PROFILE' || msg.action === 'bulkDownloadProfileMedia') {
    handleBulkDownloadProfileMedia(msg, sender.tab.id, safeRespond);
    return true;
  }
  if (msg.action === 'stopBulkCollect') {
    if (typeof th_active_scans !== 'undefined' && th_active_scans.has(msg.sessionId)) {
      th_active_scans.set(msg.sessionId, 'stopped');
    }
    safeRespond({ ok: true });
    return true;
  }

  // ── Zero state nav ──────────────────────────────────────────
  if (msg.action === 'OPEN_IG') { chrome.tabs.create({ url: 'https://www.instagram.com/' }); safeRespond({ ok: true }); }
  if (msg.action === 'OPEN_TT') { chrome.tabs.create({ url: 'https://www.tiktok.com/' }); safeRespond({ ok: true }); }
  if (msg.action === 'OPEN_TH') { chrome.tabs.create({ url: 'https://www.threads.net/' }); safeRespond({ ok: true }); }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs[0]) return;
    chrome.action.setPopup({ tabId: tabs[0].id, popup: 'popup.html' }, () => {
      if (chrome.runtime.lastError) {}
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.action.setPopup({ tabId: tab.id, popup: 'popup.html' }, () => {
    if (chrome.runtime.lastError) {}
  });
});
