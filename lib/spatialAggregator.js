/**
 * Spatial Aggregator — clusters nearby members for efficient LOD rendering.
 *
 * Key changes from MVP:
 * - Deterministic aggregate positions: centroid is nudged by a hash of the
 *   sorted member IDs so the same cluster always lands at the same spot,
 *   even if member positions jitter during animation.
 * - "Representative" tier: when the cluster is small (2-8 members) the
 *   highest-mass member is returned alongside a count badge, preserving
 *   individual identity at medium zoom.
 * - Cross-fade opacity via blendFactor passed from the LOD system.
 */

import { hash32 } from './codec.js';

export class SpatialAggregator {
  constructor() {
    this.aggregates = new Map();
    this.memberToCell = new Map();
  }

  /**
   * Cluster members into spatial aggregates based on camera distance.
   * @param {Map} members — Map of member ID -> member data
   * @param {number} cameraDistance
   * @param {object} [opts] — { lodTier, blendFactor } from getLODTier()
   * @returns {Array} Array of items to render
   */
  aggregate(members, cameraDistance, opts = {}) {
    const cellSize = this.calculateCellSize(cameraDistance);
    const { lodTier = 'individual', blendFactor = 0 } = opts;

    // Individual tier: return every member as-is
    if (cellSize < 5) {
      return Array.from(members.entries()).map(([id, m]) => ({
        type: 'individual',
        id,
        member: m,
        position: m.position,
        opacity: 1,
      }));
    }

    this.aggregates.clear();
    this.memberToCell.clear();

    // --- Bucket members into grid cells ---
    for (const [id, m] of members.entries()) {
      if (!m.position) continue;

      const cellKey = this.getCellKey(m.position, cellSize);
      this.memberToCell.set(id, cellKey);

      if (!this.aggregates.has(cellKey)) {
        this.aggregates.set(cellKey, {
          type: 'aggregate',
          members: [],
          position: { x: 0, y: 0, z: 0 },
          totalMass: 0,
          totalRisk: 0,
          count: 0,
        });
      }

      const agg = this.aggregates.get(cellKey);
      agg.members.push({ id, data: m });
      agg.count++;
    }

    // --- Build result list ---
    const result = [];

    for (const [cellKey, agg] of this.aggregates.entries()) {
      // Single member — always render individually
      if (agg.count === 1) {
        const { id, data } = agg.members[0];
        result.push({
          type: 'individual',
          id,
          member: data,
          position: data.position,
          opacity: 1,
        });
        continue;
      }

      // Compute centroid + deterministic jitter
      let sumX = 0, sumY = 0, sumZ = 0;
      let totalMass = 0;
      let totalRisk = 0;
      let riskCount = 0;
      let bestMember = null;
      let bestMass = -1;

      // Sort member IDs for deterministic hashing
      const sortedIds = agg.members.map(m => m.id).sort();

      for (const { id, data } of agg.members) {
        sumX += data.position.x;
        sumY += data.position.y;
        sumZ += data.position.z;

        const mass = data.mass !== undefined ? data.mass : 1;
        totalMass += mass;

        if (mass > bestMass) {
          bestMass = mass;
          bestMember = { id, data };
        }

        if (data.risk !== undefined && data.risk >= 0) {
          totalRisk += data.risk;
          riskCount++;
        }
      }

      const cx = sumX / agg.count;
      const cy = sumY / agg.count;
      const cz = sumZ / agg.count;

      // Deterministic nudge: hash of sorted IDs gives stable micro-offset
      // so centroid doesn't jitter when members animate
      const clusterHash = hash32(sortedIds.join('|'));
      const nudge = 0.3; // small so it doesn't move the centroid visually
      const nx = ((clusterHash & 0xff) / 255 - 0.5) * nudge;
      const ny = (((clusterHash >> 8) & 0xff) / 255 - 0.5) * nudge;
      const nz = (((clusterHash >> 16) & 0xff) / 255 - 0.5) * nudge;

      const position = { x: cx + nx, y: cy + ny, z: cz + nz };

      // Representative tier: small clusters show the top member + badge
      if (lodTier === 'representative' && agg.count <= 8 && bestMember) {
        result.push({
          type: 'representative',
          id: bestMember.id,
          member: bestMember.data,
          position: bestMember.data.position,
          count: agg.count,
          mass: totalMass,
          averageRisk: riskCount > 0 ? totalRisk / riskCount : undefined,
          opacity: 1 - blendFactor * 0.3, // slight fade toward cluster transition
          members: agg.members,
        });
        continue;
      }

      // Full aggregate
      result.push({
        type: 'aggregate',
        cellKey,
        count: agg.count,
        position,
        mass: totalMass,
        averageRisk: riskCount > 0 ? totalRisk / riskCount : undefined,
        members: agg.members,
        opacity: 1,
      });
    }

    return result;
  }

  /**
   * Logarithmic cell size from camera distance.
   */
  calculateCellSize(cameraDistance) {
    if (cameraDistance < 10) return 0;
    if (cameraDistance < 30) return 5 + (cameraDistance - 10) * 0.5;
    if (cameraDistance < 100) return 15 + (cameraDistance - 30) * 0.35;
    return 40 + (cameraDistance - 100) * 0.2;
  }

  getCellKey(pos, cellSize) {
    const cx = Math.floor(pos.x / cellSize);
    const cy = Math.floor(pos.y / cellSize);
    const cz = Math.floor(pos.z / cellSize);
    return `${cx},${cy},${cz}`;
  }

  getMembersInAggregate(cellKey) {
    const agg = this.aggregates.get(cellKey);
    return agg ? agg.members.map(m => m.id) : [];
  }

  getAggregateForMember(memberId) {
    return this.memberToCell.get(memberId) || null;
  }
}
