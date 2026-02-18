import { useRef, useEffect } from 'react';
import { useUniverseStore } from '../stores/universeStore';
import { useTrainingStore } from '../stores/trainingStore';

export function FitnessGraph() {
  const fitnessData = useUniverseStore((s) => s.fitnessHistory);
  const errorHistory = useTrainingStore((s) => s.errorHistory);
  const trainingActive = useTrainingStore((s) => s.active);
  const canvasRef = useRef(null);
  const w = 200, h = 55;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // Draw fitness curve
    if (fitnessData.length >= 2) {
      let min = Infinity, max = -Infinity;
      for (const d of fitnessData) { if (d < min) min = d; if (d > max) max = d; }
      min *= 0.95; max *= 1.02;
      const range = max - min || 1;
      ctx.beginPath();
      ctx.strokeStyle = '#27C5CE';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < fitnessData.length; i++) {
        const x = (i / (fitnessData.length - 1)) * w;
        const y = h - ((fitnessData[i] - min) / range) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = 'rgba(39,197,206,0.04)';
      ctx.fill();
      ctx.fillStyle = '#27C5CE'; ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText(fitnessData[fitnessData.length - 1].toFixed(3), w - 3, 10);
    }

    // Draw error curve overlay (if training active)
    if (trainingActive && errorHistory.length >= 2) {
      let min = Infinity, max = -Infinity;
      for (const e of errorHistory) { if (e.meanError < min) min = e.meanError; if (e.meanError > max) max = e.meanError; }
      min *= 0.9; max *= 1.1;
      const range = max - min || 1;
      ctx.beginPath();
      ctx.strokeStyle = '#B190FF';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      for (let i = 0; i < errorHistory.length; i++) {
        const x = (i / (errorHistory.length - 1)) * w;
        const y = h - ((errorHistory[i].meanError - min) / range) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#B190FF'; ctx.font = '8px monospace'; ctx.textAlign = 'left';
      ctx.fillText('err:' + errorHistory[errorHistory.length - 1].meanError.toFixed(1), 3, 10);
    }
  }, [fitnessData, errorHistory, trainingActive]);

  return (
    <div style={{ position: 'fixed', bottom: 80, right: 20, zIndex: 10, width: 200 }}>
      <h2 style={{ fontSize: 8, fontWeight: 300, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.12)', marginBottom: 3 }}>
        Fitness {trainingActive && '/ Error'}
      </h2>
      <canvas ref={canvasRef} width={w} height={h} style={{ display: 'block' }} />
    </div>
  );
}
