/**
 * Back4App REST API client for Manifest.
 * Uses fetch (browser or Node 18+).
 * In browser on localhost we use a proxy path to avoid CORS (Back4App allows claude.ai, not localhost).
 */

import { addLocationFromMember } from './codec.js';

const BASE = 'https://parseapi.back4app.com';

/** Parse class for user accounts (members). Standard is _User. */
export const PARSE_CLASS_USER = '_User';

/**
 * Query a Parse/Back4App class. Uses /classes/<className> for all classes (including _User).
 * @param {string} appId - X-Parse-Application-Id
 * @param {string} restKey - X-Parse-REST-API-Key
 * @param {string} className - Parse class (e.g. '_User', 'post', 'comment')
 * @param {Record<string, unknown>} params - Query params (keys, limit, skip, order, where, etc.)
 * @param {{ javascriptKey?: string }} [opts] - In browser, set javascriptKey if you get 403 with restKey
 * @returns {Promise<unknown[]>} - d.results or []
 */
export async function b4a(appId, restKey, className, params = {}, opts = {}) {
  const qs = [];
  for (const k of Object.keys(params)) {
    if (params[k] == null) continue;
    const v = params[k];
    qs.push(k + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v)));
  }
  const url = BASE + '/classes/' + className + (qs.length ? '?' + qs.join('&') : '');
  const isBrowser = typeof window !== 'undefined';
  const useJsKey = isBrowser && typeof (opts.javascriptKey || DEFAULT_CONFIG.javascriptKey) === 'string';
  const authKey = useJsKey ? 'X-Parse-Javascript-Key' : 'X-Parse-REST-API-Key';
  const authVal = useJsKey ? (opts.javascriptKey || DEFAULT_CONFIG.javascriptKey) : restKey;
  const res = await fetch(url, {
    headers: {
      'X-Parse-Application-Id': appId,
      [authKey]: authVal,
      'Content-Type': 'application/json',
    },
  });
  const d = await res.json();
  if (!res.ok) {
    const msg = d?.error || res.statusText || res.status;
    throw new Error('Back4App ' + res.status + ': ' + msg);
  }
  if (d && typeof d.error === 'string') {
    throw new Error('Back4App: ' + d.error);
  }
  const results = d.results || [];
  if (typeof window !== 'undefined' && className === PARSE_CLASS_USER && results.length === 0) {
    console.warn('[Manifest] _User query returned 0 rows. URL:', url, 'Response:', d);
  }
  return results;
}

/**
 * Default config (same as v6-live). Override with env or explicit config.
 * For browser requests, Back4App may require javascriptKey instead of restKey (CLP).
 * Set config.javascriptKey from Dashboard > Server Settings > Core Settings if you get 403.
 */
export const DEFAULT_CONFIG = {
  appId: 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
  restKey: 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq',
  /** Optional: use in browser if restKey returns 403 (Class Level Permissions) */
  javascriptKey: undefined,
};

/**
 * Fetch one batch of users, posts, comments and merge into state + skip counters.
 * @param {typeof DEFAULT_CONFIG} config
 * @param {{ members: Map, posts: Map, comments: Map }} state - mutable
 * @param {{ userSkip: number, postSkip: number, commentSkip: number }} skips - mutable
 * @param {{ userLimit?: number, postLimit?: number, commentLimit?: number }} batch
 * @returns {Promise<{ added: number, epochDate: Date | null }>}
 */
export async function feedFromBack4App(config, state, skips, batch = {}) {
  // Larger defaults = fewer API round-trips for universe loading (Parse allows up to 1000/request)
  const userLimit = batch.userLimit ?? 1000;
  const postLimit = batch.postLimit ?? 200;
  const commentLimit = batch.commentLimit ?? 300;
  const sdcLimit = batch.soberDateChangeLimit ?? 0; // 0 = don't load SoberDateChange
  // Support reverse-chronological loading via batch.order (default: 'createdAt')
  const sortOrder = batch.order || 'createdAt';
  const opts = { javascriptKey: config.javascriptKey };
  const fetches = [
    b4a(config.appId, config.restKey, PARSE_CLASS_USER, {
      keys: 'objectId,username,sobrietyDate,createdAt,proPic,profilePicture,updatedAt,TotalComments,region,state,city,country',
      limit: userLimit,
      skip: skips.userSkip,
      order: '-updatedAt', // Load by most recently updated to get mix of active/inactive
    }, opts),
    b4a(config.appId, config.restKey, 'post', {
      keys: 'objectId,creator,username,content,commentCount,createdAt,image',
      limit: postLimit,
      skip: skips.postSkip,
      order: sortOrder,
    }, opts),
    b4a(config.appId, config.restKey, 'comment', {
      keys: 'objectId,creator,post,content,createdAt',
      limit: commentLimit,
      skip: skips.commentSkip,
      order: sortOrder,
    }, opts),
  ];
  // Optionally load SoberDateChange records (ground truth relapses)
  if (sdcLimit > 0) {
    fetches.push(
      b4a(config.appId, config.restKey, 'SoberDateChange', {
        keys: 'objectId,user,date,lastSoberDate,setOnDayOne,daysSince,TotalComments,commentsSince,createdAt',
        limit: sdcLimit,
        skip: skips.sdcSkip || 0,
        order: sortOrder,
      }, opts)
    );
  }
  const [nU, nP, nC, nSDC] = await Promise.all(fetches);

  const parsefilesBase = `https://parsefiles.back4app.com/${config.appId}/`;
  function proPicUrlFrom(fileObj) {
    if (!fileObj) return null;
    if (typeof fileObj === 'string' && fileObj) return fileObj;
    if (fileObj.url) return fileObj.url;
    if (fileObj.name) return parsefilesBase + encodeURIComponent(fileObj.name);
    return null;
  }

  let added = 0;
  for (const u of nU) {
    const proPicUrl = proPicUrlFrom(u.proPic || u.profilePicture);

    const totalComments = u.TotalComments != null ? Number(u.TotalComments) : null;
    if (!state.members.has(u.objectId)) {
      state.members.set(u.objectId, {
        username: u.username || 'anon',
        sobriety: u.sobrietyDate?.iso ?? null,
        created: u.createdAt,
        proPic: proPicUrl,
        totalComments, // Server-side comment count — top commenters go toward center
        region: u.region ?? null,
        state: u.state ?? null,
        city: u.city ?? null,
        country: u.country ?? null,
        mass: 1,
        position: null,
        opacity: 0,
        scale: 0,
      });
      added++;
    } else {
      // Member was added as a stub (from post/comment records) — fill in proPic and real username
      const existing = state.members.get(u.objectId);
      if (!existing.proPic && proPicUrl) existing.proPic = proPicUrl;
      if (!existing.username || existing.username.startsWith('user_')) {
        existing.username = u.username || existing.username;
      }
      if (!existing.sobriety && u.sobrietyDate?.iso) existing.sobriety = u.sobrietyDate.iso;
      if (totalComments != null) existing.totalComments = totalComments;
      if (u.region != null) existing.region = u.region;
      if (u.state != null) existing.state = u.state;
      if (u.city != null) existing.city = u.city;
      if (u.country != null) existing.country = u.country;
    }
    addLocationFromMember(u);
  }
  skips.userSkip += nU.length;

  for (const p of nP) {
    if (!state.posts.has(p.objectId)) {
      if (p.creator && !state.members.has(p.creator)) {
        state.members.set(p.creator, {
          username: p.username || 'user_' + String(p.creator).slice(0, 5),
          sobriety: null,
          created: p.createdAt,
          mass: 1,
          position: null,
          opacity: 0,
          scale: 0,
        });
      }
      state.posts.set(p.objectId, {
        creator: p.creator || 'unknown',
        content: p.content || '',
        commentCount: p.commentCount || 0,
        created: p.createdAt,
        image: typeof p.image === 'string' ? p.image : p.image?.url ?? null,
      });
      added++;
    }
  }
  skips.postSkip += nP.length;

  for (const c of nC) {
    if (!state.comments.has(c.objectId) && c.creator && c.post) {
      const postObj = state.posts.get(c.post);
      const toM = postObj ? postObj.creator : null;
      if (!toM) continue;
      if (!state.members.has(c.creator)) {
        state.members.set(c.creator, {
          username: 'user_' + String(c.creator).slice(0, 5),
          sobriety: null,
          created: c.createdAt,
          mass: 1,
          position: null,
          opacity: 0,
          scale: 0,
        });
      }
      state.comments.set(c.objectId, {
        fromMember: c.creator,
        toMember: toM,
        postId: c.post,
        content: c.content || '',
        created: c.createdAt,
      });
      added++;
    }
  }
  skips.commentSkip += nC.length;

  // Merge SoberDateChange records (ground truth relapse data)
  if (nSDC && nSDC.length > 0) {
    if (!state.soberDateChanges) state.soberDateChanges = new Map();
    for (const sdc of nSDC) {
      if (!state.soberDateChanges.has(sdc.objectId)) {
        const userId = sdc.user?.objectId || null;
        state.soberDateChanges.set(sdc.objectId, {
          userId,
          newDate: sdc.date?.iso ?? null,
          lastSoberDate: sdc.lastSoberDate?.iso ?? null,
          setOnDayOne: sdc.setOnDayOne ?? true,
          daysSince: sdc.daysSince ?? null,
          totalComments: sdc.TotalComments ?? 0,
          commentsSince: sdc.commentsSince ?? 0,
          created: sdc.createdAt,
        });
        added++;
      }
    }
    skips.sdcSkip = (skips.sdcSkip || 0) + nSDC.length;
  }

  let epochDate = null;
  const arrays = [nU, nP, nC];
  if (nSDC) arrays.push(nSDC);
  for (const arr of arrays) {
    for (const item of arr) {
      const d = new Date(item.createdAt);
      if (!epochDate || d > epochDate) epochDate = d;
    }
  }

  return { added, epochDate, memberCount: state.members.size };
}
