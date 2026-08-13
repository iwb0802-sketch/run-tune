/*
 * useAutoCompositeTuner.ts
 *
 * 복합 탭의 음성 인식 정책을 자동 탭용으로 확장한 엔진.
 * 지정 건반 대신 YIN+HPS로 후보 건반을 잠근 뒤, 같은 건반에서
 * Goertzel 배음 교차검증과 안정 구간 중앙값 확정을 수행한다.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { PIANO_KEYS, type PitchResult } from "./usePitchDetector";
import {
  applyHannWindow,
  correctOctaveByHPS,
  detectPitchYIN,
  getRMS,
  goertzel,
  median,
  selectBestPartial,
  stabilizeWithNeighbors,
  targetPartial,
  CONFIDENCE_THRESHOLD,
} from "@/lib/tuner/pitchEngine";

export type AutoCompositeProfile = "trial-v2-low" | "current-mid" | "current-high" | "trial-v2-high";

export interface AutoCompositeResult extends PitchResult {
  /** B2 이하·A♯5 이상은 시험용 V2, 중간은 기존 자동 복합 엔진 */
  profile: AutoCompositeProfile;
  yinCents: number;
  goertzelCents: number;
  finalCents: number | null;
  crossValid: boolean;
  signalOk: boolean;
  isCapturing: boolean;
  captureProgress: number;
}

export interface UseAutoCompositeTunerReturn {
  isListening: boolean;
  result: AutoCompositeResult | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: string | null;
  isRecovering: boolean;
  stream: MediaStream | null;
  audioContext: AudioContext | null;
}

const CROSS_VALID_THRESHOLD = 8;
const CROSS_VALID_THRESHOLD_LOW = 15;
const CROSS_VALID_THRESHOLD_HIGH = 12;
const STABLE_DURATION_MS = 900;
const STABLE_DURATION_MS_HIGH = 500;
const MIN_SAMPLES = 8;
const MIN_SAMPLES_HIGH = 6;
const MIN_RMS = 0.004;
const MIN_RMS_LOW = 0.002;
const MIN_RMS_HIGH = 0.003;
const PEAK_RATIO = 0.55;
const PEAK_RATIO_HIGH = 0.40;
const PEAK_THRESHOLD = 0.015;
const PEAK_THRESHOLD_HIGH = 0.008;
const DOMINANCE_RATIO = 1.3;
const COARSE_STEP_LOW = 1;
const COARSE_STEP_MID = 3;
const COARSE_STEP_HIGH = 2;
const SCAN_RANGE_CENTS = 50;
const SCAN_RANGE_CENTS_HIGH = 80;
const HIGH_KEY_THRESHOLD = 52;
// 사용자 지정 경계: B2(건반 index 38) 이하 / A♯5(index 61) 이상은 시험용 V2를 사용한다.
const TRIAL_LOW_MAX_KEY = 38;
const TRIAL_HIGH_MIN_KEY = 61;
const KEY_WINDOW = 15;
const MIN_KEY_SAMPLES = 6;

function keyFromFrequency(frequency: number): { keyIndex: number; cents: number } | null {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  const midiFloat = 69 + 12 * Math.log2(frequency / 440);
  const midiRound = Math.round(midiFloat);
  const keyIndex = midiRound - 21;
  if (keyIndex < 0 || keyIndex > 87) return null;
  return { keyIndex, cents: (midiFloat - midiRound) * 100 };
}

function frequencyToTargetCents(
  frequency: number,
  baseFrequency: number,
  trialLow: boolean,
): number | null {
  if (frequency <= 0 || baseFrequency <= 0) return null;
  let folded = frequency;
  // 시험용 V2 저음부는 강한 2~6배음 혼입을 고려해 더 넓은 옥타브 폴딩 범위를 쓴다.
  const upperMargin = trialLow ? 3.5 : 1.5;
  const lowerMargin = trialLow ? 0.4 : 0.67;
  while (folded > baseFrequency * upperMargin) folded /= 2;
  while (folded < baseFrequency * lowerMargin) folded *= 2;
  return Math.round(1200 * Math.log2(folded / baseFrequency) * 10) / 10;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function twoPassGoertzelScan(
  buffer: Float32Array,
  sampleRate: number,
  targetFrequency: number,
  baseFrequency: number,
  partial: number,
  trialLow: boolean,
  trialHigh: boolean,
): { frequency: number; cents: number } {
  const coarseStep = trialLow ? 1 : 2;
  const fineStep = trialLow ? 0.2 : 0.5;
  const range = trialHigh ? 80 : 50;
  const steps = Math.round(range / coarseStep);
  let coarseBestFrequency = targetFrequency;
  let coarseBestMagnitude = -1;

  for (let offset = -steps; offset <= steps; offset++) {
    const frequency = targetFrequency * Math.pow(2, (offset * coarseStep) / 1200);
    const magnitude = goertzel(buffer, sampleRate, frequency).magnitude;
    if (magnitude > coarseBestMagnitude) {
      coarseBestMagnitude = magnitude;
      coarseBestFrequency = frequency;
    }
  }

  const fineRange = coarseStep * 2;
  const fineSteps = Math.round(fineRange / fineStep);
  let fineBestFrequency = coarseBestFrequency;
  let fineBestMagnitude = -1;
  for (let offset = -fineSteps; offset <= fineSteps; offset++) {
    const frequency = coarseBestFrequency * Math.pow(2, (offset * fineStep) / 1200);
    const magnitude = goertzel(buffer, sampleRate, frequency).magnitude;
    if (magnitude > fineBestMagnitude) {
      fineBestMagnitude = magnitude;
      fineBestFrequency = frequency;
    }
  }

  const measuredBaseFrequency = fineBestFrequency / partial;
  return {
    frequency: measuredBaseFrequency,
    cents: Math.round(1200 * Math.log2(measuredBaseFrequency / baseFrequency) * 10) / 10,
  };
}

/**
 * 실제로 확정된 타건 1회마다 한 번만 콜백을 호출한다.
 * 자동저장에서는 이 값만 세션에 기록해 실시간 프레임의 흔들림을 저장하지 않는다.
 */
export function useAutoCompositeTuner(
  onConfirmed?: (result: AutoCompositeResult) => void,
  fftSize: 4096 | 8192 = 4096,
): UseAutoCompositeTunerReturn {
  const [isListening, setIsListening] = useState(false);
  const [result, setResult] = useState<AutoCompositeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufferRef = useRef<Float32Array | null>(null);
  const spectrumRef = useRef<Float32Array | null>(null);
  const isRunningRef = useRef(false);
  const onConfirmedRef = useRef(onConfirmed);

  const recentKeysRef = useRef<number[]>([]);
  const recentCentsRef = useRef<number[]>([]);
  const lastKeyRef = useRef<number | null>(null);
  const peakRmsRef = useRef(0);
  const captureStartRef = useRef<number | null>(null);
  const captureBufferRef = useRef<number[]>([]);
  const captureCycleRef = useRef(0);
  const confirmedCycleRef = useRef(-1);

  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  }, [onConfirmed]);

  const resetCapture = useCallback(() => {
    peakRmsRef.current = 0;
    captureStartRef.current = null;
    captureBufferRef.current = [];
  }, []);

  const resetDetector = useCallback(() => {
    resetCapture();
    recentKeysRef.current = [];
    recentCentsRef.current = [];
    lastKeyRef.current = null;
    captureCycleRef.current = 0;
    confirmedCycleRef.current = -1;
  }, [resetCapture]);

  const stopListening = useCallback(() => {
    isRunningRef.current = false;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    bufferRef.current = null;
    spectrumRef.current = null;
    resetDetector();
    setIsListening(false);
    setIsRecovering(false);
    setResult(null);
  }, [resetDetector]);

  const startListening = useCallback(async () => {
    try {
      setError(null);
      setIsRecovering(false);
      resetDetector();

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false,
            sampleRate: 44100,
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
        });
      }
      streamRef.current = stream;

      const context = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 44100 });
      ctxRef.current = context;
      if (context.state === "suspended") {
        try { await context.resume(); } catch { /* ignore */ }
      }

      const analyser = context.createAnalyser();
      // 자동 모드에서는 아직 건반을 알 수 없으므로, B2 이하 후보를 놓치지 않게
      // 시험용 V2 저음 버퍼(8192)로 시작한 뒤 음역이 잠기면 해당 프로필 크기로 전환한다.
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0;
      analyserRef.current = analyser;
      context.createMediaStreamSource(stream).connect(analyser);
      bufferRef.current = new Float32Array(analyser.fftSize);
      spectrumRef.current = new Float32Array(analyser.frequencyBinCount);
      isRunningRef.current = true;
      setIsListening(true);

      const detect = () => {
        if (!isRunningRef.current) return;
        const activeContext = ctxRef.current;
        const analyserNode = analyserRef.current;
        const buffer = bufferRef.current;
        const spectrum = spectrumRef.current;
        if (!activeContext || !analyserNode || !buffer || !spectrum) return;

        if (activeContext.state === "suspended") activeContext.resume().catch(() => {});

        analyserNode.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
        const rms = getRMS(buffer);
        if (rms < MIN_RMS_LOW) {
          resetCapture();
          recentKeysRef.current = [];
          recentCentsRef.current = [];
          lastKeyRef.current = null;
          captureCycleRef.current += 1;
          confirmedCycleRef.current = -1;
          setResult(null);
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        const windowed = applyHannWindow(buffer);
        const rawYinFrequency = detectPitchYIN(windowed, activeContext.sampleRate, 26, 8000, 0.10);
        if (rawYinFrequency <= 0) {
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        analyserNode.getFloatFrequencyData(spectrum as Float32Array<ArrayBuffer>);
        const rawCandidate = keyFromFrequency(rawYinFrequency);
        const correctedFrequency = correctOctaveByHPS(
          rawYinFrequency,
          spectrum,
          activeContext.sampleRate,
          analyserNode.fftSize,
          5,
          rawCandidate?.keyIndex ?? 0,
        );
        const candidate = keyFromFrequency(correctedFrequency);
        if (!candidate) {
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        recentKeysRef.current.push(candidate.keyIndex);
        recentCentsRef.current.push(candidate.cents);
        if (recentKeysRef.current.length > KEY_WINDOW) {
          recentKeysRef.current.shift();
          recentCentsRef.current.shift();
        }

        const counts: Record<number, number> = {};
        recentKeysRef.current.forEach((keyIndex) => { counts[keyIndex] = (counts[keyIndex] || 0) + 1; });
        const topKey = Number(Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ?? candidate.keyIndex);
        const stabilized = stabilizeWithNeighbors(recentKeysRef.current, recentCentsRef.current, topKey);
        const keyConfidence = stabilized.confidence;
        const keyIndex = recentKeysRef.current.length >= MIN_KEY_SAMPLES && keyConfidence >= CONFIDENCE_THRESHOLD
          ? topKey
          : candidate.keyIndex;

        if (lastKeyRef.current !== keyIndex) {
          resetCapture();
          lastKeyRef.current = keyIndex;
          captureCycleRef.current += 1;
          confirmedCycleRef.current = -1;
        }

        const usesTrialLow = keyIndex <= TRIAL_LOW_MAX_KEY;
        const usesTrialHigh = keyIndex >= TRIAL_HIGH_MIN_KEY;
        const profile: AutoCompositeProfile = usesTrialLow
          ? "trial-v2-low"
          : usesTrialHigh
            ? "trial-v2-high"
            : keyIndex >= HIGH_KEY_THRESHOLD
              ? "current-high"
              : "current-mid";

        // B2 이하는 시험용 V2의 8192 버퍼, A♯5 이상은 V2의 4096 버퍼를 강제한다.
        // 그 사이 중음역은 사용자가 선택한 기존 자동 탭 버퍼 설정을 그대로 유지한다.
        const desiredFftSize = usesTrialLow ? 8192 : usesTrialHigh ? 4096 : fftSize;
        if (analyserNode.fftSize !== desiredFftSize) {
          analyserNode.fftSize = desiredFftSize;
          bufferRef.current = new Float32Array(desiredFftSize);
          spectrumRef.current = new Float32Array(analyserNode.frequencyBinCount);
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        const isLow = usesTrialLow || keyIndex <= 26;
        const isHigh = usesTrialHigh || keyIndex >= HIGH_KEY_THRESHOLD;
        const rmsMinimum = usesTrialLow ? 0.0036 : usesTrialHigh ? 0.0018 : (isLow ? MIN_RMS_LOW : isHigh ? MIN_RMS_HIGH : MIN_RMS);
        if (rms < rmsMinimum) {
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        const baseFrequency = PIANO_KEYS[keyIndex].freq;
        const sampleRate = activeContext.sampleRate;
        // 상·하부만 시험용 V2의 음역별 적응형 YIN을 재실행한다. 중앙(B2~A5)은 현행 로직 유지.
        const v2YinFrequency = usesTrialLow
          ? detectPitchYIN(windowed, sampleRate, 20, 200, Math.max(0.08, Math.min(0.12, 0.15 - rms * 0.5)))
          : usesTrialHigh
            ? detectPitchYIN(windowed, sampleRate, 450, 6000, Math.max(0.07, Math.min(0.12, 0.16 - rms * 0.8)))
            : correctedFrequency;
        const profiledFrequency = (usesTrialLow || usesTrialHigh) && v2YinFrequency > 0
          ? correctOctaveByHPS(v2YinFrequency, spectrum, sampleRate, analyserNode.fftSize, 5, keyIndex)
          : correctedFrequency;
        const yinCents = frequencyToTargetCents(profiledFrequency, baseFrequency, usesTrialLow);
        const partial = isLow
          ? selectBestPartial(buffer, sampleRate, keyIndex, baseFrequency)
          : targetPartial(keyIndex);
        const targetFrequency = baseFrequency * partial;

        const targetMagnitude = goertzel(buffer, sampleRate, targetFrequency);
        const lowerMagnitude = goertzel(buffer, sampleRate, targetFrequency * Math.pow(2, -1.5 / 12)).magnitude;
        const upperMagnitude = goertzel(buffer, sampleRate, targetFrequency * Math.pow(2, 1.5 / 12)).magnitude;
        const dominanceRatio = usesTrialLow ? 1.15 : usesTrialHigh ? 1.05 : (isHigh ? 1.1 : DOMINANCE_RATIO);
        const signalOk = targetMagnitude.magnitude > Math.max(lowerMagnitude, upperMagnitude, 1e-9) * dominanceRatio;

        const trialV2Active = usesTrialLow || usesTrialHigh;
        let measuredBaseFrequency: number;
        let goertzelCents: number;
        if (trialV2Active) {
          const v2Scan = twoPassGoertzelScan(
            buffer, sampleRate, targetFrequency, baseFrequency, partial, usesTrialLow, usesTrialHigh,
          );
          measuredBaseFrequency = v2Scan.frequency;
          goertzelCents = v2Scan.cents;
        } else {
          const step = isLow ? COARSE_STEP_LOW : isHigh ? COARSE_STEP_HIGH : COARSE_STEP_MID;
          const scanCents = isHigh ? SCAN_RANGE_CENTS_HIGH : SCAN_RANGE_CENTS;
          const scanSteps = Math.round(scanCents / step);
          let bestFrequency = targetFrequency;
          let bestMagnitude = -1;
          for (let offset = -scanSteps; offset <= scanSteps; offset++) {
            const testFrequency = targetFrequency * Math.pow(2, (offset * step) / 1200);
            const magnitude = goertzel(buffer, sampleRate, testFrequency).magnitude;
            if (magnitude > bestMagnitude) {
              bestMagnitude = magnitude;
              bestFrequency = testFrequency;
            }
          }
          measuredBaseFrequency = bestFrequency / partial;
          goertzelCents = Math.round(1200 * Math.log2(measuredBaseFrequency / baseFrequency) * 10) / 10;
        }

        const threshold = isLow
          ? CROSS_VALID_THRESHOLD_LOW
          : isHigh
            ? CROSS_VALID_THRESHOLD_HIGH
            : CROSS_VALID_THRESHOLD;
        const crossValid = isHigh
          ? (signalOk || yinCents !== null)
          : (signalOk && yinCents !== null && Math.abs(yinCents - goertzelCents) <= threshold);
        const effectiveYin = yinCents ?? goertzelCents;
        const liveCents = trialV2Active && yinCents !== null && crossValid
          ? Math.round((usesTrialLow
              ? yinCents * 0.35 + goertzelCents * 0.65
              : yinCents * 0.55 + goertzelCents * 0.45) * 10) / 10
          : (crossValid && yinCents !== null)
            ? Math.round(((effectiveYin + goertzelCents) / 2) * 10) / 10
            : isHigh && signalOk
              ? goertzelCents
              : crossValid
                ? Math.round(((effectiveYin + goertzelCents) / 2) * 10) / 10
                : goertzelCents;

        const peakThreshold = usesTrialLow ? 0.012 : usesTrialHigh ? 0.006 : (isHigh ? PEAK_THRESHOLD_HIGH : PEAK_THRESHOLD);
        const peakRatio = usesTrialLow ? 0.60 : usesTrialHigh ? 0.40 : (isHigh ? PEAK_RATIO_HIGH : PEAK_RATIO);
        const stableDuration = usesTrialLow ? 1100 : usesTrialHigh ? 450 : (isHigh ? STABLE_DURATION_MS_HIGH : STABLE_DURATION_MS);
        const minimumSamples = usesTrialLow ? 10 : usesTrialHigh ? 5 : (isHigh ? MIN_SAMPLES_HIGH : MIN_SAMPLES);
        const maximumStddev = usesTrialLow ? 1.5 : usesTrialHigh ? 2.0 : null;

        if (rms > peakRmsRef.current * 1.5 && rms > 0.02) {
          peakRmsRef.current = rms;
          captureStartRef.current = null;
          captureBufferRef.current = [];
          captureCycleRef.current += 1;
        } else if (rms > peakRmsRef.current) {
          peakRmsRef.current = rms;
        }

        const isStable = rms < peakRmsRef.current * peakRatio && peakRmsRef.current > peakThreshold;
        let finalCents: number | null = null;
        let isCapturing = false;
        let captureProgress = 0;

        // 한 타격은 한 번만 확정한다. 새로 충분히 큰 attack이 감지되거나 무음이 된 뒤에만
        // captureCycle이 바뀌므로, 긴 잔향이 자동저장을 반복해서 덮어쓰지 않는다.
        const alreadyConfirmed = confirmedCycleRef.current === captureCycleRef.current;
        if (isStable && !alreadyConfirmed) {
          if (captureStartRef.current === null) captureStartRef.current = Date.now();
          captureBufferRef.current.push(liveCents);
          const elapsed = Date.now() - captureStartRef.current;
          isCapturing = true;
          captureProgress = Math.min(elapsed / stableDuration, 1);

          const samplesStable = maximumStddev === null || standardDeviation(captureBufferRef.current) <= maximumStddev;
          if (elapsed >= stableDuration && captureBufferRef.current.length >= minimumSamples && samplesStable) {
            finalCents = Math.round(median(captureBufferRef.current) * 10) / 10;
            captureStartRef.current = null;
            captureBufferRef.current = [];
          }
        } else if (!alreadyConfirmed) {
          captureStartRef.current = null;
          captureBufferRef.current = [];
        }

        const nextResult: AutoCompositeResult = {
          keyIndex,
          noteName: PIANO_KEYS[keyIndex].noteName,
          octave: PIANO_KEYS[keyIndex].octave,
          frequency: measuredBaseFrequency,
          cents: liveCents,
          confidence: keyConfidence,
          rms,
          profile,
          yinCents: yinCents ?? goertzelCents,
          goertzelCents,
          finalCents,
          crossValid,
          signalOk,
          isCapturing,
          captureProgress,
        };
        setResult(nextResult);

        if (finalCents !== null && confirmedCycleRef.current !== captureCycleRef.current) {
          confirmedCycleRef.current = captureCycleRef.current;
          onConfirmedRef.current?.({ ...nextResult, cents: finalCents });
        }

        rafRef.current = requestAnimationFrame(detect);
      };

      rafRef.current = requestAnimationFrame(detect);
    } catch (caught) {
      let message = "마이크 접근 실패";
      if (caught instanceof Error) {
        if (caught.name === "NotAllowedError" || caught.name === "PermissionDeniedError") message = "마이크 권한이 거부되었습니다.";
        else if (caught.name === "NotFoundError") message = "마이크를 찾을 수 없습니다.";
        else if (caught.name === "NotReadableError") message = "마이크를 사용할 수 없습니다.";
        else message = caught.message;
      }
      setError(message);
      setIsListening(false);
      setIsRecovering(false);
    }
  }, [fftSize, resetCapture, resetDetector]);

  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible" || !isRunningRef.current) return;
      const context = ctxRef.current;
      if (!context || context.state === "closed") {
        isRunningRef.current = false;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        ctxRef.current = null;
        analyserRef.current = null;
        bufferRef.current = null;
        spectrumRef.current = null;
        resetDetector();
        setResult(null);
        setIsRecovering(true);
        try { await startListening(); } finally { setIsRecovering(false); }
      } else if (context.state === "suspended") {
        try { await context.resume(); } catch { /* ignore */ }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [resetDetector, startListening]);

  useEffect(() => () => { stopListening(); }, [stopListening]);

  return {
    isListening,
    result,
    startListening,
    stopListening,
    error,
    isRecovering,
    stream: streamRef.current,
    audioContext: ctxRef.current,
  };
}
