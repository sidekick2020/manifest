import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { seedToFloat } from '../../lib/codec.js';
import { useUniverseStore } from '../stores/universeStore';

export function Planets() {
  const members = useUniverseStore((s) => s.members);
  const posts = useUniverseStore((s) => s.posts);
  const version = useUniverseStore((s) => s.version);
  const groupRef = useRef();

  useFrame((state) => {
    if (!groupRef.current) return;
    const time = state.clock.elapsedTime;
    groupRef.current.children.forEach((mesh) => {
      const { postId, creatorId, commentCount } = mesh.userData;
      const creator = members.get(creatorId);
      if (!creator?.position) return;
      const s = 'post:' + postId;
      const r = 1.2 + (commentCount || 0) * 0.15;
      const spd = 0.12 + seedToFloat(s + '_spd') * 0.3;
      const ph = seedToFloat(s + '_ph') * Math.PI * 2;
      const tilt = seedToFloat(s + '_tlt') * Math.PI * 0.35;
      const ang = time * spd + ph;
      mesh.position.x = creator.position.x + r * Math.cos(ang) * Math.cos(tilt);
      mesh.position.y = creator.position.y + r * Math.sin(ang);
      mesh.position.z = creator.position.z + r * Math.cos(ang) * Math.sin(tilt);
    });
  });

  const entries = [];
  posts.forEach((post, pid) => {
    const creator = members.get(post.creator);
    if (!creator?.position) return;
    entries.push({
      key: pid,
      postId: pid,
      creatorId: post.creator,
      commentCount: post.commentCount || 0,
    });
  });

  return (
    <group ref={groupRef}>
      {entries.map(({ key, postId, creatorId, commentCount }) => (
        <mesh
          key={key}
          userData={{ postId, creatorId, commentCount }}
          position={[0, 0, 0]}
        >
          <sphereGeometry args={[0.08 + commentCount * 0.03, 8, 6]} />
          <meshBasicMaterial color="#9B59B6" transparent opacity={0.35} />
        </mesh>
      ))}
    </group>
  );
}
