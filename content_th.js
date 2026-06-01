// content_th.js — runs in ISOLATED world
// Provides DOM-based fallback parsing and grid sorting for Threads.

(function () {
  if (window.__vs_th_init) return;
  window.__vs_th_init = true;
  window.__vs_th = [];

  function getHandle() {
    const m = location.pathname.match(/^\/@([^/?#]+)/);
    return m ? m[1] : null;
  }

  // ── DOM fallback ─────────────────────────────────────────────────────────

  window.__vs_th_dom = function () {
    const results = [];
    const seen    = new Set();
    try {
      document.querySelectorAll('a[href*="/post/"]').forEach(a => {
        const m = a.href.match(/\/post\/([A-Za-z0-9_-]+)/);
        if (!m || seen.has(m[1])) return;
        seen.add(m[1]);
        const img    = a.querySelector('img');
        const handle = getHandle();
        // Guard against null handle to avoid "@null/post/…" URLs
        const profileHandle = handle || 'user';
        results.push({
          id:             m[1],
          shortcode:      m[1],
          handle,
          type:           'image',
          likes:          0, comments: 0, shares: 0, views: 0, saves: 0,
          thumbnail:      img?.src || null,
          imageUrl:       img?.src || null,
          videoUrl:       null,
          carouselImages: null,
          url:            `https://www.threads.net/@${profileHandle}/post/${m[1]}`,
          timestamp:      0,
          caption:        img?.alt || '',
        });
      });
    } catch (err) {
      console.warn('[vs_th] DOM fallback error:', err);
    }
    return results;
  };

  // ── Grid sort (CSS order, no DOM mutation) ───────────────────────────────

  /**
   * Walk up from `anchor` until we find the node whose parent also contains
   * at least one sibling with a "/post/" link — that node is the "cell".
   * Capped at MAX_DEPTH steps to avoid runaway traversal.
   */
  function getCell(anchor) {
    const MAX_DEPTH = 12;
    let node = anchor;
    for (let i = 0; i < MAX_DEPTH; i++) {
      const parent = node.parentElement;
      if (!parent) return node;
      const hasSibling = Array.from(parent.children).some(
        s => s !== node && s.querySelector('a[href*="/post/"]')
      );
      if (hasSibling) return node;
      node = parent;
    }
    return node;
  }

  window.__vs_th_sortGrid = function (ids) {
    try {
      const anchors = Array.from(document.querySelectorAll('a[href*="/post/"]'));
      if (!anchors.length) return false;

      /** Map post-id → cell element, deduplicated */
      const idToCell  = new Map();
      const cellSet   = new Set();

      anchors.forEach(a => {
        const m = a.href.match(/\/post\/([A-Za-z0-9_-]+)/);
        if (!m) return;
        const id   = m[1];
        const cell = getCell(a);
        if (!idToCell.has(id)) {
          idToCell.set(id, cell);
          cellSet.add(cell);
        }
      });

      if (!cellSet.size) return false;

      /**
       * Threads wraps grid cells in varying layers of divs.
       * Instead of assuming all cells share one parent, find the
       * deepest common ancestor of all cells.
       */
      function getAncestors(el) {
        const chain = [];
        let n = el;
        while (n) { chain.unshift(n); n = n.parentElement; }
        return chain;
      }

      const cellArray = Array.from(cellSet);
      let container   = null;

      // Find shared parent: walk up from first cell; check every candidate
      // against all other cells.
      const firstChain = getAncestors(cellArray[0]);
      for (let i = firstChain.length - 1; i >= 0; i--) {
        const candidate = firstChain[i];
        if (cellArray.every(c => candidate.contains(c))) {
          // Prefer the most-specific ancestor that is actually a flex/grid
          // container, or just take the deepest common ancestor.
          container = candidate;
          break;
        }
      }

      if (!container) return false;

      // Ensure the container is a flex/grid so CSS `order` works.
      const cs = getComputedStyle(container);
      if (!['flex', 'grid'].includes(cs.display)) {
        container.style.display    = 'flex';
        container.style.flexWrap   = 'wrap';
        container.style.alignItems = 'flex-start';
      }

      // Style each cell — reset `order` first to avoid stale values on
      // repeated calls, then apply sizing so the grid stays 3-column.
      cellArray.forEach(c => {
        c.style.order    = '9999'; // default: push unknowns to end
        c.style.flex     = '0 0 calc(33.333% - 3px)';
        c.style.maxWidth = 'calc(33.333% - 3px)';
        c.style.boxSizing = 'border-box';
        c.style.margin   = '1px';

        // Flatten intermediate wrappers between cell and container so that
        // `order` on the cell is honoured by the flex/grid container.
        let node = c.parentElement;
        while (node && node !== container) {
          node.style.display = 'contents';
          node = node.parentElement;
        }
      });

      // Apply requested sort order.
      ids.forEach((id, rank) => {
        const cell = idToCell.get(id);
        if (cell) cell.style.order = String(rank + 1);
      });

      return true;
    } catch (err) {
      console.warn('[vs_th] sortGrid error:', err);
      return false;
    }
  };

  // ── postMessage bridge ───────────────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;

    if (e.data?.type === 'VS_TH_READ') {
      try {
        const dom = window.__vs_th_dom();
        const all = [...window.__vs_th];
        dom.forEach(d => { if (!all.find(p => p.id === d.id)) all.push(d); });
        window.postMessage({ type: 'VS_TH_READ_RESULT', posts: all }, '*');
      } catch (err) {
        console.warn('[vs_th] VS_TH_READ error:', err);
        window.postMessage({ type: 'VS_TH_READ_RESULT', posts: [] }, '*');
      }
    }

    if (e.data?.type === 'VS_TH_SORT_GRID') {
      try {
        const ok = window.__vs_th_sortGrid(e.data.ids ?? []);
        window.postMessage({ type: 'VS_TH_SORT_DONE', ok: !!ok }, '*');
      } catch (err) {
        console.warn('[vs_th] VS_TH_SORT_GRID error:', err);
        window.postMessage({ type: 'VS_TH_SORT_DONE', ok: false }, '*');
      }
    }
  });

})();
