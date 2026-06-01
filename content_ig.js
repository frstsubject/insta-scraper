// content_ig.js — MAIN world, document_start
(function () {
  if (window.__vs_ig_init) return;
  window.__vs_ig_init = true;
  window.__vs_ig = [];

  // ── Fetch interception ────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...a) {
    const res = await _fetch.apply(this, a);
    try {
      const url = typeof a[0] === 'string' ? a[0] : (a[0]?.url || '');
      if (isIG(url)) {
        res.clone().json()
          .then(ingest)
          .catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  // ── XHR interception ─────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this._vu = u; return _open.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () {
      try {
        if (isIG(this._vu)) ingest(JSON.parse(this.responseText));
      } catch (_) {}
    });
    return _send.apply(this, a);
  };

  // ── URL filter — covers all tabs (posts, reels, tagged) ─────────────────
  function isIG(u) {
    if (!u) return false;
    return (
      u.includes('/api/v1/feed/user/')           ||
      u.includes('/api/v1/clips/user/')           ||
      u.includes('/api/v1/media/')                ||
      u.includes('/graphql/query')                ||
      u.includes('edge_owner_to_timeline_media')  ||
      u.includes('edge_felix_video_timeline')     ||
      u.includes('xdt_api__v1__feed__user_timeline') ||
      u.includes('xdt_api__v1__clips')            ||
      u.includes('xdt_api__v1__reels')            ||
      u.includes('xdt_api__v1__tagged_user')      ||
      u.includes('reels_media')                   ||
      u.includes('clips_media')                   ||
      u.includes('compat_api_reels_media')        ||
      u.includes('clips_metadata')                ||
      u.includes('PolarisProfileReels')           ||
      u.includes('PolarisProfilePostsTabQuery')   ||
      u.includes('PolarisTaggedMediaQuery')       ||
      u.includes('PolarisProfileReelsTray')
    );
  }

  // ── Handle extraction ─────────────────────────────────────────────────────
  // Works on /<handle>/, /<handle>/reels/, /<handle>/tagged/, etc.
  function getHandle() {
    const segs = location.pathname.split('/').filter(Boolean);
    const handle = segs[0];
    // segs[0] is the user handle — skip only if it's a known non-user segment
    const nonUser = ['explore', 'reel', 'p', 'stories', 'direct', 'accounts', 'tv', 'ar', 'reels'];
    if (!handle || nonUser.includes(handle)) return null;
    return handle;
  }

  // ── Current sub-tab ───────────────────────────────────────────────────────
  function getSubTab() {
    const segs = location.pathname.split('/').filter(Boolean);
    return segs[1] || 'posts'; // 'reels', 'tagged', 'posts', etc.
  }

  // ── Dedup ─────────────────────────────────────────────────────────────────
  function dedup(id) { return !window.__vs_ig.find(p => p.id === id); }

  // ── Ingest any IG API response ────────────────────────────────────────────
  function ingest(data) {
    try {
      // ── V1 items array (feed/user, clips/user, media/info) ────────────────
      const raw = data?.items || data?.data?.items || [];
      if (Array.isArray(raw) && raw.length) {
        raw.forEach(item => parseV1(item?.media || item));
      }

      // ── V1 clips_users endpoint — items nested in clips array ─────────────
      const clipItems = data?.clips || [];
      if (Array.isArray(clipItems) && clipItems.length) {
        clipItems.forEach(c => parseV1(c?.media || c));
      }

      // ── GQL user timeline ─────────────────────────────────────────────────
      const edges1 =
        data?.data?.user?.edge_owner_to_timeline_media?.edges ||
        data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges ||
        data?.graphql?.user?.edge_owner_to_timeline_media?.edges || [];
      edges1.forEach(e => parseGQL(e.node));

      // ── GQL reels/clips — all known path variants ─────────────────────────
      const edges2 =
        data?.data?.user?.edge_felix_video_timeline?.edges ||
        data?.data?.xdt_api__v1__clips__user__connection_v2?.edges ||
        data?.data?.xdt_api__v1__clips__user__connection?.edges ||
        data?.graphql?.user?.edge_felix_video_timeline?.edges || [];
      edges2.forEach(e => parseGQL(e.node?.media || e.node));

      // ── Direct top-level clips/reels connection ───────────────────────────
      const directConn =
        data?.data?.xdt_api__v1__clips__user__connection_v2 ||
        data?.data?.xdt_api__v1__clips__user__connection;
      if (directConn?.edges?.length) {
        directConn.edges.forEach(e => parseGQL(e.node?.media || e.node));
      }

      // ── Tagged posts ──────────────────────────────────────────────────────
      const taggedEdges =
        data?.data?.user?.edge_user_to_photos_of_you?.edges ||
        data?.data?.xdt_api__v1__tagged_user_graphql_connection?.edges || [];
      taggedEdges.forEach(e => parseGQL(e.node));

      // ── Reels tray / stories_media items ──────────────────────────────────
      if (Array.isArray(data?.reels_media)) {
        data.reels_media.forEach(r => {
          (r.items || []).forEach(item => parseV1(item));
        });
      }

      // ── Polaris / newer GQL wrapper shapes ────────────────────────────────
      // PolarisProfileReelsTabContentQuery returns:
      //   data.data.xdt_api__v1__clips__user__connection_v2 (already handled above)
      //   OR data.data.xdt_api__v1__clips__user__connection
      // But also sometimes wraps under user directly:
      const polarisUser = data?.data?.xdt_api__v1__user || data?.data?.user;
      if (polarisUser) {
        const pe1 = polarisUser?.edge_felix_video_timeline?.edges || [];
        pe1.forEach(e => parseGQL(e.node?.media || e.node));
        const pe2 = polarisUser?.edge_owner_to_timeline_media?.edges || [];
        pe2.forEach(e => parseGQL(e.node));
        const pe3 = polarisUser?.edge_user_to_photos_of_you?.edges || [];
        pe3.forEach(e => parseGQL(e.node));
      }

    } catch (err) {
      console.error('[content_ig][ingest] parsing error:', err);
    }
  }

  // ── Parse GraphQL node ─────────────────────────────────────────────────────
  function parseGQL(n) {
    if (!n?.id || !dedup(n.id)) return;
    const isV = n.__typename === 'GraphVideo' || n.is_video === true || n.media_type === 2 || n.product_type === 'clips';
    const isC = n.__typename === 'GraphSidecar' || n.media_type === 8;

    const res   = [...(n.thumbnail_resources || n.display_resources || [])].sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
    const thumb  = res[res.length - 1]?.src || n.thumbnail_src || n.display_url;
    const imgUrl = res[0]?.src || n.display_url;

    let carouselImages = null;
    if (isC && n.edge_sidecar_to_children?.edges) {
      carouselImages = n.edge_sidecar_to_children.edges.map((e, i) => {
        const cn = e.node;
        const cnRes = [...(cn.display_resources || [])].sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
        return {
          index: i + 1,
          imageUrl: cnRes[0]?.src || cn.display_url,
          videoUrl: cn.is_video ? (cn.video_url || null) : null,
          type: cn.is_video ? 'video' : 'image'
        };
      });
    }

    window.__vs_ig.push({
      id: n.id, shortcode: n.shortcode || n.code || null,
      handle: getHandle(),
      type: isV ? 'video' : isC ? 'carousel' : 'image',
      likes:    n.edge_media_preview_like?.count ?? n.like_count ?? -1,
      comments: n.edge_media_to_comment?.count ?? n.comments_count ?? 0,
      views:    n.video_view_count ?? n.view_count ?? n.play_count ?? 0,
      saves: 0, shares: 0,
      thumbnail: thumb, imageUrl: imgUrl,
      videoUrl: isV ? (n.video_url || null) : null,
      carouselImages,
      url: (n.shortcode || n.code) ? `https://www.instagram.com/p/${n.shortcode || n.code}/` : null,
      timestamp: n.taken_at_timestamp || n.taken_at || 0,
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text || n.caption?.text || ''
    });
  }

  // ── Parse V1 API item ─────────────────────────────────────────────────────
  function parseV1(item) {
    if (!item?.id || !dedup(item.id)) return;
    const isV = item.media_type === 2 || item.product_type === 'clips';
    const isC = item.media_type === 8;
    const imgs = item.image_versions2?.candidates || [];
    const vids = item.video_versions || [];
    const sortedImgs = [...imgs].sort((a, b) => (b.width || 0) - (a.width || 0));
    const sortedVids = [...vids].sort((a, b) => (b.width || 0) - (a.width || 0));
    const imgUrl   = sortedImgs[0]?.url || null;
    const thumb    = sortedImgs[sortedImgs.length - 1]?.url || imgUrl;
    const videoUrl = sortedVids[0]?.url || null;

    let carouselImages = null;
    if (isC && Array.isArray(item.carousel_media)) {
      carouselImages = item.carousel_media.map((m, i) => {
        const mImgs = m.image_versions2?.candidates || [];
        const mVids = m.video_versions || [];
        const sortedMImgs = [...mImgs].sort((a, b) => (b.width || 0) - (a.width || 0));
        const sortedMVids = [...mVids].sort((a, b) => (b.width || 0) - (a.width || 0));
        return {
          index: i + 1,
          imageUrl: sortedMImgs[0]?.url || null,
          videoUrl: sortedMVids[0]?.url || null,
          type: m.media_type === 2 ? 'video' : 'image'
        };
      });
    }

    window.__vs_ig.push({
      id: item.id, shortcode: item.code || null,
      handle: getHandle(),
      type: isV ? 'video' : isC ? 'carousel' : 'image',
      likes:    item.like_count ?? -1,
      comments: item.comment_count ?? 0,
      views:    item.view_count ?? item.play_count ?? 0,
      saves:    item.saved_count ?? 0, shares: 0,
      thumbnail: thumb, imageUrl: imgUrl, videoUrl,
      carouselImages,
      url: item.code ? `https://www.instagram.com/p/${item.code}/` : null,
      timestamp: item.taken_at || 0,
      caption: item.caption?.text || ''
    });
  }

  // ── Find the real scroll container ────────────────────────────────────────
  // On the reels tab, Instagram uses a virtualized container (not document.body).
  // We walk up from a known media element to find the scrolling ancestor.
  function getScrollTarget() {
    // Try a reel/post anchor to find the virtualised container
    const anchor = document.querySelector('a[href*="/reel/"],a[href*="/p/"]');
    if (anchor) {
      let node = anchor.parentElement;
      for (let i = 0; i < 20 && node && node !== document.body; i++) {
        const cs = getComputedStyle(node);
        if ((cs.overflow === 'auto' || cs.overflow === 'scroll' ||
             cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight + 50) {
          return node;
        }
        node = node.parentElement;
      }
    }
    // Fallback: look for any tall scrollable div
    const candidates = Array.from(document.querySelectorAll('div')).filter(el => {
      if (el === document.body || el === document.documentElement) return false;
      const cs = getComputedStyle(el);
      return (cs.overflow === 'auto' || cs.overflow === 'scroll' ||
              cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
              el.scrollHeight > el.clientHeight + 100 &&
              el.clientHeight > 200;
    });
    // Prefer the element with most scrollable area
    if (candidates.length) {
      candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
      return candidates[0];
    }
    return window; // last resort
  }

  // ── Scroll ────────────────────────────────────────────────────────────────
  window.__vs_ig_scroll = async function (target) {
    let attempts = 0, stuck = 0, last = 0;

    const countTotal = () => {
      const currentDom = window.__vs_ig_dom();
      currentDom.forEach(d => {
        if (!window.__vs_ig.find(p => p.id === d.id)) window.__vs_ig.push(d);
      });
      return window.__vs_ig.length;
    };

    window.postMessage({ type: 'VS_IG_PROGRESS', count: countTotal() }, '*');

    // Scroll back to top first (use both body and window)
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      document.documentElement.scrollTop = 0;
    } catch (_) {}

    await new Promise(r => setTimeout(r, 500));

    while (countTotal() < target && attempts < 80) {
      attempts++;

      // Re-detect scroll target each iteration (DOM may have changed)
      const scrollEl = getScrollTarget();

      if (scrollEl === window) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      } else {
        scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
        // Also scroll window for Instagram's hybrid layout
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }

      await new Promise(r => setTimeout(r, 1200));
      const curr = countTotal();
      window.postMessage({ type: 'VS_IG_PROGRESS', count: curr }, '*');
      if (curr === last) { if (++stuck >= 5) break; } else stuck = 0;
      last = curr;
    }
  };

  // ── DOM fallback — works on /p/, /reel/, and reels tab ───────────────────
  window.__vs_ig_dom = function () {
    const seen = new Set(), out = [];
    document.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]').forEach(a => {
      const m = a.href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const img = a.querySelector('img');
      out.push({
        id: m[1], shortcode: m[1],
        handle: getHandle(),
        type: a.href.includes('/reel/') ? 'video' : 'image',
        likes: -1, comments: 0, views: 0, saves: 0, shares: 0,
        thumbnail: img?.src || null, imageUrl: img?.src || null,
        videoUrl: null, carouselImages: null,
        url: `https://www.instagram.com${a.getAttribute('href').split('?')[0]}`,
        timestamp: 0, caption: img?.alt || ''
      });
    });
    return out;
  };

  // ── Grid Sort ─────────────────────────────────────────────────────────────
  window.__vs_ig_sortGrid = function (ids) {
    const anchors = Array.from(document.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]'));
    if (!anchors.length) return false;

    function getCell(anchor) {
      let node = anchor;
      for (let i = 0; i < 12; i++) {
        const p = node.parentElement;
        if (!p) return node;
        const hasSiblingPost = Array.from(p.children).some(
          s => s !== node && s.querySelector('a[href*="/p/"],a[href*="/reel/"]')
        );
        if (hasSiblingPost) return node;
        node = p;
      }
      return node;
    }

    const map = {}, cells = [];
    anchors.forEach(a => {
      const m = a.href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
      if (!m) return;
      const cell = getCell(a);
      map[m[1]] = cell;
      if (!cells.includes(cell)) cells.push(cell);
    });

    if (!cells.length) return false;

    // Find deepest common ancestor — more robust than assuming 2 levels up
    function getAncestors(el) {
      const chain = [];
      let n = el;
      while (n) { chain.unshift(n); n = n.parentElement; }
      return chain;
    }

    let container = null;
    const firstChain = getAncestors(cells[0]);
    for (let i = firstChain.length - 1; i >= 0; i--) {
      const cand = firstChain[i];
      if (cells.every(c => cand.contains(c))) {
        container = cand;
        break;
      }
    }

    if (!container) return false;

    cells.forEach(c => {
      let node = c.parentElement;
      while (node && node !== container) {
        node.style.display = 'contents';
        node = node.parentElement;
      }
      c.style.flex = '0 0 calc(33.333% - 3px)';
      c.style.maxWidth = 'calc(33.333% - 3px)';
      c.style.boxSizing = 'border-box';
      c.style.margin = '1px';
      c.style.order = '9999';
    });

    const cs = getComputedStyle(container);
    if (!['flex', 'grid'].includes(cs.display)) {
      container.style.display = 'flex';
      container.style.flexWrap = 'wrap';
      container.style.alignItems = 'flex-start';
    }

    ids.forEach((id, rank) => { if (map[id]) map[id].style.order = String(rank + 1); });
    return true;
  };

  // ── postMessage bridge ────────────────────────────────────────────────────
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;

    if (e.data?.type === 'VS_IG_READ') {
      const dom = window.__vs_ig_dom();
      const all = [...window.__vs_ig];
      dom.forEach(d => { if (!all.find(p => p.id === d.id)) all.push(d); });
      const currentHandle = getHandle();
      const filtered = all.filter(p => !currentHandle || !p.handle || p.handle === currentHandle);
      window.postMessage({ type: 'VS_IG_READ_RESULT', posts: filtered }, '*');
    }

    if (e.data?.type === 'VS_IG_SCAN') {
      window.__vs_ig = [];
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        document.documentElement.scrollTop = 0;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 700));
      await window.__vs_ig_scroll(e.data.count);
      const dom = window.__vs_ig_dom();
      const all = [...window.__vs_ig];
      dom.forEach(d => { if (!all.find(p => p.id === d.id)) all.push(d); });
      const currentHandle = getHandle();
      const filtered = all.filter(p => !currentHandle || !p.handle || p.handle === currentHandle);
      window.postMessage({ type: 'VS_IG_RESULT', posts: filtered.slice(0, e.data.count) }, '*');
    }

    if (e.data?.type === 'VS_IG_SORT_GRID') {
      const ok = window.__vs_ig_sortGrid(e.data.ids);
      window.postMessage({ type: 'VS_IG_SORT_DONE', ok }, '*');
    }
  });
})();
