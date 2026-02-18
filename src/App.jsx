import { Scene } from './components/Scene';
import { Metrics } from './components/Metrics';
import { HUD } from './components/HUD';
import { DetailPanel } from './components/DetailPanel';
import { FitnessGraph } from './components/FitnessGraph';
import { TrainingPanel } from './components/TrainingPanel';
import { PredictionPanel } from './components/PredictionPanel';

export default function App() {
  return (
    <>
      <Metrics />
      <HUD />
      <DetailPanel />
      <FitnessGraph />
      <TrainingPanel />
      <PredictionPanel />
      <Scene />
    </>
  );
}
