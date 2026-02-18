/**
 * Manifest prediction engine v2 — learned logistic regression for relapse risk.
 *
 * Architecture:
 *   1. Enhanced feature extraction with temporal derivatives, content signals,
 *      social graph dynamics, and cohort-relative features.
 *   2. Logistic regression with learned weights (trained via gradient descent
 *      with class balancing for rare-event prediction).
 *   3. Fallback heuristic scoring when no trained model is available.
 *
 * Pure functions, works in both Node (training) and browser.
 *
 * IMPORTANT: callers should pass opts.now = epoch timestamp from the data
 * window (not Date.now()) so predictions are relative to the data, not
 * wall-clock time.
 */

import { v3dist } from './vec3.js';

// --- Helpers ---

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

const DAY_MS = 86400000;

// --- Content signal keywords (clinical evidence) ---
const STRUGGLE_WORDS = /\b(struggling|relapse[d]?|tempt(?:ed|ation)|craving|slip(?:ped)?|drink(?:ing)?|using|gave in|fell off|reset|day (?:one|1)|start(?:ing)? over|broke|failed|weak|can'?t stop|help me)\b/i;
const POSITIVE_WORDS = /\b(grateful|blessed|proud|milestone|sober|clean|recovery|strong|better|amazing|thank|hope|miracle|celebrate|achievement|progress)\b/i;

/**
 * Count keyword matches in a text string.
 */
function countMatches(text, regex) {
  if (!text) return 0;
  const m = text.match(new RegExp(regex.source, 'gi'));
  return m ? m.length : 0;
}

// ============================================================
// FEATURE EXTRACTION (enhanced v2)
// ============================================================

/**
 * Feature names in stable order — used for model weight alignment.
 * Every feature returned by extractFeatures should be listed here.
 */
export const FEATURE_NAMES = [
  // Continuous behavioral
  'postFrequency',
  'commentFrequency',
  'postTrend',
  'commentTrend',
  'daysSinceLastPost',
  'daysSinceLastComment',
  'connectionCount',
  'reciprocityRatio',
  'sobrietyDays',
  'neighborhoodSize',
  'massRank',
  'driftMagnitude',
  'tenureDays',
  // Temporal derivatives (v2)
  'postAcceleration',
  'commentAcceleration',
  'activityVelocity7d',
  'activityVelocity30d',
  'silenceRatio',
  // Content signals (v2)
  'struggleWordCount',
  'positiveWordCount',
  'sentimentRatio',
  // Social graph dynamics (v2)
  'incomingCount',
  'outgoingCount',
  'connectionTrend',
  'supportRatio',
  // Cohort-relative (v2)
  'cohortRelativeActivity',
  'cohortRelativeConnections',
  // Interaction features
  'earlySobrietyAndSilent',
  'isolatedAndDeclining',
  'lowActivityLongTenure',
  'activeThenSilent',
  'activeThenDeepSilent',
  'communityEngaged',
  'hasPriorReset',
  'priorResetCount',
  // v3: High-precision temporal patterns
  'weekendActivityRatio',
  'lateNightActivityRatio',
  'responseLatency',
];

/**
 * Extract temporal behavioral features for a single member.
 * v2: adds temporal derivatives, content signals, social graph dynamics,
 *     and cohort-relative features.
 *
 * @param {string} mid - member ID
 * @param {{ members: Map, posts: Map, comments: Map, targetPos: Map }} state
 * @param {{ now?: number, prevPositions?: Map, cohortStats?: object }} opts
 * @returns {object} feature vector
 */
export function extractFeatures(mid, state, opts = {}) {
  const { members, posts, comments, targetPos } = state;
  const now = opts.now || Date.now();
  const m = members.get(mid);

  // Time windows (ms)
  const d7 = 7 * DAY_MS;
  const d14 = 14 * DAY_MS;
  const d21 = 21 * DAY_MS;
  const d30 = 30 * DAY_MS;

  // Collect member's posts with timestamps and content
  let postsAll = 0, postsLast14 = 0, postsLast7 = 0, postsPrev7 = 0;
  let postsLast30 = 0, postsPrev30 = 0;
  let lastPostTime = 0, firstPostTime = Infinity;
  let struggleWords = 0, positiveWords = 0;
  let weekendPosts = 0, weekdayPosts = 0, lateNightPosts = 0;
  posts.forEach((p) => {
    if (p.creator !== mid) return;
    postsAll++;
    const t = new Date(p.created).getTime();
    if (t > lastPostTime) lastPostTime = t;
    if (t < firstPostTime) firstPostTime = t;
    if (now - t <= d14) postsLast14++;
    if (now - t <= d7) postsLast7++;
    if (now - t > d7 && now - t <= d14) postsPrev7++;
    if (now - t <= d30) postsLast30++;
    if (now - t > d30 && now - t <= d30 * 2) postsPrev30++;
    // Content analysis
    struggleWords += countMatches(p.content, STRUGGLE_WORDS);
    positiveWords += countMatches(p.content, POSITIVE_WORDS);
    // v3: Temporal patterns
    const date = new Date(t);
    const dayOfWeek = date.getUTCDay(); // 0=Sunday, 6=Saturday
    const hourOfDay = date.getUTCHours(); // 0-23
    if (dayOfWeek === 0 || dayOfWeek === 6) weekendPosts++;
    else weekdayPosts++;
    if (hourOfDay >= 23 || hourOfDay <= 4) lateNightPosts++; // 11pm-4am UTC
  });
  if (firstPostTime === Infinity) firstPostTime = 0;

  // Collect member's comments with timestamps and content
  let commentsAll = 0, commentsLast14 = 0, commentsLast7 = 0, commentsPrev7 = 0;
  let commentsLast30 = 0, commentsPrev30 = 0;
  let lastCommentTime = 0, firstCommentTime = Infinity;
  const outgoing = {};   // members this member commented on
  const incoming = {};   // members who commented on this member's posts
  let outgoingLast30 = {}, outgoingPrev30 = {};
  let incomingLast30 = {}, incomingPrev30 = {};
  let weekendComments = 0, weekdayComments = 0, lateNightComments = 0;
  const incomingTimes = []; // track incoming comment times for response latency
  comments.forEach((c) => {
    if (c.fromMember === mid) {
      commentsAll++;
      const t = new Date(c.created).getTime();
      if (t > lastCommentTime) lastCommentTime = t;
      if (t < firstCommentTime) firstCommentTime = t;
      if (now - t <= d14) commentsLast14++;
      if (now - t <= d7) commentsLast7++;
      if (now - t > d7 && now - t <= d14) commentsPrev7++;
      if (now - t <= d30) { commentsLast30++; outgoingLast30[c.toMember] = 1; }
      if (now - t > d30 && now - t <= d30 * 2) { commentsPrev30++; outgoingPrev30[c.toMember] = 1; }
      outgoing[c.toMember] = 1;
      // Content analysis for comments
      struggleWords += countMatches(c.content, STRUGGLE_WORDS);
      positiveWords += countMatches(c.content, POSITIVE_WORDS);
      // v3: Temporal patterns
      const date = new Date(t);
      const dayOfWeek = date.getUTCDay();
      const hourOfDay = date.getUTCHours();
      if (dayOfWeek === 0 || dayOfWeek === 6) weekendComments++;
      else weekdayComments++;
      if (hourOfDay >= 23 || hourOfDay <= 4) lateNightComments++;
    }
    if (c.toMember === mid) {
      incoming[c.fromMember] = 1;
      const t = new Date(c.created).getTime();
      if (now - t <= d30) incomingLast30[c.fromMember] = 1;
      if (now - t > d30 && now - t <= d30 * 2) incomingPrev30[c.fromMember] = 1;
      incomingTimes.push({ postId: c.postId, time: t, from: c.fromMember });
    }
  });
  if (firstCommentTime === Infinity) firstCommentTime = 0;

  // Connection metrics
  const allConnected = { ...outgoing };
  for (const k of Object.keys(incoming)) allConnected[k] = 1;
  delete allConnected[mid];
  const connectionCount = Object.keys(allConnected).length;
  const incomingCount = Object.keys(incoming).length;
  const outgoingCount = Object.keys(outgoing).length;

  // Reciprocity: members where BOTH directions exist
  let reciprocal = 0;
  for (const k of Object.keys(outgoing)) {
    if (incoming[k]) reciprocal++;
  }
  const reciprocityRatio = connectionCount > 0 ? reciprocal / connectionCount : 0;

  // Support ratio: incoming / outgoing (>1 = receiving more support than giving)
  const supportRatio = outgoingCount > 0 ? incomingCount / outgoingCount : 0;

  // Connection trend: change in unique connections over time
  const connectionsLast30 = Object.keys({ ...outgoingLast30, ...incomingLast30 }).length;
  const connectionsPrev30 = Object.keys({ ...outgoingPrev30, ...incomingPrev30 }).length;
  const connectionTrend = connectionsPrev30 > 0 ? connectionsLast30 / connectionsPrev30 : (connectionsLast30 > 0 ? 2 : 0);

  // Sobriety
  const sobrietyDays = m && m.sobriety
    ? Math.max(0, Math.floor((now - new Date(m.sobriety).getTime()) / DAY_MS))
    : 0;

  // Tenure
  const firstActivity = Math.min(
    firstPostTime || Infinity,
    firstCommentTime || Infinity,
    m && m.created ? new Date(m.created).getTime() : Infinity
  );
  const tenureDays = firstActivity < Infinity ? Math.max(1, (now - firstActivity) / DAY_MS) : 0;

  // Neighborhood size
  let neighborhoodSize = 1;
  if (state.neighborhoods) {
    state.neighborhoods.forEach((nh) => {
      if (nh.members && nh.members.has(mid)) {
        neighborhoodSize = nh.members.size;
      }
    });
  }

  // Mass rank (percentile)
  const masses = [];
  members.forEach((mm) => masses.push(mm.mass || 1));
  masses.sort((a, b) => a - b);
  const myMass = m ? (m.mass || 1) : 1;
  const massIdx = masses.findIndex((v) => v >= myMass);
  const massRank = masses.length > 1 ? massIdx / (masses.length - 1) : 0.5;

  // Drift magnitude (spatial movement)
  let driftMagnitude = 0;
  const curPos = targetPos ? targetPos.get(mid) : null;
  const prevPos = opts.prevPositions ? opts.prevPositions.get(mid) : null;
  if (curPos && prevPos) {
    driftMagnitude = v3dist(curPos, prevPos);
  }

  // Last activity time
  const lastActivity = Math.max(lastPostTime, lastCommentTime);

  // Days since last activity
  const rawDaysSinceLastPost = lastPostTime > 0 ? (now - lastPostTime) / DAY_MS : tenureDays;
  const rawDaysSinceLastComment = lastCommentTime > 0 ? (now - lastCommentTime) / DAY_MS : tenureDays;

  // --- v2: Temporal derivatives ---

  // Post acceleration: comparing two consecutive 7-day windows (second derivative)
  // postTrend = week1/week2, postAcceleration = is the trend itself changing?
  const postsWeek3 = postsLast30 - postsLast14 - (postsPrev30 > postsLast30 ? 0 : 0); // rough
  const postAcceleration = postsPrev7 > 0
    ? (postsLast7 / Math.max(postsPrev7, 1)) - 1  // positive = accelerating
    : (postsLast7 > 0 ? 1 : 0);

  const commentAcceleration = commentsPrev7 > 0
    ? (commentsLast7 / Math.max(commentsPrev7, 1)) - 1
    : (commentsLast7 > 0 ? 1 : 0);

  // Activity velocity: rate of total activity in windows
  const totalLast7 = postsLast7 + commentsLast7;
  const totalLast30 = postsLast30 + commentsLast30;
  const activityVelocity7d = totalLast7 / 7;
  const activityVelocity30d = totalLast30 / 30;

  // Silence ratio: fraction of tenure spent silent (no activity)
  const activeDays = tenureDays > 0
    ? Math.min(tenureDays, lastActivity > 0 ? (lastActivity - firstActivity) / DAY_MS : 0)
    : 0;
  const silenceRatio = tenureDays > 7 ? 1 - (activeDays / tenureDays) : 0;

  // --- v2: Content signals ---
  const totalWords = struggleWords + positiveWords;
  const sentimentRatio = totalWords > 0 ? (positiveWords - struggleWords) / totalWords : 0;

  // --- v2: Cohort-relative features ---
  let cohortRelativeActivity = 1;
  let cohortRelativeConnections = 1;
  if (opts.cohortStats) {
    const cs = opts.cohortStats;
    if (cs.avgActivity > 0) {
      cohortRelativeActivity = (postsAll + commentsAll) / cs.avgActivity;
    }
    if (cs.avgConnections > 0) {
      cohortRelativeConnections = connectionCount / cs.avgConnections;
    }
  }

  // --- Interaction features ---
  const earlySobriety = sobrietyDays > 0 && sobrietyDays < 90;
  const silentRecently = rawDaysSinceLastPost > 14 || rawDaysSinceLastComment > 14;
  const earlySobrietyAndSilent = earlySobriety && silentRecently ? 1 : 0;

  const declining = (postsLast7 < postsPrev7) || (commentsLast7 < commentsPrev7);
  const isolated = connectionCount === 0 || reciprocityRatio < 0.1;
  const isolatedAndDeclining = isolated && declining ? 1 : 0;

  const lowActivityLongTenure = (postsAll + commentsAll <= 3 && tenureDays > 30) ? 1 : 0;

  const wasActive = postsAll + commentsAll >= 5;
  const goneQuiet = rawDaysSinceLastPost > 14 && rawDaysSinceLastComment > 14;
  const activeThenSilent = wasActive && goneQuiet ? 1 : 0;

  const deepQuiet = rawDaysSinceLastPost > 21 && rawDaysSinceLastComment > 21;
  const activeThenDeepSilent = wasActive && deepQuiet ? 1 : 0;

  const communityEngaged = reciprocityRatio >= 0.3 && connectionCount >= 2
    && (rawDaysSinceLastPost <= 7 || rawDaysSinceLastComment <= 7) ? 1 : 0;

  // Prior sobriety reset
  let priorResetCount = 0;
  if (state.soberDateChanges) {
    state.soberDateChanges.forEach((sdc) => {
      if (sdc.userId === mid && !sdc.setOnDayOne && sdc.lastSoberDate) {
        const eventDate = sdc.newDate || sdc.lastSoberDate || sdc.created;
        const eventTime = new Date(eventDate).getTime();
        if (eventTime <= now) priorResetCount++;
      }
    });
  }
  const hasPriorReset = priorResetCount > 0 ? 1 : 0;

  // v3: Calculate new temporal pattern features
  const totalWeekend = weekendPosts + weekendComments;
  const totalWeekday = weekdayPosts + weekdayComments;
  const weekendActivityRatio = totalWeekday > 0 ? totalWeekend / totalWeekday : 0;

  const totalActivity = postsAll + commentsAll;
  const totalLateNight = lateNightPosts + lateNightComments;
  const lateNightActivityRatio = totalActivity > 0 ? totalLateNight / totalActivity : 0;

  // Response latency: avg time between receiving comment and responding
  // Find posts by this member, then find incoming comments, then find member's reply
  let responseLatencies = [];
  posts.forEach((p) => {
    if (p.creator !== mid) return;
    const postTime = new Date(p.created).getTime();
    const postId = p.id;
    // Find incoming comments on this post
    const postIncoming = incomingTimes.filter(ic => ic.postId === postId);
    postIncoming.forEach((ic) => {
      // Find member's next comment after this incoming comment
      comments.forEach((c) => {
        if (c.fromMember === mid && c.postId === postId) {
          const responseTime = new Date(c.created).getTime();
          if (responseTime > ic.time) {
            const latency = (responseTime - ic.time) / (60 * 1000); // minutes
            if (latency < 7 * 24 * 60) { // ignore >1 week gaps
              responseLatencies.push(latency);
            }
          }
        }
      });
    });
  });
  const responseLatency = responseLatencies.length > 0
    ? responseLatencies.reduce((a, b) => a + b, 0) / responseLatencies.length / 60 // convert to hours
    : 0;

  return {
    // Continuous behavioral
    postFrequency: postsLast14 / 14,
    commentFrequency: commentsLast14 / 14,
    postTrend: postsLast7 / Math.max(postsPrev7, 1),
    commentTrend: commentsLast7 / Math.max(commentsPrev7, 1),
    daysSinceLastPost: rawDaysSinceLastPost,
    daysSinceLastComment: rawDaysSinceLastComment,
    connectionCount,
    reciprocityRatio,
    sobrietyDays,
    neighborhoodSize,
    massRank,
    driftMagnitude,
    tenureDays,
    // Temporal derivatives (v2)
    postAcceleration,
    commentAcceleration,
    activityVelocity7d,
    activityVelocity30d,
    silenceRatio,
    // Content signals (v2)
    struggleWordCount: struggleWords,
    positiveWordCount: positiveWords,
    sentimentRatio,
    // Social graph dynamics (v2)
    incomingCount,
    outgoingCount,
    connectionTrend,
    supportRatio,
    // Cohort-relative (v2)
    cohortRelativeActivity,
    cohortRelativeConnections,
    // Interaction features
    earlySobrietyAndSilent,
    isolatedAndDeclining,
    lowActivityLongTenure,
    activeThenSilent,
    activeThenDeepSilent,
    communityEngaged,
    hasPriorReset,
    priorResetCount,
    // v3: High-precision temporal patterns
    weekendActivityRatio,
    lateNightActivityRatio,
    responseLatency,
    // Raw counts (for labeling & thresholds, not model features)
    _totalPosts: postsAll,
    _totalComments: commentsAll,
    _totalActivity: postsAll + commentsAll,
    _lastActivityTime: lastActivity,
  };
}

/**
 * Compute cohort statistics for cohort-relative features.
 * Groups members by join quarter, computes avg activity & connections for each.
 */
export function computeCohortStats(state, opts = {}) {
  const now = opts.now || Date.now();
  const { members, posts, comments } = state;
  const QUARTER_MS = 91 * DAY_MS;

  // Count per-member activity
  const memberActivity = new Map();
  const memberConnections = new Map();
  members.forEach((_, mid) => {
    memberActivity.set(mid, 0);
    memberConnections.set(mid, new Set());
  });

  posts.forEach((p) => {
    if (memberActivity.has(p.creator)) {
      memberActivity.set(p.creator, memberActivity.get(p.creator) + 1);
    }
  });
  comments.forEach((c) => {
    if (memberActivity.has(c.fromMember)) {
      memberActivity.set(c.fromMember, memberActivity.get(c.fromMember) + 1);
    }
    if (memberConnections.has(c.fromMember)) memberConnections.get(c.fromMember).add(c.toMember);
    if (memberConnections.has(c.toMember)) memberConnections.get(c.toMember).add(c.fromMember);
  });

  // Group by join quarter
  const cohorts = {};
  members.forEach((m, mid) => {
    const joinTime = m.created ? new Date(m.created).getTime() : now;
    const quarterIdx = Math.floor((now - joinTime) / QUARTER_MS);
    if (!cohorts[quarterIdx]) cohorts[quarterIdx] = { totalActivity: 0, totalConnections: 0, count: 0 };
    cohorts[quarterIdx].totalActivity += memberActivity.get(mid) || 0;
    cohorts[quarterIdx].totalConnections += (memberConnections.get(mid) || new Set()).size;
    cohorts[quarterIdx].count++;
  });

  // Compute averages per cohort
  const cohortAvgs = {};
  for (const [q, c] of Object.entries(cohorts)) {
    cohortAvgs[q] = {
      avgActivity: c.count > 0 ? c.totalActivity / c.count : 1,
      avgConnections: c.count > 0 ? c.totalConnections / c.count : 1,
    };
  }

  return { cohorts: cohortAvgs, QUARTER_MS };
}

/**
 * Get cohort stats for a specific member.
 */
export function getCohortStatsForMember(mid, state, cohortData, opts = {}) {
  const now = opts.now || Date.now();
  const m = state.members.get(mid);
  if (!m || !cohortData) return { avgActivity: 1, avgConnections: 1 };
  const joinTime = m.created ? new Date(m.created).getTime() : now;
  const quarterIdx = Math.floor((now - joinTime) / cohortData.QUARTER_MS);
  return cohortData.cohorts[quarterIdx] || { avgActivity: 1, avgConnections: 1 };
}


// ============================================================
// LOGISTIC REGRESSION MODEL
// ============================================================

/**
 * Sigmoid function.
 */
function sigmoid(z) {
  if (z > 500) return 1;
  if (z < -500) return 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Predict probability using learned weights.
 * @param {object} features - feature object from extractFeatures
 * @param {object} model - { weights: { [featureName]: number }, bias: number, featureStats: { [name]: { mean, std } } }
 * @returns {number} probability 0-1
 */
export function predictWithModel(features, model) {
  if (!model || !model.weights) return null;

  let z = model.bias || 0;
  const stats = model.featureStats || {};

  for (const name of FEATURE_NAMES) {
    const w = model.weights[name];
    if (w === undefined || w === 0) continue;
    let val = features[name] ?? 0;

    // Standardize using training stats
    if (stats[name]) {
      const { mean, std } = stats[name];
      val = std > 0 ? (val - mean) / std : 0;
    }
    z += w * val;
  }

  return sigmoid(z);
}

/**
 * Default trained model weights — these are the INITIAL weights that get
 * overwritten by the training pipeline. They encode domain knowledge as
 * a starting point.
 */
export const DEFAULT_MODEL = {
  weights: {
    // These get overwritten by trainLogisticRegression()
    daysSinceLastPost: 0.3,
    daysSinceLastComment: 0.3,
    postTrend: -0.2,
    commentTrend: -0.2,
    connectionCount: -0.15,
    reciprocityRatio: -0.3,
    sobrietyDays: -0.05,
    hasPriorReset: 1.5,
    isolatedAndDeclining: 0.8,
    earlySobrietyAndSilent: 0.5,
    activeThenSilent: 0.2,
    silenceRatio: 0.4,
    struggleWordCount: 0.3,
    sentimentRatio: -0.2,
    activityVelocity7d: -0.3,
    connectionTrend: -0.2,
    cohortRelativeActivity: -0.2,
    priorResetCount: 0.8,
  },
  bias: -3.5,  // Low base rate (1.1% relapse) → strong negative bias
  featureStats: {}, // Will be populated by training
};

// ============================================================
// TRAINING: Logistic Regression with Gradient Descent
// ============================================================

/**
 * Train logistic regression on labeled data with class balancing.
 *
 * @param {Array<{ features: object, label: 0|1 }>} samples - training data
 * @param {{ lr?: number, epochs?: number, l2?: number, classWeight?: number|'balanced' }} opts
 * @returns {{ weights, bias, featureStats, history }}
 */
export function trainLogisticRegression(samples, opts = {}) {
  const {
    lr = 0.01,
    epochs = 500,
    l2 = 0.001,        // L2 regularization
    classWeight = 'balanced',
  } = opts;

  if (samples.length === 0) return { ...DEFAULT_MODEL, history: [] };

  // Compute feature statistics for standardization
  const featureStats = {};
  for (const name of FEATURE_NAMES) {
    const vals = samples.map(s => s.features[name] ?? 0);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    featureStats[name] = { mean, std };
  }

  // Standardize features
  const X = samples.map(s => {
    const row = [];
    for (const name of FEATURE_NAMES) {
      let val = s.features[name] ?? 0;
      const { mean, std } = featureStats[name];
      row.push(std > 0 ? (val - mean) / std : 0);
    }
    return row;
  });
  const y = samples.map(s => s.label);

  // Compute class weights for imbalanced data
  const nPositive = y.filter(v => v === 1).length;
  const nNegative = y.length - nPositive;
  let wPositive = 1, wNegative = 1;
  if (classWeight === 'balanced' && nPositive > 0 && nNegative > 0) {
    // sklearn-style: w = n_samples / (n_classes * n_class_samples)
    wPositive = y.length / (2 * nPositive);
    wNegative = y.length / (2 * nNegative);
  } else if (typeof classWeight === 'number') {
    wPositive = classWeight;
  }

  // Initialize weights
  const nFeatures = FEATURE_NAMES.length;
  const w = new Float64Array(nFeatures); // all zeros
  let b = Math.log(nPositive / Math.max(nNegative, 1)); // log-odds prior

  const history = [];

  // Mini-batch gradient descent
  for (let epoch = 0; epoch < epochs; epoch++) {
    let totalLoss = 0;
    const gradW = new Float64Array(nFeatures);
    let gradB = 0;

    for (let i = 0; i < X.length; i++) {
      // Forward pass
      let z = b;
      for (let j = 0; j < nFeatures; j++) z += w[j] * X[i][j];
      const pred = sigmoid(z);

      // Loss
      const yi = y[i];
      const sampleWeight = yi === 1 ? wPositive : wNegative;
      const loss = -(yi * Math.log(pred + 1e-15) + (1 - yi) * Math.log(1 - pred + 1e-15));
      totalLoss += loss * sampleWeight;

      // Gradients
      const err = (pred - yi) * sampleWeight;
      for (let j = 0; j < nFeatures; j++) {
        gradW[j] += err * X[i][j];
      }
      gradB += err;
    }

    // Update with L2 regularization
    const n = X.length;
    for (let j = 0; j < nFeatures; j++) {
      w[j] -= lr * (gradW[j] / n + l2 * w[j]);
    }
    b -= lr * (gradB / n);

    if (epoch % 50 === 0 || epoch === epochs - 1) {
      history.push({
        epoch,
        loss: totalLoss / n,
        bias: b,
        maxWeight: Math.max(...Array.from(w).map(Math.abs)),
      });
    }
  }

  // Convert weights to named object
  const weights = {};
  for (let j = 0; j < nFeatures; j++) {
    if (Math.abs(w[j]) > 1e-6) {
      weights[FEATURE_NAMES[j]] = Math.round(w[j] * 10000) / 10000;
    }
  }

  return {
    weights,
    bias: Math.round(b * 10000) / 10000,
    featureStats,
    history,
    trainStats: {
      samples: X.length,
      positives: nPositive,
      negatives: nNegative,
      wPositive: Math.round(wPositive * 100) / 100,
      wNegative: Math.round(wNegative * 100) / 100,
    },
  };
}


// ============================================================
// SCORING (uses learned model when available, falls back to heuristic)
// ============================================================

/** Minimum activity threshold */
const MIN_ACTIVITY = 1;

/** New-member grace period */
const GRACE_PERIOD_DAYS = 7;

/** Risk level thresholds — will be calibrated by training pipeline */
export let HIGH_RISK_THRESHOLD = 0.50;
export let WATCH_THRESHOLD = 0.25;

/**
 * Update risk thresholds (called after training finds optimal thresholds).
 */
export function setThresholds(high, watch) {
  if (high != null) HIGH_RISK_THRESHOLD = high;
  if (watch != null) WATCH_THRESHOLD = watch;
}

/**
 * Compute relapse risk score using learned model (or heuristic fallback).
 *
 * @param {object} features - from extractFeatures
 * @param {object|null} model - trained model (null = use heuristic)
 * @returns {number|null} risk 0-1, or null if insufficient data
 */
export function computeRelapseRisk(features, model = null) {
  if (features._totalActivity < MIN_ACTIVITY || features.tenureDays < GRACE_PERIOD_DAYS) {
    return null;
  }

  // Use learned model if available
  if (model && model.weights && Object.keys(model.weights).length > 0) {
    return predictWithModel(features, model);
  }

  // --- Heuristic fallback (same as v1 for backward compatibility) ---
  let base = 0;
  const silenceWindow = Math.max(14, Math.min(features.tenureDays * 0.5, 60));
  const postSilence = clamp(features.daysSinceLastPost / silenceWindow, 0, 1);
  const commentSilence = clamp(features.daysSinceLastComment / silenceWindow, 0, 1);
  base += (postSilence * postSilence) * 0.12;
  base += (commentSilence * commentSilence) * 0.12;
  base += clamp(1 - features.postTrend, 0, 1) * 0.06;
  base += clamp(1 - features.commentTrend, 0, 1) * 0.06;
  base += clamp(1 - features.reciprocityRatio, 0, 1) * 0.05;
  base += (features.connectionCount === 0 ? 1 : 0) * 0.04;
  base += clamp(1 - features.neighborhoodSize / 5, 0, 1) * 0.03;
  const sd = features.sobrietyDays;
  if (sd > 0 && sd < 90) base += 0.04;
  if (sd > 0) {
    if (sd >= 28 && sd <= 32) base += 0.02;
    if (sd >= 58 && sd <= 62) base += 0.02;
    if (sd >= 88 && sd <= 92) base += 0.02;
  }
  base += clamp(1 - features.massRank, 0, 1) * 0.03;
  if (features.daysSinceLastPost <= 3) base -= 0.10;
  else if (features.daysSinceLastPost <= 7) base -= 0.05;
  if (features.daysSinceLastComment <= 3) base -= 0.08;
  else if (features.daysSinceLastComment <= 7) base -= 0.04;
  if (features.postFrequency >= 2 / 7) base -= 0.03;
  if (features.commentFrequency >= 3 / 7) base -= 0.03;
  if (features.reciprocityRatio >= 0.5 && features.connectionCount >= 3) base -= 0.04;
  base = clamp(base, 0, 1);

  let multiplier = 1.0;
  if (features.hasPriorReset) multiplier += 0.60;
  if (features.isolatedAndDeclining) multiplier += 0.40;
  if (features.earlySobrietyAndSilent) multiplier += 0.30;
  if (features.activeThenSilent) multiplier *= 0.90;
  if (features.activeThenDeepSilent) multiplier *= 0.85;
  if (features.lowActivityLongTenure) multiplier *= 0.92;
  if (features.communityEngaged) multiplier *= 0.4;

  return clamp(base * multiplier, 0, 1);
}

/**
 * Compute sobriety stability score (0-1, higher = more stable).
 */
export function computeStability(features) {
  if (features._totalActivity < MIN_ACTIVITY || features.tenureDays < GRACE_PERIOD_DAYS) {
    return null;
  }

  let stability = 0;
  stability += clamp(features.postFrequency * 5, 0, 1) * 0.12;
  stability += clamp(features.commentFrequency * 3, 0, 1) * 0.12;
  stability += clamp(features.postTrend, 0, 2) / 2 * 0.08;
  stability += clamp(features.commentTrend, 0, 2) / 2 * 0.08;
  stability += features.reciprocityRatio * 0.12;
  stability += clamp(features.connectionCount / 5, 0, 1) * 0.08;
  stability += clamp(features.sobrietyDays / 365, 0, 1) * 0.08;
  stability += clamp(features.neighborhoodSize / 10, 0, 1) * 0.05;
  stability += clamp(features.tenureDays / 90, 0, 1) * 0.05;
  stability += features.massRank * 0.05;
  // v2 additions
  stability += clamp(features.sentimentRatio, 0, 1) * 0.05;
  stability += clamp(features.connectionTrend, 0, 2) / 2 * 0.05;
  stability += clamp(features.cohortRelativeActivity, 0, 3) / 3 * 0.05;

  return clamp(stability, 0, 1);
}

/**
 * Identify the top risk factors contributing to a member's risk score.
 */
export function topRiskFactors(features, model = null, maxFactors = 3) {
  if (features._totalActivity < MIN_ACTIVITY) return ['insufficient activity data'];
  if (features.tenureDays < GRACE_PERIOD_DAYS) return ['new member (< 7 days)'];

  const factors = [];

  // If we have a learned model, use feature importance (weight * standardized value)
  if (model && model.weights && model.featureStats) {
    const humanNames = {
      daysSinceLastPost: 'd since last post',
      daysSinceLastComment: 'd since last comment',
      hasPriorReset: 'prior sobriety reset',
      priorResetCount: 'multiple resets',
      isolatedAndDeclining: 'isolated + declining',
      earlySobrietyAndSilent: 'early sobriety + silent',
      silenceRatio: 'extended silence',
      struggleWordCount: 'struggle language',
      sentimentRatio: 'negative sentiment',
      activityVelocity7d: 'low recent activity',
      connectionTrend: 'losing connections',
      cohortRelativeActivity: 'below-cohort activity',
      postTrend: 'declining posts',
      commentTrend: 'declining comments',
      connectionCount: 'few connections',
      reciprocityRatio: 'low reciprocity',
      sobrietyDays: 'early sobriety',
      activeThenSilent: 'went silent after active',
    };

    for (const name of FEATURE_NAMES) {
      const w = model.weights[name];
      if (!w || Math.abs(w) < 0.01) continue;
      let val = features[name] ?? 0;
      const stats = model.featureStats[name];
      if (stats && stats.std > 0) val = (val - stats.mean) / stats.std;
      const contribution = w * val;
      if (contribution > 0.05) { // positive contribution to risk
        const label = humanNames[name] || name;
        const detail = typeof features[name] === 'number' && !Number.isInteger(features[name])
          ? ` (${features[name].toFixed(1)})`
          : features[name] > 1 ? ` (${features[name]})` : '';
        factors.push({ weight: contribution, label: label + detail });
      }
    }
  } else {
    // Heuristic fallback
    const silenceWindow = Math.max(14, Math.min(features.tenureDays * 0.5, 60));
    if (features.daysSinceLastPost > 7) {
      const s = clamp(features.daysSinceLastPost / silenceWindow, 0, 1);
      factors.push({ weight: s * s * 0.12, label: Math.round(features.daysSinceLastPost) + 'd since last post' });
    }
    if (features.daysSinceLastComment > 7) {
      const s = clamp(features.daysSinceLastComment / silenceWindow, 0, 1);
      factors.push({ weight: s * s * 0.12, label: Math.round(features.daysSinceLastComment) + 'd since last comment' });
    }
    if (features.hasPriorReset) factors.push({ weight: 0.60, label: 'prior sobriety reset (' + features.priorResetCount + 'x)' });
    if (features.isolatedAndDeclining) factors.push({ weight: 0.40, label: 'isolated + declining engagement' });
    if (features.earlySobrietyAndSilent) factors.push({ weight: 0.30, label: 'early sobriety + went silent' });
    if (features.postTrend < 0.5) factors.push({ weight: (1 - features.postTrend) * 0.06, label: 'declining post activity' });
    if (features.connectionCount === 0) factors.push({ weight: 0.04, label: 'no connections' });
  }

  factors.sort((a, b) => b.weight - a.weight);
  return factors.slice(0, maxFactors).map((f) => f.label);
}


// ============================================================
// PREDICTIONS & LABELING
// ============================================================

/**
 * Compute predictions for all members.
 * @param {object} state
 * @param {{ now?: number, model?: object }} opts - pass trained model for learned predictions
 * @returns {Map<string, { risk, stability, features, riskLevel, riskFactors }>}
 */
export function computePredictions(state, opts = {}) {
  const model = opts.model || null;
  const cohortData = computeCohortStats(state, opts);

  const predictions = new Map();
  state.members.forEach((_, mid) => {
    const cohortStats = getCohortStatsForMember(mid, state, cohortData, opts);
    const features = extractFeatures(mid, state, { ...opts, cohortStats });
    const rawRisk = computeRelapseRisk(features, model);
    const rawStability = computeStability(features);

    const hasData = rawRisk !== null;
    const risk = hasData ? rawRisk : 0.5;
    const stability = hasData ? rawStability : 0.5;
    const riskLevel = !hasData ? 'unknown'
      : risk > HIGH_RISK_THRESHOLD ? 'high'
      : risk > WATCH_THRESHOLD ? 'watch'
      : 'low';
    const riskFactors = topRiskFactors(features, model);
    predictions.set(mid, { risk, stability, features, riskLevel, riskFactors });
  });
  return predictions;
}

/**
 * Retrospective outcome labeling for training validation.
 * Uses SoberDateChange table (ground truth) or sobriety date heuristic.
 */
export function labelOutcomes(state, opts = {}) {
  const now = opts.now || Date.now();
  const dropoutDays = opts.dropoutDays || 18;
  const minActivity = opts.minActivity || 4;
  const dropoutMs = dropoutDays * DAY_MS;
  const outcomes = new Map();

  // Build ground-truth relapse set from SoberDateChange table
  const sdcRelapses = new Map();
  const hasSdcData = state.soberDateChanges && state.soberDateChanges.size > 0;
  if (hasSdcData) {
    state.soberDateChanges.forEach((sdc) => {
      if (!sdc.setOnDayOne && sdc.lastSoberDate && sdc.userId) {
        const eventDate = sdc.newDate || sdc.lastSoberDate || sdc.created;
        const eventTime = new Date(eventDate).getTime();
        const existing = sdcRelapses.get(sdc.userId);
        if (!existing || eventTime > new Date(existing.eventDate).getTime()) {
          sdcRelapses.set(sdc.userId, {
            relapseDate: sdc.created,
            eventDate: eventDate,
            newDate: sdc.newDate,
            lastSoberDate: sdc.lastSoberDate,
          });
        }
      }
    });
  }

  state.members.forEach((m, mid) => {
    let totalActivity = 0;
    let lastActivity = 0;
    let firstActivity = Infinity;
    let activityIn30dBeforeLast = 0;

    state.posts.forEach((p) => {
      if (p.creator === mid) {
        totalActivity++;
        const t = new Date(p.created).getTime();
        if (t > lastActivity) lastActivity = t;
        if (t < firstActivity) firstActivity = t;
      }
    });
    state.comments.forEach((c) => {
      if (c.fromMember === mid) {
        totalActivity++;
        const t = new Date(c.created).getTime();
        if (t > lastActivity) lastActivity = t;
        if (t < firstActivity) firstActivity = t;
      }
    });

    if (lastActivity > 0) {
      const windowStart = lastActivity - 30 * DAY_MS;
      state.posts.forEach((p) => {
        if (p.creator === mid) {
          const t = new Date(p.created).getTime();
          if (t >= windowStart && t <= lastActivity) activityIn30dBeforeLast++;
        }
      });
      state.comments.forEach((c) => {
        if (c.fromMember === mid) {
          const t = new Date(c.created).getTime();
          if (t >= windowStart && t <= lastActivity) activityIn30dBeforeLast++;
        }
      });
    }

    const disengaged = totalActivity >= minActivity
      && activityIn30dBeforeLast >= 2
      && lastActivity > 0
      && (now - lastActivity) > dropoutMs;

    let sobrietyReset = false;
    let relapseDate = null;

    if (hasSdcData) {
      const sdcRelapse = sdcRelapses.get(mid);
      if (sdcRelapse) {
        sobrietyReset = true;
        relapseDate = sdcRelapse.relapseDate;
      }
    } else {
      if (m.sobriety && m.created) {
        const sobTime = new Date(m.sobriety).getTime();
        const createdTime = new Date(m.created).getTime();
        const hadActivityBeforeSobriety = firstActivity < Infinity && firstActivity < sobTime;
        if ((sobTime - createdTime > 30 * DAY_MS) && hadActivityBeforeSobriety) {
          sobrietyReset = true;
        }
      }
    }

    let signal = 'none';
    const relapsed = sobrietyReset;
    if (sobrietyReset && disengaged) signal = 'both';
    else if (sobrietyReset) signal = 'sobrietyReset';
    else if (disengaged) signal = 'engagementDropout';

    const entry = { relapsed, disengaged, signal };
    if (relapseDate) entry.relapseDate = relapseDate;
    outcomes.set(mid, entry);
  });

  return outcomes;
}
