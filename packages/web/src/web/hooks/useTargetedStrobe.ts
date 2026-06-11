/**
 * useTargetedStrobe.ts
 * 목표 건반을 "이미 아는" 상태에서의 Goertzel 위상 스트로브 측정.
 *
 * 핵심:
 * - 저음은 targetPartial()로 6/4/2배음 분석
 * - 최종 표시값은 배음 cent가 아니라
 *   "측정 배음 Hz ÷ partial = 기본음 Hz"로 환산 후
 *   평균율 0점 기준 절대 cent로 표시
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PIANO_KEYS } from "./usePitchDetector";
import {
  goertzel,
  centsFromPhaseDelta,
  targetPartial,
  selectBestPartial,
} from "@/lib/tuner/pitchEngine";

export interface TargetedStrobeState {
  strobeCents: number | null;
  liveCents: number | null;
  isCapturing: boolean;
  captureProgress: number;
  currentNote: string | null;
  currentKeyIndex: number | null;
  analysisFreq: number | null;
  partial: number | null;
  signalOk: boolean;
}

interface Options {
  stableDurationMs?: number;
  fftSize?: 4096 | 8192;
  dominanceRatio?: number;
}

const MIN_RMS = 0.006;

function wrapPi(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return p - 2 * Math.PI * Math.round(p / (2 * Math.PI));
}

function medianOf(arr: number[]): number {
  if (!arr.length) return 0;

  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);

  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * targetFreq ±1반음 범위를 Goertzel magnitude로 스캔하여
 * 가장 magnitude가 큰 주파수를 반환.
 *
 * 위상 기반 inblockFreq 방식 대신 사용 — 저음 배음 분석 시
 * 위상 추정이 인접 배음으로 튀는 문제를 방지.
 *
 * 스캔 범위: fTarget × 2^(-1/12) ~ fTarget × 2^(+1/12)
 * 스캔 스텝: 5센트 단위
 */
function coarseFreq(
  buf: Float32Array,
  sr: number,
  fTarget: number
): number {
  // ±1반음 = ±100cent, 5cent 스텝 → 41개 포인트
  const STEP_CENTS = 5;
  const RANGE_CENTS = 100;
  const steps = Math.round(RANGE_CENTS / STEP_CENTS);

  let bestFreq = fTarget;
  let bestMag = -1;

  for (let i = -steps; i <= steps; i++) {
    const f = fTarget * Math.pow(2, (i * STEP_CENTS) / 1200);
    const mag = goertzel(buf, sr, f).magnitude;
    if (mag > bestMag) {
      bestMag = mag;
      bestFreq = f;
    }
  }

  return bestFreq;
}

/**
 * 배음으로 측정된 Hz를 기본음 기준 절대 cent로 환산.
 *
 * 예:
 * A0를 6배음으로 분석
 * measuredPartialHz / 6 = A0 기본음 Hz
 * displayCents = 1200 * log2(A0 기본음 Hz / A0 평균율 Hz)
 */
function partialHzToBaseAbsoluteCents(
  measuredPartialHz: number,
  keyIndex: number,
  partial: number
): number {
  const equalBaseHz = PIANO_KEYS[keyIndex]?.freq;

  if (
    !equalBaseHz ||
    !Number.isFinite(measuredPartialHz) ||
    measuredPartialHz <= 0 ||
    partial <= 0
  ) {
    return Number.NaN;
  }

  const measuredBaseHz = measuredPartialHz / partial;

  return 1200 * Math.log2(measuredBaseHz / equalBaseHz);
}

export function useTargetedStrobe(
  stream: MediaStream | null,
  audioContext: AudioContext | null,
  targetKeyIndex: number | null,
  opts: Options = {}
): TargetedStrobeState {
  const {
    stableDurationMs = 800,
    fftSize = 4096,
    dominanceRatio = 1.4,
  } = opts;

  const [strobeCents, setStrobeCents] = useState<number | null>(null);
  const [liveCents, setLiveCents] = useState<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState(0);
  const [signalOk, setSignalOk] = useState(false);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<Float32Array | null>(null);

  const targetKeyRef = useRef<number | null>(targetKeyIndex);
  const targetFreqRef = useRef<number>(0);
  const partialRef = useRef<number>(1);

  const peakRmsRef = useRef(0);
  const captureStartRef = useRef<number | null>(null);
  const prevResidualRef = useRef<number | null>(null);
  const cumPhaseRef = useRef(0);
  const startAudioTimeRef = useRef(0);
  const lastAudioTimeRef = useRef(0);
  const coarseBufRef = useRef<number[]>([]);

  const resetCapture = useCallback(() => {
    prevResidualRef.current = null;
    cumPhaseRef.current = 0;
    captureStartRef.current = null;
    coarseBufRef.current = [];
  }, []);

  useEffect(() => {
    targetKeyRef.current = targetKeyIndex;

    if (targetKeyIndex !== null) {
      const p = targetPartial(targetKeyIndex);
      partialRef.current = p;
      targetFreqRef.current = PIANO_KEYS[targetKeyIndex].freq * p;
    } else {
      targetFreqRef.current = 0;
      partialRef.current = 1;
    }

    resetCapture();
    peakRmsRef.current = 0;

    setStrobeCents(null);
    setLiveCents(null);
    setIsCapturing(false);
    setCaptureProgress(0);
    setSignalOk(false);
  }, [targetKeyIndex, resetCapture]);

  useEffect(() => {
    if (!stream || !audioContext) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      try {
        sourceRef.current?.disconnect();
      } catch {
        /* ignore */
      }

      analyserRef.current = null;
      bufRef.current = null;
      return;
    }

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    analyserRef.current = analyser;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    sourceRef.current = source;

    bufRef.current = new Float32Array(analyser.fftSize);

    const detect = () => {
      const analyserNode = analyserRef.current;
      const buf = bufRef.current;
      const fTarget = targetFreqRef.current;
      const keyIndex = targetKeyRef.current;
      const partial = partialRef.current;

      if (
        !analyserNode ||
        !buf ||
        fTarget <= 0 ||
        keyIndex === null ||
        partial <= 0
      ) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      const tAudio = audioContext.currentTime;

      analyserNode.getFloatTimeDomainData(
        buf as Float32Array<ArrayBuffer>
      );

      let sum = 0;

      for (let i = 0; i < buf.length; i++) {
        sum += buf[i] * buf[i];
      }

      const rms = Math.sqrt(sum / buf.length);

      if (rms < MIN_RMS) {
        setSignalOk(false);
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      if (rms > peakRmsRef.current * 1.5 && rms > 0.02) {
        peakRmsRef.current = rms;
        resetCapture();

        setIsCapturing(false);
        setCaptureProgress(0);
        setStrobeCents(null);
      } else if (rms > peakRmsRef.current) {
        peakRmsRef.current = rms;
      }

      const sr = audioContext.sampleRate;

      const gTarget = goertzel(buf, sr, fTarget);
      const magLo = goertzel(
        buf,
        sr,
        fTarget * Math.pow(2, -1.5 / 12)
      ).magnitude;
      const magHi = goertzel(
        buf,
        sr,
        fTarget * Math.pow(2, 1.5 / 12)
      ).magnitude;

      const dominant =
        gTarget.magnitude >
        Math.max(magLo, magHi, 1e-9) * dominanceRatio;

      setSignalOk(dominant);

      if (!dominant) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      const isStable =
        rms < peakRmsRef.current * 0.55 &&
        peakRmsRef.current > 0.015;

      if (!isStable) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      // ── 동적 배음 선택 ──────────────────────────────────────────
      // 안정 구간 진입 후 실제 신호에서 가장 강한 배음 자동 선택.
      // partial이 바뀌면 targetFreq도 갱신하고 캡처 리셋.
      if (keyIndex <= 26) {
        const baseFreq = PIANO_KEYS[keyIndex].freq;
        const bestP = selectBestPartial(buf, sr, keyIndex, baseFreq);
        if (bestP !== partialRef.current) {
          partialRef.current = bestP;
          targetFreqRef.current = baseFreq * bestP;
          resetCapture();
          rafRef.current = requestAnimationFrame(detect);
          return;
        }
      }

      const fc = coarseFreq(buf, sr, targetFreqRef.current);

      coarseBufRef.current.push(fc);

      if (coarseBufRef.current.length > 60) {
        coarseBufRef.current.shift();
      }

      const fcMed = medianOf(coarseBufRef.current);

      // 동적 선택 후 최신 partial/targetFreq ref 사용
      const currentPartial = partialRef.current;
      const currentTargetFreq = targetFreqRef.current;

      const liveC = partialHzToBaseAbsoluteCents(
        fcMed,
        keyIndex,
        currentPartial
      );

      if (Number.isFinite(liveC) && Math.abs(liveC) < 300) {
        setLiveCents(Math.round(liveC * 10) / 10);
      }

      const residual = wrapPi(
        gTarget.phase - 2 * Math.PI * currentTargetFreq * tAudio
      );

      if (captureStartRef.current === null) {
        captureStartRef.current = performance.now();
        startAudioTimeRef.current = tAudio;
        lastAudioTimeRef.current = tAudio;
        prevResidualRef.current = residual;
        cumPhaseRef.current = 0;

        setIsCapturing(true);
      } else {
        const prev = prevResidualRef.current!;
        const dt = tAudio - lastAudioTimeRef.current;

        const predicted =
          2 * Math.PI * (fcMed - currentTargetFreq) * dt;

        const raw = residual - prev;
        const k = Math.round(
          (predicted - raw) / (2 * Math.PI)
        );

        cumPhaseRef.current += raw + 2 * Math.PI * k;
        prevResidualRef.current = residual;
        lastAudioTimeRef.current = tAudio;
      }

      const elapsedMs =
        performance.now() - captureStartRef.current;

      setCaptureProgress(
        Math.min(elapsedMs / stableDurationMs, 1)
      );

      if (elapsedMs >= stableDurationMs) {
        const totalDt =
          tAudio - startAudioTimeRef.current;

        if (totalDt > 1e-3) {
          const centsFromTarget = centsFromPhaseDelta(
            0,
            cumPhaseRef.current,
            totalDt,
            currentTargetFreq
          );

          let finalC = liveC;

          if (Number.isFinite(centsFromTarget)) {
            const measuredPartialHz =
              currentTargetFreq * Math.pow(2, centsFromTarget / 1200);

            const absoluteCents =
              partialHzToBaseAbsoluteCents(
                measuredPartialHz,
                keyIndex,
                currentPartial
              );

            finalC =
              Number.isFinite(absoluteCents) &&
              Math.abs(absoluteCents - liveC) <= 10
                ? absoluteCents
                : liveC;
          }

          if (Number.isFinite(finalC)) {
            setStrobeCents(Math.round(finalC * 10) / 10);
          }
        }

        setIsCapturing(false);
        setCaptureProgress(0);
        resetCapture();
        peakRmsRef.current = 0;
      }

      rafRef.current = requestAnimationFrame(detect);
    };

    rafRef.current = requestAnimationFrame(detect);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      try {
        source.disconnect();
      } catch {
        /* ignore */
      }

      analyserRef.current = null;
      bufRef.current = null;

      resetCapture();
      peakRmsRef.current = 0;
    };
  }, [
    stream,
    audioContext,
    stableDurationMs,
    fftSize,
    dominanceRatio,
    resetCapture,
  ]);

  const keyIndex = targetKeyRef.current;

  return {
    strobeCents,
    liveCents,
    isCapturing,
    captureProgress,
    currentNote:
      keyIndex !== null
        ? `${PIANO_KEYS[keyIndex].noteName}${PIANO_KEYS[keyIndex].octave}`
        : null,
    currentKeyIndex: keyIndex,
    analysisFreq: targetFreqRef.current || null,
    partial: keyIndex !== null ? partialRef.current : null,
    signalOk,
  };
}