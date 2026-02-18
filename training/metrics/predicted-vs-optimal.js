/**
 * Predicted vs Optimal: compare codec-predicted positions against graph-optimal.
 * This is the core training metric — how well does the hash predict graph structure?
 */
import { computeGraphOptimal } from '../../lib/graphOptimal.js';
import { computePredictionError } from '../../lib/hashTrainer.js';

/**
 * @param {object} state - Codec state with members, posts, comments, targetPos
 * @returns {{ meanError: number, medianError: number, maxError: number, r2: number, memberCount: number, convergenceSteps: number, worstMembers: Array }}
 */
export function predictedVsOptimal(state) {
  if (state.members.size === 0 || state.targetPos.size === 0) {
    return { meanError: 0, medianError: 0, maxError: 0, r2: 0, memberCount: 0, convergenceSteps: 0, worstMembers: [] };
  }

  const { positions: optimalPositions, convergence } = computeGraphOptimal(
    { members: state.members, comments: state.comments },
    { iterations: 200 }
  );

  const error = computePredictionError(state.targetPos, optimalPositions);

  // Get worst predicted members
  const worstMembers = Array.from(error.perMember.entries())
    .sort(([, a], [, b]) => b.error - a.error)
    .slice(0, 20)
    .map(([id, { error: err }]) => {
      const m = state.members.get(id);
      return { id, username: m?.username || 'unknown', error: err };
    });

  return {
    meanError: error.meanError,
    medianError: error.medianError,
    maxError: error.maxError,
    r2: error.r2,
    memberCount: error.perMember.size,
    convergenceSteps: convergence.length,
    worstMembers,
  };
}
