/**
 * useReferenceTuner.ts
 * 기준음 재생 + 실측 cents 비교 훅
 *
 * 기준음: 피아노 음색 합성 (배음 오실레이터 + ADSR 엔벨로프)
 * - 저음(0~26): 배음 풍부 + 긴 서스테인 → 저음 스피커에서도 잘 들림
 * - 중음(27~60): 균형잡힌 배음
 * - 고음(61~87): 배음 적게 + 빠른 감쇠
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { unlockAudio } from "@/lib/tuner/sharedAudio";
import { PIANO_KEYS, usePitchDetector, type PitchResult } from "@/hooks/usePitchDetector";
import { useTargetedStrobe } from "@/hooks/useTargetedStrobe";

export interface ReferenceResult {
  frequency: number;
  cents: number;
  keyIndex: number;
  confidence: number;
}

export interface UseReferenceTunerReturn {
  isPlayingRef: boolean;
  refVolume: number;
  toggleReference: () => Promise<void>;
  setRefVolume: (v: number) => void;
  isListening: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: string | null;
  result: ReferenceResult | null;
  stableCents: number | null;
}

// ── 피아노 음색 파라미터 ──────────────────────────────────────────────
interface PianoParams {
  // 배음: [배수, 상대볼륨] 쌍
  partials: [number, number][];
  attack: number;   // s
  decay: number;    // s
  sustain: number;  // 0~1
  release: number;  // s
  duration: number; // 재생 총 길이 s (버튼 켜두는 동안은 sustain 유지)
}

function getPianoParams(keyIndex: number): PianoParams {
  if (keyIndex <= 15) {
    // 초저음 (1~16번) — 배음 매우 풍부, 긴 서스테인
    return {
      partials: [
        [1, 0.5], [2, 1.0], [3, 0.7], [4, 0.5],
        [5, 0.3], [6, 0.2], [7, 0.15], [8, 0.1],
      ],
      attack: 0.008, decay: 0.6, sustain: 0.7, release: 1.2, duration: 6,
    };
  } else if (keyIndex <= 26) {
    // 저음 (17~27번)
    return {
      partials: [
        [1, 0.6], [2, 1.0], [3, 0.6], [4, 0.4],
        [5, 0.25], [6, 0.15], [7, 0.1],
      ],
      attack: 0.007, decay: 0.5, sustain: 0.65, release: 1.0, duration: 5,
    };
  } else if (keyIndex <= 48) {
    // 중저음 (28~49번)
    return {
      partials: [
        [1, 0.8], [2, 0.9], [3, 0.5], [4, 0.3],
        [5, 0.15], [6, 0.08],
      ],
      attack: 0.006, decay: 0.4, sustain: 0.55, release: 0.8, duration: 4,
    };
  } else if (keyIndex <= 60) {
    // 중음 (50~61번)
    return {
      partials: [
        [1, 1.0], [2, 0.6], [3, 0.3], [4, 0.15], [5, 0.07],
      ],
      attack: 0.005, decay: 0.35, sustain: 0.45, release: 0.6, duration: 3.5,
    };
  } else if (keyIndex <= 75) {
    // 고음 (62~76번)
    return {
      partials: [
        [1, 1.0], [2, 0.4], [3, 0.15], [4, 0.06],
      ],
      attack: 0.004, decay: 0.25, sustain: 0.3, release: 0.4, duration: 2.5,
    };
  } else {
    // 최고음 (77~88번)
    return {
      partials: [
        [1, 1.0], [2, 0.2], [3, 0.06],
      ],
      attack: 0.003, decay: 0.18, sustain: 0.2, release: 0.3, duration: 1.8,
    };
  }
}

export function useReferenceTuner(
  targetKeyIndex: number,
  onConfirmed?: (result: ReferenceResult) => void,
  fftSize: 4096 | 8192 = 4096,
): UseReferenceTunerReturn {
  const targetKey = PIANO_KEYS[targetKeyIndex];
  const etFreq = targetKey?.freq ?? 440;

  // ── 기준음 상태 ──────────────────────────────────────────────────
  const [isPlayingRef, setIsPlayingRef] = useState(false);
  const [refVolume, setRefVolumeState] = useState(0.35);
  const isPlayingRefRef = useRef(false);
  const refVolumeRef = useRef(0.35);

  // 현재 재생 중인 노드들
  const activeOscsRef = useRef<OscillatorNode[]>([]);
  const activeGainsRef = useRef<GainNode[]>([]);
  const masterGainRef = useRef<GainNode | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 정지 ─────────────────────────────────────────────────────────
  const stopRef = useCallback(() => {
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }

    if (masterGainRef.current) {
      try {
        const ctx = masterGainRef.current.context;
        const now = ctx.currentTime;
        const params = getPianoParams(targetKeyIndex);
        masterGainRef.current.gain.cancelScheduledValues(now);
        masterGainRef.current.gain.setValueAtTime(masterGainRef.current.gain.value, now);
        masterGainRef.current.gain.linearRampToValueAtTime(0, now + params.release);
        const oscs = [...activeOscsRef.current];
        releaseTimerRef.current = setTimeout(() => {
          oscs.forEach(o => { try { o.stop(); } catch { /* 무시 */ } });
          activeOscsRef.current = [];
          activeGainsRef.current = [];
          masterGainRef.current = null;
        }, params.release * 1000 + 50);
      } catch {
        activeOscsRef.current.forEach(o => { try { o.stop(); } catch { /* 무시 */ } });
        activeOscsRef.current = [];
        activeGainsRef.current = [];
        masterGainRef.current = null;
      }
    }

    setIsPlayingRef(false);
    isPlayingRefRef.current = false;
  }, [targetKeyIndex]);

  // ── 재생 (피아노 음색 합성) ───────────────────────────────────────
  const startRef = useCallback(async (freq: number, vol: number, keyIdx: number) => {
    // 기존 정지
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }
    activeOscsRef.current.forEach(o => { try { o.stop(); } catch { /* 무시 */ } });
    activeOscsRef.current = [];
    activeGainsRef.current = [];
    masterGainRef.current = null;

    try {
      const ctx = await unlockAudio();
      const now = ctx.currentTime;
      const p = getPianoParams(keyIdx);

      // 마스터 게인 (ADSR 엔벨로프)
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, now);
      master.gain.linearRampToValueAtTime(vol, now + p.attack);
      master.gain.linearRampToValueAtTime(vol * p.sustain, now + p.attack + p.decay);
      master.connect(ctx.destination);
      masterGainRef.current = master;

      // 배음 오실레이터들
      const totalWeight = p.partials.reduce((s, [, w]) => s + w, 0);
      p.partials.forEach(([harmonic, weight]) => {
        const hFreq = freq * harmonic;
        if (hFreq > 20000) return; // 가청 범위 초과 무시

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.value = hFreq;

        // 배음별 볼륨 + 고배음일수록 빠르게 감쇠
        const harmGain = weight / totalWeight;
        const harmDecayMul = harmonic <= 2 ? 1.0 : 1.0 / (harmonic * 0.4);
        gain.gain.setValueAtTime(harmGain, now);
        gain.gain.linearRampToValueAtTime(harmGain * harmDecayMul, now + p.attack + p.decay);

        osc.connect(gain);
        gain.connect(master);
        osc.start(now);

        activeOscsRef.current.push(osc);
        activeGainsRef.current.push(gain);
      });

      setIsPlayingRef(true);
      isPlayingRefRef.current = true;

      // sustain 이후 자동 release (버튼 켜둔 동안은 계속 유지)
      // → 버튼으로 끄기 전까지 sustain 레벨 유지 (자동 종료 없음)

    } catch (e) {
      console.warn("ref audio failed:", e);
    }
  }, []);

  const toggleReference = useCallback(async () => {
    if (isPlayingRefRef.current) {
      stopRef();
    } else {
      await startRef(etFreq, refVolumeRef.current, targetKeyIndex);
    }
  }, [etFreq, targetKeyIndex, startRef, stopRef]);

  const setRefVolume = useCallback((v: number) => {
    refVolumeRef.current = v;
    setRefVolumeState(v);
    if (masterGainRef.current && isPlayingRefRef.current) {
      const ctx = masterGainRef.current.context;
      const p = getPianoParams(targetKeyIndex);
      masterGainRef.current.gain.cancelScheduledValues(ctx.currentTime);
      masterGainRef.current.gain.setValueAtTime(v * p.sustain, ctx.currentTime);
    }
  }, [targetKeyIndex]);

  // 건반 변경 시 재생 중이면 새 건반 음색으로 자동 전환
  useEffect(() => {
    if (isPlayingRefRef.current) {
      startRef(etFreq, refVolumeRef.current, targetKeyIndex);
    }
  }, [etFreq, targetKeyIndex, startRef]);

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      activeOscsRef.current.forEach(o => { try { o.stop(); } catch { /* 무시 */ } });
    };
  }, []);

  // ── 마이크 감지 ───────────────────────────────────────────────────
  const [result, setResult] = useState<ReferenceResult | null>(null);
  const latestResultRef = useRef<ReferenceResult | null>(null);

  const handlePitch = useCallback((p: PitchResult) => {
    if (p.confidence < 0.5) return;
    const centsFromET = 1200 * Math.log2(p.frequency / etFreq);
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

  useEffect(() => {
    setResult(null);
    latestResultRef.current = null;
  }, [targetKeyIndex]);

  // ── 저음 안정값 ──────────────────────────────────────────────────
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
