/**
 * Zustand store for prediction overlay mode.
 * Supports learned logistic regression model and risk-driven layout.
 */
import { create } from 'zustand';
import { computePredictions, labelOutcomes, extractFeatures, computeCohortStats, getCohortStatsForMember, trainLogisticRegression, DEFAULT_MODEL, setThresholds } from '../../lib/predictions.js';
import { computeRiskLayout, blendLayouts } from '../../lib/riskLayout.js';
import { useUniverseStore, setPredictionStoreGetter } from './universeStore.js';

export const usePredictionStore = create((set, get) => ({
  // --- Prediction mode ---
  active: false,

  // --- Predictions ---
  predictions: null, // Map<mid, { risk, stability, features, riskLevel, riskFactors }>

  // --- Trained model (loaded from training pipeline or default) ---
  model: null, // { weights, bias, featureStats } or null for heuristic fallback

  // --- Risk layout ---
  riskPositions: null, // Map<mid, {x,y,z}> from risk-driven layout
  layoutBlend: 0.7,    // 0 = pure codec layout, 1 = pure risk layout

  // --- Visual toggles ---
  showHalos: true,
  showDriftVectors: true,
  showRelapseRings: true,
  showPanel: false,

  // --- Training state ---
  trainedOnSDC: 0,       // how many SDC records the current model was trained on
  trainingStatus: null,   // 'training' | 'done' | null

  // --- Summary ---
  summary: null,

  // --- Actions ---

  toggleActive() {
    const next = !get().active;
    set({ active: next, showPanel: next });
    if (next) get().recompute();
  },

  togglePanel() {
    set({ showPanel: !get().showPanel });
  },

  toggleHalos() {
    set({ showHalos: !get().showHalos });
  },

  toggleDriftVectors() {
    set({ showDriftVectors: !get().showDriftVectors });
  },

  toggleRelapseRings() {
    set({ showRelapseRings: !get().showRelapseRings });
  },

  setLayoutBlend(blend) {
    set({ layoutBlend: Math.max(0, Math.min(1, blend)) });
    get().applyRiskLayout();
  },

  /**
   * Load a trained model (from training pipeline JSON or embedded).
   */
  loadModel(modelData) {
    if (modelData && modelData.weights) {
      set({ model: modelData });
      if (get().active) get().recompute();
    }
  },

  /**
   * Apply risk-driven layout positions to universe store.
   */
  applyRiskLayout() {
    const { riskPositions, layoutBlend, active } = get();
    if (!active || !riskPositions) return;

    const universe = useUniverseStore.getState();
    if (universe.targetPos.size === 0) return;

    const blended = blendLayouts(universe.targetPos, riskPositions, layoutBlend);
    blended.forEach((pos, mid) => {
      universe.targetPos.set(mid, pos);
    });
    // Don't increment version - this prevents recompute loop
    // The tick() function will trigger renders from position changes
  },

  recompute() {
    const universe = useUniverseStore.getState();
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[predictionStore] ${timestamp} recompute() called, members:`, universe.members.size);
    if (universe.members.size === 0) {
      console.log('[predictionStore] No members, returning early');
      return;
    }

    const state = {
      members: universe.members,
      posts: universe.posts,
      comments: universe.comments,
      targetPos: universe.targetPos,
      neighborhoods: universe.neighborhoods,
      metadataHashes: universe.metadataHashes || new Map(),
      soberDateChanges: universe.soberDateChanges || new Map(),
    };

    const now = universe.epochDate ? universe.epochDate.getTime() : Date.now();

    // Auto-train from SDC data if we have enough and model is stale or missing
    const sdcSize = state.soberDateChanges.size;
    const { trainedOnSDC, trainingStatus } = get();
    // TEMPORARILY DISABLED: Auto-training not working due to 0 samples
    // if (sdcSize >= 3 && trainingStatus !== 'training' && sdcSize > trainedOnSDC * 1.3) {
    //   console.log('[predictionStore] Auto-training from SDC');
    //   get().trainFromSDC();
    //   return; // trainFromSDC calls recompute() after training
    // }

    const model = get().model;
    const predictions = computePredictions(state, { now, model });
    console.log(`[predictionStore] ${timestamp} Computed ${predictions.size} predictions (SDC: ${sdcSize}, model: ${model ? 'loaded' : 'heuristic'})`);
    const outcomes = labelOutcomes(state, { now });

    // Compute risk-driven layout
    const riskLayoutResult = computeRiskLayout(state, predictions);
    const riskPositions = riskLayoutResult.positions;

    // Compute summary
    let totalRisk = 0, totalStability = 0, scored = 0;
    let highRiskCount = 0, watchCount = 0, lowCount = 0, unknownCount = 0;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    let disengagedCount = 0;

    predictions.forEach((p, mid) => {
      if (p.riskLevel === 'unknown') { unknownCount++; return; }
      scored++;
      totalRisk += p.risk;
      totalStability += p.stability;
      if (p.riskLevel === 'high') highRiskCount++;
      else if (p.riskLevel === 'watch') watchCount++;
      else lowCount++;

      const outcome = outcomes.get(mid);
      if (outcome) {
        if (outcome.disengaged) disengagedCount++;
        const predictedHigh = p.riskLevel === 'high';
        if (outcome.relapsed) {
          if (predictedHigh) tp++; else fn++;
        } else {
          if (predictedHigh) fp++; else tn++;
        }
      }
    });
    const n = scored || 1;

    const fpr = (fp + tn) > 0 ? fp / (fp + tn) : 0;
    const specificity = 1 - fpr;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

    set({
      predictions,
      riskPositions,
      summary: {
        avgRisk: Math.round((totalRisk / n) * 1000) / 1000,
        avgStability: Math.round((totalStability / n) * 1000) / 1000,
        highRiskCount,
        watchCount,
        lowCount,
        unknownCount,
        scoredCount: scored,
        disengagedCount,
        tp, fp, fn, tn,
        precision: Math.round(precision * 1000) / 1000,
        recall: Math.round(recall * 1000) / 1000,
        f1: Math.round(f1 * 1000) / 1000,
        fpr: Math.round(fpr * 1000) / 1000,
        specificity: Math.round(specificity * 1000) / 1000,
        modelType: model ? 'learned' : 'heuristic',
      },
    });

    // Apply risk layout if blend > 0
    if (get().layoutBlend > 0) {
      get().applyRiskLayout();
    }
  },

  /**
   * Train logistic regression from SoberDateChange ground truth.
   * Builds labeled samples, trains, loads the learned model, then recomputes.
   */
  trainFromSDC() {
    const universe = useUniverseStore.getState();
    const sdc = universe.soberDateChanges;
    console.log('[predictionStore] trainFromSDC() called, SDC size:', sdc ? sdc.size : 0);
    if (!sdc || sdc.size === 0) return;

    set({ trainingStatus: 'training' });

    const state = {
      members: universe.members,
      posts: universe.posts,
      comments: universe.comments,
      targetPos: universe.targetPos,
      neighborhoods: universe.neighborhoods,
      metadataHashes: universe.metadataHashes || new Map(),
      soberDateChanges: sdc,
    };
    const now = universe.epochDate ? universe.epochDate.getTime() : Date.now();

    // Build labeled training samples from SDC outcomes
    const outcomes = labelOutcomes(state, { now });
    const cohortData = computeCohortStats(state, { now });
    const samples = [];

    state.members.forEach((_, mid) => {
      const outcome = outcomes.get(mid);
      if (!outcome) return;
      // Only include members with enough activity for meaningful features
      const cohortStats = getCohortStatsForMember(mid, state, cohortData, { now });
      const features = extractFeatures(mid, state, { now, cohortStats });
      if (features._totalActivity < 1 || features.tenureDays < 7) return;
      samples.push({ features, label: outcome.relapsed ? 1 : 0 });
    });

    console.log('[predictionStore] Built', samples.length, 'training samples');
    if (samples.length < 10) {
      console.log('[predictionStore] Not enough samples, skipping training');
      set({ trainingStatus: null });
      return;
    }

    // Train with in-browser logistic regression
    console.log('[predictionStore] Starting training...');
    const result = trainLogisticRegression(samples, {
      lr: 0.005,
      epochs: 800,
      l2: 0.05,
      classWeight: 'balanced',
    });
    console.log('[predictionStore] Training complete, weights:', Object.keys(result.weights).length);

    set({
      model: { weights: result.weights, bias: result.bias, featureStats: result.featureStats },
      trainedOnSDC: sdc.size,
      trainingStatus: 'done',
    });

    console.log('[predictionStore] Calling recompute() after training');
    // Recompute predictions with the new model
    get().recompute();
  },

  resetPredictions() {
    set({
      active: false,
      predictions: null,
      model: null,
      riskPositions: null,
      showHalos: true,
      showDriftVectors: true,
      showRelapseRings: true,
      showPanel: false,
      summary: null,
      layoutBlend: 0.7,
      trainedOnSDC: 0,
      trainingStatus: null,
    });
  },
}));

// Register getter so universeStore can access predictions without circular import
setPredictionStoreGetter(() => usePredictionStore.getState());

// Auto-recompute predictions when universe data changes (debounced)
let _lastVersion = -1;
let _debounceTimer = null;
useUniverseStore.subscribe((state) => {
  const pred = usePredictionStore.getState();
  if (pred.active && state.version !== _lastVersion) {
    _lastVersion = state.version;
    // Debounce: only recompute after 500ms of no changes
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      pred.recompute();
      _debounceTimer = null;
    }, 500);
  }
});
