/**
 * Run evolution sessions on state. Collect snapshot per session for metrics.
 */
import { evolve, getTemp } from '../lib/codec.js';

/**
 * Run N evolution steps. state is mutated; snapshots are collected.
 * @param {object} state - codec state (members, posts, comments, targetPos, ...)
 * @param {number} numSessions
 * @returns {{ snapshots: Array<{ session: number, fitness: number, temperature: number, memberCount: number }> }}
 */
export function runSessions(state, numSessions) {
  const snapshots = [];
  for (let s = 0; s < numSessions; s++) {
    const result = evolve(state);
    snapshots.push({
      session: state.sessionCount,
      fitness: result.winner.fitness,
      temperature: getTemp(state.sessionCount),
      memberCount: state.members.size,
    });
  }
  return { snapshots };
}
