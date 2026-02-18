/**
 * Error lines — connect each star's predicted position to its graph-optimal position.
 * Color-coded by error magnitude: green (<5), yellow (5-15), red (>15).
 */
import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { useTrainingStore } from '../stores/trainingStore';
import { useUniverseStore } from '../stores/universeStore';

export function ErrorLines() {
  const showErrorLines = useTrainingStore((s) => s.showErrorLines);
  const currentError = useTrainingStore((s) => s.currentError);
  const members = useUniverseStore((s) => s.members);
  const version = useUniverseStore((s) => s.version);

  const lines = useMemo(() => {
    if (!showErrorLines || !currentError?.perMember) return [];
    const out = [];
    currentError.perMember.forEach(({ predicted, optimal, error }, id) => {
      const member = members.get(id);
      if (!member?.position) return;
      // Use actual animated position (not predicted target)
      const from = [member.position.x, member.position.y, member.position.z];
      const to = [optimal.x, optimal.y, optimal.z];
      const color = error < 5 ? '#27C5CE' : error < 15 ? '#FFD580' : '#FF8C42';
      out.push({ id, from, to, color, error });
    });
    return out;
  }, [showErrorLines, currentError, members, version]);

  if (lines.length === 0) return null;

  return (
    <group>
      {lines.map(({ id, from, to, color, error }) => (
        <Line
          key={id}
          points={[from, to]}
          color={color}
          lineWidth={error > 15 ? 1.5 : 0.8}
          opacity={0.3}
          transparent
          dashed
          dashSize={0.5}
          gapSize={0.3}
        />
      ))}
    </group>
  );
}
