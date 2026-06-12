/**
 * useCompositeTuner.ts
 * 4중 복합 판단 엔진: YIN + Goertzel 교차검증 → 스트로브 안정화
 *
 * v2: 건반 지정 방식 (수동모드와 동일한 시퀀스 구조)
 *  - targetKeyIndex를 외부에서 지정
 *  - 지정 건반 기준으로 YIN cent 계산 + Goertzel 교차검증
 *  - 교차검증 통과 + 900ms 안정 시 finalCents 확정
 *  - targetKeyIndex 변경 시 자동 상태 리셋
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PIANO_KEYS } from "./usePitchDetector";
import {
  applyHannWindow,
  detectPitchYIN,
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
  yinCents: number;
  goertzelCents: number;
  liveCents: number;
  finalCents: number | null;
  crossValid: boolean;
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
}

const CROSS_VALID_THRESHOLD     = 8;    // ¢ 중음
const CROSS_VALID_THRESHOLD_LOW = 15;   // ¢ 저음 ≤26
const CROSS_VALID_THRESHOLD_HIGH = 12;  // ¢ 고음 ≥52 (배음 혼재 감안해 완화)
const STABLE_DURATION_MS        = 900;  // 중음
const STABLE_DURATION_MS_HIGH   = 500;  // 고음 — 빠른 decay
const MIN_SAMPLES               = 8;
const MIN_SAMPLES_HIGH          = 4;    // 고음 — 짧은 sustain
const MIN_RMS                   = 0.004;
const MIN_RMS_LOW               = 0.002;
const MIN_RMS_HIGH              = 0.003;
const PEAK_RATIO                = 0.55; // 중/저음
const PEAK_RATIO_HIGH           = 0.40; // 고음 — 빠른 decay 허용
const PEAK_THRESHOLD            = 0.015;
const PEAK_THRESHOLD_HIGH       = 0.008; // 고음 피크 감도
const DOMINANCE_RATIO           = 1.3;
const COARSE_STEP_LOW           = 1;    // 저음 scan 스텝 (¢)
const COARSE_STEP_MID           = 3;    // 중음 scan 스텝 (¢)
const COARSE_STEP_HIGH          = 2;    // 고음 scan 스텝 (¢)
const SCAN_RANGE_CENTS          = 50;   // 중/저음 ±¢
const SCAN_RANGE_CENTS_HIGH     = 80;   // 고음 ±¢ (넓게)
// 고음 구간 경계
const HIGH_KEY_THRESHOLD        = 52;   // C5 이상 (keyIndex 52+)

// YIN이 잡은 주파수를 targetKeyIndex 기준 절대 cent로 환산
function yinFreqToCents(fYin: number, baseFreq: number): number | null {
  if (fYin <= 0 || baseFreq <= 0) return null;
  // 옥타브 폴딩: fYin이 2배음 이상으로 잡혔을 때 기본음으로 내림
  let f = fYin;
  while (f > baseFreq * 1.5) f /= 2;
  while (f < baseFreq * 0.67) f *= 2;
  return Math.round(1200 * Math.log2(f / baseFreq) * 10) / 10;
}

export function useCompositeTuner(
  targetKeyIndex: number,
  onConfirmed?: (result: CompositeResult) => void,
  fftSize: 4096 | 8192 = 4096
): UseCompositeTunerReturn {
  const [isListening, setIsListening] = useState(false);
  const [result, setResult] = useState<CompositeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef      = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const rafRef      = useRef<number | null>(null);
  const bufRef      = useRef<Float32Array | null>(null);
  const isRunningRef = useRef(false);

  // 캡처 상태
  const peakRmsRef       = useRef(0);
  const captureStartRef  = useRef<number | null>(null);
  const captureBufferRef = useRef<number[]>([]);

  // targetKeyIndex ref (stale closure 방지)
  const targetKeyRef = useRef(targetKeyIndex);
  useEffect(() => { targetKeyRef.current = targetKeyIndex; }, [targetKeyIndex]);

  // 건반 바뀌면 캡처 리셋
  useEffect(() => {
    peakRmsRef.current       = 0;
    captureStartRef.current  = null;
    captureBufferRef.current = [];
    setResult(null);
  }, [targetKeyIndex]);

  const resetCapture = useCallback(() => {
    peakRmsRef.current       = 0;
    captureStartRef.current  = null;
    captureBufferRef.current = [];
  }, []);

  const stopListening = useCallback(() => {
    isRunningRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current   = null;
    analyserRef.current = null;
    bufRef.current      = null;
    resetCapture();
    setIsListening(false);
    setResult(null);
  }, [resetCapture]);

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
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0;
      analyserRef.current = analyser;
      ctx.createMediaStreamSource(stream).connect(analyser);

      bufRef.current = new Float32Array(analyser.fftSize);
      isRunningRef.current = true;
      setIsListening(true);

      const detect = () => {
        if (!isRunningRef.current) return;
        const ctx      = ctxRef.current;
        const analyser = analyserRef.current;
        const buf      = bufRef.current;
        if (!ctx || !analyser || !buf) return;

        if (ctx.state === "suspended") ctx.resume().catch(() => {});

        analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
        const rms = getRMS(buf);

        const ki       = targetKeyRef.current;
        const isLow    = ki <= 26;
        const isHigh   = ki >= HIGH_KEY_THRESHOLD; // C5+
        const rmsMin   = isLow ? MIN_RMS_LOW : isHigh ? MIN_RMS_HIGH : MIN_RMS;

        if (rms < rmsMin) {
          resetCapture();
          setResult(null);
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        const baseFreq = PIANO_KEYS[ki].freq;
        const sr       = ctx.sampleRate;

        // ── 1. YIN → 지정 건반 기준 cent ────────────────────────────
        const winBuf = applyHannWindow(buf);
        // 고음은 fMax 확장(8000), threshold 완화(0.10) → 2배음 혼입 감소
        const yinFmax      = isHigh ? 8000 : 5000;
        const yinThreshold = isHigh ? 0.10 : 0.12;
        const fYin    = detectPitchYIN(winBuf, sr, 26, yinFmax, yinThreshold);
        const yinCents = fYin > 0 ? yinFreqToCents(fYin, baseFreq) : null;

        // ── 2. Goertzel → 배음 기반 cent ─────────────────────────────
        const partial    = isLow
          ? selectBestPartial(buf, sr, ki, baseFreq)
          : targetPartial(ki);
        const targetFreq = baseFreq * partial;

        // 도미넌스 체크 — 고음은 기준 완화 (배음이 많아 dominant 피크 약함)
        const gTarget = goertzel(buf, sr, targetFreq);
        const magLo   = goertzel(buf, sr, targetFreq * Math.pow(2, -1.5 / 12)).magnitude;
        const magHi   = goertzel(buf, sr, targetFreq * Math.pow(2,  1.5 / 12)).magnitude;
        const domRatio = isHigh ? 1.1 : DOMINANCE_RATIO; // 고음: 도미넌스 기준 완화
        const signalOk = gTarget.magnitude > Math.max(magLo, magHi, 1e-9) * domRatio;

        // coarse scan — 고음은 step 2¢, ±80¢ 범위
        const step      = isLow ? COARSE_STEP_LOW : isHigh ? COARSE_STEP_HIGH : COARSE_STEP_MID;
        const scanCents = isHigh ? SCAN_RANGE_CENTS_HIGH : SCAN_RANGE_CENTS;
        const scanRange = Math.round(scanCents / step);
        let bestFreq = targetFreq;
        let bestMag  = -1;
        for (let i = -scanRange; i <= scanRange; i++) {
          const f   = targetFreq * Math.pow(2, (i * step) / 1200);
          const mag = goertzel(buf, sr, f).magnitude;
          if (mag > bestMag) { bestMag = mag; bestFreq = f; }
        }
        const measuredBaseHz  = bestFreq / partial;
        const goertzelCents   = Math.round(1200 * Math.log2(measuredBaseHz / baseFreq) * 10) / 10;

        // ── 3. 교차검증 ──────────────────────────────────────────────
        // 고음: YIN null이어도 Goertzel 단독으로 신뢰 (signalOk만 요구)
        const threshold  = isLow
          ? CROSS_VALID_THRESHOLD_LOW
          : isHigh
            ? CROSS_VALID_THRESHOLD_HIGH
            : CROSS_VALID_THRESHOLD;

        const crossValid = isHigh
          ? (signalOk || yinCents !== null) // 고음: 둘 중 하나만 있으면 통과
          : (signalOk && yinCents !== null && Math.abs(yinCents - goertzelCents) <= threshold);

        const effectiveYin = yinCents ?? goertzelCents;
        // 고음: YIN이 있으면 YIN 우선, 없으면 Goertzel 단독
        const liveCents = (crossValid && yinCents !== null)
          ? Math.round(((effectiveYin + goertzelCents) / 2) * 10) / 10
          : isHigh && signalOk
            ? goertzelCents
            : crossValid
              ? Math.round(((effectiveYin + goertzelCents) / 2) * 10) / 10
              : goertzelCents;

        // ── 4. 스트로브 안정화 ────────────────────────────────────────
        // 고음: peakThreshold 낮추고 PEAK_RATIO 완화 (빠른 decay)
        const peakThreshold = isHigh ? PEAK_THRESHOLD_HIGH : PEAK_THRESHOLD;
        const peakRatio     = isHigh ? PEAK_RATIO_HIGH : PEAK_RATIO;
        const stableDuration = isHigh ? STABLE_DURATION_MS_HIGH : STABLE_DURATION_MS;
        const minSamples     = isHigh ? MIN_SAMPLES_HIGH : MIN_SAMPLES;

        if (rms > peakRmsRef.current * 1.5 && rms > 0.02) {
          peakRmsRef.current      = rms;
          captureStartRef.current = null;
          captureBufferRef.current = [];
        } else if (rms > peakRmsRef.current) {
          peakRmsRef.current = rms;
        }

        const isStable = rms < peakRmsRef.current * peakRatio && peakRmsRef.current > peakThreshold;

        let finalCents: number | null = null;
        let isCapturing = false;
        let captureProgress = 0;

        if (isStable) {
          if (captureStartRef.current === null) captureStartRef.current = Date.now();
          captureBufferRef.current.push(liveCents);
          const elapsed = Date.now() - captureStartRef.current;
          isCapturing      = true;
          captureProgress  = Math.min(elapsed / stableDuration, 1);

          if (elapsed >= stableDuration && captureBufferRef.current.length >= minSamples) {
            finalCents               = Math.round(median(captureBufferRef.current) * 10) / 10;
            captureStartRef.current  = null;
            captureBufferRef.current = [];
            peakRmsRef.current       = 0;
          }
        } else {
          captureStartRef.current  = null;
          captureBufferRef.current = [];
        }

        const newResult: CompositeResult = {
          keyIndex: ki,
          noteName: PIANO_KEYS[ki].noteName,
          octave:   PIANO_KEYS[ki].octave,
          frequency: measuredBaseHz,
          yinCents:     yinCents ?? goertzelCents,
          goertzelCents,
          liveCents,
          finalCents,
          crossValid,
          signalOk,
          isCapturing,
          captureProgress,
        };

        setResult(newResult);
        if (finalCents !== null) onConfirmed?.(newResult);

        rafRef.current = requestAnimationFrame(detect);
      };

      rafRef.current = requestAnimationFrame(detect);
    } catch (err) {
      let msg = "마이크 접근 실패";
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") msg = "마이크 권한이 거부되었습니다.";
        else if (err.name === "NotFoundError")    msg = "마이크를 찾을 수 없습니다.";
        else if (err.name === "NotReadableError") msg = "마이크를 사용할 수 없습니다.";
        else msg = err.message;
      }
      setError(msg);
      setIsListening(false);
    }
  }, [onConfirmed, fftSize, resetCapture]);

  // visibility 복구
  useEffect(() => {
    const handler = async () => {
      if (document.visibilityState !== "visible" || !isRunningRef.current) return;
      const ctx = ctxRef.current;
      if (!ctx || ctx.state === "closed") {
        isRunningRef.current = false;
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = ctxRef.current = analyserRef.current = bufRef.current = null;
        resetCapture();
        setResult(null);
        try { await startListening(); } catch {}
      } else if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch {}
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [startListening, resetCapture]);

  useEffect(() => () => { stopListening(); }, [stopListening]);

  return { isListening, result, startListening, stopListening, error };
}
