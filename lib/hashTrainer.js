/**
 * Hash training engine: compare codec-predicted positions against graph-optimal
 * "reality" positions. Compute error metrics. Tune codec hyperparameters.
 */
import { v3dist } from './vec3.js';
import { DEFAULT_PARAMS, evolve, createState } from './codec.js';
import { computeGraphOptimal } from './graphOptimal.js';

/**
 * Compute per-member and aggregate error between predicted and optimal positions.
 * @param {Map<string, {x,y,z}>} predicted - Codec output positions
 * @param {Map<string, {x,y,z}>} optimal - Graph-optimal positions
 * @returns {{ meanError: number, medianError: number, maxError: number, r2: number, perMember: Map<string, { predicted: {x,y,z}, optimal: {x,y,z}, error: number }> }}
 */
export function computePredictionError(predicted, optimal) {
  const perMember = new Map();
  const errors = [];

  optimal.forEach((optPos, id) => {
    const predPos = predicted.get(id);
    if (!predPos) return;
    const err = v3dist(predPos, optPos);
    errors.push(err);
    perMember.set(id, { predicted: predPos, optimal: optPos, error: err });
  });

  if (errors.length === 0) {
    return { meanError: 0, medianError: 0, maxError: 0, r2: 0, perMember };
  }

  errors.sort((a, b) => a - b);
  const meanError = errors.reduce((s, e) => s + e, 0) / errors.length;
  const medianError = errors[Math.floor(errors.length / 2)];
  const maxError = errors[errors.length - 1];

  // R² score (how much variance in optimal positions is explained by predicted)
  // Compute total variance of optimal positions (sum of squared distances from centroid)
  let cx = 0, cy = 0, cz = 0, count = 0;
  optimal.forEach((p) => { cx += p.x; cy += p.y; cz += p.z; count++; });
  cx /= count; cy /= count; cz /= count;

  let ssTot = 0, ssRes = 0;
  optimal.forEach((optPos, id) => {
    const predPos = predicted.get(id);
    if (!predPos) return;
    ssTot += (optPos.x - cx) ** 2 + (optPos.y - cy) ** 2 + (optPos.z - cz) ** 2;
    ssRes += (optPos.x - predPos.x) ** 2 + (optPos.y - predPos.y) ** 2 + (optPos.z - predPos.z) ** 2;
  });
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { meanError, medianError, maxError, r2, perMember };
}

/**
 * Generate a full training snapshot: evolve, compute optimal, measure error.
 */
export function generateSnapshot(state, params = DEFAULT_PARAMS) {
  const optResult = computeGraphOptimal(state);
  const error = computePredictionError(state.targetPos, optResult.positions);

  return {
    epoch: state.sessionCount,
    memberCount: state.members.size,
    fitness: state.fitnessHistory.length > 0 ? state.fitnessHistory[state.fitnessHistory.length - 1] : null,
    temperature: Math.max(0.03, Math.pow(params.annealingRate, state.sessionCount)),
    error: {
      mean: error.meanError,
      median: error.medianError,
      max: error.maxError,
      r2: error.r2,
    },
    params: { ...params },
    timestamp: Date.now(),
    optimalPositions: optResult.positions,
    perMemberErrors: error.perMember,
  };
}

/**
 * Tune codec params by testing perturbations and picking the best.
 * Simple hill-climbing: perturb each param ±10%, keep improvements.
 *
 * @param {{ members: Map, posts: Map, comments: Map }} state - data to test against
 * @param {object} currentParams - current codec params
 * @param {{ perturbScale?: number, sessionsPerTest?: number }} opts
 * @returns {{ params: object, improvement: number, bestError: number }}
 */
export function tuneParams(state, currentParams = DEFAULT_PARAMS, opts = {}) {
  const { perturbScale = 0.15, sessionsPerTest = 10 } = opts;

  // Tunable param keys (skip variantCount — must be integer)
  const tunable = [
    'cohesionWeight', 'stabilityWeight', 'nhRadiusBase', 'nhRadiusScale',
    'localRadiusBase', 'localRadiusScale', 'gravityFactor', 'annealingRate',
    'massPostW', 'massCommentTotalW', 'massDirectCommentW',
    'cohesionScale', 'stabilityScale',
  ];

  function testParams(params) {
    // Clone state for isolated test
    const testState = createState();
    state.members.forEach((v, k) => testState.members.set(k, { ...v, position: null }));
    state.posts.forEach((v, k) => testState.posts.set(k, { ...v }));
    state.comments.forEach((v, k) => testState.comments.set(k, { ...v }));

    for (let i = 0; i < sessionsPerTest; i++) {
      evolve(testState, params);
    }

    const optResult = computeGraphOptimal(testState);
    const error = computePredictionError(testState.targetPos, optResult.positions);
    return error.meanError;
  }

  // Baseline
  const baselineError = testParams(currentParams);
  let bestParams = { ...currentParams };
  let bestError = baselineError;

  // Try perturbing each param
  for (const key of tunable) {
    const base = currentParams[key];
    if (base === 0) continue;

    // Try +perturbScale
    const upParams = { ...bestParams, [key]: base * (1 + perturbScale) };
    const upError = testParams(upParams);
    if (upError < bestError) {
      bestError = upError;
      bestParams = upParams;
      continue;
    }

    // Try -perturbScale
    const downParams = { ...bestParams, [key]: base * (1 - perturbScale) };
    const downError = testParams(downParams);
    if (downError < bestError) {
      bestError = downError;
      bestParams = downParams;
    }
  }

  return {
    params: bestParams,
    improvement: baselineError - bestError,
    baselineError,
    bestError,
  };
}
