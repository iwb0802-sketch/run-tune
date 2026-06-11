/**
 * useStablePitch.ts
 * 스트로브용 안정 피치 감지
 *
 * 전략:
 * 1. 건반을 치면 RMS가 급격히 올라감 (어택)
 * 2. 피크 이후 RMS가 서서히 내려오는 구간 = 소리 안정 구간
 * 3. 안정 구간에서 일정 시간(1초) 동안 센트값 수집
 * 4. 수집된 값의 중앙값 → 스트로브 기준값으로 제공
 */

import { useCallback, useRef, useState } from "react";

export interface StablePitchResult {
  cents: number;
  frequency: number;
  keyIndex: number;
  noteName: string;
  octave: number;
}

export function useStablePitch(stableDurationMs: number = 1200) {
  const [stableCents, setStableCents] = useState<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  // 안정 구간 수집 버퍼
  const stableBufferRef = useRef<number[]>([]);
  const peakRmsRef = useRef<number>(0);
  const captureStartRef = useRef<number | null>(null);
  const lastResultRef = useRef<StablePitchResult | null>(null);

  const STABLE_DURATION_MS = stableDurationMs;  // 안정 구간 수집 시간 (사용자 조정 가능)
  const PEAK_RATIO = 0.6;           // 피크 대비 이 비율 이하로 내려오면 안정 구간 시작
  const MIN_STABLE_SAMPLES = 15;    // 최소 샘플 수

  const processPitch = useCallback((
    cents: number,
    frequency: number,
    keyIndex: number,
    noteName: string,
    octave: number,
    rms: number
  ) => {
    // 피크 RMS 갱신
    if (rms > peakRmsRef.current) {
      peakRmsRef.current = rms;
      // 새 피크 감지 시 버퍼 초기화 (새 건반 시작)
      stableBufferRef.current = [];
      captureStartRef.current = null;
      setIsCapturing(false);
    }

    // 안정 구간 판단: 피크의 60% 이하로 내려왔을 때
    const isStableZone = rms < peakRmsRef.current * PEAK_RATIO && peakRmsRef.current > 0.02;

    if (isStableZone) {
      if (captureStartRef.current === null) {
        captureStartRef.current = Date.now();
        setIsCapturing(true);
      }

      stableBufferRef.current.push(cents);

      // 수집 시간이 지나면 중앙값 계산
      const elapsed = Date.now() - captureStartRef.current;
      if (elapsed >= STABLE_DURATION_MS && stableBufferRef.current.length >= MIN_STABLE_SAMPLES) {
        const sorted = [...stableBufferRef.current].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianCents = sorted.length % 2 !== 0
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;

        const rounded = Math.round(medianCents * 10) / 10;
        setStableCents(rounded);
        setIsCapturing(false);

        lastResultRef.current = { cents: rounded, frequency, keyIndex, noteName, octave };

        // 다음 건반을 위해 리셋
        stableBufferRef.current = [];
        captureStartRef.current = null;
        peakRmsRef.current = 0;
      }
    }
  }, []);

  const reset = useCallback(() => {
    stableBufferRef.current = [];
    captureStartRef.current = null;
    peakRmsRef.current = 0;
    setIsCapturing(false);
    // stableCents는 유지 (마지막 값 표시)
  }, []);

  return { stableCents, isCapturing, processPitch, reset, lastResult: lastResultRef.current };
}
