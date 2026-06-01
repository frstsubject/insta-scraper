// content_bridge.js — isolated world
(function () {
  if (window.__vs_bridge_init) return;
  window.__vs_bridge_init = true;
  const isIG = location.hostname.includes('instagram.com');
  const isTT = location.hostname.includes('tiktok.com');
  const isTH = location.hostname.includes('threads.net') || location.hostname.includes('threads.com');

  // ── Filename helpers ─────────────────────────────────────────
  function fmt(n) {
    if (!n || n < 0) return '0';
    if (n >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';
    if (n >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
    return String(n);
  }
  function buildBase(p) {
    const r = String(p.rank||0).padStart(3,'0');
    const v = p.isViral ? '_VIRAL' : '';
    const s = p.viralScore ? `_${p.viralScore}pct` : '';
    const m = p.likes > 0 ? `_${fmt(p.likes)}lk` : p.views > 0 ? `_${fmt(p.views)}vw` : '';
    const h = p.handle ? `_@${(p.handle||'').replace(/[^a-z0-9_]/gi,'').slice(0,16)}` : '';
    return `Post_${r}${v}${s}${m}${h}`;
  }

  // ── Pass URL directly to background.js for download (no content-script fetch) ──
  // Fetching cdninstagram.com / fbcdn.net from a content script with
  // credentials:'include' is blocked by CORS — the CDN never sets
  // Access-Control-Allow-Credentials:true even though it returns 200.
  // Fix: send the raw URL straight to background.js which calls
  // chrome.downloads.download(). Service workers are not subject to CORS.
  async function blobDl(rawUrl, filename) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'DOWNLOAD_FILE', url: rawUrl, filename }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error('[content_bridge][blobDl] sendMessage error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else if (resp && !resp.ok) {
          console.error('[content_bridge][blobDl] download error:', resp.error);
          reject(new Error(resp.error));
        } else {
          resolve();
        }
      });
    });
  }

  // ── Story & Highlight Downloading ─────────────────────────────
  async function dlStoryAPI(urlPath, prefixName, handle) {
    try {
      const res = await fetch(`https://www.instagram.com/api/v1/feed/${urlPath}`, {
        credentials: 'include', headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (!res.ok) return false;
      const data = await res.json();
      const reelKeys = Object.keys(data.reels || {});
      if (!reelKeys.length) return false;
      
      let count = 0;
      for (const rk of reelKeys) {
        const reel = data.reels[rk];
        if (!reel.items) continue;
        for (let i = 0; i < reel.items.length; i++) {
          const item = reel.items[i];
          const vids = item.video_versions || [];
          const imgs = item.image_versions2?.candidates || [];
          vids.sort((a, b) => (b.width || 0) - (a.width || 0));
          imgs.sort((a, b) => (b.width || 0) - (a.width || 0));
          const url = vids[0]?.url || imgs[0]?.url;
          if (!url) continue;
          const ext = item.media_type === 2 ? 'mp4' : 'jpg';
          const hName = handle || 'UnknownUser';
          const name = `${hName}/stories_highlights/${prefixName}_${i+1}.${ext}`;
          await blobDl(url, name);
          count++;
          await new Promise(r => setTimeout(r, 250));
        }
      }
      return count > 0;
    } catch (err) {
      console.error('[content_bridge][dlStoryAPI] error:', err);
      return false;
    }
  }

  async function dlHighlight(hlId, title, handle) {
    const cleanTitle = (title||'').replace(/[^a-z0-9]/gi, '_');
    return dlStoryAPI(`reels_media/?reel_ids=highlight%3A${hlId}`, `Highlight_${cleanTitle}`, handle);
  }

  async function dlUserStories() {
    const username = location.pathname.split('/')[1];
    if (!username) return false;
    try {
      const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
        headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' }
      });
      const data = await res.json();
      const userId = data.data?.user?.id;
      if (!userId) return false;
      return dlStoryAPI(`reels_media/?reel_ids=${userId}`, `Story_${username}`, username);
    } catch (err) {
      console.error('[content_bridge][dlUserStories] error:', err);
      return false;
    }
  }

  // ── Fetch FULL post data from Instagram API ───────────────────
  async function fetchPostData(post) {
    const h = {
      'X-IG-App-ID': '936619743392459',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json'
    };

    // A real shortcode is alphanumeric (base64url), doesn't start with a digit, no underscores.
    // Compound IDs like "3897784778401557272_70124051101" are media IDs, NOT shortcodes.
    const looksLikeShortcode = (s) => s && !/^\d/.test(s) && !s.includes('_') && /^[A-Za-z0-9-]{4,30}$/.test(s);
    const sc = looksLikeShortcode(post.shortcode) ? post.shortcode
             : looksLikeShortcode(post.id)        ? post.id
             : null;
    if (sc) {
      // 1. Robust GraphQL endpoint
      try {
        const vars = encodeURIComponent(JSON.stringify({shortcode: sc}));
        const res = await fetch(`https://www.instagram.com/graphql/query/?doc_id=10015901848480474&variables=${vars}`, { credentials: 'include', headers: h });
        if (res.ok) {
          const d = await res.json();
          if (d?.data?.xdt_shortcode_media) return { type: 'gql', item: d.data.xdt_shortcode_media };
        }
      } catch {}

      // 2. Fallback ?__a=1 endpoint
      try {
        const res = await fetch(`https://www.instagram.com/p/${sc}/?__a=1&__d=dis`, { credentials: 'include', headers: h });
        if (res.ok) {
          const d = await res.json();
          if (d?.items?.[0])               return { type: 'v1',  item: d.items[0] };
          if (d?.graphql?.shortcode_media) return { type: 'gql', item: d.graphql.shortcode_media };
        }
      } catch {}
    }

    // 3. REST v1 with numeric ID
    if (/^\d{10,}$/.test(String(post.id))) {
      try {
        const res = await fetch(`https://www.instagram.com/api/v1/media/${post.id}/info/`, { credentials: 'include', headers: h });
        if (res.ok) { const d = await res.json(); if (d?.items?.[0]) return { type: 'v1', item: d.items[0] }; }
      } catch {}
    }
    
    // 4. Ultimate Fallback: Fetch raw HTML and scrape embedded JSON / og: tags
    if (sc) {
      try {
        const res = await fetch(`https://www.instagram.com/p/${sc}/`, { credentials: 'include' });
        if (res.ok) {
          const html = await res.text();
          const jsonMatch = html.match(/<script type="application\/json" data-sjs>(.*?)<\/script>/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[1]);
            const findMedia = (obj) => {
              if (!obj || typeof obj !== 'object') return null;
              if (obj.shortcode_media) return obj.shortcode_media;
              for (const key in obj) {
                const found = findMedia(obj[key]);
                if (found) return found;
              }
              return null;
            };
            const media = findMedia(data);
            if (media) return { type: 'gql', item: media };
          }
          const vidMatch = html.match(/<meta property="og:video" content="([^"]+)"/);
          const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
          if (vidMatch || imgMatch) {
            return {
              type: 'html',
              item: {
                media_type: vidMatch ? 2 : 1,
                video_versions: vidMatch ? [{ url: vidMatch[1].replace(/&amp;/g, '&') }] : undefined,
                image_versions2: imgMatch ? { candidates: [{ url: imgMatch[1].replace(/&amp;/g, '&') }] } : undefined
              }
            };
          }
        }
      } catch {}
    }
    
    return null;
  }

  // ── Extract ALL slide URLs from fetched data ──────────────────
  function extractSlides(fetched) {
    if (!fetched) return [];
    const { type, item } = fetched;

    function getBest(m) {
      const vids = m.video_versions || [];
      const imgs = m.image_versions2?.candidates || [];
      vids.sort((a, b) => (b.width || 0) - (a.width || 0));
      imgs.sort((a, b) => (b.width || 0) - (a.width || 0));
      return vids[0]?.url || imgs[0]?.url;
    }

    if (type === 'v1' || type === 'html') {
      if (item.carousel_media?.length) {
        return item.carousel_media.map((m, i) => ({
          index: i + 1, url: getBest(m), ext: m.media_type === 2 ? 'mp4' : 'jpg'
        })).filter(s => s.url);
      }
      return [{ index: 1, url: getBest(item), ext: item.media_type === 2 || item.video_versions?.length ? 'mp4' : 'jpg' }].filter(s => s.url);
    }

    if (type === 'gql') {
      if (item.carousel_media?.length) {
        return item.carousel_media.map((m, i) => ({
          index: i + 1, url: getBest(m), ext: m.media_type === 2 ? 'mp4' : 'jpg'
        })).filter(s => s.url);
      }
      const edges = item.edge_sidecar_to_children?.edges || [];
      if (edges.length) {
        return edges.map((e, i) => {
          const n = e.node;
          const res = n.display_resources || [];
          res.sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
          return { index: i + 1, url: n.is_video ? n.video_url : (res[0]?.src || n.display_url), ext: n.is_video ? 'mp4' : 'jpg' };
        }).filter(s => s.url);
      }
      if (item.is_video && item.video_url) return [{ index: 1, url: item.video_url, ext: 'mp4' }];
      if (item.display_url) return [{ index: 1, url: item.display_url, ext: 'jpg' }];
    }
    return [];
  }

  // ── Master download function ──────────────────────────────────
  async function dlPost(post) {
    if (!post) return false;
    try {
      let folderType = post.type === 'video' ? 'reels' : 'posts';
      let handle = post.handle || 'UnknownUser';
      let baseId = post.shortcode || post.id || 'UnknownID';

      const hasCarouselData = post.type === 'carousel' && post.carouselImages?.length > 1;
      const hasVideoUrl     = post.type === 'video' && !!post.videoUrl;
      const hasImageUrl     = post.type === 'image' && !!(post.imageUrl || post.thumbnail);

      let slides = [];

      if (!hasVideoUrl || post.type === 'carousel') {
        const fetched = await fetchPostData(post);
        slides = extractSlides(fetched);
      }

      if (!slides.length) {
        if (hasCarouselData) {
          slides = post.carouselImages.map((s, i) => ({
            index: i + 1, url: s.videoUrl || s.imageUrl, ext: s.type === 'video' ? 'mp4' : 'jpg'
          }));
        } else if (hasVideoUrl) {
          slides = [{ index: 1, url: post.videoUrl, ext: 'mp4' }];
        } else if (hasImageUrl) {
          slides = [{ index: 1, url: post.imageUrl || post.thumbnail, ext: 'jpg' }];
        } else if (post.thumbnail) {
          slides = [{ index: 1, url: post.thumbnail, ext: 'jpg' }];
        }
      }

      if (!slides.length || slides.every(s => !s.url)) return false;

      const total = slides.filter(s => s.url).length;
      let done = 0;

      for (const slide of slides) {
        if (!slide.url) continue;
        const suffix = total > 1 ? `_${slide.index}` : '';
        const filename = `${handle}/${folderType}/${baseId}${suffix}.${slide.ext}`;
        await blobDl(slide.url, filename);
        done++;
        if (total > 1) await new Promise(r => setTimeout(r, 300));
      }

      return done > 0;
    } catch (err) {
      console.error('[content_bridge][dlPost] error:', err);
      return false;
    }
  }

  // ── Overlay styles ───────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('vs-sty')) return;
    const s = document.createElement('style');
    s.id = 'vs-sty';
    s.textContent = `
      a.vs-host { position: relative !important; display: block !important; }
      .vs-wrap { position:absolute;inset:0;z-index:9000;pointer-events:none;overflow:hidden; }

      /* VIRAL tag — hot pink, always visible */
      .vs-tag {
        position:absolute;top:6px;left:6px;
        font:900 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;
        padding:4px 8px;border-radius:5px;color:#fff;pointer-events:none;
        white-space:nowrap;letter-spacing:.02em;
        text-shadow:0 1px 2px rgba(0,0,0,.4);
        box-shadow:0 2px 8px rgba(0,0,0,.45);
      }
      .vs-tag.vir {
        background:linear-gradient(135deg,#f43f8e,#e11d48);
        border:1px solid rgba(255,255,255,.25);
      }
      .vs-tag.avg {
        background:rgba(0,0,0,.7);
        border:1px solid rgba(255,255,255,.12);
      }
      .vs-tag.hi {
        background:linear-gradient(135deg,#f59e0b,#d97706);
        border:1px solid rgba(255,255,255,.2);
      }

      /* RANK badge — bottom left */
      .vs-rank {
        position:absolute;bottom:6px;left:6px;
        font:700 11px/1 -apple-system,sans-serif;
        color:#fff;background:rgba(0,0,0,.72);
        padding:3px 7px;border-radius:4px;pointer-events:none;
        box-shadow:0 1px 5px rgba(0,0,0,.4);
      }

      /* SCORE badge — bottom right */
      .vs-score {
        position:absolute;bottom:6px;right:6px;
        font:700 10px/1 monospace;
        color:#fff;background:rgba(0,0,0,.65);
        padding:3px 5px;border-radius:4px;pointer-events:none;
      }

      /* DOWNLOAD button — top right, sophisticated glassmorphism */
      .vs-dl {
        position:absolute;top:6px;right:6px;
        width:32px;height:32px;border-radius:8px;
        background:rgba(20, 20, 20, 0.6);
        backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
        border:1px solid rgba(255,255,255,0.15);
        color:#e2e8f0;font-size:15px;cursor:pointer;pointer-events:all;
        display:flex;align-items:center;justify-content:center;
        opacity:0.85;transition:all .2s ease;
        box-shadow:0 4px 12px rgba(0,0,0,0.3);
      }
      .vs-host:hover .vs-dl { opacity:1 !important; border-color:rgba(124, 58, 237, 0.6); background:rgba(20, 20, 20, 0.8); color:#fff; }
      .vs-dl:hover { transform:translateY(-2px); box-shadow:0 6px 16px rgba(124,58,237,0.3); background:rgba(30,30,30,0.9); color:#fff; }
      .vs-dl:active { transform:translateY(0); }
      .vs-dl.busy { background:rgba(217, 119, 6, 0.8); border-color:rgba(251,191,36,0.5); cursor:wait; }
      .vs-dl.done { background:rgba(5, 150, 105, 0.8); border-color:rgba(52,211,153,0.5); }

      /* Viral posts: distinct purple/pink glow on hover */
      .vs-host.is-viral .vs-dl:hover {
        box-shadow:0 6px 16px rgba(244,63,142,0.4); border-color:rgba(244,63,142,0.6);
      }

      /* STORY & HIGHLIGHT DOWNLOAD BUTTON */
      .vs-hl-dl {
        position:absolute; bottom:0; right:0; z-index:9001;
        width:32px; height:32px; border-radius:50%;
        background:rgba(20, 20, 20, 0.6);
        backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
        border:1px solid rgba(255,255,255,0.15); color:#e2e8f0; font-size:15px;
        cursor:pointer; display:flex; align-items:center; justify-content:center;
        box-shadow:0 4px 12px rgba(0,0,0,0.3); transition:all .2s ease;
        opacity: 0.85;
      }
      .vs-hl-dl:hover { transform:translateY(-2px); border-color:rgba(124, 58, 237, 0.6); background:rgba(30, 30, 30, 0.9); box-shadow:0 6px 16px rgba(124,58,237,0.3); color:#fff; }
      .vs-hl-dl.busy { background:rgba(217, 119, 6, 0.8); border-color:rgba(251,191,36,0.5); cursor:wait; }
      .vs-hl-dl.done { background:rgba(5, 150, 105, 0.8); border-color:rgba(52,211,153,0.5); }
    `;
    document.head.appendChild(s);
  }

  // ── Inject overlays ──────────────────────────────────────────
  function injectOverlays(posts, platform) {
    injectStyles();
    document.querySelectorAll('.vs-wrap').forEach(el => el.remove());
    document.querySelectorAll('a.vs-host').forEach(el => el.classList.remove('vs-host'));

    const byKey = {};
    (posts || []).forEach(p => {
      if (!p) return;
      if (p.shortcode) byKey[p.shortcode] = p;
      if (p.id)        byKey[p.id]        = p;
    });

    const sel = platform === 'tt'
      ? 'a[href*="/video/"]'
      : (platform === 'th' ? 'a[href*="/post/"]' : 'a[href*="/p/"],a[href*="/reel/"]');

    document.querySelectorAll(sel).forEach(a => {
      const m = platform === 'tt'
        ? a.href.match(/\/video\/(\d+)/)
        : (platform === 'th' ? a.href.match(/\/post\/([A-Za-z0-9_-]+)/) : a.href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/));
      if (!m) return;
      const p = byKey[m[1]];
      if (!p) return;

      let host = a;
      host.classList.add('vs-host');
      if (p.isViral) host.classList.add('is-viral');

      let wrap = host.querySelector('.vs-wrap');
      if (wrap) {
        const existingTag = wrap.querySelector('.vs-tag');
        if (p.isViral && !existingTag) wrap.insertAdjacentHTML('afterbegin', `<div class="vs-tag vir">🔥 VIRAL</div>`);
        else if (p.isViral && existingTag) existingTag.textContent = '🔥 VIRAL';
        return;
      }

      wrap = document.createElement('div');
      wrap.className = 'vs-wrap';

      const tag = document.createElement('div');
      if (p.isViral) {
        tag.className = 'vs-tag vir';
        tag.textContent = '🔥 VIRAL';
      } else if (p.viralScore >= 80) {
        tag.className = 'vs-tag hi';
        tag.textContent = `↑ ${p.viralScore}%`;
      } else if (p.viralScore > 0) {
        tag.className = 'vs-tag avg';
        tag.textContent = `${p.viralScore}%`;
      } else {
        tag.className = 'vs-tag avg';
        const typeLabel = p.type === 'video' ? '▶ Reel' : p.type === 'carousel' ? '⊞ Album' : '🖼 Post';
        tag.textContent = typeLabel;
      }
      wrap.appendChild(tag);

      const rank = document.createElement('div');
      rank.className = 'vs-rank';
      const icon = p.type === 'video' ? '▶' : p.type === 'carousel' ? `⊞${p.carouselImages?.length > 1 ? p.carouselImages.length : ''}` : '';
      rank.textContent = `#${p.rank||'?'}${icon ? ' ' + icon : ''}`;
      wrap.appendChild(rank);

      if (p.isViral && p.viralScore > 0) {
        const sc = document.createElement('div');
        sc.className = 'vs-score';
        sc.textContent = p.viralScore + '%';
        wrap.appendChild(sc);
      }

      const btn = document.createElement('button');
      btn.className = 'vs-dl';
      btn.innerHTML = '⬇';
      const slideCount = p.carouselImages?.length;
      btn.title = `Download ${p.type === 'carousel' && slideCount ? `all ${slideCount} slides of ` : ''}#${p.rank||'?'}${p.isViral ? ' 🔥' : ''}`;

      btn.addEventListener('click', async e => {
        e.preventDefault(); e.stopPropagation();
        if (btn.classList.contains('busy')) return;
        btn.innerHTML = '⏳'; btn.classList.add('busy');
        try {
          const ok = await dlPost(p);
          btn.classList.remove('busy');
          btn.innerHTML = ok ? '✓' : '✕';
          btn.classList.toggle('done', ok);
          setTimeout(() => { btn.innerHTML = '⬇'; btn.classList.remove('done'); }, 3000);
        } catch (err) {
          console.error('[content_bridge][overlay-dl] error:', err);
          btn.classList.remove('busy');
          btn.innerHTML = '✕';
          setTimeout(() => { btn.innerHTML = '⬇'; }, 2000);
        }
      });
      wrap.appendChild(btn);
      a.appendChild(wrap);
    });

    // ── Inject Story & Highlight download buttons (Instagram Only) ──
    if (platform === 'ig') {
      document.querySelectorAll('a[href*="/stories/highlights/"]').forEach(a => {
        if (a.querySelector('.vs-hl-dl')) return;
        const m = a.href.match(/highlights\/(\d+)/);
        if (!m) return;
        a.style.position = 'relative';
        const btn = document.createElement('button');
        btn.className = 'vs-hl-dl'; btn.innerHTML = '⬇'; btn.title = 'Download Highlight';
        btn.addEventListener('click', async e => {
          e.preventDefault(); e.stopPropagation();
          if (btn.classList.contains('busy')) return;
          btn.innerHTML = '⏳'; btn.classList.add('busy');
          const ok = await dlHighlight(m[1], a.textContent?.trim() || m[1]);
          btn.classList.remove('busy');
          btn.innerHTML = ok ? '✓' : '✕';
          btn.classList.toggle('done', ok);
          setTimeout(() => { btn.innerHTML = '⬇'; btn.classList.remove('done'); }, 3000);
        });
        a.appendChild(btn);
      });

      const profilePicCanvas = document.querySelector('header canvas');
      if (profilePicCanvas) {
        const wrap = profilePicCanvas.parentElement;
        if (wrap && !wrap.querySelector('.vs-hl-dl')) {
          wrap.style.position = 'relative';
          const btn = document.createElement('button');
          btn.className = 'vs-hl-dl'; btn.innerHTML = '⬇'; btn.title = 'Download Stories';
          btn.style.bottom = '10px'; btn.style.right = '10px'; btn.style.width = '32px'; btn.style.height = '32px'; btn.style.fontSize = '15px';
          btn.addEventListener('click', async e => {
            e.preventDefault(); e.stopPropagation();
            if (btn.classList.contains('busy')) return;
            btn.innerHTML = '⏳'; btn.classList.add('busy');
            const ok = await dlUserStories();
            btn.classList.remove('busy');
            btn.innerHTML = ok ? '✓' : '✕';
            btn.classList.toggle('done', ok);
            setTimeout(() => { btn.innerHTML = '⬇'; btn.classList.remove('done'); }, 3000);
          });
          wrap.appendChild(btn);
        }
      }
    }
  }

  let _lastPosts = null, _lastPlat = null;

  async function handlePopupDownload(post) {
    return dlPost(post);
  }

  async function downloadAllStoriesAndHighlights() {
    const userMatch = window.location.pathname.match(/^\/([^\/]+)\/?$/);
    const handle = userMatch ? userMatch[1] : 'UnknownUser';
    if (userMatch && userMatch[1] !== 'explore' && userMatch[1] !== 'reels') {
      try { await dlStoryAPI(`/stories/${handle}/`, `Story_${handle}`, handle); } catch(e) {
        console.error('[content_bridge][dlAllStories] story error:', e);
      }
    }
    
    const highlights = [];
    document.querySelectorAll('ul.x1n2onr6 li a[href*="/stories/highlights/"]').forEach(a => {
       const url = new URL(a.href);
       highlights.push(url.pathname);
    });
    
    for (let path of highlights) {
       const hlId = path.match(/\d+/)?.[0] || 'Unknown';
       try { await dlStoryAPI(path, `Highlight_${hlId}`, handle); } catch(e) {
         console.error('[content_bridge][dlAllStories] highlight error:', e);
       }
    }
    return true;
  }

  // ── chrome.runtime messages ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    let responded = false;
    function safeRespond(val) {
      if (responded) return;
      responded = true;
      sendResponse(val);
    }

    if (msg.action === 'VS_PING') { safeRespond(true); return; }

    if (msg.action === 'DOWNLOAD_ALL_STORIES') {
      downloadAllStoriesAndHighlights()
        .then(ok => safeRespond({ ok }))
        .catch(err => {
          console.error('[content_bridge][DOWNLOAD_ALL_STORIES] error:', err);
          safeRespond({ ok: false });
        });
      return true;
    }

    if (msg.action === 'SCAN_PROFILE' || msg.action === 'QUICK_READ') {
      const isQ   = msg.action === 'QUICK_READ';
      let send, recv, prog;
      if (isIG) {
        send = isQ ? 'VS_IG_READ' : 'VS_IG_SCAN';
        recv = isQ ? 'VS_IG_READ_RESULT' : 'VS_IG_RESULT';
        prog = 'VS_IG_PROGRESS';
      } else if (isTT) {
        send = isQ ? 'VS_TT_READ' : 'VS_TT_SCAN';
        recv = isQ ? 'VS_TT_READ_RESULT' : 'VS_TT_RESULT';
        prog = 'VS_TT_PROGRESS';
      } else if (isTH) {
        send = isQ ? 'VS_TH_READ' : 'VS_TH_SCAN';
        recv = isQ ? 'VS_TH_READ_RESULT' : 'VS_TH_RESULT';
        prog = 'VS_TH_PROGRESS';
      }

      const onMsg = e => {
        if (e.source !== window) return;
        if (e.data?.type === recv) {
          window.removeEventListener('message', onMsg);
          safeRespond({ ok: true, posts: e.data.posts });
        }
        if (e.data?.type === prog) {
          chrome.runtime.sendMessage({ type: 'VS_PROGRESS', count: e.data.count }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type: send, count: msg.count || 25 }, '*');

      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        safeRespond({ ok: false, posts: [] });
      }, 90000);

      return true;
    }

    if (msg.action === 'SORT_GRID') {
      const sT = isIG ? 'VS_IG_SORT_GRID' : (isTT ? 'VS_TT_SORT_GRID' : 'VS_TH_SORT_GRID');
      const dT = isIG ? 'VS_IG_SORT_DONE' : (isTT ? 'VS_TT_SORT_DONE' : 'VS_TH_SORT_DONE');

      const onD = e => {
        if (e.source !== window || e.data?.type !== dT) return;
        window.removeEventListener('message', onD);
        safeRespond({ ok: e.data.ok });
      };
      window.addEventListener('message', onD);
      window.postMessage({ type: sT, ids: msg.ids }, '*');

      setTimeout(() => {
        window.removeEventListener('message', onD);
        safeRespond({ ok: false });
      }, 5000);

      return true;
    }

    if (msg.action === 'INJECT_OVERLAYS') {
      _lastPosts = msg.posts;
      _lastPlat  = isTT ? 'tt' : (isTH ? 'th' : 'ig');
      injectOverlays(msg.posts, _lastPlat);
      safeRespond({ ok: true });
    }

    if (msg.action === 'DOWNLOAD_POST') {
      handlePopupDownload(msg.post)
        .then(ok => safeRespond({ ok }))
        .catch(err => {
          console.error('[content_bridge][DOWNLOAD_POST] error:', err);
          safeRespond({ ok: false });
        });
      return true;
    }
  });

  // ── Global message listener for MAIN world ↔ Isolated world ──
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;

    // Bridge FETCH request from MAIN world to background.js
    if (e.data?.type === 'VS_TH_FETCH') {
      const { id, url, options } = e.data;
      chrome.runtime.sendMessage({
        action: 'FETCH_CROSS_ORIGIN',
        url,
        options
      }, (res) => {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: 'VS_TH_FETCH_RESULT',
            id,
            ok: false,
            error: chrome.runtime.lastError.message
          }, '*');
        } else {
          window.postMessage({
            type: 'VS_TH_FETCH_RESULT',
            id,
            ok: res.ok,
            data: res.data,
            error: res.error
          }, '*');
        }
      });
    }

    // Persist captured credentials from MAIN world to local storage
    if (e.data?.type === 'VS_TH_CREDS_UPDATE') {
      chrome.storage.local.set({ vs_th_creds: e.data.creds });
    }

    // Retrieve stored credentials from local storage for MAIN world
    if (e.data?.type === 'VS_TH_GET_CREDS') {
      chrome.storage.local.get('vs_th_creds', ({ vs_th_creds }) => {
        if (vs_th_creds) {
          window.postMessage({ type: 'VS_TH_SET_CREDS', creds: vs_th_creds }, '*');
        }
      });
    }
  }); // end global window.addEventListener

  // ── Threads Bulk Download UI Page Injection ──────────────────

  function showProgressOverlay(title, sub, pct) {
    let overlay = document.getElementById('vs-progress-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'vs-progress-overlay';
      overlay.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 320px;
        padding: 18px;
        background: rgba(20, 20, 20, 0.82);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 16px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        color: #fff;
        z-index: 2147483647;
        transition: all 0.3s ease;
      `;
      overlay.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div id="vs-overlay-title" style="font-weight:700;font-size:14px;color:#fff;">Scraping Profile...</div>
          <div id="vs-overlay-pct" style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.72);">0%</div>
        </div>
        <div style="width:100%;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;margin-bottom:8px;">
          <div id="vs-overlay-fill" style="width:0%;height:100%;background:linear-gradient(90deg, #7c3aed, #f43f8e);transition:width 0.2s ease;"></div>
        </div>
        <div id="vs-overlay-sub" style="font-size:12px;color:rgba(255,255,255,0.6);">Initial contact...</div>
      `;
      document.body.appendChild(overlay);
    } else {
      overlay.style.opacity = '1';
      overlay.style.transform = 'translateY(0)';
    }

    const titleEl = document.getElementById('vs-overlay-title');
    const subEl = document.getElementById('vs-overlay-sub');
    const pctEl = document.getElementById('vs-overlay-pct');
    const fillEl = document.getElementById('vs-overlay-fill');

    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = sub;
    if (pctEl) pctEl.textContent = pct + '%';
    if (fillEl) fillEl.style.width = pct + '%';
  }

  function hideProgressOverlay() {
    const overlay = document.getElementById('vs-progress-overlay');
    if (overlay) {
      overlay.style.opacity = '0';
      overlay.style.transform = 'translateY(10px)';
      setTimeout(() => {
        if (overlay.parentNode && overlay.style.opacity === '0') {
          overlay.remove();
        }
      }, 300);
    }
  }

  function resetBulkBtn() {
    const btn = document.getElementById('vs-th-bulk-btn');
    if (btn) {
      btn.classList.remove('busy');
      const nativeBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]'))
        .find(el => {
          const txt = el.textContent?.toLowerCase() || '';
          return (txt.includes('share') || txt.includes('mention') || txt.includes('edit profile') || txt.includes('follow')) && el.offsetWidth > 10;
        });
      btn.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: ${nativeBtn?.offsetHeight || 34}px;
        padding: 0 16px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 10px;
        background: linear-gradient(135deg, #7c3aed, #f43f8e);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(244, 63, 142, 0.35);
        transition: all 0.2s ease;
        margin-left: 8px;
        vertical-align: middle;
        z-index: 10000;
      `;
      btn.innerHTML = `<span>⬇</span> Download All`;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'VS_TH_RESULT') {
      const posts = msg.posts || [];
      if (!posts.length) return;

      // Process viral scores and inject overlays
      const metrics = posts.map(p => p.views > 0 ? p.views : Math.max(p.likes, 0)).filter(v => v > 0);
      const avg = metrics.length ? metrics.reduce((a,b)=>a+b,0) / metrics.length : 0;
      
      const enriched = posts.map(p => {
        const m = p.views > 0 ? p.views : Math.max(p.likes, 0);
        return { ...p, isViral: avg > 0 && m >= avg * 1.2, viralScore: avg > 0 ? Math.round(m/avg*100) : 0 };
      });

      injectOverlays(enriched, 'th');
    }
  });

  // ── Auto-read & Auto-inject (Background Page Loop) ──────────
  let _intervalPending = false;

  setInterval(() => {
    if (!isIG && !isTH) return;
    if (_intervalPending) return; // previous read not yet answered
    
    if (isIG) {
      const match = location.pathname.match(/^\/([^\/]+)\/?$/);
      if (!match || match[1] === 'explore' || match[1] === 'reels') return;
    } else if (isTH) {
      const match = location.pathname.match(/^\/@([^\/]+)\/?$/);
      if (!match) return;
    }

    _intervalPending = true;
    const recvType = isIG ? 'VS_IG_READ_RESULT' : 'VS_TH_READ_RESULT';
    const sendType = isIG ? 'VS_IG_READ' : 'VS_TH_READ';
    const plat = isIG ? 'ig' : 'th';

    const onMsg = e => {
      if (e.source !== window || e.data?.type !== recvType) return;
      window.removeEventListener('message', onMsg);
      _intervalPending = false;
      const posts = e.data.posts || [];
      if (!posts.length) return;

      const metrics = posts.map(p => p.views > 0 ? p.views : Math.max(p.likes, 0)).filter(v => v > 0);
      const avg = metrics.length ? metrics.reduce((a,b)=>a+b,0) / metrics.length : 0;
      
      const enriched = posts.map(p => {
        const m = p.views > 0 ? p.views : Math.max(p.likes, 0);
        return { ...p, isViral: avg > 0 && m >= avg * 1.2, viralScore: avg > 0 ? Math.round(m/avg*100) : 0 };
      });
      
      injectOverlays(enriched, plat);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ type: sendType, count: 999 }, '*');

    // Safety: clear pending flag if no response arrives within 3s
    setTimeout(() => {
      if (_intervalPending) {
        window.removeEventListener('message', onMsg);
        _intervalPending = false;
      }
    }, 3000);
  }, 2500);

})();
