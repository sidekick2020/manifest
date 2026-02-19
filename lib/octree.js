/**
 * Octree spatial index for efficient 3D queries.
 * Enables frustum culling and radius searches in O(log n) time.
 */

import { vec3 } from './vec3.js';

export class Octree {
  /**
   * @param {Object} bounds - {min: vec3, max: vec3}
   * @param {number} capacity - Max items per node before subdivision
   * @param {number} maxDepth - Maximum tree depth
   * @param {number} depth - Current depth (internal)
   */
  constructor(bounds, capacity = 8, maxDepth = 8, depth = 0) {
    this.bounds = bounds;
    this.capacity = capacity;
    this.maxDepth = maxDepth;
    this.depth = depth;
    this.members = []; // {id, position}
    this.subdivided = false;
    this.children = null;
  }

  /**
   * Insert a member into the octree
   */
  insert(memberId, position) {
    // Check if point is in bounds
    if (!this.contains(position)) {
      return false;
    }

    // If space available, add to this node
    if (this.members.length < this.capacity || this.depth >= this.maxDepth) {
      this.members.push({ id: memberId, position });
      return true;
    }

    // Subdivide if needed
    if (!this.subdivided) {
      this.subdivide();
    }

    // Insert into appropriate child
    for (const child of this.children) {
      if (child.insert(memberId, position)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if point is within bounds
   */
  contains(point) {
    return (
      point.x >= this.bounds.min.x &&
      point.x <= this.bounds.max.x &&
      point.y >= this.bounds.min.y &&
      point.y <= this.bounds.max.y &&
      point.z >= this.bounds.min.z &&
      point.z <= this.bounds.max.z
    );
  }

  /**
   * Subdivide node into 8 octants
   */
  subdivide() {
    const { min, max } = this.bounds;
    const mid = vec3(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2
    );

    this.children = [
      // Bottom four octants (z < mid.z)
      new Octree({ min: vec3(min.x, min.y, min.z), max: vec3(mid.x, mid.y, mid.z) }, this.capacity, this.maxDepth, this.depth + 1),
      new Octree({ min: vec3(mid.x, min.y, min.z), max: vec3(max.x, mid.y, mid.z) }, this.capacity, this.maxDepth, this.depth + 1),
      new Octree({ min: vec3(min.x, mid.y, min.z), max: vec3(mid.x, max.y, mid.z) }, this.capacity, this.maxDepth, this.depth + 1),
      new Octree({ min: vec3(mid.x, mid.y, min.z), max: vec3(max.x, max.y, mid.z) }, this.capacity, this.maxDepth, this.depth + 1),
      // Top four octants (z >= mid.z)
      new Octree({ min: vec3(min.x, min.y, mid.z), max: vec3(mid.x, mid.y, max.z) }, this.capacity, this.maxDepth, this.depth + 1),
      new Octree({ min: vec3(mid.x, min.y, mid.z), max: vec3(max.x, mid.y, max.z) }, this.capacity, this.maxDepth, this.depth + 1),
      new Octree({ min: vec3(min.x, mid.y, mid.z), max: vec3(mid.x, max.y, max.z) }, this.capacity, this.maxDepth, this.depth + 1),
      new Octree({ min: vec3(mid.x, mid.y, mid.z), max: vec3(max.x, max.y, max.z) }, this.capacity, this.maxDepth, this.depth + 1),
    ];

    // Redistribute existing members to children
    for (const member of this.members) {
      for (const child of this.children) {
        if (child.insert(member.id, member.position)) {
          break;
        }
      }
    }

    this.members = []; // Clear parent node
    this.subdivided = true;
  }

  /**
   * Query members within a bounding box
   * @param {Object} bounds - {min: vec3, max: vec3}
   * @returns {Array} - Array of {id, position}
   */
  query(bounds, result) {
    if (!result) result = [];

    // No overlap, skip this node
    if (!this.intersects(bounds)) {
      return result;
    }

    // Check members in this node
    for (const member of this.members) {
      if (this.pointInBounds(member.position, bounds)) {
        result.push(member);
      }
    }

    // Recursively check children (push directly to collector — no intermediate arrays)
    if (this.subdivided) {
      for (const child of this.children) {
        child.query(bounds, result);
      }
    }

    return result;
  }

  /**
   * Query members within radius of a center point
   * @param {vec3} center
   * @param {number} radius
   * @returns {Array} - Array of {id, position}
   */
  queryRadius(center, radius, result) {
    if (!result) result = [];

    // Create bounding box for radius
    const bounds = {
      min: vec3(center.x - radius, center.y - radius, center.z - radius),
      max: vec3(center.x + radius, center.y + radius, center.z + radius),
    };

    // No overlap, skip this node
    if (!this.intersects(bounds)) {
      return result;
    }

    // Check members in this node
    const radiusSq = radius * radius;
    for (const member of this.members) {
      const dx = member.position.x - center.x;
      const dy = member.position.y - center.y;
      const dz = member.position.z - center.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= radiusSq) {
        result.push(member);
      }
    }

    // Recursively check children (push directly to collector — no intermediate arrays)
    if (this.subdivided) {
      for (const child of this.children) {
        child.queryRadius(center, radius, result);
      }
    }

    return result;
  }

  /**
   * Check if this node's bounds intersect with query bounds
   */
  intersects(bounds) {
    return !(
      bounds.max.x < this.bounds.min.x ||
      bounds.min.x > this.bounds.max.x ||
      bounds.max.y < this.bounds.min.y ||
      bounds.min.y > this.bounds.max.y ||
      bounds.max.z < this.bounds.min.z ||
      bounds.min.z > this.bounds.max.z
    );
  }

  /**
   * Check if point is within bounds
   */
  pointInBounds(point, bounds) {
    return (
      point.x >= bounds.min.x &&
      point.x <= bounds.max.x &&
      point.y >= bounds.min.y &&
      point.y <= bounds.max.y &&
      point.z >= bounds.min.z &&
      point.z <= bounds.max.z
    );
  }

  /**
   * Clear all members from tree
   */
  clear() {
    this.members = [];
    this.subdivided = false;
    this.children = null;
  }

  /**
   * Rebuild tree from scratch
   */
  rebuild(memberArray) {
    this.clear();
    for (const { id, position } of memberArray) {
      this.insert(id, position);
    }
  }

  /**
   * Get tree statistics (for debugging)
   */
  getStats() {
    let nodeCount = 1;
    let leafCount = this.subdivided ? 0 : 1;
    let memberCount = this.members.length;
    let maxDepthReached = this.depth;

    if (this.subdivided) {
      for (const child of this.children) {
        const childStats = child.getStats();
        nodeCount += childStats.nodeCount;
        leafCount += childStats.leafCount;
        memberCount += childStats.memberCount;
        maxDepthReached = Math.max(maxDepthReached, childStats.maxDepth);
      }
    }

    return {
      nodeCount,
      leafCount,
      memberCount,
      maxDepth: maxDepthReached,
    };
  }

  /**
   * Get all members recursively (for aggregate creation)
   */
  getAllMembers(result) {
    if (!result) result = [];
    for (let i = 0; i < this.members.length; i++) {
      result.push(this.members[i]);
    }
    if (this.subdivided) {
      for (const child of this.children) {
        child.getAllMembers(result);
      }
    }
    return result;
  }

  /**
   * Create aggregate representation of this node
   */
  createAggregate() {
    const members = this.getAllMembers();
    if (members.length === 0) return null;

    const centroid = { x: 0, y: 0, z: 0 };
    let totalMass = 0;

    members.forEach(m => {
      centroid.x += m.position.x;
      centroid.y += m.position.y;
      centroid.z += m.position.z;
      totalMass += m.mass || 1;
    });

    centroid.x /= members.length;
    centroid.y /= members.length;
    centroid.z /= members.length;

    return {
      type: 'aggregate',
      count: members.length,
      position: centroid,
      mass: totalMass,
      memberIds: members.map(m => m.id),
    };
  }

  /**
   * Query frustum at specific LOD level
   * @param {Object} frustum - {min, max} bounds
   * @param {number} cellSize - Target cell size for aggregation (0 = individual members)
   * @returns {Array} - Aggregates or individual members
   */
  queryFrustumLOD(frustum, cellSize) {
    if (cellSize === 0) return this.query(frustum); // Individual mode

    const result = [];
    this._aggregateQuery(frustum, cellSize, result);
    return result;
  }

  /**
   * Distance-aware frustum query: each octree node picks its own LOD based
   * on distance from cameraPos, using getCellSizeFn(distance) to decide
   * whether to aggregate or descend. Nodes closer to the camera resolve at
   * finer detail; distant nodes aggregate aggressively.
   *
   * @param {Object} frustum — {min, max} bounds
   * @param {Object} cameraPos — {x, y, z}
   * @param {Function} getCellSizeFn — (distance) => cellSize
   * @returns {Array} mixed individual / aggregate items
   */
  queryFrustumDistanceLOD(frustum, cameraPos, getCellSizeFn) {
    const result = [];
    this._distanceLODQuery(frustum, cameraPos, getCellSizeFn, result);
    return result;
  }

  /** @private */
  _distanceLODQuery(frustum, camPos, getCellSizeFn, result) {
    if (!this.intersects(frustum)) return;

    const nodeSize = this.bounds.max.x - this.bounds.min.x;

    // Compute distance from camera to node center
    const cx = (this.bounds.min.x + this.bounds.max.x) / 2;
    const cy = (this.bounds.min.y + this.bounds.max.y) / 2;
    const cz = (this.bounds.min.z + this.bounds.max.z) / 2;
    const dx = cx - camPos.x, dy = cy - camPos.y, dz = cz - camPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const targetSize = getCellSizeFn(dist);

    // Individual mode for this node
    if (targetSize === 0) {
      // Return individual members from this node and all descendants
      const all = this.getAllMembers();
      for (const m of all) {
        if (this.pointInBounds(m.position, frustum)) result.push(m);
      }
      return;
    }

    // Node matches target size: aggregate
    if (nodeSize <= targetSize * 1.5 && nodeSize >= targetSize * 0.4) {
      const agg = this.createAggregate();
      if (agg) result.push(agg);
      return;
    }

    // Node is too large — descend into children
    if (this.subdivided) {
      for (const child of this.children) {
        child._distanceLODQuery(frustum, camPos, getCellSizeFn, result);
      }
    } else if (nodeSize > targetSize) {
      const agg = this.createAggregate();
      if (agg) result.push(agg);
    } else {
      this.members.forEach(m => {
        if (this.pointInBounds(m.position, frustum)) result.push(m);
      });
    }
  }

  /**
   * Internal recursive aggregate query
   */
  _aggregateQuery(frustum, targetSize, result) {
    if (!this.intersects(frustum)) return;

    const nodeSize = this.bounds.max.x - this.bounds.min.x;

    // If this node size matches target (±50%), create aggregate
    if (Math.abs(nodeSize - targetSize) < targetSize * 0.5) {
      const agg = this.createAggregate();
      if (agg) result.push(agg);
      return;
    }

    // If subdivided, recurse to children
    if (this.subdivided) {
      for (const child of this.children) {
        child._aggregateQuery(frustum, targetSize, result);
      }
    } else if (nodeSize > targetSize) {
      // Leaf is larger than target: create aggregate from members
      const agg = this.createAggregate();
      if (agg) result.push(agg);
    } else {
      // Leaf is smaller than target: return individual members
      this.members.forEach(m => {
        if (this.pointInBounds(m.position, frustum)) result.push(m);
      });
    }
  }
}

/**
 * Create frustum bounds from camera parameters.
 * Uses FOV-based AABB with safety margin for rotation.
 */
export function getFrustumBounds(camera, screenDimensions) {
  const { width, height } = screenDimensions;
  const aspect = width && height ? width / height : 1;
  const fovY = Math.PI / 3; // 60-degree vertical FOV (matches Scene.jsx projection)

  // Compute half-extents from FOV and camera distance
  const halfH = camera.d * Math.tan(fovY / 2);
  const halfW = halfH * aspect;

  // Diagonal extent with 1.3x margin for camera rotation safety
  const radius = Math.sqrt(halfW * halfW + halfH * halfH) * 1.3;

  // Ensure minimum radius so close-up views don't cull too aggressively
  const safeRadius = Math.max(radius, 20);

  return {
    min: vec3(
      camera.focus.x - safeRadius,
      camera.focus.y - safeRadius,
      camera.focus.z - safeRadius
    ),
    max: vec3(
      camera.focus.x + safeRadius,
      camera.focus.y + safeRadius,
      camera.focus.z + safeRadius
    ),
  };
}
