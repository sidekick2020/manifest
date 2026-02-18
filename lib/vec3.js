/**
 * 3D vector helpers for Manifest spatial codec.
 */

export function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function v3lerp(a, b, t) {
  return vec3(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t
  );
}

export function v3dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
