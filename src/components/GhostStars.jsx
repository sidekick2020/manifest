/**
 * Ghost stars — semi-transparent wireframe spheres at graph-optimal positions.
 * Shows where the force-directed layout says members "should" be.
 */
import * as THREE from 'three';
import { useTrainingStore } from '../stores/trainingStore';
import { useUniverseStore } from '../stores/universeStore';

export function GhostStars() {
  const optimalPositions = useTrainingStore((s) => s.optimalPositions);
  const showGhosts = useTrainingStore((s) => s.showGhosts);
  const members = useUniverseStore((s) => s.members);
  const version = useUniverseStore((s) => s.version);

  if (!showGhosts || !optimalPositions || optimalPositions.size === 0) return null;

  const ghosts = [];
  optimalPositions.forEach((pos, id) => {
    const member = members.get(id);
    if (!member) return;
    const mass = member.mass ?? 1;
    const radius = (2.5 + mass * 0.5) * 0.15;
    ghosts.push({ id, pos, radius });
  });

  return (
    <group>
      {ghosts.map(({ id, pos, radius }) => (
        <mesh key={id} position={[pos.x, pos.y, pos.z]}>
          <sphereGeometry args={[radius, 12, 8]} />
          <meshBasicMaterial
            color="#B190FF"
            transparent
            opacity={0.15}
            wireframe
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
