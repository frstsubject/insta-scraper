// content_ig.js — MAIN world, document_start
(function () {
  if (window.__vs_ig_init) return;
  window.__vs_ig_init = true;
  window.__vs_ig = [];

  const _fetch = window.fetch;
  window.fetch = async function (...a) {
    const res = await _fetch.apply(this, a);
    try {
      const url = typeof a[0] === 'string' ? a[0] : (a[0]?.url || '');
      if (isIG(url)) {
        res.clone().json()
          .then(ingest)
          .catch((err) => {
            console.error('[content_ig][fetch] clone/json extraction failed:', err);
          });
      }
    } catch (err) {
      console.error('[content_ig][fetch] intercept failed:', err);
    }
    return res;
  };
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this._vu = u; return _open.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () {
      try {
        if (isIG(this._vu)) ingest(JSON.parse(this.responseText));
      } catch (err) {
        console.error('[content_ig][xhr] parse failed:', err);
      }
    });
    return _send.apply(this, a);
  };

  function isIG(u) {
    return u && (
      u.includes('/api/v1/feed/user/') ||
      u.includes('/api/v1/clips/user/') ||
      u.includes('/api/v1/media/') ||
      u.includes('/graphql/query') ||
      u.includes('edge_owner_to_timeline_media') ||
      u.includes('edge_felix_video_timeline') ||
      u.includes('xdt_api__v1__feed__user_timeline') ||
      u.includes('xdt_api__v1__clips')
    );
  }

  function dedup(id) { return !window.__vs_ig.find(p => p.id === id); }

  // Read the handle from the current profile URL
  function getHandle() {
    const m = location.pathname.match(/^\/([^/?#]+)/);
    const skip = ['explore','reel','p','stories','direct','accounts','reels'];
    if (m && !skip.includes(m[1])) return m[1];
    return null;
  }

  function ingest(data) {
    try {
      const raw = data?.items || data?.data?.items || [];
      if (Array.isArray(raw) && raw.length) {
        raw.forEach(item => parseV1(item?.media || item));
      }
      const edges1 =
        data?.data?.user?.edge_owner_to_timeline_media?.edges ||
        data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges ||
        data?.graphql?.user?.edge_owner_to_timeline_media?.edges || [];
      edges1.forEach(e => parseGQL(e.node));

      const edges2 =
        data?.data?.user?.edge_felix_video_timeline?.edges ||
        data?.data?.xdt_api__v1__clips__user__connection_v2?.edges ||
        data?.graphql?.user?.edge_felix_video_timeline?.edges || [];
      edges2.forEach(e => parseGQL(e.node?.media || e.node));
    } catch (err) {
      console.error('[content_ig][ingest] parsing error:', err);
    }
  }

  function parseGQL(n) {
    if (!n?.id || !dedup(n.id)) return;
    const isV = n.__typename === 'GraphVideo' || n.is_video;
    const isC = n.__typename === 'GraphSidecar';
    const res  = [...(n.thumbnail_resources || n.display_resources || [])].sort((a,b) => (b.config_width || 0) - (a.config_width || 0));
    const thumb = res[res.length - 1]?.src || n.thumbnail_src || n.display_url;
    const imgUrl = res[0]?.src || n.display_url;

    // Carousel slides from sidecar
    let carouselImages = null;
    if (isC && n.edge_sidecar_to_children?.edges) {
      carouselImages = n.edge_sidecar_to_children.edges.map((e, i) => {
        const cn = e.node;
        const cnRes = [...(cn.display_resources || [])].sort((a,b) => (b.config_width || 0) - (a.config_width || 0));
        return {
          index: i + 1,
          imageUrl: cnRes[0]?.src || cn.display_url,
          videoUrl: cn.is_video ? cn.video_url || null : null,
          type: cn.is_video ? 'video' : 'image'
        };
      });
    }

    window.__vs_ig.push({
      id: n.id, shortcode: n.shortcode || null,
      handle: getHandle(),
      type: isV ? 'video' : isC ? 'carousel' : 'image',
      likes:    n.edge_media_preview_like?.count ?? n.like_count ?? -1,
      comments: n.edge_media_to_comment?.count ?? n.comments_count ?? 0,
      views:    n.video_view_count ?? 0,
      saves: 0, shares: 0,
      thumbnail: thumb, imageUrl: imgUrl,
      videoUrl: isV ? (n.video_url || null) : null,
      carouselImages,
      url: n.shortcode ? `https://www.instagram.com/p/${n.shortcode}/` : null,
      timestamp: n.taken_at_timestamp || n.taken_at || 0,
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text || ''
    });
  }

  function parseV1(item) {
    if (!item?.id || !dedup(item.id)) return;
    const isV = item.media_type === 2 || item.product_type === 'clips';
    const isC = item.media_type === 8;
    const imgs = item.image_versions2?.candidates || [];
    const vids = item.video_versions || [];
    const sortedImgs = [...imgs].sort((a,b) => (b.width || 0) - (a.width || 0));
    const sortedVids = [...vids].sort((a,b) => (b.width || 0) - (a.width || 0));
    const imgUrl = sortedImgs[0]?.url || null;
    const thumb  = sortedImgs[sortedImgs.length - 1]?.url || imgUrl;
    const videoUrl = sortedVids[0]?.url || null;

    // ── Extract ALL carousel slides ──────────────────────────
    let carouselImages = null;
    if (isC && Array.isArray(item.carousel_media)) {
      carouselImages = item.carousel_media.map((m, i) => {
        const mImgs = m.image_versions2?.candidates || [];
        const mVids = m.video_versions || [];
        const sortedMImgs = [...mImgs].sort((a,b) => (b.width || 0) - (a.width || 0));
        const sortedMVids = [...mVids].sort((a,b) => (b.width || 0) - (a.width || 0));
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

  // ── Scroll ────────────────────────────────────────────────────
  window.__vs_ig_scroll = async function (target) {
    let attempts = 0, stuck = 0, last = 0;
    
    const countTotal = () => {
      // Continually capture DOM posts before they unmount
      const currentDom = window.__vs_ig_dom();
      currentDom.forEach(d => {
        if (!window.__vs_ig.find(p => p.id === d.id)) window.__vs_ig.push(d);
      });
      return window.__vs_ig.length;
    };

    window.postMessage({ type: 'VS_IG_PROGRESS', count: countTotal() }, '*');

    while (countTotal() < target && attempts < 80) {
      attempts++;
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 1100));
      const curr = countTotal();
      window.postMessage({ type: 'VS_IG_PROGRESS', count: curr }, '*');
      if (curr === last) { if (++stuck >= 5) break; } else stuck = 0;
      last = curr;
    }
  };

  // ── DOM fallback ─────────────────────────────────────────────
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

  // ── Grid Sort — uses CSS order (much more reliable than DOM move) ──
  window.__vs_ig_sortGrid = function (ids) {
    const anchors = Array.from(document.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]'));
    if (!anchors.length) return false;

    // Find the grid cell for an anchor:
    function getCell(anchor) {
      let node = anchor;
      for (let i = 0; i < 12; i++) {
        const p = node.parentElement;
        if (!p) return node;
        // If parent has siblings that also contain post links, this is likely our cell
        const hasSiblingPost = Array.from(p.children).some(
          s => s !== node && s.querySelector('a[href*="/p/"],a[href*="/reel/"]')
        );
        if (hasSiblingPost) return node;
        node = p;
      }
      return node;
    }

    const map = {};
    const cells = [];
    anchors.forEach(a => {
      const m = a.href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
      if (!m) return;
      const cell = getCell(a);
      // Key by the shortcode extracted from the URL (always alphanumeric, matches popup sort IDs)
      map[m[1]] = cell;
      if (!cells.includes(cell)) cells.push(cell);
    });

    if (!cells.length) return false;

    // Instagram often wraps grid items in rows (e.g. 3 per row).
    // CSS `order` does not work across different rows unless we flatten them.
    // By setting `display: contents` on the row wrapper, the children participate
    // directly in the parent's flex/grid container.
    const container = cells[0].parentElement?.parentElement;
    if (container) {
      cells.forEach(c => {
        if (c.parentElement && c.parentElement !== container) {
           c.parentElement.style.display = 'contents';
        }
        c.style.flex = '0 0 calc(33.333% - 3px)';
        c.style.maxWidth = 'calc(33.333% - 3px)';
        c.style.boxSizing = 'border-box';
        c.style.margin = '1px';
      });
      const cs = getComputedStyle(container);
      if (!['flex','grid'].includes(cs.display)) {
        container.style.display = 'flex';
        container.style.flexWrap = 'wrap';
        container.style.alignItems = 'flex-start';
      }
    }

    // Set CSS order on each ranked cell
    ids.forEach((id, rank) => {
      if (map[id]) map[id].style.order = String(rank + 1);
    });

    // Push anything not in our ranked list to the end
    Object.keys(map).forEach(id => {
      if (!ids.includes(id)) map[id].style.order = '9999';
    });

    return true;
  };

  // ── postMessage bridge ────────────────────────────────────────
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
