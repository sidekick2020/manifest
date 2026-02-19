/**
 * Zustand store for the Manifest universe.
 * Holds codec state (Maps by reference), feed/UI state, and derived metrics.
 * Maps are mutated in place; `version` counter triggers re-renders.
 */
import { create } from 'zustand';
import { createState, evolve, getTemp, getAggregates, DEFAULT_PARAMS } from '../../lib/codec.js';
import { feedFromBack4App, DEFAULT_CONFIG } from '../../lib/back4app.js';
import { v3lerp } from '../../lib/vec3.js';

// Lazy getter for prediction store to avoid circular import
let _getPredictionStore = null;
export function setPredictionStoreGetter(getter) {
  _getPredictionStore = getter;
}

// O(1) via precomputed aggregates (was O(C) scan over all comments)
function computeBeamCount(codecState) {
  const agg = getAggregates(codecState);
  return agg.beamCount;
}

// O(MH) via aggregate lookups (was O(MH * (P + 2C)) per-member scans)
function computeHashAccuracy(members, metadataHashes, codecState) {
  const agg = getAggregates(codecState);
  let tAcc = 0, aCnt = 0;
  metadataHashes.forEach((mh, mid) => {
    if (!members.has(mid)) return;
    const ps = agg.postStats.get(mid) || { count: 0 };
    const cs = agg.commentStats.get(mid) || { sent: 0 };
    const conns = agg.connectionsByMember.get(mid) || new Set();
    let ma = 0;
    if (mh.encoded.postCount === ps.count) ma++;
    if (mh.encoded.commentCount === cs.sent) ma++;
    if (mh.encoded.connections === conns.size) ma++;
    tAcc += ma / 3;
    aCnt++;
  });
  return aCnt > 0 ? Math.round((tAcc / aCnt) * 100) : null;
}

export const useUniverseStore = create((set, get) => {
  const codec = createState();

  return {
    // --- Codec state (mutable refs) ---
    members: codec.members,
    posts: codec.posts,
    comments: codec.comments,
    soberDateChanges: codec.soberDateChanges,
    targetPos: codec.targetPos,
    neighborhoods: codec.neighborhoods,
    metadataHashes: codec.metadataHashes,
    aggregates: null,
    sessionCount: 0,
    masterSeed: 0,
    fitnessHistory: [],

    // --- Feed state ---
    skips: { userSkip: 0, postSkip: 0, commentSkip: 0 },
    epochDate: null,
    feeding: false,
    status: 'idle',

    // --- UI ---
    selectedMember: null,
    selectedPost: null,
    running: false,
    intervalId: null,
    performanceMode: false,
    animationEnabled: true,  // Control animation freeze
    zoomToMemberTrigger: null, // Set to member ID to trigger zoom in Scene.jsx

    // --- Derived ---
    beamCount: 0,
    hashAccuracy: null,
    temperature: 1,

    // --- Mutation version (increment to signal change) ---
    version: 0,

    // --- Actions ---

    /** Build codec state object from current store (for passing to lib functions) */
    _codecState() {
      const s = get();
      return {
        members: s.members,
        posts: s.posts,
        comments: s.comments,
        soberDateChanges: s.soberDateChanges,
        targetPos: s.targetPos,
        neighborhoods: s.neighborhoods,
        metadataHashes: s.metadataHashes,
        aggregates: s.aggregates || null,
        sessionCount: s.sessionCount,
        masterSeed: s.masterSeed,
        fitnessHistory: s.fitnessHistory,
      };
    },

    async feedStep(params = DEFAULT_PARAMS) {
      const s = get();
      if (s.feeding) return false;

      // OPTIMIZATION: Auto-enable performance mode for large datasets
      if (s.members.size > 10000 && !s.performanceMode) {
        console.log('🚀 Entering performance mode (10K+ members) - disabling expensive features');
        set({ performanceMode: true, status: 'performance mode enabled (10K+ members)' });
      }

      set({ feeding: true, animationEnabled: false, status: 'querying back4app...' });

      const feedState = { members: s.members, posts: s.posts, comments: s.comments, soberDateChanges: s.soberDateChanges };
      const skips = { ...s.skips };

      try {
        const { added, epochDate } = await feedFromBack4App(DEFAULT_CONFIG, feedState, skips, {
          userLimit: 500,       // Larger batches = fewer API calls
          postLimit: 500,
          commentLimit: 1000,
          soberDateChangeLimit: 50,
          order: '-createdAt'   // Posts/comments by recent, users by updatedAt (set in back4app.js)
        });

        // Invalidate stale aggregates after new data loaded
        const newAggregates = added > 0 ? null : s.aggregates;

        // Track consecutive empty feeds for adaptive interval
        const emptyFeedCount = added > 0 ? 0 : (s._emptyFeedCount || 0) + 1;

        // Update skips
        set({
          feeding: false,
          animationEnabled: true,  // Re-enable animation after data load
          skips,
          aggregates: newAggregates,
          _emptyFeedCount: emptyFeedCount,
          epochDate: epochDate || s.epochDate,
          status: added > 0 ? `+${added} from back4app (${s.members.size} members, ${s.soberDateChanges.size} SDC)` : 'no new data',
        });

        // Evolve if we have data (skip during animation freeze)
        if (s.members.size > 0 && s.animationEnabled) {
          const codecState = get()._codecState();

          // With precomputed aggregates, evolution is ~60x faster.
          // Only skip for very large datasets (5000+) where even optimized evolution is costly.
          if (s.members.size > 5000) {
            // Simple sphere positioning for very large datasets
            s.members.forEach((m, id) => {
              if (!s.targetPos.has(id)) {
                const hash = id.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
                const t = Math.abs(hash) / 2147483647;
                const phi = t * Math.PI * 2;
                const theta = Math.acos(2 * ((hash >>> 16) / 65535) - 1);
                const r = 80 + (Math.abs(hash) % 40);

                s.targetPos.set(id, {
                  x: r * Math.sin(theta) * Math.cos(phi),
                  y: r * Math.sin(theta) * Math.sin(phi),
                  z: r * Math.cos(theta)
                });
              }
            });

            set({ version: get().version + 1 });
          } else {
            // Social-graph-aware evolution (now efficient up to 5000 members)
            let predictions = null;
            if (_getPredictionStore) {
              const predStore = _getPredictionStore();
              predictions = predStore.active ? predStore.predictions : null;
            }

            const result = evolve(codecState, params, predictions);

            set({
              sessionCount: codecState.sessionCount,
              masterSeed: codecState.masterSeed,
              targetPos: codecState.targetPos,
              neighborhoods: codecState.neighborhoods,
              aggregates: codecState.aggregates,
              fitnessHistory: [...codecState.fitnessHistory],
              beamCount: computeBeamCount(codecState),
              hashAccuracy: computeHashAccuracy(s.members, s.metadataHashes, codecState),
              temperature: getTemp(codecState.sessionCount, params),
              version: get().version + 1,
            });
          }
        }
        return added > 0;
      } catch (err) {
        set({ feeding: false, status: 'API error: ' + (err.message || 'unknown') });
        return false;
      }
    },

    runEvolve(params = DEFAULT_PARAMS) {
      const codecState = get()._codecState();
      // Get predictions from predictionStore if active (lazy to avoid circular import)
      let predictions = null;
      if (_getPredictionStore) {
        const predStore = _getPredictionStore();
        predictions = predStore.active ? predStore.predictions : null;
      }
      const result = evolve(codecState, params, predictions);
      const s = get();
      set({
        sessionCount: codecState.sessionCount,
        masterSeed: codecState.masterSeed,
        targetPos: codecState.targetPos,
        neighborhoods: codecState.neighborhoods,
        aggregates: codecState.aggregates,
        fitnessHistory: [...codecState.fitnessHistory],
        beamCount: computeBeamCount(codecState),
        hashAccuracy: computeHashAccuracy(s.members, s.metadataHashes, codecState),
        temperature: getTemp(codecState.sessionCount, params),
        version: s.version + 1,
      });
      return result;
    },

    tick() {
      const { members, targetPos } = get();
      const t = 0.04;
      let changed = false;
      members.forEach((m, id) => {
        const target = targetPos.get(id);
        if (!target) return;
        if (!m.position) {
          m.position = { x: target.x, y: target.y, z: target.z };
          changed = true;
          return;
        }
        m.position = v3lerp(m.position, target, t);
        m.opacity = (m.opacity ?? 0) + (0.9 - (m.opacity ?? 0)) * 0.03;
        m.scale = (m.scale ?? 0) + (1 - (m.scale ?? 0)) * 0.04;
        changed = true;
      });
      if (changed) set({ version: get().version + 1 });
    },

    toggleRunning() {
      const s = get();
      if (s.running) {
        // Stop immediately - clear timeout and update state
        if (s.intervalId) clearTimeout(s.intervalId);
        set({ running: false, intervalId: null, _emptyFeedCount: 0, status: 'paused — explore' });
      } else {
        // Start running - first feed, then set up adaptive interval
        s.feedStep().catch(err => {
          console.error('[toggleRunning] Initial feed error:', err);
          set({ running: false, intervalId: null, status: 'error: ' + err.message });
        });
        // Adaptive feed interval: backs off when no new data arrives
        // Base 5s, doubles per consecutive empty feed, caps at 20s
        function scheduleNext() {
          const cur = get();
          if (!cur.running) return;
          const emptyCount = cur._emptyFeedCount || 0;
          const interval = Math.min(20000, 5000 * Math.pow(2, Math.min(emptyCount, 2)));
          const nextId = setTimeout(() => {
            get().feedStep().then(() => {
              scheduleNext();
            }).catch(err => {
              console.error('[toggleRunning] Feed error:', err);
              scheduleNext(); // Keep trying
            });
          }, interval);
          set({ intervalId: nextId });
        }
        set({ running: true, _emptyFeedCount: 0 });
        scheduleNext();
      }
    },

    setSelectedMember(id, options = {}) {
      const shouldZoom = options.zoom !== false; // Default to true
      console.log(`[Store] setSelectedMember(${id ? id.slice(0, 8) + '...' : 'null'}, zoom=${shouldZoom})`);
      set({
        selectedMember: id,
        zoomToMemberTrigger: shouldZoom ? id : null
      });
      console.log(`[Store] zoomToMemberTrigger set to:`, shouldZoom ? id : null);
    },

    setSelectedPost(id) {
      set({ selectedPost: id });
    },

    reset() {
      const s = get();
      if (s.intervalId) clearTimeout(s.intervalId);
      const fresh = createState();
      set({
        members: fresh.members,
        posts: fresh.posts,
        comments: fresh.comments,
        soberDateChanges: fresh.soberDateChanges,
        targetPos: fresh.targetPos,
        neighborhoods: fresh.neighborhoods,
        metadataHashes: fresh.metadataHashes,
        aggregates: null,
        sessionCount: 0,
        masterSeed: 0,
        fitnessHistory: [],
        skips: { userSkip: 0, postSkip: 0, commentSkip: 0 },
        epochDate: null,
        feeding: false,
        _emptyFeedCount: 0,
        status: 'reset',
        selectedMember: null,
        selectedPost: null,
        running: false,
        intervalId: null,
        beamCount: 0,
        hashAccuracy: null,
        temperature: 1,
        version: 0,
      });
    },
  };
});
