# CLAUDE.md — Viral Scraper Extension

Context file for AI-assisted development. Read this before modifying any file.

---

## Project Overview

**Viral Scraper** is a Chrome MV3 extension that scrapes Instagram, TikTok, and Threads profiles for viral-detection analytics. It intercepts GraphQL API responses in the MAIN world, collects post metrics (likes, views, comments, shares), and presents them in a sorted popup UI.

---

## File Map

```
extension/
├── manifest.json          # MV3 manifest — permissions + content_scripts
├── background.js          # Service worker — downloads, keepalive, tab navigation
├── popup.html             # Extension popup UI shell
├── popup.css              # Popup styles
├── popup.js               # Popup logic — scanning, sorting, rendering, export
├── content_ig.js          # Instagram MAIN-world intercept + scraper
├── content_tt.js          # TikTok MAIN-world intercept + scraper
├── content_th.js          # Threads MAIN-world intercept + active API scraper ← KEY FILE
├── content_bridge.js      # Isolated-world bridge — relays messages popup ↔ MAIN world
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── threads_reference/     # Reference extension — Threads Downloader (read-only, do not ship)
    ├── manifest.json
    ├── js/
    │   ├── cs.js          # Reference content script (compiled/minified)
    │   └── sw.js          # Reference service worker — confirmed API endpoints + doc_ids
    └── css/
        └── content.css
```

---

## Architecture

### Data Flow

```
Threads page loads
    │
    ├─► content_th.js (MAIN world)
    │       Intercepts fetch/XHR → captures auth headers + parses responses
    │       Exposes: window.__vs_th[], window.__vs_th_creds, window.__vs_th_active_scan()
    │
    └─► content_bridge.js (ISOLATED world)
            Listens for chrome.runtime.onMessage from popup
            Posts messages to MAIN world (VS_TH_SCAN, VS_TH_READ, VS_TH_SORT_GRID)
            Receives responses (VS_TH_RESULT, VS_TH_READ_RESULT, VS_TH_SORT_DONE)
            Forwards progress (VS_TH_PROGRESS) → background.js → popup

popup.js
    Sends: chrome.tabs.sendMessage → content_bridge
    Receives: result.posts[]  →  processRawPosts()  →  render grid
```

### Message Protocol (Threads)

| popup → bridge → MAIN       | MAIN → bridge → popup        |
|-----------------------------|------------------------------|
| `VS_TH_SCAN` + `{count}`   | `VS_TH_RESULT` + `{posts}`  |
| `VS_TH_READ`                | `VS_TH_READ_RESULT` + posts  |
| `VS_TH_SORT_GRID` + `{ids}`| `VS_TH_SORT_DONE` + `{ok}`  |
| progress listener           | `VS_TH_PROGRESS` + `{count}`|

---

## Post Data Schema

Every post object stored in `window.__vs_th[]` (and expected by popup.js):

```javascript
{
  id:             string,        // post pk/id (numeric string)
  shortcode:      string,        // post code (for URL) or falls back to id
  handle:         string,        // username without @
  type:           'image' | 'video' | 'carousel',
  likes:          number,        // like_count
  comments:       number,        // reply_count / direct_reply_count
  views:          number,        // play_count or view_count; falls back to repost_count
  saves:          number,        // always 0 (Threads doesn't expose saves)
  shares:         number,        // repost_count
  thumbnail:      string|null,   // best-resolution image URL
  imageUrl:       string|null,   // same as thumbnail
  videoUrl:       string|null,   // first video_version URL
  carouselImages: array|null,    // [{index, imageUrl, videoUrl, type}, ...]
  url:            string,        // https://www.threads.net/@{handle}/post/{code}
  timestamp:      number,        // taken_at (Unix seconds)
  caption:        string,        // caption.text or ''
}
```

---

## content_th.js Deep Dive

### Why it was broken (pre-fix)

1. **Wrong API URL filter** — only checked `threads.net/graphql` but Threads migrated to `threads.com/graphql/query` in ~2024
2. **Broken response parser** — infinite recursion in `findThreads()` caused double-counting and stack overflows on large responses
3. **No active fetching** — relied entirely on passive interception; if user hadn't scrolled, nothing was captured
4. **Missing `threads.com` host permission** in manifest.json

### How it works now

#### 1. Passive Collection (always on)
- Intercepts ALL `fetch()` and `XHR` calls
- URL filter: checks `threads.com/graphql` OR `threads.net/graphql` (both)
- Captures auth headers from request init: `x-fb-lsd`, `x-asbd-id`, `x-ig-app-id`, `x-csrftoken`
- Parses GraphQL responses using priority-ordered shape detection (see below)

#### 2. Auth Header Capture
```javascript
window.__vs_th_creds = {
  lsd:        null,  // x-fb-lsd — required for GraphQL requests
  asbdId:     null,  // x-asbd-id
  igAppId:    null,  // x-ig-app-id
  csrfToken:  null,  // from cookie csrftoken (also from x-csrftoken header)
  isLoggedIn: false, // detected from relay provider vars in responses
}
```

#### 3. GraphQL Response Shapes (priority order)
The parser tries these in order and stops at the first hit:

| Priority | Shape | Path |
|----------|-------|------|
| 1 | Profile media tab | `data.data.mediaData.edges[].node.thread_items[].post` |
| 1 alt | Profile media (xdt_api) | `data.data.xdt_api__v1__text_feed__user_id__profile__media__connection.edges[].node.thread_items[].post` |
| 2 | Single post direct | `data.data.data` (object with .pk) |
| 3 | Feed/search edges | `data.data.edges[].node.thread_items[].post` |
| 4 | Shallow fallback | Recursive scan capped at depth 10 |

#### 4. Active API Scan (`window.__vs_th_active_scan(target)`)
Called when `VS_TH_SCAN` arrives. Directly calls Threads' GraphQL API:

- **Endpoint**: `https://www.threads.com/graphql/query` (fallback: `https://www.threads.net/graphql/query`)
- **Query**: `BarcelonaProfileMediaTabDirectQuery`
- **doc_id logged-in**: `26198814349786313`
- **doc_id logged-out**: `26162887256693931`
- **User ID lookup**: `https://i.instagram.com/api/v1/users/web_profile_info/?username={handle}`
- **Pagination**: cursor-based via `after` + `pageInfo.end_cursor`
- **Page sizes**: 4 (first page), 10 (subsequent pages)
- **Polite delay**: 1–3 seconds between pages

If active scan yields nothing, falls back to scroll-based collection, then DOM parsing.

---

## Key Constants from Reference Extension

Source: `threads_reference/js/sw.js`

```javascript
// Profile media query doc_ids (BarcelonaProfileMediaTabDirectQuery)
DOC_ID_LOGGED_IN  = '26198814349786313'
DOC_ID_LOGGED_OUT = '26162887256693931'

// Single post query doc_id (BarcelonaLightboxDialogRootQuery)
DOC_ID_POST       = '25345179165155449'

// Primary GraphQL endpoint
ENDPOINT = 'https://www.threads.com/graphql/query'

// User ID lookup
USER_ID_LOOKUP = 'https://i.instagram.com/api/v1/users/web_profile_info/?username={username}'
```

---

## Permissions

### Current (manifest.json)
```json
"permissions": ["activeTab","scripting","storage","downloads","tabs","clipboardWrite"],
"host_permissions": [
  "https://www.instagram.com/*",
  "https://i.instagram.com/*",
  "https://www.tiktok.com/*",
  "https://www.threads.net/*",
  "https://www.threads.com/*"   ← ADDED in v2.1.0 (critical for API calls)
]
```

### Why `threads.com` matters
The Threads API endpoint migrated to `www.threads.com/graphql/query`. Without this host permission, fetch() calls from the content script to `threads.com` would be blocked by Chrome's extension security model.

### Reference extension permissions (threads_reference)
```json
"permissions": ["downloads","declarativeNetRequestWithHostAccess","cookies","storage","webRequest","tabs"]
```
The reference uses `webRequest` to capture headers in the background. We capture headers in the MAIN world content script instead — no extra permissions needed.

---

## How to Load the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder (the one containing `manifest.json`)
5. Open a Threads profile (e.g. `https://www.threads.net/@somehandle`)
6. Click the Viral Scraper icon in the toolbar

---

## Adding a New Platform

1. Create `content_{xx}.js` in MAIN world (copy `content_th.js` as template)
2. Add content script entry in `manifest.json` for the new domain
3. Add host permission for the new domain
4. Update `content_bridge.js` — add `isXX` flag, add `VS_XX_*` message types
5. Update `popup.js` — add platform detection, tab handler, `processRawPosts` call

---

## Common Debugging

### "No posts captured"
- Check DevTools Console on the Threads tab (not popup) for `[content_th]` errors
- Confirm you're on a profile page (`threads.net/@handle`)
- Open Network tab → filter by `graphql` → reload page → confirm requests appear
- Check `window.__vs_th_creds` in console — `lsd` should be non-null after first API call

### Active scan failing
- `window.__vs_th_creds.lsd === null` → scroll profile manually to trigger API calls first
- User not logged in → `isLoggedIn = false`, doc_id switches automatically
- Profile is private → API returns `threads_profile_cannot_see_user` error

### CORS errors
- content_th.js runs in MAIN world of `threads.net` — requests to `threads.com` are cross-origin
- The page itself makes these calls so CORS headers are already set by Threads
- If CORS fails, requests fall back to `threads.net` endpoint

---

## Do NOT

- Ship `threads_reference/` folder — it's a third-party extension for reference only
- Remove `world: "MAIN"` from content_th.js entry — it MUST run in MAIN to intercept fetch()
- Rename `window.__vs_th` or `window.__vs_th_creds` — content_bridge.js depends on them
- Add `console.log` in the fetch intercept hot path — runs on every page request

---

## Changelog

| Version | Change |
|---------|--------|
| 2.1.0 | Fixed Threads support: active GraphQL API fetching, threads.com host permission, multi-shape response parser, credential capture |
| 2.0.1 | Initial Threads support (passive intercept only — broken due to API migration) |
