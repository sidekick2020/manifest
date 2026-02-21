/**
 * Manifest spatial hash codec — deterministic layout from members/posts/comments.
 * Same data + seed → same 3D positions. Evolution optimizes cohesion + stability.
 *
 * All tunable constants are in DEFAULT_PARAMS so they can be adjusted during training.
 */

import { vec3, v3dist } from './vec3.js';

// --- Default codec hyperparameters (tunable for training) ---
export const DEFAULT_PARAMS = {
  cohesionWeight: 0.85,      // fitness = cohesion * cW + stability * sW (strong cohesion priority)
  stabilityWeight: 0.15,     // low stability weight — willing to rearrange to achieve cohesion
  nhRadiusBase: 80,           // neighborhood center sphere radius
  nhRadiusScale: 16,          // additional radius per cluster count
  localRadiusBase: 4,         // member offset radius base (small — keep cluster members tight)
  localRadiusScale: 0.05,     // log-scaled below; this is the fallback multiplier (keep tiny)
  gravityFactor: 0.8,        // mass pulls member toward NH center (strong pull)
  annealingRate: 0.72,        // temperature = rate^sessionCount
  variantCount: 5,            // candidates per evolution step (fewer = faster, 5 still gives good layout)
  massPostW: 0.5,             // mass formula weights
  massCommentTotalW: 0.2,
  massDirectCommentW: 0.3,
  massServerCommentW: 0.25,   // server TotalComments on _User — more comments = more gravity (pull toward center)
  cohesionScale: 0.5,        // 1/(1 + avgDist * scale) — sensitive to distance between connected users
  stabilityScale: 0.05,       // 1/(1 + avgDrift * scale)
  pairGravityScale: 4.0,     // more comments from A→B = stronger gravity (pull A and B closer). Weight = log(1+count)*this.
  staticStarSpacing: 17.5,    // target nearest-neighbor distance in 3D units; radius = spacing * cbrt(N)
};

/**
 * Compute the target universe radius based on member count and static star spacing.
 * Maintains a constant average nearest-neighbor distance regardless of member count.
 * Uses cube root scaling (appropriate for 3D):
 *   10 members → ~37.7,  50 → ~64.5,  200 → ~102,  500 → ~139,  2000 → ~220
 *
 * @param {number} memberCount - Number of members to position
 * @param {object} [params] - Codec params (uses staticStarSpacing)
 * @returns {number} Target radius for the universe sphere
 */
export function computeTargetRadius(memberCount, params = DEFAULT_PARAMS) {
  const spacing = params.staticStarSpacing ?? 17.5;
  return spacing * Math.cbrt(Math.max(memberCount, 1));
}

/**
 * Filter members by location criteria.
 * @param {Map} members - Full member Map
 * @param {{ country?: string, region?: string, city?: string }} filter
 * @returns {Map} Filtered member Map (same reference if no filter active)
 */
export function filterMembersByLocation(members, filter) {
  if (!filter) return members;
  const hasFilter = (filter.country && filter.country.trim()) ||
                    (filter.region && filter.region.trim()) ||
                    (filter.city && filter.city.trim());
  if (!hasFilter) return members;

  const filtered = new Map();
  members.forEach((m, id) => {
    if (memberMatchesLocationFilter(m, filter)) {
      filtered.set(id, m);
    }
  });
  return filtered;
}

/**
 * Build a self-contained state object containing only members that match the filter,
 * plus only the posts and comments that reference those members.
 * Neighborhoods, indexes, and positions are all computed from this filtered subset,
 * so the codec trains on exactly the visible universe.
 *
 * @param {object} state - Full codec state
 * @param {Map} filteredMembers - Pre-filtered member Map
 * @returns {object} A state object scoped to the filtered subset
 */
export function buildFilteredState(state, filteredMembers) {
  const posts = new Map();
  state.posts.forEach((p, id) => {
    if (filteredMembers.has(p.creator)) posts.set(id, p);
  });

  const comments = new Map();
  state.comments.forEach((c, id) => {
    if (filteredMembers.has(c.fromMember) && filteredMembers.has(c.toMember)) {
      comments.set(id, c);
    }
  });

  return {
    ...state,
    members: filteredMembers,
    posts,
    comments,
  };
}

// --- Hash primitives (FNV-1a) ---
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seedToFloat(seed) {
  return (hash32(String(seed)) & 0x7fffffff) / 0x7fffffff;
}

export function seedToPos(seed, r) {
  const s1 = seedToFloat(seed);
  const s2 = seedToFloat(seed + '_p');
  const th = s1 * Math.PI * 2;
  const ph = Math.acos(2 * s2 - 1);
  return vec3(
    r * Math.sin(ph) * Math.cos(th),
    r * Math.sin(ph) * Math.sin(th),
    r * Math.cos(ph)
  );
}

/**
 * Build precomputed indexes from state so per-member lookups are O(1) instead of O(P+C).
 * Call once per evolve() or enrichment pass; reuse for all member computations.
 */
export function buildIndexes(state) {
  const { posts, comments } = state;
  // postsByCreator: memberId → { count, totalComments }
  const postsByCreator = new Map();
  posts.forEach((p) => {
    const entry = postsByCreator.get(p.creator);
    if (entry) {
      entry.count++;
      entry.totalComments += (p.commentCount || 0);
    } else {
      postsByCreator.set(p.creator, { count: 1, totalComments: p.commentCount || 0 });
    }
  });
  // commentsByMember: memberId → { count, connected: Set<memberId> }
  const commentsByMember = new Map();
  // commentPairs: "smallerId-largerId" → count (for scoreCohesion)
  const commentPairs = {};
  comments.forEach((c) => {
    const from = c.fromMember, to = c.toMember;
    let fe = commentsByMember.get(from);
    if (!fe) { fe = { count: 0, connected: new Set() }; commentsByMember.set(from, fe); }
    fe.count++;
    fe.connected.add(to);
    let te = commentsByMember.get(to);
    if (!te) { te = { count: 0, connected: new Set() }; commentsByMember.set(to, te); }
    te.count++;
    te.connected.add(from);
    const k = from < to ? from + '-' + to : to + '-' + from;
    commentPairs[k] = (commentPairs[k] || 0) + 1;
  });
  return { postsByCreator, commentsByMember, commentPairs };
}

// --- Member seed (identity + engagement + connections); writes to state.metadataHashes ---
export function computeMemberSeed(mid, ms, state, indexes) {
  const { members, metadataHashes } = state;
  const m = members.get(mid);
  if (!m) return '0';
  let s = 'm:' + mid + ':' + m.username;
  let pc, cc, connectedKeys;
  if (indexes) {
    const pe = indexes.postsByCreator.get(mid);
    pc = pe ? pe.count : 0;
    const ce = indexes.commentsByMember.get(mid);
    cc = ce ? ce.count : 0;
    connectedKeys = ce ? [...ce.connected].filter(id => id !== mid).sort() : [];
  } else {
    // Fallback: iterate all posts/comments (slow path for backward compat)
    const { posts, comments } = state;
    pc = 0; cc = 0;
    const connected = {};
    posts.forEach((p) => { if (p.creator === mid) pc++; });
    comments.forEach((c) => {
      if (c.fromMember === mid || c.toMember === mid) {
        cc++;
        connected[c.fromMember] = 1;
        connected[c.toMember] = 1;
      }
    });
    delete connected[mid];
    connectedKeys = Object.keys(connected).sort();
  }
  // Use epochDate from state if available to avoid wall-clock non-determinism
  const refTime = state.epochDate ? new Date(state.epochDate).getTime() : Date.now();
  const sobrDays = m.sobriety
    ? Math.floor((refTime - new Date(m.sobriety).getTime()) / 86400000)
    : 0;
  s += ':p' + pc + ':c' + cc + ':sob' + sobrDays + ':n[' + connectedKeys.join(',') + ']:s' + ms;
  const encoded = { postCount: pc, commentCount: cc, connections: connectedKeys.length, sobrietyDays: sobrDays };
  metadataHashes.set(mid, { hash: hash32(s), encoded, timestamp: Date.now() });
  return s;
}

export function computeMass(mid, state, params = DEFAULT_PARAMS, indexes) {
  const { members } = state;
  let pc, tc, dc;
  if (indexes) {
    const pe = indexes.postsByCreator.get(mid);
    pc = pe ? pe.count : 0;
    tc = pe ? pe.totalComments : 0;
    const ce = indexes.commentsByMember.get(mid);
    dc = ce ? ce.count : 0;
  } else {
    // Fallback: iterate all posts/comments (slow path for backward compat)
    const { posts, comments } = state;
    pc = 0; tc = 0; dc = 0;
    posts.forEach((p) => {
      if (p.creator === mid) { pc++; tc += p.commentCount || 0; }
    });
    comments.forEach((c) => {
      if (c.fromMember === mid || c.toMember === mid) dc++;
    });
  }
  const m = members.get(mid);
  const serverTc = m && (m.totalComments != null || m.TotalComments != null)
    ? Number(m.totalComments ?? m.TotalComments) || 0
    : 0;
  const serverW = params.massServerCommentW ?? 0.25;
  return 1 + pc * params.massPostW + tc * params.massCommentTotalW + dc * params.massDirectCommentW + serverTc * serverW;
}

/** Build adjacency and connected clusters from comments (no seed). Expensive; cache result per evolve(). */
export function getClusterStructure(state) {
  const { members, comments } = state;
  const adj = {};
  members.forEach((_, id) => { adj[id] = {}; });
  comments.forEach((c) => {
    if (adj[c.fromMember] && adj[c.toMember]) {
      adj[c.fromMember][c.toMember] = 1;
      adj[c.toMember][c.fromMember] = 1;
    }
  });
  const visited = {};
  const clusters = [];
  members.forEach((_, mid) => {
    if (visited[mid]) return;
    const cluster = [];
    const q = [mid];
    while (q.length) {
      const cur = q.pop();
      if (visited[cur]) continue;
      visited[cur] = 1;
      cluster.push(cur);
      for (const nb of Object.keys(adj[cur] || {})) {
        if (!visited[nb]) q.push(nb);
      }
    }
    clusters.push(cluster);
  });
  return { clusters };
}

/** Build neighborhoods (with hashes and centers) from precomputed clusters + seed. */
export function computeNeighborhoodsFromStructure(ms, state, clusterStructure, indexes) {
  const { clusters } = clusterStructure;
  const nhs = new Map();
  for (let i = 0; i < clusters.length; i++) {
    const seeds = clusters[i].sort().map((id) => computeMemberSeed(id, ms, state, indexes));
    nhs.set('nh_' + i, {
      members: new Set(clusters[i]),
      hash: hash32(seeds.join('|')),
      center: null,
    });
  }
  const nhRadiusBase = DEFAULT_PARAMS.nhRadiusBase ?? 80;
  const nhRadiusScale = DEFAULT_PARAMS.nhRadiusScale ?? 16;
  for (let i = 0; i < clusters.length; i++) {
    const nh = nhs.get('nh_' + i);
    if (nh) {
      nh.center = seedToPos(
        'nh:nh_' + i + ':' + nh.hash + ':' + ms,
        nhRadiusBase + clusters.length * nhRadiusScale
      );
    }
  }
  return nhs;
}

export function computeNeighborhoods(ms, state) {
  const clusterStructure = getClusterStructure(state);
  return computeNeighborhoodsFromStructure(ms, state, clusterStructure);
}

export function encodeWithSeed(seed, state, params = DEFAULT_PARAMS, predictions = null, precomputedNhs = null, indexes = null) {
  const { members } = state;
  const nhs = precomputedNhs ?? computeNeighborhoods(seed, state);
  const positions = new Map();
  const arr = [];
  nhs.forEach((v, k) => arr.push([k, v]));
  if (!precomputedNhs) {
    for (let i = 0; i < arr.length; i++) {
      arr[i][1].center = seedToPos(
        'nh:' + arr[i][0] + ':' + arr[i][1].hash + ':' + seed,
        params.nhRadiusBase + arr.length * params.nhRadiusScale
      );
    }
  }

  // Derive mass and engagement once per member (used in position + time/engagement pass)
  const massByMember = new Map();
  const engagementByMember = new Map();
  let maxEngagement = 1;
  members.forEach((m, mid) => {
    const mass = computeMass(mid, state, params, indexes);
    massByMember.set(mid, mass);
    const tc = m && (m.totalComments != null || m.TotalComments != null)
      ? Number(m.totalComments ?? m.TotalComments) || 0
      : 0;
    const serverEng = 1 + Math.log(1 + tc);
    const eng = Math.max(mass, serverEng);
    engagementByMember.set(mid, eng);
    if (eng > maxEngagement) maxEngagement = eng;
  });

  members.forEach((_, mid) => {
    const s = computeMemberSeed(mid, seed, state, indexes);
    const mass = massByMember.get(mid) ?? computeMass(mid, state, params, indexes);
    let nhC = vec3(), nhS = 1;
    nhs.forEach((nh) => {
      if (nh.members.has(mid) && nh.center) {
        nhC = nh.center;
        nhS = nh.members.size;
      }
    });
    // Log-scale local spread: large clusters stay tight rather than exploding linearly.
    const localR = params.localRadiusBase + Math.log(1 + nhS) * params.localRadiusScale * 10;
    const lp = seedToPos(s, localR);

    // Risk-driven gravity: high-risk members drift toward periphery (weaker pull)
    let gravityValue = mass;
    if (predictions) {
      const pred = predictions.get(mid);
      if (pred && pred.riskLevel !== 'unknown') {
        const riskGravity = (1 - pred.risk) * 3;
        gravityValue = mass * 0.3 + riskGravity * 0.7;
      }
    }

    const gp = 1 / (1 + gravityValue * params.gravityFactor);
    positions.set(mid, vec3(nhC.x + lp.x * gp, nhC.y + lp.y * gp, nhC.z + lp.z * gp));
  });

  // --- Time axis (Y) + engagement axis (XZ radius) ---
  const refTime = state.epochDate ? new Date(state.epochDate).getTime() : Date.now();
  let minJoin = Infinity, maxJoin = -Infinity;
  members.forEach((m, mid) => {
    const jt = m.created ? new Date(m.created).getTime() : refTime;
    if (jt < minJoin) minJoin = jt;
    if (jt > maxJoin) maxJoin = jt;
  });
  const joinRange = Math.max(maxJoin - minJoin, 1);

  const TARGET_RADIUS = computeTargetRadius(members.size, params);

  let maxXZ = 0;
  positions.forEach((p) => {
    const xz = Math.sqrt(p.x * p.x + p.z * p.z);
    if (xz > maxXZ) maxXZ = xz;
  });
  if (maxXZ === 0) maxXZ = 1;

  // Apply time→Y and engagement→XZ using precomputed engagementByMember
  positions.forEach((p, mid) => {
    const m = members.get(mid);
    const jt = m && m.created ? new Date(m.created).getTime() : refTime;
    const joinT = (jt - minJoin) / joinRange;
    p.y = (joinT * 2 - 1) * TARGET_RADIUS;

    const eng = engagementByMember.get(mid) ?? 1;
    const engT = Math.log(1 + eng) / Math.log(1 + maxEngagement);
    const targetXZ = (1 - engT) * TARGET_RADIUS;

    const curXZ = Math.sqrt(p.x * p.x + p.z * p.z) || 1;
    const scale = targetXZ / curXZ;
    p.x *= scale;
    p.z *= scale;
  });

  return { positions, neighborhoods: nhs };
}

export function scoreCohesion(positions, state, params = DEFAULT_PARAMS, precomputedPairs = null) {
  const { comments } = state;
  if (comments.size === 0) return 1;
  const pairs = precomputedPairs || (() => {
    const p = {};
    comments.forEach((c) => {
      const a = c.fromMember, b = c.toMember;
      const k = a < b ? a + '-' + b : b + '-' + a;
      p[k] = (p[k] || 0) + 1;
    });
    return p;
  })();
  // Weighted mean distance: pairs with more comments get higher weight, so evolution pulls them closer.
  // Log-scale weight prevents a single high-volume pair from dominating the layout.
  let t = 0, n = 0;
  for (const k of Object.keys(pairs)) {
    const [a, b] = k.split('-');
    const pa = positions.get(a), pb = positions.get(b);
    if (pa && pb) {
      const count = pairs[k];
      const w = Math.log(1 + count) * (params.pairGravityScale ?? 1.0);
      t += v3dist(pa, pb) * w;
      n += w;
    }
  }
  return n ? 1 / (1 + (t / n) * params.cohesionScale) : 1;
}

export function scoreStability(positions, targetPos, params = DEFAULT_PARAMS) {
  if (targetPos.size === 0) return 1;
  let t = 0, n = 0;
  positions.forEach((p, id) => {
    const prev = targetPos.get(id);
    if (prev) { t += v3dist(prev, p); n++; }
  });
  return n ? 1 / (1 + (t / n) * params.stabilityScale) : 1;
}

export function getTemp(sessionCount, params = DEFAULT_PARAMS) {
  return Math.max(0.03, Math.pow(params.annealingRate, sessionCount));
}

/**
 * Run one evolution step. Mutates state (sessionCount, masterSeed, neighborhoods,
 * targetPos, fitnessHistory, member.position/mass). Returns { winner }.
 *
 * When locationFilter is provided, evolution operates only on members that match
 * the filter. Neighborhoods, cohesion, and mass are all computed from the filtered
 * subset, so the codec trains on exactly the visible universe. Members outside the
 * filter are hidden (opacity=0, scale=0) and have no target positions.
 *
 * @param {object} state - Codec state (mutated in place)
 * @param {object} [params] - Codec hyperparameters
 * @param {Map|null} [predictions] - Risk predictions (optional)
 * @param {{ country?: string, region?: string, city?: string }|null} [locationFilter] - Active location filter
 */
export function evolve(state, params = DEFAULT_PARAMS, predictions = null, locationFilter = null) {
  const { targetPos, masterSeed, fitnessHistory } = state;

  // --- Filter: build a working state scoped to the active location filter ---
  const activeMembers = filterMembersByLocation(state.members, locationFilter);
  const workingState = (activeMembers === state.members)
    ? state
    : buildFilteredState(state, activeMembers);

  const { members, posts, comments } = workingState;

  state.sessionCount++;
  const sc = state.sessionCount;
  const temp = getTemp(sc, params);
  const base = hash32('ses:' + sc + ':m' + members.size + ':p' + posts.size + ':c' + comments.size + ':prev' + masterSeed);
  // Precompute indexes once: O(P+C) instead of O(M×V×(P+C))
  const indexes = buildIndexes(workingState);
  // Compute cluster structure once per evolve (expensive BFS); reuse for all variants
  const clusterStructure = getClusterStructure(workingState);
  const variants = [];
  const vc = params.variantCount;
  for (let i = 0; i < vc; i++) {
    const ms = Math.floor(temp * (0.3 + (i === 0 ? 0 : (i / (vc - 1)) * 2.5)) * 0xffffff);
    const seed = i === 0 ? base : hash32(base + ':mut:' + i + ':ms' + ms + ':sc' + sc);
    const nhs = computeNeighborhoodsFromStructure(seed, workingState, clusterStructure, indexes);
    const r = encodeWithSeed(seed, workingState, params, predictions, nhs, indexes);
    const c = scoreCohesion(r.positions, workingState, params, indexes.commentPairs);
    const s = scoreStability(r.positions, targetPos, params);
    const f = c * params.cohesionWeight + s * params.stabilityWeight;
    variants.push({
      label: String.fromCharCode(65 + i),
      seed,
      positions: r.positions,
      neighborhoods: r.neighborhoods,
      fitness: f,
    });
  }
  variants.sort((a, b) => b.fitness - a.fitness);
  const w = variants[0];
  state.masterSeed = w.seed;
  state.neighborhoods = w.neighborhoods;
  fitnessHistory.push(w.fitness);
  if (fitnessHistory.length > 80) fitnessHistory.shift();
  state.targetPos = w.positions;

  // Update filtered members: set mass, position, and visibility
  activeMembers.forEach((m, id) => {
    m.mass = computeMass(id, workingState, params, indexes);
    const t = w.positions.get(id);
    if (t && typeof t.x === 'number' && typeof t.y === 'number' && typeof t.z === 'number') {
      m.position = vec3(t.x, t.y, t.z);
      m.opacity = m.opacity ?? 0.9;
      m.scale = m.scale ?? 1.0;
    }
  });

  // Hide members outside the filter (if filter is active)
  if (activeMembers !== state.members) {
    state.members.forEach((m, id) => {
      if (!activeMembers.has(id)) {
        m.opacity = 0;
        m.scale = 0;
      }
    });
  }

  return { winner: w };
}

/**
 * US state abbreviation ↔ full name mapping.
 * Used to normalize "AR" and "Arkansas" to the same canonical form for filtering.
 */
const US_STATE_ABBR_TO_NAME = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri',
  mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
  nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio',
  ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  dc: 'district of columbia',
};
const US_STATE_NAME_TO_ABBR = Object.fromEntries(
  Object.entries(US_STATE_ABBR_TO_NAME).map(([abbr, name]) => [name, abbr])
);

/** Normalize a location string to a canonical US state name if it matches an abbreviation or full name. */
export function normalizeRegion(s) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!v) return '';
  if (US_STATE_ABBR_TO_NAME[v]) return US_STATE_ABBR_TO_NAME[v];
  if (US_STATE_NAME_TO_ABBR[v]) return v;
  return v;
}

/** Returns true if the given string is a recognized US state name or abbreviation. */
export function isUSState(s) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return !!(US_STATE_ABBR_TO_NAME[v] || US_STATE_NAME_TO_ABBR[v]);
}

const US_COUNTRY_VARIANTS = new Set(['', 'us', 'usa', 'united states', 'united states of america']);

function normLoc(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Check if a member matches the active location filter.
 * Returns true if no filter is active or if the member matches all active filter fields.
 * @param {{ region?: string, state?: string, city?: string, country?: string }} member
 * @param {{ country?: string, region?: string, city?: string }} filter
 */
export function memberMatchesLocationFilter(member, filter) {
  if (!member) return false;
  const hasFilter = (filter.country && filter.country.trim()) ||
                    (filter.region && filter.region.trim()) ||
                    (filter.city && filter.city.trim());
  if (!hasFilter) return true;

  if (filter.country && filter.country.trim()) {
    if (normLoc(member.country) !== normLoc(filter.country)) return false;
  }
  if (filter.region && filter.region.trim()) {
    const regionVal = normalizeRegion(filter.region);
    const metaRegion = normalizeRegion(member.region);
    const metaState = normalizeRegion(member.state);
    if (metaRegion !== regionVal && metaState !== regionVal) return false;
    if (regionVal && isUSState(regionVal) && !US_COUNTRY_VARIANTS.has(normLoc(member.country))) return false;
  }
  if (filter.city && filter.city.trim()) {
    if (normLoc(member.city) !== normLoc(filter.city)) return false;
  }
  return true;
}

/**
 * Accumulated location options from all users ever loaded (not limited to current point cloud).
 * Populated by addLocationFromMember(); used by getLocationFilterOptions() for filter dropdowns.
 */
const locationOptions = {
  regions: new Set(),
  states: new Set(),
  cities: new Set(),
  countries: new Set(),
};

/**
 * Add a member's location fields to the accumulated options so filter dropdowns show all known values.
 * @param {{ region?: string | null, state?: string | null, city?: string | null, country?: string | null }} m - User/member object (from Back4App or point metadata).
 */
export function addLocationFromMember(m) {
  if (!m || typeof m !== 'object') return;
  const r = (m.region || '').trim();
  const s = (m.state || '').trim();
  const c = (m.city || '').trim();
  const co = (m.country || '').trim();
  if (r) locationOptions.regions.add(r);
  if (s) locationOptions.states.add(s);
  if (c) locationOptions.cities.add(c);
  if (co) locationOptions.countries.add(co);
}

/**
 * Return sorted arrays of all accumulated region/state/city/country values for filter dropdowns.
 * Regions list merges region + state, consolidating abbreviations (e.g. "AR" and "Arkansas" → "Arkansas").
 */
export function getLocationFilterOptions() {
  const seen = new Map(); // normalized → display name
  for (const raw of [...locationOptions.regions, ...locationOptions.states]) {
    const norm = normalizeRegion(raw);
    if (!norm) continue;
    // Prefer the full-name form for display (longer string)
    const existing = seen.get(norm);
    if (!existing || raw.length > existing.length) {
      seen.set(norm, raw);
    }
  }
  return {
    countries: [...locationOptions.countries].sort(),
    regions: [...seen.values()].sort(),
    cities: [...locationOptions.cities].sort(),
  };
}

/**
 * Create initial empty state (Maps and counters). Use before feeding data.
 */
export function createState() {
  return {
    members: new Map(),
    posts: new Map(),
    comments: new Map(),
    soberDateChanges: new Map(),
    targetPos: new Map(),
    neighborhoods: new Map(),
    metadataHashes: new Map(),
    sessionCount: 0,
    masterSeed: 0,
    fitnessHistory: [],
  };
}
