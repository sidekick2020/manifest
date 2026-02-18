import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useUniverseStore } from '../stores/universeStore';

function Star({ memberId, member, target, selected, onSelect }) {
  const meshRef = useRef();
  const pos = member.position || target || { x: 0, y: 0, z: 0 };

  useFrame(() => {
    if (!meshRef.current || !target) return;
    const m = meshRef.current;
    m.position.x = member.position?.x ?? target.x;
    m.position.y = member.position?.y ?? target.y;
    m.position.z = member.position?.z ?? target.z;
  });

  if (!target) return null;

  const mass = member.mass ?? 1;
  const radius = 0.3 + mass * 0.08;
  const intensity = Math.min(1, mass / 6);
  const hue = 0.1 + intensity * 0.04;
  const color = new THREE.Color().setHSL(hue, 0.85, selected ? 0.8 : 0.55 + intensity * 0.25);

  return (
    <mesh
      ref={meshRef}
      position={[pos.x, pos.y, pos.z]}
      userData={{ memberId }}
      onClick={(e) => { e.stopPropagation(); onSelect(memberId); }}
      onPointerMissed={(e) => e.button === 0 && onSelect(null)}
    >
      <sphereGeometry args={[radius, 16, 12]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={selected ? 0.95 : 0.85}
      />
    </mesh>
  );
}

export function Stars() {
  const members = useUniverseStore((s) => s.members);
  const targetPos = useUniverseStore((s) => s.targetPos);
  const selectedId = useUniverseStore((s) => s.selectedMember);
  const setSelectedMember = useUniverseStore((s) => s.setSelectedMember);
  const version = useUniverseStore((s) => s.version);

  return (
    <group>
      {Array.from(members.entries()).map(([id, member]) => (
        <Star
          key={id}
          memberId={id}
          member={member}
          target={targetPos.get(id)}
          selected={id === selectedId}
          onSelect={setSelectedMember}
        />
      ))}
    </group>
  );
}
