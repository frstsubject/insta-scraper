// threads_reference/js/cs.js
// Threads content-script companion – injected alongside content_th.js.
// Responsibilities:
//   1. Inject "Download All" button into Threads profile headers.
//   2. Handle the bulk-download flow: talk to background_th.js, show
//      progress, and trigger individual downloads via content_bridge.js.
//   3. Stay idle on non-profile pages and re-attach when navigation
//      changes the URL (Threads is a SPA).

(function () {
  'use strict';

  if (window.__vs_cs_th_init) return;
  window.__vs_cs_th_init = true;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getHandle () {
    const m = location.pathname.match(/^\/@([^/?#]+)\/?$/);
    return m ? m[1] : null;
  }

  function isProfilePage () {
    return /^\/@([^/?#]+)\/?$/.test(location.pathname);
  }

  // ── Progress overlay ───────────────────────────────────────────────────────

  function showOverlay (title, sub, pct) {
    let el = document.getElementById('vs-progress-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vs-progress-overlay';
      el.innerHTML = [
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">',
          '<div id="vs-overlay-title" style="font-weight:700;font-size:14px">Scraping…</div>',
          '<div id="vs-overlay-pct"   style="font-size:12px;font-weight:700;color:rgba(255,255,255,.72)">0%</div>',
        '</div>',
        '<div style="width:100%;height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden;margin-bottom:8px">',
          '<div id="vs-overlay-fill" style="width:0%;height:100%;background:linear-gradient(90deg,#7c3aed,#f43f8e);transition:width .2s ease"></div>',
        '</div>',
        '<div id="vs-overlay-sub" style="font-size:12px;color:rgba(255,255,255,.6)">Starting…</div>',
      ].join('');
      document.body.appendChild(el);
    }
    const T = document.getElementById('vs-overlay-title');
    const S = document.getElementById('vs-overlay-sub');
    const P = document.getElementById('vs-overlay-pct');
    const F = document.getElementById('vs-overlay-fill');
    if (T) T.textContent = title;
    if (S) S.textContent = sub;
    if (P) P.textContent = pct + '%';
    if (F) F.style.width = pct + '%';
  }

  function hideOverlay () {
    const el = document.getElementById('vs-progress-overlay');
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => { if (el.parentNode && el.style.opacity === '0') el.remove(); }, 300);
    }
  }

  // ── Button state ───────────────────────────────────────────────────────────

  function resetBtn () {
    const btn = document.getElementById('vs-th-bulk-btn');
    if (!btn) return;
    btn.classList.remove('busy');
    btn.innerHTML = '<span>⬇</span> Download All';
    btn.disabled = false;
  }

  function setBtnBusy (label) {
    const btn = document.getElementById('vs-th-bulk-btn');
    if (!btn) return;
    btn.classList.add('busy');
    btn.innerHTML = label || '⏳ Collecting…';
    btn.disabled = true;
  }

  // ── Bulk download ──────────────────────────────────────────────────────────

  let _activeScan = null;

  function startBulkDownload () {
    const handle = getHandle();
    if (!handle) return;

    const sessionId = 'vs_th_' + Date.now();
    _activeScan = sessionId;
    setBtnBusy('⏳ Collecting…');
    showOverlay('Collecting Threads posts', 'Starting…', 0);

    // Listen for incremental progress updates sent from background_th.js
    // via chrome.tabs.sendMessage({ action:"bulkCollectUpdate", … }).
    const progressListener = (msg) => {
      if (msg?.action !== 'bulkCollectUpdate') return;
      if (msg.sessionId !== sessionId) return;
      const n = msg.totalPostCount || 0;
      setBtnBusy(`⏳ ${n} posts…`);
      showOverlay('Collecting Threads posts', `Found ${n} posts…`, Math.min(80, Math.round((n / (n + 10)) * 80)));
    };
    chrome.runtime.onMessage.addListener(progressListener);

    chrome.runtime.sendMessage(
      { action: 'TH_BULK_DOWNLOAD_PROFILE', username: handle, sessionId },
      (resp) => {
        chrome.runtime.onMessage.removeListener(progressListener);

        if (chrome.runtime.lastError || !resp?.ok) {
          console.warn('[cs.js] bulk download failed:', chrome.runtime.lastError?.message || resp?.err);
          resetBtn();
          hideOverlay();
          return;
        }

        const plan      = resp.plan || [];
        const summary   = resp.summary || {};
        const total     = summary.mediaCount || plan.reduce((s, p) => s + (p.items?.length || 1), 0);
        let   done      = 0;

        showOverlay('Downloading media', `0 / ${total}`, 0);
        setBtnBusy('⬇ Downloading…');

        if (!plan.length) {
          resetBtn();
          hideOverlay();
          return;
        }

        // Sequential download: one item at a time to avoid rate-limiting.
        (async () => {
          for (const post of plan) {
            for (const item of (post.items || [])) {
              if (!item.url) { done++; continue; }

              const ext      = item.kind === 'video' ? 'mp4' : 'jpg';
              const idx      = (post.items.length > 1) ? `_${item.downloadIndex + 1}` : '';
              const filename = `${post.username}/threads/${post.postId}${idx}.${ext}`;

              try {
                await new Promise((resolve, reject) => {
                  chrome.runtime.sendMessage(
                    { action: 'DOWNLOAD_FILE', url: item.url, filename },
                    (res) => {
                      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                      if (res && !res.ok)           return reject(new Error(res.error));
                      resolve();
                    }
                  );
                });
              } catch (err) {
                console.warn('[cs.js] download error:', err);
              }

              done++;
              const pct = Math.round((done / total) * 100);
              showOverlay('Downloading media', `${done} / ${total}`, pct);
              await new Promise(r => setTimeout(r, 150));
            }
          }

          resetBtn();
          showOverlay('Done!', `Downloaded ${done} files.`, 100);
          setTimeout(hideOverlay, 2500);
        })();
      }
    );
  }

  // ── Inject "Download All" button into profile header ───────────────────────

  let _btnInjected = false;

  function injectButton () {
    if (_btnInjected && document.getElementById('vs-th-bulk-btn')) return;
    _btnInjected = false;

    if (!isProfilePage()) return;

    // Try to find the Follow / Edit Profile button row as an anchor point.
    // Threads renders different selectors depending on logged-in state;
    // we fall back to a header heuristic.
    const anchor =
      document.querySelector('[data-pressable-container] [role="button"]') ||
      document.querySelector('header [role="button"]') ||
      document.querySelector('header button');

    if (!anchor) return; // Not rendered yet — the MutationObserver will retry.

    // Avoid double-injection.
    if (document.getElementById('vs-th-bulk-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'vs-th-bulk-btn';
    btn.innerHTML = '<span>⬇</span> Download All';
    btn.title = 'Viral Scraper – bulk download this Threads profile';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      startBulkDownload();
    });

    anchor.parentElement.appendChild(btn);
    _btnInjected = true;
  }

  // ── SPA navigation watcher ─────────────────────────────────────────────────

  let _lastPath = location.pathname;

  function onNavigate () {
    if (location.pathname === _lastPath) return;
    _lastPath = location.pathname;
    _btnInjected = false;
    // Give the SPA a moment to render the new page's DOM.
    setTimeout(injectButton, 800);
  }

  // Threads uses the History API for navigation.
  const _origPushState    = history.pushState.bind(history);
  const _origReplaceState = history.replaceState.bind(history);
  history.pushState = function (...args) { _origPushState(...args);    onNavigate(); };
  history.replaceState = function (...args) { _origReplaceState(...args); onNavigate(); };
  window.addEventListener('popstate', onNavigate);

  // MutationObserver retries button injection when the DOM changes.
  const _observer = new MutationObserver(() => {
    if (isProfilePage() && !document.getElementById('vs-th-bulk-btn')) {
      injectButton();
    }
  });
  _observer.observe(document.body, { childList: true, subtree: true });

  // Initial attempt.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(injectButton, 800));
  } else {
    setTimeout(injectButton, 800);
  }

})();
