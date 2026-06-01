// background_th.js - Threads Scraper logic for the service worker

const TH_RULE_ID = 38482737;

// Setup declarativeNetRequest rules
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules) {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [TH_RULE_ID],
    addRules: [{
      id: TH_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: 'https://www.threads.com' },
          { header: 'referer', operation: 'set', value: 'https://www.threads.com' }
        ]
      },
      condition: {
        urlFilter: '|https://www.threads.com/graphql/query',
        resourceTypes: ['xmlhttprequest']
      }
    }]
  });
}

// Intercept headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    let captured = {};
    for (const h of details.requestHeaders) {
      const name = h.name.toLowerCase();
      if (['x-asbd-id', 'x-fb-lsd', 'x-ig-app-id'].includes(name)) {
        captured[name] = h.value;
      }
    }
    if (Object.keys(captured).length > 0) {
      chrome.storage.local.get(['vs_th_creds'], (res) => {
        const creds = res.vs_th_creds || {};
        let updated = false;
        if (captured['x-fb-lsd'] && creds.lsd !== captured['x-fb-lsd']) { creds.lsd = captured['x-fb-lsd']; updated = true; }
        if (captured['x-asbd-id'] && creds.asbdId !== captured['x-asbd-id']) { creds.asbdId = captured['x-asbd-id']; updated = true; }
        if (captured['x-ig-app-id'] && creds.igAppId !== captured['x-ig-app-id']) { creds.igAppId = captured['x-ig-app-id']; updated = true; }
        if (updated) chrome.storage.local.set({ vs_th_creds: creds });
      });
    }
  },
  { urls: ['https://www.threads.com/graphql/*', 'https://www.threads.net/graphql/*'] },
  ['requestHeaders', 'extraHeaders']
);

// Constants
const DOC_ID_PROFILE_LOGGED_IN  = '26198814349786313';
const DOC_ID_PROFILE_LOGGED_OUT = '26162887256693931';

const RELAY_LOGGED_IN = {
  allow_page_info_for_lox_user: false,
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
  __relay_internal__pv__BarcelonaHasGhostPostNullStateStringrelayprovider: true,
  __relay_internal__pv__BarcelonaHasProfileSelfReplyContextrelayprovider: true,
  __relay_internal__pv__BarcelonaIsReplyApprovalEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaThreadsWebCachingImprovementsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
  __relay_internal__pv__BarcelonaIsReplyApprovalsConsumptionEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaHasPodcastConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
  __relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider: true,
  __relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasMusicrelayprovider: false,
  __relay_internal__pv__BarcelonaHasSelfThreadCountrelayprovider: true,
  __relay_internal__pv__BarcelonaHasGhostPostConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider: false,
  __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider: false,
  __relay_internal__pv__BarcelonaQuotedPostUFIEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaHasTopicTagsrelayprovider: true,
  __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDisplayNamesrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false,
  __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
  __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: true,
  __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
};

const RELAY_LOGGED_OUT = {
  allow_page_info_for_lox_user: false,
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
  __relay_internal__pv__BarcelonaHasGhostPostNullStateStringrelayprovider: true,
  __relay_internal__pv__BarcelonaHasProfileSelfReplyContextrelayprovider: false,
  __relay_internal__pv__BarcelonaIsReplyApprovalEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaThreadsWebCachingImprovementsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
  __relay_internal__pv__BarcelonaIsReplyApprovalsConsumptionEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaHasPodcastConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
  __relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider: true,
  __relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasMusicrelayprovider: false,
  __relay_internal__pv__BarcelonaHasSelfThreadCountrelayprovider: false,
  __relay_internal__pv__BarcelonaHasGhostPostConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider: false,
  __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider: false,
  __relay_internal__pv__BarcelonaQuotedPostUFIEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaHasTopicTagsrelayprovider: true,
  __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDisplayNamesrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false,
  __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
  __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: false,
  __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
};

// State
let th_active_scans = new Map();

function getBestImageUrl(candidates) {
  if (!candidates?.length) return null;
  return candidates.reduce((best, c) => {
    if (!best) return c;
    return (c.width || 0) * (c.height || 0) > (best.width || 0) * (best.height || 0) ? c : best;
  }, null)?.url || null;
}

function getFirstVideoUrl(versions) {
  return versions?.[0]?.url || null;
}

function dedup(id, posts) {
  return !posts.find(p => p.id === id);
}

function parseTH(threadItem, posts, targetUsername) {
  try {
    const post = threadItem?.post || threadItem;
    if (!post) return;
    const rawId = post.pk || post.id;
    if (!rawId) return;
    const id = String(rawId);
    if (!dedup(id, posts)) return;

    const user    = post.user || {};
    const likes   = Number(post.like_count)  || 0;
    const replies = Number(post.reply_count || post.text_post_app_info?.direct_reply_count) || 0;
    const reposts = Number(post.repost_count || post.text_post_app_info?.repost_count) || 0;
    const views   = Number(post.play_count || post.view_count) || reposts;

    let type        = 'image';
    let videoUrl    = getFirstVideoUrl(post.video_versions);
    let imageUrl    = getBestImageUrl(post.image_versions2?.candidates);
    if (videoUrl) type = 'video';

    let carouselImages = null;
    const carouselMedia = post.carousel_media?.length ? post.carousel_media
      : (post.text_post_app_info?.linked_inline_media?.length ? post.text_post_app_info.linked_inline_media : null);

    if (carouselMedia) {
      type = 'carousel';
      carouselImages = carouselMedia.map((m, idx) => {
        const mVid = getFirstVideoUrl(m.video_versions);
        const mImg = getBestImageUrl(m.image_versions2?.candidates);
        return { index: idx + 1, imageUrl: mImg, videoUrl: mVid, type: mVid ? 'video' : 'image' };
      });
      if (!imageUrl && carouselImages[0]?.imageUrl) imageUrl = carouselImages[0].imageUrl;
    }

    const code     = post.code || post.shortcode || null;
    const username = user.username || targetUsername || 'user';
    const postUrl  = code
      ? `https://www.threads.net/@${username}/post/${code}`
      : `https://www.threads.net/@${username}`;

    posts.push({
      id,
      shortcode:     code || id,
      handle:        username,
      type,
      likes,
      comments:      replies,
      views,
      saves:         0,
      shares:        reposts,
      thumbnail:     imageUrl,
      imageUrl,
      videoUrl,
      carouselImages,
      url:           postUrl,
      timestamp:     post.taken_at || 0,
      caption:       post.caption?.text || '',
    });
  } catch (err) {
    console.error('[background_th][parseTH] error:', err);
  }
}

async function getCookiesAndCreds() {
  const creds = await new Promise(r => chrome.storage.local.get(['vs_th_creds'], res => r(res.vs_th_creds || {})));
  let csrfToken = '';
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'threads.com' });
    const csrfCookie = cookies.find(c => c.name === 'csrftoken');
    if (csrfCookie) csrfToken = csrfCookie.value;
  } catch(e) {}
  return { creds, csrfToken };
}

async function lookupUserId(username, creds) {
  const extraHeaders = {};
  if (creds.lsd)     extraHeaders['x-fb-lsd']    = creds.lsd;
  if (creds.asbdId)  extraHeaders['x-asbd-id']   = creds.asbdId;
  if (creds.igAppId) extraHeaders['x-ig-app-id'] = creds.igAppId;

  try {
    const res = await fetch(
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(String(username || '').trim())}`,
      { method: 'GET', credentials: 'omit', headers: { accept: '*/*', ...extraHeaders } }
    );
    const data = await res.json();
    const uid = data?.data?.user?.id;
    if (uid) return String(uid);
  } catch (_) {}
  return null;
}

async function fetchProfilePage(userId, after, first, username, creds, csrfToken) {
  // Assume logged in if we have LSD. The reference extension checks for a session.
  const loggedIn  = !!creds.lsd;
  const docId     = loggedIn ? DOC_ID_PROFILE_LOGGED_IN : DOC_ID_PROFILE_LOGGED_OUT;
  const relay     = loggedIn ? RELAY_LOGGED_IN : RELAY_LOGGED_OUT;
  const pageFirst = Math.max(1, Number(first || (after ? 10 : 4)));

  const variables = { ...relay, first: pageFirst, userID: String(userId) };
  if (after) {
    variables.after = after;
    variables.before = null;
    variables.last = null;
  }

  const body = new URLSearchParams();
  body.set('fb_api_caller_class', 'RelayModern');
  body.set('fb_api_req_friendly_name', 'BarcelonaProfileMediaTabDirectQuery');
  body.set('variables', JSON.stringify(variables));
  body.set('doc_id', docId);

  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-fb-friendly-name': 'BarcelonaProfileMediaTabDirectQuery',
    'x-root-field-name': 'xdt_api__v1__text_feed__user_id__profile__media__connection',
  };
  if (creds.lsd)       headers['x-fb-lsd']    = creds.lsd;
  if (creds.asbdId)    headers['x-asbd-id']   = creds.asbdId;
  if (creds.igAppId)   headers['x-ig-app-id'] = creds.igAppId;
  headers['x-csrftoken'] = csrfToken || '';

  const res = await fetch('https://www.threads.com/graphql/query', {
    method: 'POST',
    credentials: 'omit', // Not strictly needed as DNR modifies origin, but could include if cookies are sent
    headers,
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`threads_profile_graphql_http_${res.status}`);
  const data = await res.json();
  
  if (Array.isArray(data?.errors) && data.errors.length) {
    const err = data.errors[0];
    if (err?.description === 'cannot see user' || err?.summary === 'Not Found') {
      throw new Error('threads_profile_cannot_see_user');
    }
    throw new Error(err?.description || err?.message || 'threads_profile_graphql_execution_error');
  }

  if (data?.status && data.status !== 'ok') {
    throw new Error(`threads_profile_graphql_status_${data.status}`);
  }

  const mediaData = data?.data?.mediaData;
  const edges    = mediaData?.edges || [];
  const pageInfo = mediaData?.page_info || {};
  const posts    = [];

  for (const edge of edges) {
    const items = edge?.node?.thread_items || [];
    const valid = items.filter(i => i?.post?.pk || i?.post?.id);
    valid.forEach(item => parseTH(item, posts, username));
  }

  return {
    posts,
    hasNextPage: Boolean(pageInfo.has_next_page),
    endCursor: pageInfo.end_cursor || null,
  };
}

function convertPostToPlanItem(post) {
  let items = [];
  if (post.carouselImages) {
    post.carouselImages.forEach((m, idx) => {
      items.push({ kind: m.type, url: m.type === 'video' ? m.videoUrl : m.imageUrl, downloadIndex: idx });
    });
  } else {
    items.push({ kind: post.type, url: post.type === 'video' ? post.videoUrl : post.imageUrl, downloadIndex: 0 });
  }

  return {
    postedAt: post.timestamp * 1000,
    postId: post.shortcode || post.id,
    username: post.handle,
    items: items
  };
}

async function handleBulkDownloadProfileMedia(msg, tabId, sendResponse) {
  const { sessionId, username } = msg;
  const { creds, csrfToken } = await getCookiesAndCreds();
  const userId = msg.userId || await lookupUserId(username, creds);
  
  if (!userId) {
    sendResponse({ ok: false, err: "user_not_found" });
    return;
  }

  th_active_scans.set(sessionId, 'running');

  const allPosts = [];
  let after = null;
  let pageNum = 0;
  let stopped = false;

  for (;;) {
    if (th_active_scans.get(sessionId) === 'stopped') {
      stopped = true;
      break;
    }

    pageNum++;
    try {
      const first = after ? 10 : 4;
      const page = await fetchProfilePage(userId, after, first, username, creds, csrfToken);

      allPosts.push(...page.posts);

      let mediaCount = 0;
      allPosts.forEach(p => {
        mediaCount += (p.carouselImages ? p.carouselImages.length : 1);
      });

      chrome.tabs.sendMessage(tabId, {
        action: "bulkCollectUpdate",
        sessionId: sessionId,
        stage: "progress",
        totalPostCount: allPosts.length,
        summary: { postCount: allPosts.length, mediaCount: mediaCount }
      });

      if (!page.hasNextPage || !page.endCursor) break;

      after = page.endCursor;
      await new Promise(r => setTimeout(r, 1000 + Math.floor(2001 * Math.random())));
    } catch (err) {
      console.error('[background_th][handleBulkDownloadProfileMedia] error:', err);
      break;
    }
  }

  th_active_scans.delete(sessionId);

  let mediaCount = 0;
  const plan = allPosts.map(p => {
    const item = convertPostToPlanItem(p);
    mediaCount += item.items.length;
    return item;
  });

  // 1. Respond to cs.js so it can start ZIP download UI
  sendResponse({
    ok: true,
    plan: plan,
    summary: { postCount: allPosts.length, mediaCount: mediaCount },
    stopped: stopped
  });

  // 2. Broadcast to content_bridge.js so Viral Scraper UI gets populated
  chrome.tabs.sendMessage(tabId, { type: 'VS_TH_RESULT', posts: allPosts });
}


