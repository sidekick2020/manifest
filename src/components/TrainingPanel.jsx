import { useTrainingStore } from '../stores/trainingStore';
import { useUniverseStore } from '../stores/universeStore';
import { DEFAULT_PARAMS } from '../../lib/codec.js';

const PARAM_DEFS = [
  { key: 'cohesionWeight', label: 'Cohesion wt', min: 0, max: 1, step: 0.05 },
  { key: 'stabilityWeight', label: 'Stability wt', min: 0, max: 1, step: 0.05 },
  { key: 'nhRadiusBase', label: 'NH radius', min: 5, max: 80, step: 1 },
  { key: 'nhRadiusScale', label: 'NH scale', min: 1, max: 20, step: 0.5 },
  { key: 'localRadiusBase', label: 'Local radius', min: 1, max: 15, step: 0.5 },
  { key: 'localRadiusScale', label: 'Local scale', min: 0.2, max: 5, step: 0.1 },
  { key: 'gravityFactor', label: 'Gravity', min: 0, max: 1, step: 0.01 },
  { key: 'annealingRate', label: 'Anneal rate', min: 0.3, max: 0.99, step: 0.01 },
  { key: 'cohesionScale', label: 'Cohesion scl', min: 0.01, max: 0.5, step: 0.01 },
  { key: 'stabilityScale', label: 'Stability scl', min: 0.01, max: 0.3, step: 0.005 },
];

export function TrainingPanel() {
  const showPanel = useTrainingStore((s) => s.showPanel);
  const active = useTrainingStore((s) => s.active);
  const togglePanel = useTrainingStore((s) => s.togglePanel);
  const toggleActive = useTrainingStore((s) => s.toggleActive);
  const currentError = useTrainingStore((s) => s.currentError);
  const errorHistory = useTrainingStore((s) => s.errorHistory);
  const codecParams = useTrainingStore((s) => s.codecParams);
  const setParam = useTrainingStore((s) => s.setParam);
  const showGhosts = useTrainingStore((s) => s.showGhosts);
  const showErrorLines = useTrainingStore((s) => s.showErrorLines);
  const toggleGhosts = useTrainingStore((s) => s.toggleGhosts);
  const toggleErrorLines = useTrainingStore((s) => s.toggleErrorLines);
  const trainStep = useTrainingStore((s) => s.trainStep);
  const autoTrain = useTrainingStore((s) => s.autoTrain);
  const toggleAutoTrain = useTrainingStore((s) => s.toggleAutoTrain);
  const runAutoTune = useTrainingStore((s) => s.runAutoTune);
  const computeOptimal = useTrainingStore((s) => s.computeOptimal);
  const resetTraining = useTrainingStore((s) => s.resetTraining);

  const memberCount = useUniverseStore((s) => s.members.size);

  if (!showPanel) return null;

  const btn = (label, onClick, color = '#B190FF', bgAlpha = '0.08') => (
    <button type="button" onClick={onClick} style={{
      padding: '6px 14px', borderRadius: 16, cursor: 'pointer', fontSize: 10,
      letterSpacing: '0.04em', border: `1px solid ${color}33`,
      color, background: `${color}${Math.round(parseFloat(bgAlpha) * 255).toString(16).padStart(2, '0')}`,
      fontFamily: 'inherit',
    }}>
      {label}
    </button>
  );

  const toggle = (label, value, onClick) => (
    <button type="button" onClick={onClick} style={{
      padding: '4px 10px', borderRadius: 12, cursor: 'pointer', fontSize: 9,
      border: `1px solid ${value ? 'rgba(177,144,255,0.3)' : 'rgba(255,255,255,0.08)'}`,
      color: value ? '#B190FF' : 'rgba(255,255,255,0.3)',
      background: value ? 'rgba(177,144,255,0.08)' : 'transparent',
      fontFamily: 'inherit',
    }}>
      {value ? '●' : '○'} {label}
    </button>
  );

  return (
    <div style={{
      position: 'fixed', top: 20, left: 240, zIndex: 15, width: 300,
      maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
      background: 'rgba(7,6,14,0.94)', backdropFilter: 'blur(30px)',
      border: '1px solid rgba(177,144,255,0.12)', borderRadius: 12, padding: 16,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{
          fontSize: 10, fontWeight: 300, letterSpacing: '0.2em', textTransform: 'uppercase',
          color: '#B190FF',
        }}>
          Hash Training
        </span>
        <button type="button" onClick={togglePanel} style={{
          background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 12,
        }}>×</button>
      </div>

      {/* Error metrics */}
      {currentError && (
        <div style={{ marginBottom: 14, padding: 10, background: 'rgba(177,144,255,0.04)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Mean Error</div>
              <div style={{ fontFamily: 'monospace', fontSize: 18, color: '#B190FF', fontWeight: 300 }}>
                {currentError.meanError.toFixed(2)}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>R²</div>
              <div style={{
                fontFamily: 'monospace', fontSize: 18, fontWeight: 300,
                color: currentError.r2 > 0.5 ? '#27C5CE' : currentError.r2 > 0 ? '#FFD580' : '#FF8C42',
              }}>
                {currentError.r2.toFixed(3)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>
            <span>median: {currentError.medianError.toFixed(2)}</span>
            <span>max: {currentError.maxError.toFixed(2)}</span>
            <span>n={memberCount}</span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {btn('Compute Optimal', computeOptimal, '#27C5CE')}
        {btn('Train Step', trainStep)}
        {btn(autoTrain ? '■ Stop' : '▶ Auto-Train', toggleAutoTrain, autoTrain ? '#FF8C42' : '#B190FF')}
        {btn('Auto-Tune', runAutoTune, '#FFD580')}
      </div>

      {/* Toggles */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {toggle('Ghosts', showGhosts, toggleGhosts)}
        {toggle('Error lines', showErrorLines, toggleErrorLines)}
      </div>

      {/* Param sliders */}
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.15)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
        Codec Parameters
      </div>
      {PARAM_DEFS.map(({ key, label, min, max, step }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', minWidth: 80 }}>{label}</span>
          <input
            type="range"
            min={min} max={max} step={step}
            value={codecParams[key]}
            onChange={(e) => setParam(key, parseFloat(e.target.value))}
            style={{ flex: 1, height: 4, accentColor: '#B190FF' }}
          />
          <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#B190FF', minWidth: 35, textAlign: 'right' }}>
            {codecParams[key].toFixed(key.includes('Weight') || key.includes('Scale') || key.includes('Factor') ? 2 : 1)}
          </span>
        </div>
      ))}

      {/* Worst predicted */}
      {currentError?.perMember && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.15)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            Worst Predicted
          </div>
          {Array.from(currentError.perMember.entries())
            .sort(([, a], [, b]) => b.error - a.error)
            .slice(0, 8)
            .map(([id, { error }]) => {
              const m = useUniverseStore.getState().members.get(id);
              return (
                <div key={id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>
                    {m?.username || id.slice(0, 8)}
                  </span>
                  <span style={{
                    fontFamily: 'monospace', fontSize: 9,
                    color: error < 5 ? '#27C5CE' : error < 15 ? '#FFD580' : '#FF8C42',
                  }}>
                    {error.toFixed(2)}
                  </span>
                </div>
              );
            })}
        </div>
      )}

      {/* Reset */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <button type="button" onClick={resetTraining} style={{
          padding: '5px 12px', borderRadius: 12, cursor: 'pointer', fontSize: 9,
          border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.25)',
          background: 'transparent', fontFamily: 'inherit',
        }}>
          Reset Training
        </button>
      </div>
    </div>
  );
}
