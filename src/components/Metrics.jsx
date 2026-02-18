import { useUniverseStore } from '../stores/universeStore';
import { useTrainingStore } from '../stores/trainingStore';
import { usePredictionStore } from '../stores/predictionStore';

export function Metrics() {
  const members = useUniverseStore((s) => s.members);
  const posts = useUniverseStore((s) => s.posts);
  const comments = useUniverseStore((s) => s.comments);
  const soberDateChanges = useUniverseStore((s) => s.soberDateChanges);
  const beamCount = useUniverseStore((s) => s.beamCount);
  const epochDate = useUniverseStore((s) => s.epochDate);
  const sessionCount = useUniverseStore((s) => s.sessionCount);
  const temperature = useUniverseStore((s) => s.temperature);
  const fitnessHistory = useUniverseStore((s) => s.fitnessHistory);
  const hashAccuracy = useUniverseStore((s) => s.hashAccuracy);
  const version = useUniverseStore((s) => s.version);

  const trainingActive = useTrainingStore((s) => s.active);
  const currentError = useTrainingStore((s) => s.currentError);

  const predictionActive = usePredictionStore((s) => s.active);
  const predSummary = usePredictionStore((s) => s.summary);
  const trainedOnSDC = usePredictionStore((s) => s.trainedOnSDC);
  const trainingStatus = usePredictionStore((s) => s.trainingStatus);

  const epochStr = epochDate ? epochDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const tempStr = temperature != null ? temperature.toFixed(3) : '1.000';
  const fitness = fitnessHistory.length > 0 ? fitnessHistory[fitnessHistory.length - 1] : null;
  const fitnessStr = fitness != null ? fitness.toFixed(3) : '—';
  const accStr = hashAccuracy != null ? hashAccuracy + '%' : '—';
  const accColor = hashAccuracy >= 90 ? '#27C5CE' : hashAccuracy >= 70 ? '#FFD580' : '#FF8C42';

  const row = (label, value, color) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', minWidth: 85 }}>{label}</span>
      <span style={{ fontFamily: 'monospace', fontSize: 10, color: color || '#67B3FD' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ position: 'fixed', top: 20, left: 20, zIndex: 10 }}>
      <h1 style={{
        fontSize: 12, fontWeight: 200, letterSpacing: '0.35em', textTransform: 'uppercase',
        background: 'linear-gradient(135deg, #67B3FD, #B190FF)',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: 10,
      }}>
        Manifest
      </h1>
      {row('Members', members.size)}
      {row('Posts', posts.size)}
      {row('Comments', comments.size)}
      {row('Connections', beamCount)}
      {row('Resets (SDC)', soberDateChanges.size, soberDateChanges.size > 0 ? '#FF5038' : 'rgba(255,255,255,0.15)')}
      <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.04)' }} />
      {row('Epoch', epochStr, 'rgba(255,255,255,0.15)')}
      {row('Session', sessionCount, 'rgba(255,255,255,0.15)')}
      {row('Temperature', tempStr, 'rgba(255,255,255,0.15)')}
      {row('Fitness', fitnessStr, 'rgba(255,255,255,0.15)')}
      {row('Hash accuracy', accStr, accColor)}
      {trainingActive && currentError && (
        <>
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.04)' }} />
          {row('Mean error', currentError.meanError.toFixed(2), '#B190FF')}
          {row('R²', currentError.r2.toFixed(3), currentError.r2 > 0.5 ? '#27C5CE' : '#FF8C42')}
        </>
      )}
      {predictionActive && predSummary && (
        <>
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.04)' }} />
          {row('Model', trainingStatus === 'training' ? 'training...' : predSummary.modelType || 'heuristic', trainingStatus === 'training' ? '#FFC83C' : predSummary.modelType?.includes('learned') ? '#B190FF' : 'rgba(255,255,255,0.15)')}
          {trainedOnSDC > 0 && row('Trained on', trainedOnSDC + ' SDC', '#B190FF')}
          {row('Avg risk', predSummary.avgRisk.toFixed(2), predSummary.avgRisk > 0.6 ? '#FF5038' : predSummary.avgRisk > 0.3 ? '#FFC83C' : '#3CDC78')}
          {row('Avg stability', predSummary.avgStability.toFixed(2), '#3CDC78')}
          {row('At risk', predSummary.highRiskCount, '#FF5038')}
          {row('Specificity', predSummary.specificity != null ? predSummary.specificity.toFixed(2) : '—', predSummary.specificity >= 0.8 ? '#3CDC78' : predSummary.specificity >= 0.5 ? '#FFC83C' : '#FF5038')}
          {row('FPR', predSummary.fpr != null ? predSummary.fpr.toFixed(2) : '—', predSummary.fpr <= 0.2 ? '#3CDC78' : predSummary.fpr <= 0.5 ? '#FFC83C' : '#FF5038')}
        </>
      )}
    </div>
  );
}
