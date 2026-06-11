/**
 * useReferenceTuner.ts
 * 기준음 재생 + 실측 cents 비교 훅
 *
 * - 각 건반의 ET 주파수를 오실레이터로 재생 (볼륨 조절 가능)
 * - 마이크로 실측 주파수 감지 → ET 대비 cents 계산
 * - targetKeyIndex 변경 시 재생 중이면 자동으로 새 주파수로 전환
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { unlockAudio } from "@/lib/tuner/sharedAudio";
import { PIANO_KEYS, usePitchDetector, type PitchResult } from "@/hooks/usePitchDetector";
import { useTargetedStrobe } from "@/hooks/useTargetedStrobe";

export interface ReferenceResult {
  frequency: number;
  cents: number;        // ET 대비 cents 오차
  keyIndex: number;
  confidence: number;
}

export interface UseReferenceTunerReturn {
  // 기준음
  isPlayingRef: boolean;
  refVolume: number;                          // 0~1
  toggleReference: () => Promise<void>;
  setRefVolume: (v: number) => void;

  // 마이크
  isListening: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: string | null;

  // 실측 결과
  result: ReferenceResult | null;
  stableCents: number | null;                 // 저음 안정값 (useTargetedStrobe)
}

export function useReferenceTuner(
  targetKeyIndex: number,
  onConfirmed?: (result: ReferenceResult) => void,
  fftSize: 4096 | 8192 = 4096,
): UseReferenceTunerReturn {
  const targetKey = PIANO_KEYS[targetKeyIndex];
  const etFreq = targetKey?.freq ?? 440;

  // ── 기준음 오실레이터 ─────────────────────────────────────────────
  const [isPlayingRef, setIsPlayingRef] = useState(false);
  const [refVolume, setRefVolumeState] = useState(0.25);
  const oscRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const isPlayingRefRef = useRef(false);
  const refVolumeRef = useRef(0.25);

  const stopRef = useCallback(() => {
    if (oscRef.current) {
      try {
        const ctx = oscRef.current.context;
        const now = ctx.currentTime;
        gainRef.current?.gain.setValueAtTime(gainRef.current.gain.value, now);
        gainRef.current?.gain.linearRampToValueAtTime(0, now + 0.04);
        setTimeout(() => { try { oscRef.current?.stop(); } catch { /* 무시 */ } oscRef.current = null; gainRef.current = null; }, 50);
      } catch { oscRef.current = null; gainRef.current = null; }
    }
    setIsPlayingRef(false);
    isPlayingRefRef.current = false;
  }, []);

  const startRef = useCallback(async (freq: number, vol: number) => {
    stopRef();
    try {
      const ctx = await unlockAudio();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(vol, now + 0.02);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      oscRef.current = osc;
      gainRef.current = gain;
      setIsPlayingRef(true);
      isPlayingRefRef.current = true;
    } catch (e) {
      console.warn("ref audio failed:", e);
    }
  }, [stopRef]);

  const toggleReference = useCallback(async () => {
    if (isPlayingRefRef.current) {
      stopRef();
    } else {
      await startRef(etFreq, refVolumeRef.current);
    }
  }, [etFreq, startRef, stopRef]);

  const setRefVolume = useCallback((v: number) => {
    refVolumeRef.current = v;
    setRefVolumeState(v);
    if (gainRef.current) {
      const ctx = gainRef.current.context;
      gainRef.current.gain.setValueAtTime(v, ctx.currentTime);
    }
  }, []);

  // targetKeyIndex 변경 시 재생 중이면 새 주파수로 자동 전환
  useEffect(() => {
    if (isPlayingRefRef.current) {
      // 부드럽게 주파수 변경
      if (oscRef.current) {
        try {
          oscRef.current.frequency.setValueAtTime(etFreq, oscRef.current.context.currentTime);
        } catch {
          startRef(etFreq, refVolumeRef.current);
        }
      }
    }
  }, [etFreq, startRef]);

  // 언마운트 시 정리
  useEffect(() => {
    return () => { stopRef(); };
  }, [stopRef]);

  // ── 마이크 감지 ───────────────────────────────────────────────────
  const [result, setResult] = useState<ReferenceResult | null>(null);
  const latestResultRef = useRef<ReferenceResult | null>(null);

  const handlePitch = useCallback((p: PitchResult) => {
    if (p.confidence < 0.5) return;

    // ET 대비 cents 계산: 실측 주파수 vs 타겟 ET 주파수
    const centsFromET = 1200 * Math.log2(p.frequency / etFreq);

    // ±50¢ 이내만 유효 (옥타브 오류 필터)
    if (Math.abs(centsFromET) > 50) return;

    const r: ReferenceResult = {
      frequency: p.frequency,
      cents: centsFromET,
      keyIndex: targetKeyIndex,
      confidence: p.confidence,
    };
    setResult(r);
    latestResultRef.current = r;
  }, [etFreq, targetKeyIndex]);

  const { isListening, startListening, stopListening, error, stream, audioContext } =
    usePitchDetector(handlePitch, fftSize);

  // 건반 변경 시 결과 초기화
  useEffect(() => {
    setResult(null);
    latestResultRef.current = null;
  }, [targetKeyIndex]);

  // ── 저음 안정값 (Goertzel 배음 분석) ────────────────────────────
  const { strobeCents: stableCents } = useTargetedStrobe(
    isListening ? stream : null,
    isListening ? audioContext : null,
    targetKeyIndex,
    { stableDurationMs: 800, fftSize },
  );

  return {
    isPlayingRef,
    refVolume,
    toggleReference,
    setRefVolume,
    isListening,
    startListening,
    stopListening,
    error,
    result,
    stableCents: targetKeyIndex <= 26 ? (stableCents ?? null) : null,
  };
}
