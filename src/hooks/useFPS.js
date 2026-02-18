import { useRef, useEffect, useState } from 'react';

/**
 * Hook to monitor FPS in real-time
 * @param {number} sampleSize - Number of frames to average over (default 60)
 * @returns {number} Current FPS (updated every sampleSize frames)
 */
export function useFPS(sampleSize = 60) {
  const [fps, setFPS] = useState(60);
  const frameTimesRef = useRef([]);
  const lastFrameRef = useRef(performance.now());

  useEffect(() => {
    let rafId;

    function measure() {
      const now = performance.now();
      const delta = now - lastFrameRef.current;
      lastFrameRef.current = now;

      // Record frame time
      frameTimesRef.current.push(delta);
      if (frameTimesRef.current.length > sampleSize) {
        frameTimesRef.current.shift();
      }

      // Update FPS when we have enough samples
      if (frameTimesRef.current.length === sampleSize) {
        const avg = frameTimesRef.current.reduce((a, b) => a + b, 0) / sampleSize;
        setFPS(Math.round(1000 / avg));
      }

      rafId = requestAnimationFrame(measure);
    }

    rafId = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(rafId);
  }, [sampleSize]);

  return fps;
}
