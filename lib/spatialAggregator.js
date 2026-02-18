/**
 * Spatial Aggregator - Clusters nearby members into aggregates for efficient rendering
 *
 * Key concepts:
 * - Uses grid-based spatial hashing for O(1) clustering
 * - LOD system: Show aggregates when zoomed out, individuals when zoomed in
 * - Aggregate properties: position (centroid), count, average risk, combined mass
 */

export class SpatialAggregator {
  constructor() {
    this.aggregates = new Map(); // Grid cell key -> aggregate data
    this.memberToCell = new Map(); // Member ID -> grid cell key
  }

  /**
   * Cluster members into spatial aggregates based on camera distance
   * @param {Map} members - Map of member ID -> member data
   * @param {number} cameraDistance - Current camera distance (zoom level)
   * @returns {Array} Array of aggregates or individual members to render
   */
  aggregate(members, cameraDistance) {
    // Dynamic cell size based on zoom level
    // When zoomed out (high distance), use large cells to cluster aggressively
    // When zoomed in (low distance), use small cells or skip aggregation entirely
    const cellSize = this.calculateCellSize(cameraDistance);

    // Skip aggregation when very zoomed in (show all individual members)
    if (cellSize < 5) {
      return Array.from(members.entries()).map(([id, m]) => ({
        type: 'individual',
        id,
        member: m,
        position: m.position
      }));
    }

    // Clear previous aggregation
    this.aggregates.clear();
    this.memberToCell.clear();

    // Group members into grid cells
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
          count: 0
        });
      }

      const agg = this.aggregates.get(cellKey);
      agg.members.push({ id, data: m });
      agg.count++;
    }

    // Calculate aggregate properties (centroid, average risk, etc.)
    const result = [];

    for (const [cellKey, agg] of this.aggregates.entries()) {
      // Single member in cell - render as individual
      if (agg.count === 1) {
        const { id, data } = agg.members[0];
        result.push({
          type: 'individual',
          id,
          member: data,
          position: data.position
        });
        continue;
      }

      // Multiple members - create aggregate
      let sumX = 0, sumY = 0, sumZ = 0;
      let totalMass = 0;
      let totalRisk = 0;
      let riskCount = 0;

      for (const { data } of agg.members) {
        sumX += data.position.x;
        sumY += data.position.y;
        sumZ += data.position.z;

        // Accumulate mass (for sizing)
        if (data.mass !== undefined) {
          totalMass += data.mass;
        } else {
          totalMass += 1; // Default mass
        }

        // Accumulate risk (if available)
        if (data.risk !== undefined && data.risk >= 0) {
          totalRisk += data.risk;
          riskCount++;
        }
      }

      result.push({
        type: 'aggregate',
        cellKey,
        count: agg.count,
        position: {
          x: sumX / agg.count,
          y: sumY / agg.count,
          z: sumZ / agg.count
        },
        mass: totalMass,
        averageRisk: riskCount > 0 ? totalRisk / riskCount : undefined,
        members: agg.members // Keep reference for drill-down
      });
    }

    return result;
  }

  /**
   * Calculate optimal cell size based on camera distance (zoom level)
   * @param {number} cameraDistance - Current camera distance
   * @returns {number} Grid cell size
   */
  calculateCellSize(cameraDistance) {
    // Logarithmic scaling for smooth LOD transitions
    // d=1-10: cellSize=0-5 (individual members)
    // d=10-30: cellSize=5-15 (small clusters, 2-5 members)
    // d=30-100: cellSize=15-40 (medium clusters, 5-20 members)
    // d=100+: cellSize=40+ (large clusters, 20+ members)

    if (cameraDistance < 10) return 0; // No aggregation, too close
    if (cameraDistance < 30) return 5 + (cameraDistance - 10) * 0.5;
    if (cameraDistance < 100) return 15 + (cameraDistance - 30) * 0.35;
    return 40 + (cameraDistance - 100) * 0.2;
  }

  /**
   * Get grid cell key for a position
   * @param {Object} pos - {x, y, z} position
   * @param {number} cellSize - Size of grid cells
   * @returns {string} Cell key
   */
  getCellKey(pos, cellSize) {
    const cx = Math.floor(pos.x / cellSize);
    const cy = Math.floor(pos.y / cellSize);
    const cz = Math.floor(pos.z / cellSize);
    return `${cx},${cy},${cz}`;
  }

  /**
   * Get all member IDs in a specific aggregate
   * @param {string} cellKey - Grid cell key
   * @returns {Array} Array of member IDs
   */
  getMembersInAggregate(cellKey) {
    const agg = this.aggregates.get(cellKey);
    return agg ? agg.members.map(m => m.id) : [];
  }

  /**
   * Find which aggregate contains a specific member
   * @param {string} memberId - Member ID
   * @returns {string|null} Cell key or null
   */
  getAggregateForMember(memberId) {
    return this.memberToCell.get(memberId) || null;
  }
}
