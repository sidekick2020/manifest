import { useUniverseStore } from '../stores/universeStore';
import { useTrainingStore } from '../stores/trainingStore';
import { usePredictionStore } from '../stores/predictionStore';
import { useFPS } from '../hooks/useFPS';

const btn = {
  padding: '8px 18px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 11, letterSpacing: '0.06em', transition: 'all .25s', whiteSpace: 'nowrap', border: 'none',
};

export function HUD() {
  const status = useUniverseStore((s) => s.status);
  const running = useUniverseStore((s) => s.running);
  const toggleRunning = useUniverseStore((s) => s.toggleRunning);
  const feedStep = useUniverseStore((s) => s.feedStep);
  const reset = useUniverseStore((s) => s.reset);
  const members = useUniverseStore((s) => s.members);
  const performanceMode = useUniverseStore((s) => s.performanceMode);

  const fps = useFPS();

  const trainingActive = useTrainingStore((s) => s.active);
  const toggleTraining = useTrainingStore((s) => s.toggleActive);
  const togglePanel = useTrainingStore((s) => s.togglePanel);

  const predictionActive = usePredictionStore((s) => s.active);
  const togglePredictions = usePredictionStore((s) => s.toggleActive);
  const togglePredPanel = usePredictionStore((s) => s.togglePanel);

  const handleReset = () => {
    if (running) toggleRunning();
    reset();
  };

  const fpsColor = fps < 30 ? '#FF5555' : fps < 50 ? '#FFAA55' : '#55FF55';

  return (
    <>
      {/* FPS & Stats Display */}
      <div style={{
        position: 'fixed', top: 14, left: 14, zIndex: 10,
        fontFamily: 'monospace', fontSize: 11,
        background: 'rgba(7,6,14,0.88)', backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '8px 12px',
        color: '#fff',
      }}>
        <div style={{ marginBottom: 4 }}>
          FPS: <span style={{ color: fpsColor, fontWeight: 'bold' }}>{fps}</span>
        </div>
        <div style={{ marginBottom: 4 }}>
          Members: <span style={{ color: '#67B3FD' }}>{members.size.toLocaleString()}</span>
        </div>
        {performanceMode && (
          <div style={{ color: '#FFAA55', marginTop: 6, fontSize: 10 }}>
            ⚡ Performance Mode
          </div>
        )}
      </div>

      {/* Main Controls */}
      <div style={{
        position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 14,
        background: 'rgba(7,6,14,0.88)', backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.06)', borderRadius: 40, padding: '10px 22px',
      }}>
      <button
        type="button"
        onClick={toggleRunning}
        style={{
          ...btn,
          borderColor: running ? 'rgba(255,140,66,0.3)' : 'rgba(39,197,206,0.3)',
          border: `1px solid ${running ? 'rgba(255,140,66,0.3)' : 'rgba(39,197,206,0.3)'}`,
          color: running ? '#FF8C42' : '#27C5CE',
          background: running ? 'rgba(255,140,66,0.08)' : 'rgba(39,197,206,0.08)',
        }}
      >
        {running ? '■ Pause' : '▶ Feed live'}
      </button>
      <button
        type="button"
        onClick={() => feedStep()}
        style={{
          ...btn,
          background: 'rgba(103,179,253,0.08)',
          border: '1px solid rgba(103,179,253,0.2)',
          color: '#67B3FD',
        }}
      >
        + Step
      </button>
      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.06)' }} />
      <span style={{
        fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.25)',
        maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {status}
      </span>
      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.06)' }} />
      <button
        type="button"
        onClick={trainingActive ? togglePanel : toggleTraining}
        style={{
          ...btn,
          border: `1px solid ${trainingActive ? 'rgba(177,144,255,0.3)' : 'rgba(177,144,255,0.15)'}`,
          color: trainingActive ? '#B190FF' : 'rgba(177,144,255,0.5)',
          background: trainingActive ? 'rgba(177,144,255,0.08)' : 'transparent',
        }}
      >
        {trainingActive ? '◆ Training' : '◇ Train'}
      </button>
      <button
        type="button"
        onClick={predictionActive ? togglePredPanel : togglePredictions}
        style={{
          ...btn,
          border: `1px solid ${predictionActive ? 'rgba(255,80,56,0.3)' : 'rgba(255,80,56,0.15)'}`,
          color: predictionActive ? '#FF5038' : 'rgba(255,80,56,0.5)',
          background: predictionActive ? 'rgba(255,80,56,0.08)' : 'transparent',
        }}
      >
        {predictionActive ? '◆ Predict' : '◇ Predict'}
      </button>
      <button
        type="button"
        onClick={handleReset}
        style={{
          ...btn,
          border: '1px solid rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.3)',
          background: 'transparent',
        }}
      >
        Reset
      </button>
    </div>
    </>
  );
}
