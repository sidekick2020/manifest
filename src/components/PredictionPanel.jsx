import { usePredictionStore } from '../stores/predictionStore';
import { useUniverseStore } from '../stores/universeStore';

const RISK_COLORS = { high: '#FF5038', watch: '#FFC83C', low: '#3CDC78', unknown: 'rgba(255,255,255,0.15)' };

export function PredictionPanel() {
  const showPanel = usePredictionStore((s) => s.showPanel);
  const predictions = usePredictionStore((s) => s.predictions);
  const summary = usePredictionStore((s) => s.summary);
  const showHalos = usePredictionStore((s) => s.showHalos);
  const showDriftVectors = usePredictionStore((s) => s.showDriftVectors);
  const showRelapseRings = usePredictionStore((s) => s.showRelapseRings);
  const togglePanel = usePredictionStore((s) => s.togglePanel);
  const toggleHalos = usePredictionStore((s) => s.toggleHalos);
  const toggleDriftVectors = usePredictionStore((s) => s.toggleDriftVectors);
  const toggleRelapseRings = usePredictionStore((s) => s.toggleRelapseRings);
  const recompute = usePredictionStore((s) => s.recompute);
  const trainFromSDC = usePredictionStore((s) => s.trainFromSDC);
  const resetPredictions = usePredictionStore((s) => s.resetPredictions);
  const trainedOnSDC = usePredictionStore((s) => s.trainedOnSDC);
  const trainingStatus = usePredictionStore((s) => s.trainingStatus);

  const setSelectedMember = useUniverseStore((s) => s.setSelectedMember);
  const members = useUniverseStore((s) => s.members);
  const sdcCount = useUniverseStore((s) => s.soberDateChanges).size;

  if (!showPanel) return null;

  const toggle = (label, value, onClick) => (
    <button type="button" onClick={onClick} style={{
      padding: '4px 10px', borderRadius: 12, cursor: 'pointer', fontSize: 9,
      border: `1px solid ${value ? 'rgba(255,80,56,0.3)' : 'rgba(255,255,255,0.08)'}`,
      color: value ? '#FF5038' : 'rgba(255,255,255,0.3)',
      background: value ? 'rgba(255,80,56,0.08)' : 'transparent',
      fontFamily: 'inherit',
    }}>
      {value ? '●' : '○'} {label}
    </button>
  );

  // Build sorted high-risk list
  const highRiskList = [];
  if (predictions) {
    predictions.forEach((p, mid) => {
      if (p.riskLevel === 'high' || p.riskLevel === 'watch') {
        const m = members.get(mid);
        highRiskList.push({ mid, username: m?.username || mid.slice(0, 8), risk: p.risk, stability: p.stability, riskLevel: p.riskLevel });
      }
    });
    highRiskList.sort((a, b) => b.risk - a.risk);
  }

  return (
    <div style={{
      position: 'fixed', top: 20, left: 240, zIndex: 15, width: 300,
      maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
      background: 'rgba(7,6,14,0.94)', backdropFilter: 'blur(30px)',
      border: '1px solid rgba(255,80,56,0.12)', borderRadius: 12, padding: 16,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{
          fontSize: 10, fontWeight: 300, letterSpacing: '0.2em', textTransform: 'uppercase',
          color: '#FF5038',
        }}>
          Predictions
        </span>
        <button type="button" onClick={togglePanel} style={{
          background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 12,
        }}>×</button>
      </div>

      {/* Summary */}
      {summary && (
        <div style={{ marginBottom: 14, padding: 10, background: 'rgba(255,80,56,0.04)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Avg Risk</div>
              <div style={{ fontFamily: 'monospace', fontSize: 18, color: '#FF5038', fontWeight: 300 }}>
                {summary.avgRisk.toFixed(2)}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Avg Stability</div>
              <div style={{ fontFamily: 'monospace', fontSize: 18, color: '#3CDC78', fontWeight: 300 }}>
                {summary.avgStability.toFixed(2)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 9, color: 'rgba(255,255,255,0.2)', flexWrap: 'wrap' }}>
            <span style={{ color: RISK_COLORS.high }}>● {summary.highRiskCount} high</span>
            <span style={{ color: RISK_COLORS.watch }}>● {summary.watchCount} watch</span>
            <span style={{ color: RISK_COLORS.low }}>● {summary.lowCount} low</span>
            {summary.unknownCount > 0 && <span style={{ color: RISK_COLORS.unknown }}>● {summary.unknownCount} new</span>}
          </div>
          {/* Specificity / FPR — only show when we have labeled outcomes */}
          {(summary.tp + summary.fp + summary.fn + summary.tn) > 0 && (
            <div style={{ display: 'flex', gap: 12, marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
              <div>
                <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Specificity</div>
                <div style={{
                  fontFamily: 'monospace', fontSize: 14, fontWeight: 300,
                  color: summary.specificity >= 0.8 ? '#3CDC78' : summary.specificity >= 0.5 ? '#FFC83C' : '#FF5038',
                }}>
                  {summary.specificity.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>FPR</div>
                <div style={{
                  fontFamily: 'monospace', fontSize: 14, fontWeight: 300,
                  color: summary.fpr <= 0.2 ? '#3CDC78' : summary.fpr <= 0.5 ? '#FFC83C' : '#FF5038',
                }}>
                  {summary.fpr.toFixed(2)}
                </div>
              </div>
              <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.15)', alignSelf: 'center', lineHeight: 1.3 }}>
                TP {summary.tp} · FP {summary.fp}<br/>FN {summary.fn} · TN {summary.tn}
                {summary.disengagedCount > 0 && <><br/><span style={{ color: 'rgba(255,200,60,0.4)' }}>{summary.disengagedCount} disengaged</span></>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Model info */}
      {summary && (
        <div style={{ marginBottom: 12, padding: 8, background: 'rgba(177,144,255,0.04)', borderRadius: 6, fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span>Model</span>
            <span style={{ color: summary.modelType?.includes('learned') ? '#B190FF' : 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
              {trainingStatus === 'training' ? 'training...' : summary.modelType || 'heuristic'}
            </span>
          </div>
          {trainedOnSDC > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Trained on</span>
              <span style={{ color: '#B190FF', fontFamily: 'monospace' }}>{trainedOnSDC} SDC records</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span>SDC loaded</span>
            <span style={{ color: sdcCount > 0 ? '#FF5038' : 'rgba(255,255,255,0.15)', fontFamily: 'monospace' }}>{sdcCount}</span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" onClick={recompute} style={{
          padding: '6px 14px', borderRadius: 16, cursor: 'pointer', fontSize: 10,
          letterSpacing: '0.04em', border: '1px solid rgba(255,80,56,0.3)',
          color: '#FF5038', background: 'rgba(255,80,56,0.08)', fontFamily: 'inherit',
        }}>
          Recompute
        </button>
        <button type="button" onClick={trainFromSDC} disabled={sdcCount < 3} style={{
          padding: '6px 14px', borderRadius: 16, cursor: sdcCount < 3 ? 'not-allowed' : 'pointer', fontSize: 10,
          letterSpacing: '0.04em', border: '1px solid rgba(177,144,255,0.3)',
          color: sdcCount < 3 ? 'rgba(177,144,255,0.25)' : '#B190FF',
          background: 'rgba(177,144,255,0.08)', fontFamily: 'inherit',
          opacity: sdcCount < 3 ? 0.5 : 1,
        }}>
          Train Model
        </button>
      </div>

      {/* Toggles */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {toggle('Halos', showHalos, toggleHalos)}
        {toggle('Drift vectors', showDriftVectors, toggleDriftVectors)}
        {toggle('Relapse rings', showRelapseRings, toggleRelapseRings)}
      </div>

      {/* High-risk list */}
      {highRiskList.length > 0 && (
        <div style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.15)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            At Risk Members
          </div>
          {highRiskList.slice(0, 15).map(({ mid, username, risk, riskLevel }) => (
            <div
              key={mid}
              onClick={() => setSelectedMember(mid)}
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, cursor: 'pointer', padding: '3px 6px', borderRadius: 6, transition: 'background 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>
                {username}
              </span>
              <span style={{
                fontFamily: 'monospace', fontSize: 9,
                color: RISK_COLORS[riskLevel],
              }}>
                {risk.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Reset */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <button type="button" onClick={resetPredictions} style={{
          padding: '5px 12px', borderRadius: 12, cursor: 'pointer', fontSize: 9,
          border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.25)',
          background: 'transparent', fontFamily: 'inherit',
        }}>
          Reset Predictions
        </button>
      </div>
    </div>
  );
}
