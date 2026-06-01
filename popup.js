// popup.js — full orchestration for Instagram, TikTok, and Threads
// Integrates premium hospitality Director of Growth standards with full MV3 reliability.

// ── Progress listener registered at top-level (before DOMContentLoaded)
// so it catches messages that arrive before the DOM is ready.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'VS_PROGRESS') updateProgress(msg.count);
});

// ── State ────────────────────────────────────────────────────
// S is the single source of truth. It is always hydrated from storage
// before any render occurs. Never access S before initState() resolves.
let S = {
  platform: null,   // 'ig' | 'tt' | 'th'
  tabId: null,
  posts: [],
  stats: {},
  activeTab: 'all', // 'all'|'viral'|'video'|'image'
  scanning: false,
  handle: null,
  sortColumn: null,
  sortDirection: 'desc'
};

// ── Helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function fmt(n) {
  if (n == null || n < 0) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function slugify(s) {
  return (s || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
}

function buildFilename(post, ext) {
  const rank    = String(post.rank).padStart(3, '0');
  const viral   = post.isViral ? '_VIRAL' : '';
  const score   = post.viralScore ? `_${post.viralScore}pct` : '';
  const primary = post.likes > 0 ? `_${fmt(post.likes)}lk`
                : post.views > 0 ? `_${fmt(post.views)}vw` : '';
  const handle  = post.handle ? `_@${slugify(post.handle)}` : '';
  return `Post_${rank}${viral}${score}${primary}${handle}.${ext}`;
}

function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 2800);
}

function setStatus(label, cls = '') {
  const p = $('statusPill');
  p.textContent = label;
  p.className = 'status-pill' + (cls ? ' ' + cls : '');
}

// ── Persist S to storage (debounced) ─────────────────────────
let _saveTimer = null;
function persistState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    chrome.storage.local.set({
      vs_state: {
        posts:         (S.posts || []).filter(p => p != null),
        stats:         S.stats,
        handle:        S.handle,
        platform:      S.platform,
        activeTab:     S.activeTab,
        sortColumn:    S.sortColumn,
        sortDirection: S.sortDirection,
        ts:            Date.now()
      }
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('[popup][persistState] error:', chrome.runtime.lastError.message);
      }
    });
  }, 300);
}

// ── Restore S from storage ────────────────────────────────────
// Returns true if usable stored data was found and applied.
function restoreState(currentPlatform) {
  return new Promise((resolve) => {
    chrome.storage.local.get('vs_state', ({ vs_state }) => {
      if (chrome.runtime.lastError) {
        console.error('[popup][restoreState] storage error:', chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      if (!vs_state) { resolve(false); return; }
      if (vs_state.platform !== currentPlatform) { resolve(false); return; }
      // Expire after 60 minutes
      if (Date.now() - vs_state.ts > 60 * 60 * 1000) {
        chrome.storage.local.remove('vs_state', () => {
          if (chrome.runtime.lastError) {
            console.error('[popup][restoreState] remove error:', chrome.runtime.lastError.message);
          }
        });
        resolve(false);
        return;
      }
      S.posts         = (vs_state.posts  || []).filter(p => p != null);
      S.stats         = vs_state.stats  || {};
      S.handle        = vs_state.handle || null;
      S.activeTab     = vs_state.activeTab || 'all';
      S.sortColumn    = vs_state.sortColumn    || null;
      S.sortDirection = vs_state.sortDirection || 'desc';
      resolve(S.posts.length > 0);
    });
  });
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    S.tabId = tab.id;
    const url = tab.url || '';

    // Update Platform-specific tabs & labels
    const btnDlStories = $('btnDlStories');

    if (url.includes('instagram.com')) {
      S.platform = 'ig'; setStatus('Instagram', 'ig');
      showView('main'); $('platformBar').style.display = 'flex';
      $('platIG').classList.add('active');
      $('platTT').classList.remove('active');
      $('platTH').classList.remove('active');
      if (btnDlStories) btnDlStories.style.display = 'flex';
      detectProfile(url);
    } else if (url.includes('tiktok.com')) {
      S.platform = 'tt'; setStatus('TikTok', 'tt');
      showView('main'); $('platformBar').style.display = 'flex';
      $('platTT').classList.add('active');
      $('platIG').classList.remove('active');
      $('platTH').classList.remove('active');
      if (btnDlStories) btnDlStories.style.display = 'none';
      detectProfile(url);
    } else if (url.includes('threads.net') || url.includes('threads.com')) {
      S.platform = 'th'; setStatus('Threads', 'th');
      showView('main'); $('platformBar').style.display = 'flex';
      $('platTH').classList.add('active');
      $('platIG').classList.remove('active');
      $('platTT').classList.remove('active');
      if (btnDlStories) btnDlStories.style.display = 'none';
      detectProfile(url);
    } else {
      showView('zero');
      wireUI();
      return;
    }

    // ── Restore storage BEFORE wiring UI or running quickRead ──
    const hadData = await restoreState(S.platform);

    wireUI();

    if (hadData) {
      if (S.sortColumn) {
        $('selSortBy').value = S.sortColumn;
        const sortBy = S.sortColumn;
        const primaryMetric = (p) => {
          let m = -1;
          if (sortBy === 'likes')    m = p.likes >= 0 ? p.likes : p.views;
          if (sortBy === 'views')    m = p.views > 0 ? p.views : p.likes;
          if (sortBy === 'comments') m = p.comments;
          if (sortBy === 'shares')   m = p.shares;
          if (sortBy === 'saves')    m = p.saves;
          if (m <= 0) m = Math.max(p.likes, p.views, p.comments, 0);
          return m;
        };
        if (sortBy === 'newest')      S.posts.sort((a, b) => b.timestamp - a.timestamp);
        else if (sortBy === 'oldest') S.posts.sort((a, b) => a.timestamp - b.timestamp);
        else                          S.posts.sort((a, b) => primaryMetric(b) - primaryMetric(a));
      }

      switchTab(S.activeTab, /*persist=*/false);
      renderStats();
      renderPostList();
      $('resultsBlock').style.display = '';
      $('profileSub').textContent = `${S.posts.length} posts · ${S.stats.viral||0} viral — restored`;
      
      // Filter out null values before sending to content script
      const cleanPosts = (S.posts || []).filter(p => p != null);
      chrome.tabs.sendMessage(S.tabId, { action: 'INJECT_OVERLAYS', posts: cleanPosts }, () => {
        if (chrome.runtime.lastError) {
          // popup may have re-opened while page navigated; ignore
        }
      });
    } else {
      setTimeout(() => {
        if (!S.scanning) quickRead();
      }, 250);
    }
  } catch (err) {
    console.error('[popup][DOMContentLoaded] init error:', err);
  }
});

function detectProfile(url) {
  let handle = null;
  if (S.platform === 'ig') {
    const m = url.match(/instagram\.com\/([^/?#]+)/);
    if (m && !['explore','reel','p','stories','direct','accounts','reels'].includes(m[1])) handle = m[1];
  } else if (S.platform === 'tt') {
    const m = url.match(/tiktok\.com\/@([^/?#]+)/);
    if (m) handle = m[1];
  } else if (S.platform === 'th') {
    const m = url.match(/threads\.(?:net|com)\/@([^/?#]+)/);
    if (m) handle = m[1];
  }
  if (handle) {
    $('profileBar').style.display = 'flex';
    $('profileHandle').textContent = `@${handle}`;
    $('profileSub').textContent = 'Profile page detected';
    $('profileAva').textContent = handle[0].toUpperCase();
    S.handle = handle;
  }
}

function showView(v) {
  $('viewZero').style.display = v === 'zero' ? '' : 'none';
  $('viewMain').style.display = v === 'main' ? '' : 'none';
}

// ── Wire all UI ───────────────────────────────────────────────
function wireUI() {
  $('goIG').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_IG' }, () => {
      if (chrome.runtime.lastError) console.error('[popup][goIG] error:', chrome.runtime.lastError.message);
    });
  });
  $('goTT').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_TT' }, () => {
      if (chrome.runtime.lastError) console.error('[popup][goTT] error:', chrome.runtime.lastError.message);
    });
  });
  $('goTH').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_TH' }, () => {
      if (chrome.runtime.lastError) console.error('[popup][goTH] error:', chrome.runtime.lastError.message);
    });
  });

  $('platIG').addEventListener('click', () => {
    if (S.platform !== 'ig') {
      chrome.tabs.create({ url: 'https://www.instagram.com/' }, () => {
        if (chrome.runtime.lastError) console.error('[popup][platIG] create tab error:', chrome.runtime.lastError.message);
      });
    }
  });
  $('platTT').addEventListener('click', () => {
    if (S.platform !== 'tt') {
      chrome.tabs.create({ url: 'https://www.tiktok.com/' }, () => {
        if (chrome.runtime.lastError) console.error('[popup][platTT] create tab error:', chrome.runtime.lastError.message);
      });
    }
  });
  $('platTH').addEventListener('click', () => {
    if (S.platform !== 'th') {
      chrome.tabs.create({ url: 'https://www.threads.net/' }, () => {
        if (chrome.runtime.lastError) console.error('[popup][platTH] create tab error:', chrome.runtime.lastError.message);
      });
    }
  });

  $('btnScan').addEventListener('click', startScan);
  $('btnQuick').addEventListener('click', quickRead);

  $('chkDateRange').addEventListener('change', () => {
    $('dateRangePanel').style.display = $('chkDateRange').checked ? 'grid' : 'none';
  });

  $('btnSortGrid').addEventListener('click', sortGrid);
  $('btnDlViral').addEventListener('click', () => startDownload(true));
  $('btnDlAll').addEventListener('click',   () => startDownload(false));

  $('btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('exportMenu');
    m.style.display = m.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', () => $('exportMenu').style.display = 'none');

  $('expCSV').addEventListener('click',    () => exportData('csv'));
  $('expJSON').addEventListener('click',   () => exportData('json'));
  $('expSheets').addEventListener('click', () => exportData('sheets'));
  $('expExcel').addEventListener('click',  () => exportData('excel'));

  $('tabAll').addEventListener('click',   () => switchTab('all'));
  $('tabViral').addEventListener('click', () => switchTab('viral'));
  $('tabVideo').addEventListener('click', () => switchTab('video'));
  $('tabImage').addEventListener('click', () => switchTab('image'));

  const btnDlStories = $('btnDlStories');
  if (btnDlStories) {
    btnDlStories.addEventListener('click', async () => {
      if (S.platform !== 'ig') return toast('Only supported on Instagram', 'err');
      toast('Injecting bridge...', 'info');
      await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: ['content_bridge.js'] })
        .catch((err) => console.error('[popup][dlStories] Script injection failed:', err));
      
      toast('Extracting all stories & highlights...', 'info');
      chrome.tabs.sendMessage(S.tabId, { action: 'DOWNLOAD_ALL_STORIES' }, res => {
        if (chrome.runtime.lastError || !res?.ok) {
          toast('Failed or no stories found', 'err');
        } else {
          toast('Started downloading stories/highlights', 'ok');
        }
      });
    });
  }

  // Re-process on filter change (only if data already exists — don't re-trigger a read on every change)
  ['selCount', 'selSortBy', 'selThreshold', 'selType'].forEach(id => {
    $(id).addEventListener('change', () => {
      if (S.platform && !S.scanning && S.posts.length) reprocessPosts();
    });
  });
  $('chkDateRange').addEventListener('change', () => {
    if (S.platform && !S.scanning && S.posts.length) reprocessPosts();
  });
  $('dateFrom').addEventListener('change', () => {
    if (S.platform && !S.scanning && S.posts.length) reprocessPosts();
  });
  $('dateTo').addEventListener('change', () => {
    if (S.platform && !S.scanning && S.posts.length) reprocessPosts();
  });
}

// ── Wake the service worker before sending messages to it ────
// MV3 SWs can be killed at any time. Opening a port wakes it instantly.
// We also send a message ping as a belt-and-suspenders fallback.
let _swPort = null;

function wakeSW() {
  return new Promise((resolve) => {
    // Open a long-lived port to hold the SW awake during the scan
    try {
      if (_swPort) { try { _swPort.disconnect(); } catch (_) {} }
      _swPort = chrome.runtime.connect({ name: 'vs-keepalive' });
      _swPort.onDisconnect.addListener(() => { _swPort = null; });
    } catch (_) {}

    // Ping to confirm it's responding
    chrome.runtime.sendMessage({ action: 'SW_PING' }, () => {
      if (chrome.runtime.lastError) {
        // SW was dead — it restarted on the connect above; give it 400ms
        setTimeout(resolve, 400);
      } else {
        resolve();
      }
    });
  });
}

// ── SCAN ──────────────────────────────────────────────────────
async function startScan() {
  if (S.scanning) return;
  S.scanning = true;
  const btn = $('btnScan');
  btn.disabled = true;
  $('btnScanTxt').textContent = 'Scanning…';
  setStatus('Scanning…', 'scanning');
  $('progressBlock').style.display = '';
  $('resultsBlock').style.display  = 'none';
  setPb(5, 'Connecting…');

  // Wake the service worker FIRST — avoids "No SW" / dead-SW errors
  await wakeSW();

  const count      = parseInt($('selCount').value, 10);
  const sortBy     = $('selSortBy').value;
  const threshold  = parseFloat($('selThreshold').value);
  const typeFilter = $('selType').value;

  let dateFrom = null, dateTo = null;
  if ($('chkDateRange').checked) {
    if ($('dateFrom').value) dateFrom = new Date($('dateFrom').value).getTime() / 1000;
    if ($('dateTo').value)   dateTo   = new Date($('dateTo').value).getTime() / 1000;
  }

  try {
    // Inject bridge and verify it's alive before starting
    await chrome.scripting.executeScript({
      target: { tabId: S.tabId },
      files: ['content_bridge.js']
    }).catch(err => { throw new Error('Failed to inject bridge: ' + err.message); });

    // Ping to confirm bridge is responding
    const pingOk = await new Promise((resolve) => {
      chrome.tabs.sendMessage(S.tabId, { action: 'VS_PING' }, (res) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(!!res);
      });
    });
    if (!pingOk) throw new Error('Content bridge not responding. Reload the profile page and try again.');

    setPb(15, 'Injected — scrolling profile…');

    const result = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Scan timed out (90s). Try scrolling the profile manually first.')), 90000);
      chrome.tabs.sendMessage(S.tabId, { action: 'SCAN_PROFILE', count }, (res) => {
        clearTimeout(to);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(res);
        }
      });
    });

    // If API intercept returned nothing (common on reels tab first load),
    // fall back to a Quick Read which uses the already-intercepted data
    // plus the DOM fallback, then show a helpful hint.
    if (!result?.ok || !result.posts?.length) {
      setPb(90, 'Trying quick read fallback…');
      const qResult = await new Promise((resolve) => {
        chrome.tabs.sendMessage(S.tabId, { action: 'QUICK_READ' }, (r) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      });
      if (qResult?.posts?.length) {
        // We got posts from the fallback — use them but warn the user
        toast('Tip: scroll the reels tab first for better results', '');
        result.posts = qResult.posts;
        result.ok = true;
      } else {
        throw new Error('No posts captured. On the reels tab, scroll down a bit first then scan again.');
      }
    }

    const processed = processRawPosts(result.posts, { count, sortBy, threshold, typeFilter, dateFrom, dateTo });
    S.posts = (processed.posts || []).filter(p => p != null);
    S.stats = processed.stats;

    renderStats();
    renderPostList();
    persistState();

    setPb(100, 'Done!');
    $('resultsBlock').style.display = '';
    const vp = processed.stats.viral;
    const vPct = processed.stats.viralPct;
    $('profileSub').textContent = `${S.posts.length} posts · ${vp} viral (${vPct}%)`;

    // Filter out null values before sending to content script
    const cleanPosts = (S.posts || []).filter(p => p != null);
    chrome.tabs.sendMessage(S.tabId, { action: 'INJECT_OVERLAYS', posts: cleanPosts }, () => {
      if (chrome.runtime.lastError) {}
    });

  } catch (err) {
    console.error('[popup][startScan] error:', err);
    toast('Error: ' + err.message, 'err');
    $('progressBlock').style.display = 'none';
  } finally {
    S.scanning = false;
    btn.disabled = false;
    $('btnScanTxt').textContent = 'Full Scan';
    setStatus(S.platform === 'ig' ? 'Instagram' : (S.platform === 'tt' ? 'TikTok' : 'Threads'), S.platform);
    // Stop keepalive port + message
    try { if (_swPort) { _swPort.disconnect(); _swPort = null; } } catch (_) {}
    chrome.runtime.sendMessage({ action: 'SCAN_KEEPALIVE_STOP' }, () => {
      if (chrome.runtime.lastError) {}
    });
  }
}

// ── Core processing pipeline (shared by scan + quickRead + filter changes) ──
function processRawPosts(rawPosts, opts) {
  const { count, sortBy, threshold, typeFilter, dateFrom, dateTo } = opts;

  S.sortColumn = sortBy;
  S.sortDirection = (sortBy === 'oldest') ? 'asc' : 'desc';

  let posts = (rawPosts || []).filter(p => p != null);

  if (typeFilter && typeFilter !== 'all') posts = posts.filter(p => p.type === typeFilter);
  if (dateFrom) posts = posts.filter(p => !p.timestamp || p.timestamp >= dateFrom);
  if (dateTo)   posts = posts.filter(p => !p.timestamp || p.timestamp <= dateTo);

  posts = posts.map(p => ({ ...p, handle: p.handle || S.handle || null }));

  const primaryMetric = (p) => {
    let m = -1;
    if (sortBy === 'likes')    m = p.likes >= 0 ? p.likes : p.views;
    if (sortBy === 'views')    m = p.views > 0 ? p.views : p.likes;
    if (sortBy === 'comments') m = p.comments;
    if (sortBy === 'shares')   m = p.shares;
    if (sortBy === 'saves')    m = p.saves;
    if (m <= 0) m = Math.max(p.likes, p.views, p.comments, 0);
    return m;
  };

  const metrics = posts.map(primaryMetric).filter(v => v >= 0);
  const avg = metrics.length ? metrics.reduce((a, b) => a + b, 0) / metrics.length : 0;

  posts = posts.map(p => {
    const m = primaryMetric(p);
    return { ...p, isViral: avg > 0 && m >= avg * threshold, viralScore: avg > 0 ? Math.round((m / avg) * 100) : 0, _primary: m };
  });

  // Sort BEFORE slicing so top-N are always the correct posts
  if (sortBy === 'newest')      posts.sort((a, b) => b.timestamp - a.timestamp);
  else if (sortBy === 'oldest') posts.sort((a, b) => a.timestamp - b.timestamp);
  else                          posts.sort((a, b) => b._primary - a._primary);

  posts = posts.slice(0, count);
  posts = posts.map((p, i) => ({ ...p, rank: i + 1 }));

  const avg2 = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const viralPosts = posts.filter(p => p.isViral);
  const viralPct   = posts.length ? Math.round((viralPosts.length / posts.length) * 100) : 0;

  const stats = {
    total: posts.length,
    viral: viralPosts.length,
    viralPct,
    avgLikes:    avg2(posts.map(p => p.likes).filter(v => v >= 0)),
    avgViews:    avg2(posts.map(p => p.views).filter(v => v > 0)),
    avgComments: avg2(posts.map(p => p.comments).filter(v => v > 0)),
    topPost:     posts[0]?.likes ?? posts[0]?.views ?? 0
  };

  return { posts, stats };
}

// ── Re-process existing raw data when filters/sort change ────
function reprocessPosts() {
  if (!S.scanning) quickRead();
}

function updateProgress(count) {
  const target = parseInt($('selCount').value, 10);
  const pct = 15 + Math.round((count / target) * 70);
  setPb(Math.min(pct, 85), `Collected ${count} / ${target} posts…`);
}

function setPb(pct, label) {
  $('pbFill').style.width = pct + '%';
  $('pbLabel').textContent = label;
}

// ── Stats render ─────────────────────────────────────────────
function renderStats() {
  const s = S.stats;
  $('sTotal').textContent    = s.total;
  $('sViral').textContent    = `${s.viral} (${s.viralPct}%)`;
  $('sAvgLikes').textContent = fmt(s.avgLikes);
  $('sAvgViews').textContent = fmt(s.avgViews);
  $('sAvgComments').textContent = fmt(s.avgComments);
  $('sTopPost').textContent  = fmt(s.topPost);
}

// ── Post list render ─────────────────────────────────────────
function switchTab(tab, persist = true) {
  S.activeTab = tab;
  ['all','viral','video','image'].forEach(t => {
    $(`tab${t.charAt(0).toUpperCase()+t.slice(1)}`).classList.toggle('active', t === tab);
  });
  renderPostList();
  if (persist) persistState();
}

function renderPostList() {
  const list = $('postList');
  list.innerHTML = '';
  let posts = (S.posts || []).filter(p => p != null);

  if (S.activeTab === 'viral') posts = posts.filter(p => p.isViral);
  if (S.activeTab === 'video') posts = posts.filter(p => p.type === 'video');
  if (S.activeTab === 'image') posts = posts.filter(p => p.type !== 'video');

  if (!posts.length) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);font-size:12px">No posts to show</div>`;
    return;
  }

  posts.forEach(post => {
    const ext  = post.type === 'video' ? 'mp4' : 'jpg';
    const name = buildFilename(post, ext);
    const hotClass = post.isViral ? ' viral' : '';
    const typeIcon = post.type === 'video' ? '▶' : post.type === 'carousel' ? '⊞' : '🖼';

    const card = document.createElement('a');
    card.className = `post-card${hotClass}`;
    card.href  = post.url || '#';
    card.target = '_blank';
    card.rel   = 'noopener';

    card.innerHTML = `
      <div class="post-thumb">
        ${post.thumbnail ? `<img src="${post.thumbnail}" loading="lazy" alt="">` : ''}
        <div class="type-badge">${typeIcon}</div>
        ${post.viralScore ? `<div class="viral-score">${post.viralScore}%</div>` : ''}
      </div>
      <div class="post-body">
        <div class="post-top">
          <span class="post-rank">#${post.rank}</span>
          ${post.isViral ? '<span class="viral-badge">🔥 Viral</span>' : ''}
        </div>
        <div class="post-metrics">
          ${post.likes >= 0 ? `<span class="pm${post.isViral ? ' hot' : ''}">❤ <strong>${fmt(post.likes)}</strong></span>` : ''}
          ${post.views > 0  ? `<span class="pm">▶ <strong>${fmt(post.views)}</strong></span>` : ''}
          ${post.comments > 0 ? `<span class="pm">💬 <strong>${fmt(post.comments)}</strong></span>` : ''}
          ${post.shares > 0   ? `<span class="pm">🔁 <strong>${fmt(post.shares)}</strong></span>` : ''}
          ${post.saves > 0    ? `<span class="pm">🔖 <strong>${fmt(post.saves)}</strong></span>` : ''}
        </div>
        <div class="post-fname">${name}</div>
      </div>
      <div class="post-actions">
        <button class="pa-btn dl" data-id="${post.id}" title="Download">⬇</button>
        <button class="pa-btn cp" data-url="${post.videoUrl || post.imageUrl || ''}" title="Copy URL">📋</button>
      </div>
    `;

    card.querySelector('.pa-btn.dl').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      downloadSingle(post);
    });
    card.querySelector('.pa-btn.cp').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const url = post.videoUrl || post.imageUrl || post.url || '';
      navigator.clipboard.writeText(url)
        .then(() => toast('URL copied!', 'ok'))
        .catch(() => toast('Copy failed', 'err'));
    });

    list.appendChild(card);
  });
}

// ── Quick Read (no scroll — reads already-captured data) ────
async function quickRead() {
  if (S.scanning) return;
  S.scanning = true;
  $('btnQuick').textContent = '⏳…';
  $('btnQuick').disabled = true;
  setStatus('Reading…', 'scanning');
  try {
    await wakeSW();
    await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: ['content_bridge.js'] }).catch(() => {});

    const result = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('Timeout')), 10000);
      chrome.tabs.sendMessage(S.tabId, { action: 'QUICK_READ' }, r => {
        clearTimeout(to);
        if (chrome.runtime.lastError) {
          rej(new Error(chrome.runtime.lastError.message));
        } else {
          res(r);
        }
      });
    });

    if (result?.posts?.length) {
      const count      = parseInt($('selCount').value, 10);
      const threshold  = parseFloat($('selThreshold').value);
      const sortBy     = $('selSortBy').value;
      const typeFilter = $('selType').value;
      const dateFrom   = $('chkDateRange').checked && $('dateFrom').value ? new Date($('dateFrom').value).getTime() / 1000 : null;
      const dateTo     = $('chkDateRange').checked && $('dateTo').value   ? new Date($('dateTo').value).getTime()   / 1000 + 86399 : null;

      const processed = processRawPosts(result.posts, { count, sortBy, threshold, typeFilter, dateFrom, dateTo });
      S.posts = (processed.posts || []).filter(p => p != null);
      S.stats = processed.stats;

      renderStats();
      renderPostList();
      $('resultsBlock').style.display = '';
      persistState();

      // Filter out null values before sending to content script
      const cleanPosts = (S.posts || []).filter(p => p != null);
      chrome.tabs.sendMessage(S.tabId, { action: 'INJECT_OVERLAYS', posts: cleanPosts }, () => {
        if (chrome.runtime.lastError) {}
      });
      toast(`⚡ Quick read: ${S.posts.length} posts`, 'ok');
    } else {
      toast('Nothing captured yet — scroll the profile first or use Full Scan', 'err');
    }
  } catch (err) {
    console.error('[popup][quickRead] error:', err);
    toast('Quick read failed: ' + err.message, 'err');
  } finally {
    S.scanning = false;
    $('btnQuick').textContent = '⚡ Quick Read';
    $('btnQuick').disabled = false;
    setStatus(S.platform === 'ig' ? 'Instagram' : (S.platform === 'tt' ? 'TikTok' : 'Threads'), S.platform);
  }
}

// ── Grid Sort ─────────────────────────────────────────────────
async function sortGrid() {
  if (!S.posts.length) { toast('Scan first!', 'err'); return; }
  const btn = $('btnSortGrid');
  btn.disabled = true;
  btn.textContent = '⏳ Sorting…';

  // For IG / Threads: always use shortcode (matches URL path segment).
  // Derive shortcode from post.url if post.shortcode is null.
  const ids = S.posts.map(p => {
    if (S.platform === 'ig') {
      if (p.shortcode) return p.shortcode;
      const m = (p.url || '').match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : null;
    }
    if (S.platform === 'th') {
      if (p.shortcode) return p.shortcode;
      const m = (p.url || '').match(/\/post\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : null;
    }
    // TikTok: numeric video ID
    return p.id || null;
  }).filter(Boolean);

  if (!ids.length) {
    toast('No valid IDs for sort', 'err');
    btn.disabled = false;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M3 12h12M3 18h6"/></svg> Sort Grid`;
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: ['content_bridge.js'] }).catch(() => {});

    await new Promise((resolve) => {
      chrome.tabs.sendMessage(S.tabId, { action: 'SORT_GRID', ids }, (res) => {
        if (chrome.runtime.lastError) {
          console.error('[popup][sortGrid] sendMessage error:', chrome.runtime.lastError.message);
          toast('Grid sort — try scrolling profile first', 'err');
        } else if (!res?.ok) {
          toast('Grid sort — no matching posts found in DOM', 'err');
        } else {
          toast('✓ Grid sorted by viral score', 'ok');
        }
        resolve();
      });
    });
  } catch (err) {
    console.error('[popup][sortGrid] error:', err);
    toast('Sort failed: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M3 12h12M3 18h6"/></svg> Sort Grid`;
  }
}

// ── Download ─────────────────────────────────────────────────
async function downloadSingle(post) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: ['content_bridge.js'] }).catch(() => {});

    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(S.tabId, { action: 'DOWNLOAD_POST', post }, (r) => {
        if (chrome.runtime.lastError) {
          console.error('[popup][downloadSingle] sendMessage error:', chrome.runtime.lastError.message);
          resolve(null); // signal bridge unavailable
        } else {
          resolve(r);
        }
      });
    });

    if (res === null) {
      // Bridge unavailable — direct fallback via background
      const url = post.videoUrl || post.imageUrl || post.thumbnail;
      if (!url) { toast('No URL — scroll profile or rescan', 'err'); return; }
      const ext = post.type === 'video' ? 'mp4' : 'jpg';
      const folderType = post.type === 'video' ? 'reels' : 'posts';
      const handle = post.handle || 'UnknownUser';
      const name = post.shortcode || post.id || 'UnknownID';
      chrome.runtime.sendMessage({ action: 'DOWNLOAD_FILE', url, filename: `${handle}/${folderType}/${name}.${ext}` }, (r) => {
        if (chrome.runtime.lastError) {
          console.error('[popup][downloadSingle] direct fallback error:', chrome.runtime.lastError.message);
          toast('Download failed: ' + chrome.runtime.lastError.message, 'err');
        } else {
          toast('⬇ Downloading (Direct)…', 'ok');
        }
      });
    } else if (res?.ok) {
      toast('⬇ Downloading…', 'ok');
    } else {
      // Bridge responded but said not ok — try direct fallback
      console.error('[popup][downloadSingle] bridge returned ok:false');
      const url = post.videoUrl || post.imageUrl || post.thumbnail;
      if (url) {
        const ext = post.type === 'video' ? 'mp4' : 'jpg';
        const folderType = post.type === 'video' ? 'reels' : 'posts';
        const handle = post.handle || 'UnknownUser';
        const name = post.shortcode || post.id || 'UnknownID';
        chrome.runtime.sendMessage({ action: 'DOWNLOAD_FILE', url, filename: `${handle}/${folderType}/${name}.${ext}` }, (r) => {
          if (chrome.runtime.lastError) {
            toast('Download failed: ' + chrome.runtime.lastError.message, 'err');
          } else {
            toast('⬇ Downloading (Fallback)…', 'ok');
          }
        });
      } else {
        toast('Failed to get download URL', 'err');
      }
    }
  } catch (err) {
    console.error('[popup][downloadSingle] error:', err);
    toast('Download error: ' + err.message, 'err');
  }
}

async function startDownload(viralOnly) {
  if (!S.posts.length) { toast('Scan first!', 'err'); return; }

  const dlImages    = $('dlImages').checked;
  const dlVideos    = $('dlVideos').checked;
  const dlCarousels = $('dlCarousels').checked;

  let posts = S.posts.filter(p => {
    if (viralOnly && !p.isViral) return false;
    if (!dlImages    && p.type === 'image')    return false;
    if (!dlVideos    && p.type === 'video')    return false;
    if (!dlCarousels && p.type === 'carousel') return false;
    return true;
  });

  if (!posts.length) { toast('Nothing matches filters', 'err'); return; }

  await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: ['content_bridge.js'] }).catch(() => {});

  const ol = $('dlOverlay');
  ol.style.display = 'flex';
  $('dlTitle').textContent = `Downloading ${posts.length} files…`;
  $('dlSub').textContent   = `0 / ${posts.length}`;
  $('dlFill').style.width  = '0%';

  let done = 0;
  for (const post of posts) {
    await downloadSingle(post);
    done++;
    $('dlSub').textContent  = `${done} / ${posts.length}`;
    $('dlFill').style.width = Math.round((done / posts.length) * 100) + '%';
    await new Promise(r => setTimeout(r, 200));
  }

  ol.style.display = 'none';
  const dlHandle = S.handle || 'UnknownUser';
  toast(`✓ ${done} files → ${dlHandle}/`, 'ok');
}

// ── Export ───────────────────────────────────────────────────
function exportData(format) {
  $('exportMenu').style.display = 'none';
  if (!S.posts.length) { toast('Scan first!', 'err'); return; }

  if (format === 'csv' || format === 'excel') {
    const rows = [
      ['Rank','Viral','Score%','Type','Likes','Views','Comments','Shares','Saves','URL','Filename','Caption'].join(','),
      ...S.posts.map(p => {
        const ext  = p.type === 'video' ? 'mp4' : 'jpg';
        const name = buildFilename(p, ext);
        return [p.rank, p.isViral?'YES':'NO', p.viralScore, p.type, p.likes, p.views, p.comments, p.shares, p.saves,
          p.url, name, (p.caption||'').replace(/"/g,'""')]
          .map(v => `"${v ?? ''}"`).join(',');
      })
    ].join('\n');

    const blob = new Blob([rows], { type: 'text/csv' });
    const bUrl = URL.createObjectURL(blob);
    chrome.downloads.download({ url: bUrl, filename: 'ViralScraper/viral_report.csv', saveAs: false }, (id) => {
      if (chrome.runtime.lastError) {
        console.error('[popup][exportData] csv download error:', chrome.runtime.lastError.message);
        toast('Export failed: ' + chrome.runtime.lastError.message, 'err');
      } else {
        toast(`✓ ${format === 'excel' ? 'Excel-ready' : 'CSV'} exported`, 'ok');
      }
      URL.revokeObjectURL(bUrl);
    });
    return;
  }

  if (format === 'json') {
    const data = S.posts.map(p => ({
      rank: p.rank, viral: p.isViral, viralScore: p.viralScore,
      type: p.type, likes: p.likes, views: p.views, comments: p.comments,
      shares: p.shares, saves: p.saves, url: p.url, caption: p.caption,
      filename: buildFilename(p, p.type === 'video' ? 'mp4' : 'jpg')
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const bUrl = URL.createObjectURL(blob);
    chrome.downloads.download({ url: bUrl, filename: 'ViralScraper/viral_report.json', saveAs: false }, (id) => {
      if (chrome.runtime.lastError) {
        console.error('[popup][exportData] json download error:', chrome.runtime.lastError.message);
        toast('Export failed: ' + chrome.runtime.lastError.message, 'err');
      } else {
        toast('✓ JSON exported', 'ok');
      }
      URL.revokeObjectURL(bUrl);
    });
    return;
  }

  if (format === 'sheets') {
    const rows = [
      ['Rank','Viral','Score%','Type','Likes','Views','Comments','Shares','URL'],
      ...S.posts.map(p => [p.rank, p.isViral?'YES':'NO', p.viralScore+'%', p.type, p.likes, p.views, p.comments, p.shares, p.url])
    ].map(r => r.join('\t')).join('\n');
    navigator.clipboard.writeText(rows).then(() => {
      chrome.tabs.create({ url: 'https://docs.google.com/spreadsheets/create' }, () => {
        if (chrome.runtime.lastError) console.error('[popup][exportData] create sheets tab error:', chrome.runtime.lastError.message);
      });
      toast('Data copied — paste into Sheet!', 'ok');
    }).catch(() => toast('Clipboard blocked', 'err'));
  }
}
