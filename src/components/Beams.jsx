import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { useUniverseStore } from '../stores/universeStore';

const seenKey = (a, b) => (a < b ? a + '-' + b : b + '-' + a);

export function Beams() {
  const members = useUniverseStore((s) => s.members);
  const comments = useUniverseStore((s) => s.comments);
  const selectedId = useUniverseStore((s) => s.selectedMember);
  const version = useUniverseStore((s) => s.version);

  const lines = useMemo(() => {
    const seen = {};
    const out = [];
    comments.forEach((c) => {
      const a = c.fromMember, b = c.toMember;
      const k = seenKey(a, b);
      if (seen[k]) return;
      seen[k] = 1;
      const fm = members.get(a), tm = members.get(b);
      if (!fm?.position || !tm?.position) return;
      out.push({
        key: k,
        from: [fm.position.x, fm.position.y, fm.position.z],
        to: [tm.position.x, tm.position.y, tm.position.z],
        selected: a === selectedId || b === selectedId,
      });
    });
    return out;
  }, [members, comments, selectedId, version]);

  return (
    <group>
      {lines.map(({ key, from, to, selected }) => (
        <Line
          key={key}
          points={[from, to]}
          color="#27C5CE"
          lineWidth={selected ? 1.5 : 0.5}
          opacity={selected ? 0.35 : 0.06}
          transparent
        />
      ))}
    </group>
  );
}
