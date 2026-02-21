/**
 * Zustand store for hash training mode.
 * Manages graph-optimal positions, error metrics, param tuning, and visual overlays.
 */
import { create } from 'zustand';
import { DEFAULT_PARAMS, filterMembersByLocation, buildFilteredState } from '../../lib/codec.js';
import { computeGraphOptimal } from '../../lib/graphOptimal.js';
import { computePredictionError, generateSnapshot, tuneParams } from '../../lib/hashTrainer.js';
import { useUniverseStore } from './universeStore.js';

export const useTrainingStore = create((set, get) => ({
  // --- Training mode ---
  active: false,

  // --- Ground truth ---
  optimalPositions: null, // Map<id, {x,y,z}>

  // --- Error metrics ---
  currentError: null, // { meanError, medianError, maxError, r2, perMember }
  errorHistory: [],   // [{ epoch, meanError, r2 }]

  // --- Codec params (editable copy) ---
  codecParams: { ...DEFAULT_PARAMS },

  // --- Visual toggles ---
  showGhosts: true,
  showErrorLines: true,
  showPanel: false,

  // --- Auto-train ---
  autoTrain: false,
  autoTrainId: null,

  // --- Actions ---

  toggleActive() {
    const next = !get().active;
    set({ active: next, showPanel: next });
    if (next) get().computeOptimal();
  },

  togglePanel() {
    set({ showPanel: !get().showPanel });
  },

  toggleGhosts() {
    set({ showGhosts: !get().showGhosts });
  },

  toggleErrorLines() {
    set({ showErrorLines: !get().showErrorLines });
  },

  computeOptimal() {
    const universe = useUniverseStore.getState();
    if (universe.members.size === 0) return;

    // Use filtered subset so training targets match the visible universe
    const locFilter = universe.locationFilter;
    const activeMembers = filterMembersByLocation(universe.members, locFilter);
    const filteredState = (activeMembers === universe.members)
      ? { members: universe.members, comments: universe.comments }
      : buildFilteredState(
          { members: universe.members, posts: universe.posts, comments: universe.comments },
          activeMembers
        );

    const result = computeGraphOptimal({
      members: filteredState.members,
      comments: filteredState.comments,
    });
    set({ optimalPositions: result.positions });

    // Immediately compute error
    get().computeError();
  },

  computeError() {
    const { optimalPositions, errorHistory } = get();
    const universe = useUniverseStore.getState();
    if (!optimalPositions || universe.targetPos.size === 0) return;

    const error = computePredictionError(universe.targetPos, optimalPositions);
    const entry = {
      epoch: universe.sessionCount,
      meanError: error.meanError,
      r2: error.r2,
    };
    set({
      currentError: error,
      errorHistory: [...errorHistory, entry].slice(-100),
    });
  },

  /** Run one training step: evolve with current params, recompute error */
  trainStep() {
    const { codecParams } = get();
    const universe = useUniverseStore.getState();

    // Feed + evolve with training params
    universe.feedStep(codecParams).then(() => {
      // Recompute optimal and error
      get().computeOptimal();
    });
  },

  /** Auto-tune: perturb params, find improvement */
  async runAutoTune() {
    const { codecParams } = get();
    const universe = useUniverseStore.getState();
    if (universe.members.size < 3) return;

    // Train on filtered subset so tuned params optimize for the visible universe
    const locFilter = universe.locationFilter;
    const activeMembers = filterMembersByLocation(universe.members, locFilter);
    const fullState = {
      members: universe.members,
      posts: universe.posts,
      comments: universe.comments,
    };
    const state = (activeMembers === universe.members)
      ? fullState
      : buildFilteredState(fullState, activeMembers);

    const result = tuneParams(state, codecParams, { perturbScale: 0.15, sessionsPerTest: 8 });
    set({ codecParams: result.params });

    // Update optimal and error after tuning
    get().computeOptimal();

    return result;
  },

  toggleAutoTrain() {
    const s = get();
    if (s.autoTrain) {
      if (s.autoTrainId) clearInterval(s.autoTrainId);
      set({ autoTrain: false, autoTrainId: null });
    } else {
      get().trainStep();
      const id = setInterval(() => get().trainStep(), 3000);
      set({ autoTrain: true, autoTrainId: id });
    }
  },

  setParam(key, value) {
    set({ codecParams: { ...get().codecParams, [key]: value } });
  },

  resetTraining() {
    const s = get();
    if (s.autoTrainId) clearInterval(s.autoTrainId);
    set({
      active: false,
      optimalPositions: null,
      currentError: null,
      errorHistory: [],
      codecParams: { ...DEFAULT_PARAMS },
      showGhosts: true,
      showErrorLines: true,
      showPanel: false,
      autoTrain: false,
      autoTrainId: null,
    });
  },
}));
