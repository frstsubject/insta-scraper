// content_tt.js — runs in MAIN world at document_start
// Intercepts TikTok's fetch/XHR to collect post metrics.

(function () {
  if (window.__vs_tt_init) return;
  window.__vs_tt_init = true;
  window.__vs_tt = [];

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (isTTApiUrl(url)) {
        res.clone().json()
          .then(d => ingestTT(d))
          .catch((err) => {
            console.error('[content_tt][fetch] json extraction failed:', err);
          });
      }
    } catch (err) {
      console.error('[content_tt][fetch] intercept failed:', err);
    }
    return res;
  };

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url, ...r) {
    this._vsUrl = url; return _open.call(this, m, url, ...r);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () {
      try {
        if (isTTApiUrl(this._vsUrl)) ingestTT(JSON.parse(this.responseText));
      } catch (err) {
        console.error('[content_tt][xhr] parse failed:', err);
      }
    });
    return _send.apply(this, a);
  };

  function isTTApiUrl(u) {
    return u && (
      u.includes('/api/user/post') ||
      u.includes('/api/item_list') ||
      u.includes('/api/post/item_list') ||
      u.includes('tiktok.com/api/recommend') ||
      u.includes('/aweme/v1/feed')
    );
  }

  function dedup(id) { return !window.__vs_tt.find(p => p.id === id); }

  function ingestTT(data) {
    try {
      const items = data?.itemList || data?.aweme_list || data?.data?.itemList || [];
      if (!Array.isArray(items)) return;
      items.forEach(parseTT);
    } catch (err) {
      console.error('[content_tt][ingest] parse error:', err);
    }
  }

  function parseTT(item) {
    const id = item?.id || item?.aweme_id;
    if (!id || !dedup(id)) return;
    const s = item.stats || item.statistics || {};
    const likes    = s.diggCount    ?? s.digg_count    ?? 0;
    const comments = s.commentCount ?? s.comment_count ?? 0;
    const shares   = s.shareCount   ?? s.share_count   ?? 0;
    const views    = s.playCount    ?? s.play_count    ?? 0;
    const saves    = s.collectCount ?? s.collect_count ?? 0;

    const cover = item.video?.cover || item.video?.dynamicCover || item.video?.originCover || null;
    const videoUrl = item.video?.downloadAddr || item.video?.playAddr || null;
    const code = item.shareInfo?.shareUrl?.match(/video\/(\d+)/)?.[1] || id;

    window.__vs_tt.push({
      id,
      type: 'video',
      likes, comments, shares, views, saves,
      thumbnail: cover,
      imageUrl: cover,
      videoUrl,
      url: `https://www.tiktok.com/@${item.author?.uniqueId || 'user'}/video/${code}`,
      handle: item.author?.uniqueId || null,
      timestamp: item.createTime || 0,
      caption: item.desc || ''
    });
  }

  // ── Scroll helper ────────────────────────────────────────────
  window.__vs_tt_scroll = async function (target) {
    const max = 80, delay = 1200;
    let attempts = 0, stuck = 0, last = 0;
    while (window.__vs_tt.length < target && attempts < max) {
      attempts++;
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, delay));
      window.postMessage({ type: 'VS_TT_PROGRESS', count: window.__vs_tt.length }, '*');
      if (window.__vs_tt.length === last) { if (++stuck >= 4) break; }
      else stuck = 0;
      last = window.__vs_tt.length;
    }
    return window.__vs_tt.slice(0, target);
  };

  // ── DOM fallback ─────────────────────────────────────────────
  window.__vs_tt_dom = function () {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/video/"]').forEach(a => {
      const m = a.href.match(/\/video\/(\d+)/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const img = a.querySelector('img');
      const handle = a.href.match(/@([^/]+)/)?.[1] || null;
      results.push({
        id: m[1], type: 'video',
        likes: 0, comments: 0, shares: 0, views: 0, saves: 0,
        thumbnail: img?.src || null, imageUrl: img?.src || null, videoUrl: null,
        url: `https://www.tiktok.com${a.getAttribute('href')}`,
        handle, timestamp: 0, caption: img?.alt || ''
      });
    });
    return results;
  };

  // ── Grid sort — uses CSS order, not DOM mutation ──────────────
  // Mirrors the IG approach to avoid triggering React re-renders.
  window.__vs_tt_sortGrid = function (ids) {
    const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    if (!anchors.length) return false;

    function getCell(anchor) {
      let node = anchor;
      for (let i = 0; i < 10; i++) {
        const p = node.parentElement;
        if (!p) return node;
        const kids = Array.from(p.children);
        if (kids.length >= 3 && kids.every(k => k.tagName === kids[0].tagName)) return node;
        node = p;
      }
      return node;
    }

    const map = {};
    const cells = [];
    anchors.forEach(a => {
      const m = a.href.match(/\/video\/(\d+)/);
      if (!m) return;
      const cell = getCell(a);
      map[m[1]] = cell;
      if (!cells.includes(cell)) cells.push(cell);
    });

    if (!cells.length) return false;

    // Make the container a flex grid so CSS order works
    const container = cells[0].parentElement;
    if (!container) return false;

    const cs = getComputedStyle(container);
    if (!['flex', 'grid'].includes(cs.display)) {
      container.style.display = 'flex';
      container.style.flexWrap = 'wrap';
      container.style.alignItems = 'flex-start';
    }

    cells.forEach(c => {
      if (c.parentElement && c.parentElement !== container)
        c.parentElement.style.display = 'contents';
      c.style.flex = '0 0 calc(33.333% - 3px)';
      c.style.maxWidth = 'calc(33.333% - 3px)';
      c.style.boxSizing = 'border-box';
      c.style.margin = '1px';
    });

    // Apply order to ranked cells
    ids.forEach((id, rank) => {
      if (map[id]) map[id].style.order = String(rank + 1);
    });

    // Push anything not in our ranked list to the end
    Object.keys(map).forEach(id => {
      if (!ids.includes(id)) map[id].style.order = '9999';
    });

    return true;
  };

  // ── postMessage bridge ───────────────────────────────────────
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;

    if (e.data?.type === 'VS_TT_READ') {
      const dom = window.__vs_tt_dom();
      const all = [...window.__vs_tt];
      dom.forEach(d => { if (!all.find(p => p.id === d.id)) all.push(d); });
      window.postMessage({ type: 'VS_TT_READ_RESULT', posts: all }, '*');
    }

    if (e.data?.type === 'VS_TT_SCAN') {
      window.__vs_tt = [];
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 600));
      await window.__vs_tt_scroll(e.data.count);
      const dom = window.__vs_tt_dom();
      const all = [...window.__vs_tt];
      dom.forEach(d => { if (!all.find(p => p.id === d.id)) all.push(d); });
      window.postMessage({ type: 'VS_TT_RESULT', posts: all.slice(0, e.data.count) }, '*');
    }

    if (e.data?.type === 'VS_TT_SORT_GRID') {
      const ok = window.__vs_tt_sortGrid(e.data.ids);
      window.postMessage({ type: 'VS_TT_SORT_DONE', ok: !!ok }, '*');
    }
  });
})();
