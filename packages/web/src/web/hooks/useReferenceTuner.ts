/**
 * useReferenceTuner.ts
 * 기준음 재생 + 실측 cents 비교 훅
 *
 * 기준음: Salamander Grand Piano 실제 샘플 기반
 * - https://tonejs.github.io/audio/salamander/
 * - 29개 기준 노트(A/C/D#/F# × 옥타브) — 나머지는 playbackRate로 피치시프트
 * - RAILSBACK 스트레치 튜닝 cents 반영 → playbackRate에 포함
 * - 샘플 lazy 캐시 (AudioContext 기준)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { unlockAudio } from "@/lib/tuner/sharedAudio";
import { PIANO_KEYS, usePitchDetector, type PitchResult } from "@/hooks/usePitchDetector";
import { useTargetedStrobe } from "@/hooks/useTargetedStrobe";
import { RAILSBACK } from "@/lib/tuner/tuningCurveData";

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

// ── Salamander 샘플 노트 정의 ───────────────────────────────────────────
// midi 번호 → 샘플 파일명 매핑
// Salamander: A0~A7, C1~C7, D#1~D#7, F#1~F#7
const SAMPLE_BASE = "https://tonejs.github.io/audio/salamander/";

// 샘플로 존재하는 미디 번호 목록
const SAMPLE_MIDIS: { midi: number; name: string }[] = [
  { midi: 21, name: "A0" },
  { midi: 24, name: "C1" },  { midi: 27, name: "Ds1" }, { midi: 30, name: "Fs1" },
  { midi: 33, name: "A1" },
  { midi: 36, name: "C2" },  { midi: 39, name: "Ds2" }, { midi: 42, name: "Fs2" },
  { midi: 45, name: "A2" },
  { midi: 48, name: "C3" },  { midi: 51, name: "Ds3" }, { midi: 54, name: "Fs3" },
  { midi: 57, name: "A3" },
  { midi: 60, name: "C4" },  { midi: 63, name: "Ds4" }, { midi: 66, name: "Fs4" },
  { midi: 69, name: "A4" },
  { midi: 72, name: "C5" },  { midi: 75, name: "Ds5" }, { midi: 78, name: "Fs5" },
  { midi: 81, name: "A5" },
  { midi: 84, name: "C6" },  { midi: 87, name: "Ds6" }, { midi: 90, name: "Fs6" },
  { midi: 93, name: "A6" },
  { midi: 96, name: "C7" },  { midi: 99, name: "Ds7" }, { midi: 102, name: "Fs7" },
  { midi: 105, name: "A7" },
];

// 건반 midi에서 가장 가까운 샘플 찾기
function findNearestSample(midi: number): { midi: number; name: string } {
  let best = SAMPLE_MIDIS[0];
  let minDist = Math.abs(midi - SAMPLE_MIDIS[0].midi);
  for (const s of SAMPLE_MIDIS) {
    const d = Math.abs(midi - s.midi);
    if (d < minDist) { minDist = d; best = s; }
  }
  return best;
}

// ── 샘플 캐시 (모듈 레벨 — AudioContext 재사용) ─────────────────────────
const bufferCache = new Map<string, AudioBuffer>();
const loadingPromises = new Map<string, Promise<AudioBuffer>>();

async function loadSample(ctx: AudioContext, sampleName: string): Promise<AudioBuffer> {
  if (bufferCache.has(sampleName)) return bufferCache.get(sampleName)!;
  if (loadingPromises.has(sampleName)) return loadingPromises.get(sampleName)!;

  const promise = (async () => {
    const url = `${SAMPLE_BASE}${sampleName}.mp3`;
    const resp = await fetch(url);
    const arrayBuf = await resp.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    bufferCache.set(sampleName, audioBuf);
    loadingPromises.delete(sampleName);
    return audioBuf;
  })();

  loadingPromises.set(sampleName, promise);
  return promise;
}

// ── 재생 중 노드 관리 ────────────────────────────────────────────────────
interface ActiveNodes {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  ctx: AudioContext;
}

export function useReferenceTuner(
  targetKeyIndex: number,
  onConfirmed?: (result: ReferenceResult) => void,
  fftSize: 4096 | 8192 = 4096,
): UseReferenceTunerReturn {
  const targetKey = PIANO_KEYS[targetKeyIndex];
  // 스트레치 반영 기준 주파수
  const railsbackCents = RAILSBACK[targetKeyIndex] ?? 0;
  const etFreqPure = targetKey?.freq ?? 440;                                      // ET 순정 (cents 계산 기준)
  const etFreq = etFreqPure * Math.pow(2, railsbackCents / 1200);                 // 스트레치 반영 (재생용)

  // ── 기준음 상태 ──────────────────────────────────────────────────
  const [isPlayingRef, setIsPlayingRef] = useState(false);
  const [refVolume, setRefVolumeState] = useState(0.7);
  const isPlayingRefRef = useRef(false);
  const refVolumeRef = useRef(0.7);
  const activeNodesRef = useRef<ActiveNodes | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 정지 ─────────────────────────────────────────────────────────
  const stopRef = useCallback(() => {
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }

    const nodes = activeNodesRef.current;
    if (nodes) {
      try {
        const { gainNode, source, ctx } = nodes;
        const now = ctx.currentTime;
        const release = 0.4;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(0, now + release);
        releaseTimerRef.current = setTimeout(() => {
          try { source.stop(); } catch { /* 무시 */ }
          activeNodesRef.current = null;
        }, release * 1000 + 50);
      } catch {
        try { activeNodesRef.current?.source.stop(); } catch { /* 무시 */ }
        activeNodesRef.current = null;
      }
    }

    setIsPlayingRef(false);
    isPlayingRefRef.current = false;
  }, []);

  // ── 재생 (Salamander 샘플 기반) ────────────────────────────────────
  const startRef = useCallback(async (midi: number, railsCents: number, vol: number) => {
    // 기존 즉시 중단
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }
    if (activeNodesRef.current) {
      try { activeNodesRef.current.source.stop(); } catch { /* 무시 */ }
      activeNodesRef.current = null;
    }

    try {
      const ctx = await unlockAudio();

      // 가장 가까운 샘플 로드
      const sample = findNearestSample(midi);
      const buffer = await loadSample(ctx, sample.name);

      // 피치시프트 비율:
      // 목표 midi - 샘플 midi = 반음 차이 → 2^(semitones/12)
      // 거기에 스트레치 cents 추가 → 2^(railsCents/1200)
      const semitoneDiff = midi - sample.midi;
      const playbackRate = Math.pow(2, semitoneDiff / 12) * Math.pow(2, railsCents / 1200);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = playbackRate;
      // 샘플 루프: sustain 구간 (샘플 후반부 루프로 자연스럽게 유지)
      // Salamander은 긴 샘플이므로 루프 안 해도 충분히 김 — 루프 없음

      const gainNode = ctx.createGain();
      const now = ctx.currentTime;
      const attack = 0.008;
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(vol, now + attack);
      gainNode.connect(ctx.destination);
      source.connect(gainNode);
      source.start(now);

      activeNodesRef.current = { source, gainNode, ctx };
      setIsPlayingRef(true);
      isPlayingRefRef.current = true;

      // 샘플 끝나면 자동 정리
      source.onended = () => {
        if (activeNodesRef.current?.source === source) {
          activeNodesRef.current = null;
          setIsPlayingRef(false);
          isPlayingRefRef.current = false;
        }
      };

    } catch (e) {
      console.warn("ref audio (sampler) failed:", e);
    }
  }, []);

  const toggleReference = useCallback(async () => {
    if (isPlayingRefRef.current) {
      stopRef();
    } else {
      const midi = targetKey?.midi ?? 69;
      await startRef(midi, railsbackCents, refVolumeRef.current);
    }
  }, [targetKey, railsbackCents, startRef, stopRef]);

  const setRefVolume = useCallback((v: number) => {
    refVolumeRef.current = v;
    setRefVolumeState(v);
    const nodes = activeNodesRef.current;
    if (nodes && isPlayingRefRef.current) {
      const now = nodes.ctx.currentTime;
      nodes.gainNode.gain.cancelScheduledValues(now);
      nodes.gainNode.gain.setValueAtTime(v, now);
    }
  }, []);

  // 건반 변경 시 재생 중이면 새 건반 샘플로 자동 전환
  useEffect(() => {
    if (isPlayingRefRef.current && targetKey) {
      startRef(targetKey.midi, railsbackCents, refVolumeRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKeyIndex]);

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      try { activeNodesRef.current?.source.stop(); } catch { /* 무시 */ }
    };
  }, []);

  // ── 마이크 감지 ───────────────────────────────────────────────────
  const [result, setResult] = useState<ReferenceResult | null>(null);
  const latestResultRef = useRef<ReferenceResult | null>(null);

  const handlePitch = useCallback((p: PitchResult) => {
    if (p.confidence < 0.5) return;
    const centsFromET = 1200 * Math.log2(p.frequency / etFreqPure);  // ET 순정 기준
    if (Math.abs(centsFromET) > 50) return;
    const r: ReferenceResult = {
      frequency: p.frequency,
      cents: centsFromET,
      keyIndex: targetKeyIndex,
      confidence: p.confidence,
    };
    setResult(r);
    latestResultRef.current = r;
  }, [etFreqPure, targetKeyIndex]);

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
