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

const CROSS_VALID_THRESHOLD     = 8;    // ¢ 중고음
const CROSS_VALID_THRESHOLD_LOW = 15;   // ¢ 저음 ≤26
const STABLE_DURATION_MS        = 900;
const MIN_SAMPLES               = 8;
const MIN_RMS                   = 0.004;
const MIN_RMS_LOW               = 0.002;
const PEAK_RATIO                = 0.55;
const DOMINANCE_RATIO           = 1.3;
const COARSE_STEP_LOW           = 1;    // 저음 scan 스텝 (¢)
const COARSE_STEP_MID           = 3;    // 중고음 scan 스텝 (¢)

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
        const rmsMin   = isLow ? MIN_RMS_LOW : MIN_RMS;

        if (rms < rmsMin) {
          resetCapture();
          setResult(null);
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        const baseFreq = PIANO_KEYS[ki].freq;
        const sr       = ctx.sampleRate;

        // ── 1. YIN → 지정 건반 기준 cent ────────────────────────────
        const winBuf  = applyHannWindow(buf);
        const fYin    = detectPitchYIN(winBuf, sr, 26, 5000, 0.12);
        const yinCents = fYin > 0 ? yinFreqToCents(fYin, baseFreq) : null;

        // ── 2. Goertzel → 배음 기반 cent ─────────────────────────────
        const partial    = isLow
          ? selectBestPartial(buf, sr, ki, baseFreq)
          : targetPartial(ki);
        const targetFreq = baseFreq * partial;

        // 도미넌스 체크
        const gTarget = goertzel(buf, sr, targetFreq);
        const magLo   = goertzel(buf, sr, targetFreq * Math.pow(2, -1.5 / 12)).magnitude;
        const magHi   = goertzel(buf, sr, targetFreq * Math.pow(2,  1.5 / 12)).magnitude;
        const signalOk = gTarget.magnitude > Math.max(magLo, magHi, 1e-9) * DOMINANCE_RATIO;

        // coarse scan
        const step      = isLow ? COARSE_STEP_LOW : COARSE_STEP_MID;
        const scanRange = Math.round(50 / step);
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
        const threshold  = isLow ? CROSS_VALID_THRESHOLD_LOW : CROSS_VALID_THRESHOLD;
        const crossValid = signalOk
          && yinCents !== null
          && Math.abs(yinCents - goertzelCents) <= threshold;

        const effectiveYin = yinCents ?? goertzelCents;
        const liveCents    = crossValid
          ? Math.round(((effectiveYin + goertzelCents) / 2) * 10) / 10
          : goertzelCents; // YIN 없거나 교차 실패 → Goertzel 단독

        // ── 4. 스트로브 안정화 ────────────────────────────────────────
        if (rms > peakRmsRef.current * 1.5 && rms > 0.02) {
          peakRmsRef.current      = rms;
          captureStartRef.current = null;
          captureBufferRef.current = [];
        } else if (rms > peakRmsRef.current) {
          peakRmsRef.current = rms;
        }

        const isStable = rms < peakRmsRef.current * PEAK_RATIO && peakRmsRef.current > 0.015;

        let finalCents: number | null = null;
        let isCapturing = false;
        let captureProgress = 0;

        if (isStable) {
          if (captureStartRef.current === null) captureStartRef.current = Date.now();
          captureBufferRef.current.push(liveCents);
          const elapsed = Date.now() - captureStartRef.current;
          isCapturing      = true;
          captureProgress  = Math.min(elapsed / STABLE_DURATION_MS, 1);

          if (elapsed >= STABLE_DURATION_MS && captureBufferRef.current.length >= MIN_SAMPLES) {
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
