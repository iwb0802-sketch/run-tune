/**
 * useCompositeTuner.ts
 * 4중 복합 판단 엔진: YIN → HPS → Goertzel → 스트로브
 *
 * 흐름:
 * 1. YIN → 건반 후보 추정
 * 2. HPS → 옥타브 보정 (keyIndex < 60만)
 * 3. Goertzel → 보정된 건반 기준 위상 추적 → live cent
 * 4. YIN cent vs Goertzel cent 교차검증 (±8¢ 이내)
 * 5. 스트로브 → stableDurationMs 안정 시 최종 확정
 *
 * 건반 지정 없이 자동 인식, 수동 모드 수준 정밀도.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PIANO_KEYS, freqToCentOffset } from "./usePitchDetector";
import {
  applyHannWindow,
  detectPitchYIN,
  correctOctaveByHPS,
  getRMS,
  median,
  goertzel,
  targetPartial,
  selectBestPartial,
} from "@/lib/tuner/pitchEngine";

export interface CompositeResult {
  keyIndex: number;
  noteName: string;
  octave: number;
  frequency: number;
  // 각 엔진 출력
  yinCents: number;
  goertzelCents: number;
  liveCents: number;       // 두 엔진 평균
  finalCents: number | null; // 스트로브 확정값
  // 신뢰도
  confidence: number;      // YIN 윈도우 confidence
  crossValid: boolean;     // YIN ↔ Goertzel ±8¢ 일치 여부
  signalOk: boolean;
  isCapturing: boolean;
  captureProgress: number;
}

export interface UseCompositeTunerReturn {
  isListening: boolean;
  result: CompositeResult | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: string | null;
  stream: MediaStream | null;
  audioContext: AudioContext | null;
}

const WINDOW = 15;
const MIN_MATCH = 8;
const CROSS_VALID_THRESHOLD = 8;   // ¢
const STABLE_DURATION_MS = 900;
const MIN_SAMPLES = 8;
const MIN_RMS = 0.004;
const PEAK_RATIO = 0.55;
const DOMINANCE_RATIO = 1.3;

export function useCompositeTuner(
  onConfirmed?: (result: CompositeResult) => void,
  fftSize: 4096 | 8192 = 4096
): UseCompositeTunerReturn {
  const [isListening, setIsListening] = useState(false);
  const [result, setResult] = useState<CompositeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const specRef = useRef<Float32Array | null>(null);
  const isRunningRef = useRef(false);

  // YIN 안정화 윈도우
  const recentKeys = useRef<number[]>([]);
  const recentCents = useRef<number[]>([]);

  // 스트로브 캡처
  const peakRmsRef = useRef(0);
  const captureStartRef = useRef<number | null>(null);
  const captureBufferRef = useRef<number[]>([]);
  const lastConfirmedKeyRef = useRef<number | null>(null);

  const stopListening = useCallback(() => {
    isRunningRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    bufRef.current = null;
    specRef.current = null;
    recentKeys.current = [];
    recentCents.current = [];
    peakRmsRef.current = 0;
    captureStartRef.current = null;
    captureBufferRef.current = [];
    lastConfirmedKeyRef.current = null;
    setIsListening(false);
    setResult(null);
  }, []);

  const startListening = useCallback(async () => {
    try {
      setError(null);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false, sampleRate: 44100 },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
        });
      }
      streamRef.current = stream;

      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 44100 });
      ctxRef.current = ctx;
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* ignore */ } }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0;
      analyserRef.current = analyser;

      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);

      bufRef.current = new Float32Array(analyser.fftSize);
      specRef.current = new Float32Array(analyser.frequencyBinCount);
      isRunningRef.current = true;
      setIsListening(true);

      const detect = () => {
        if (!isRunningRef.current) return;
        const ctx = ctxRef.current;
        const analyser = analyserRef.current;
        const buf = bufRef.current;
        const spec = specRef.current;
        if (!ctx || !analyser || !buf || !spec) return;

        if (ctx.state === "suspended") { ctx.resume().catch(() => {}); }

        analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
        const rms = getRMS(buf);

        if (rms < MIN_RMS) {
          recentKeys.current = [];
          recentCents.current = [];
          setResult(null);
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        // ── 1. YIN ──────────────────────────────────────────────────
        const winBuf = applyHannWindow(buf);
        const fYin = detectPitchYIN(winBuf, ctx.sampleRate, 26, 5000, 0.12);

        if (fYin <= 0) {
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        // ── 2. HPS 옥타브 보정 ──────────────────────────────────────
        analyser.getFloatFrequencyData(spec as Float32Array<ArrayBuffer>);
        const tempKi = freqToCentOffset(fYin)?.keyIndex ?? 0;
        const fCorrected = correctOctaveByHPS(fYin, spec, ctx.sampleRate, analyser.fftSize, 5, tempKi);

        const rYin = freqToCentOffset(fCorrected);
        if (!rYin) {
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        // YIN 안정화 윈도우
        recentKeys.current.push(rYin.keyIndex);
        recentCents.current.push(rYin.cents);
        if (recentKeys.current.length > WINDOW) {
          recentKeys.current.shift();
          recentCents.current.shift();
        }

        const counts: Record<number, number> = {};
        recentKeys.current.forEach(k => { counts[k] = (counts[k] || 0) + 1; });
        const [topKey, topCount] = Object.entries(counts)
          .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
        const stableKi = parseInt(topKey);
        const confidence = Number(topCount) / WINDOW;

        if (confidence < 0.55) {
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        const yinCentsArr = recentKeys.current
          .map((k, i) => k === stableKi ? recentCents.current[i] : null)
          .filter((v): v is number => v !== null);
        const yinCents = Math.round(median(yinCentsArr) * 10) / 10;

        // ── 3. Goertzel 위상 추적 ────────────────────────────────────
        const baseFreq = PIANO_KEYS[stableKi].freq;
        const sr = ctx.sampleRate;

        // 저음은 동적 배음 선택, 나머지는 1배음
        const partial = stableKi <= 26
          ? selectBestPartial(buf, sr, stableKi, baseFreq)
          : targetPartial(stableKi);

        const targetFreq = baseFreq * partial;

        // 도미넌스 체크: 타겟 주파수가 주변보다 강한지
        const gTarget = goertzel(buf, sr, targetFreq);
        const magLo = goertzel(buf, sr, targetFreq * Math.pow(2, -1.5 / 12)).magnitude;
        const magHi = goertzel(buf, sr, targetFreq * Math.pow(2, 1.5 / 12)).magnitude;
        const signalOk = gTarget.magnitude > Math.max(magLo, magHi, 1e-9) * DOMINANCE_RATIO;

        // Goertzel cent: 측정 주파수 → 기본음 환산 → 절대 cent
        // coarse scan ±50¢, 3¢ 스텝
        let bestFreq = targetFreq;
        let bestMag = -1;
        for (let i = -17; i <= 17; i++) {
          const f = targetFreq * Math.pow(2, (i * 3) / 1200);
          const mag = goertzel(buf, sr, f).magnitude;
          if (mag > bestMag) { bestMag = mag; bestFreq = f; }
        }
        const measuredBaseHz = bestFreq / partial;
        const goertzelCents = Math.round(1200 * Math.log2(measuredBaseHz / baseFreq) * 10) / 10;

        // ── 4. 교차검증 ─────────────────────────────────────────────
        const crossValid = signalOk && Math.abs(yinCents - goertzelCents) <= CROSS_VALID_THRESHOLD;
        const liveCents = crossValid
          ? Math.round(((yinCents + goertzelCents) / 2) * 10) / 10
          : yinCents;

        // ── 5. 스트로브 안정화 ───────────────────────────────────────
        // 건반 바뀌거나 RMS 급상승 시 리셋
        if (stableKi !== lastConfirmedKeyRef.current) {
          captureStartRef.current = null;
          captureBufferRef.current = [];
          peakRmsRef.current = 0;
          lastConfirmedKeyRef.current = stableKi;
        }

        if (rms > peakRmsRef.current * 1.5 && rms > 0.02) {
          peakRmsRef.current = rms;
          captureStartRef.current = null;
          captureBufferRef.current = [];
        } else if (rms > peakRmsRef.current) {
          peakRmsRef.current = rms;
        }

        const isStable = rms < peakRmsRef.current * PEAK_RATIO && peakRmsRef.current > 0.015;

        let finalCents: number | null = null;
        let isCapturing = false;
        let captureProgress = 0;

        if (isStable && crossValid) {
          if (captureStartRef.current === null) {
            captureStartRef.current = Date.now();
          }
          captureBufferRef.current.push(liveCents);
          const elapsed = Date.now() - captureStartRef.current;
          isCapturing = true;
          captureProgress = Math.min(elapsed / STABLE_DURATION_MS, 1);

          if (elapsed >= STABLE_DURATION_MS && captureBufferRef.current.length >= MIN_SAMPLES) {
            finalCents = Math.round(median(captureBufferRef.current) * 10) / 10;
            captureStartRef.current = null;
            captureBufferRef.current = [];
            peakRmsRef.current = 0;
          }
        } else {
          captureStartRef.current = null;
          captureBufferRef.current = [];
        }

        const newResult: CompositeResult = {
          keyIndex: stableKi,
          noteName: PIANO_KEYS[stableKi].noteName,
          octave: PIANO_KEYS[stableKi].octave,
          frequency: measuredBaseHz,
          yinCents,
          goertzelCents,
          liveCents,
          finalCents,
          confidence,
          crossValid,
          signalOk,
          isCapturing,
          captureProgress,
        };

        setResult(newResult);
        if (finalCents !== null) {
          onConfirmed?.(newResult);
        }

        rafRef.current = requestAnimationFrame(detect);
      };

      rafRef.current = requestAnimationFrame(detect);
    } catch (err) {
      let msg = "마이크 접근 실패";
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          msg = "마이크 권한이 거부되었습니다.";
        } else if (err.name === "NotFoundError") {
          msg = "마이크를 찾을 수 없습니다.";
        } else if (err.name === "NotReadableError") {
          msg = "마이크를 사용할 수 없습니다.";
        } else {
          msg = err.message;
        }
      }
      setError(msg);
      setIsListening(false);
    }
  }, [onConfirmed, fftSize]);

  // visibility 복구
  useEffect(() => {
    const handler = async () => {
      if (document.visibilityState !== "visible") return;
      if (!isRunningRef.current) return;
      const ctx = ctxRef.current;
      if (!ctx || ctx.state === "closed") {
        isRunningRef.current = false;
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        ctxRef.current = null;
        analyserRef.current = null;
        bufRef.current = null;
        specRef.current = null;
        recentKeys.current = [];
        recentCents.current = [];
        setResult(null);
        try { await startListening(); } catch { /* ignore */ }
      } else if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch { /* ignore */ }
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [startListening]);

  useEffect(() => () => { stopListening(); }, [stopListening]);

  return {
    isListening,
    result,
    startListening,
    stopListening,
    error,
    stream: streamRef.current,
    audioContext: ctxRef.current,
  };
}
