/**
 * useCompositeTuner21.ts — 복합탭 2-1 엔진 (복합2 엔진 useCompositeTuner.ts 를 복사해 3가지만 고침)
 *
 *  ① 중·고음 +2¢ 치우침 제거
 *     - 실시간 값(liveCents)은 Goertzel 단독. coarse scan 뒤 0.1¢ 단위로 정밀 탐색한다.
 *     - YIN 은 값 계산에 섞지 않고 교차검증(게이트)에만 쓴다.
 *  ② 고음(64번~) 저장 오류 수정용 "타건 단위" 값 제공
 *     - 새 타건(onset)을 RMS 급상승으로 감지하고, 해머 소리 구간(ONSET_SKIP_MS)을 버린 뒤
 *       그 타건의 프레임만 모아 중앙값(strikeCents)을 만든다.
 *     - 한 타건에서 값이 충분히 모이면 onStrike 콜백을 정확히 1회 호출한다.
 *     - 신호가 잠깐 끊겼다 다시 잡히는 것(dropout)은 새 타건으로 보지 않는다.
 *  ③ 저음 흔들림 감소
 *     - 저음(1~27번)은 8192 샘플 창으로 분석, 중·고음은 같은 버퍼의 최근 4096 샘플만 사용(반응속도 유지).
 *     - 배음 선택은 매 프레임 바뀌는 selectBestPartial 대신 고정 targetPartial 사용.
 *
 * 복합2(useCompositeTuner.ts)는 그대로 두고, 이 파일은 /composite2-1 에서만 쓴다.
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
} from "@/lib/tuner/pitchEngine";
import type { CompositeResult } from "./useCompositeTuner";

export interface Composite21Result extends CompositeResult {
  /** 현재 타건 번호(새 타건마다 +1) */
  strikeId: number;
  /** 현재 타건에서 해머 구간을 뺀 프레임들의 중앙값. 아직 모이지 않았으면 null */
  strikeCents: number | null;
}

export interface UseCompositeTuner21Return {
  isListening: boolean;
  result: Composite21Result | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: string | null;
}

const CROSS_VALID_THRESHOLD     = 8;    // ¢ 중음
const CROSS_VALID_THRESHOLD_LOW = 15;   // ¢ 저음 ≤26
const STABLE_DURATION_MS        = 900;  // 중음
const STABLE_DURATION_MS_HIGH   = 500;  // 고음 — 빠른 decay
const MIN_SAMPLES               = 8;
const MIN_SAMPLES_HIGH          = 6;    // 고음 — 짧은 sustain
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
const FINE_STEP                 = 0.1;  // ① 정밀 탐색 스텝 (¢)
const SCAN_RANGE_CENTS          = 50;   // 중/저음 ±¢
const SCAN_RANGE_CENTS_HIGH     = 80;   // 고음 ±¢ (넓게)
const HIGH_KEY_THRESHOLD        = 52;   // C5 이상 (keyIndex 52+)
const LOW_KEY_MAX               = 26;   // 저음 구간 (keyIndex 0~26)
const LONG_WINDOW               = 8192; // ③ 저음 분석 창
const SHORT_WINDOW              = 4096; // 중·고음 분석 창

// ② 타건 단위 측정
const ONSET_RATIO        = 1.6;   // 직전 프레임들 최소 RMS 대비 이만큼 커지면 새 타건 후보
const ONSET_JUMP_RATIO   = 2.5;   // 이만큼 급증하면 바로 새 타건 (울리는 중 다시 친 경우 포함)
const ONSET_PEAK_FRAC    = 0.6;   // 급증이 작으면(1.6~2.5배) 직전 타건 최대 음량의 60% 이상일 때만 새 타건
                                  //   → 실녹음 고음의 맥놀이로 음량이 다시 부푸는 것(최대의 절반 이하, 1.9배 이하)을 타건으로 세지 않음
const ONSET_HISTORY      = 4;     // 비교할 직전 프레임 수(≈67ms)
const ONSET_MIN_RMS_MULT = 1.5;   // 새 타건은 게이트(rmsMin)의 1.5배 이상 (3배는 작은 소리 고음을 놓침)
const ONSET_REFRACTORY_MS = 250;  // 타건 감지 후 이 시간 동안은 다시 감지하지 않음
const ONSET_SKIP_MS      = 130;   // 해머 소리 구간: 타건 감지 후 이 시간 동안의 프레임은 버림 (4096 창 ≈ 93ms 포함)
const STRIKE_COLLECT_MS  = 500;   // 해머 구간 뒤 이 시간만큼 모이면 타건값 확정 (맥놀이 1주기 이상을 평균)
const STRIKE_MIN_FRAMES  = 4;     // 타건값 확정 최소 프레임 수

type StrikeSample = { t: number; cents: number; late: boolean };

/** 타건 1회의 대표값. 해머 구간 뒤 프레임이 충분하면 그 중앙값,
 *  짧은 고음처럼 소리가 빨리 끝나 부족하면 그 타건의 마지막 프레임들(가장 안정된 끝부분) 중앙값. */
function strikeValue(samples: StrikeSample[]): number | null {
  const late = samples.filter(s => s.late);
  const pick = late.length >= STRIKE_MIN_FRAMES ? late
    : samples.length >= STRIKE_MIN_FRAMES ? samples.slice(samples.length - STRIKE_MIN_FRAMES)
    : null;
  return pick ? Math.round(median(pick.map(s => s.cents)) * 10) / 10 : null;
}

// YIN이 잡은 주파수를 targetKeyIndex 기준 절대 cent로 환산
function yinFreqToCents(fYin: number, baseFreq: number): number | null {
  if (fYin <= 0 || baseFreq <= 0) return null;
  let f = fYin;
  while (f > baseFreq * 1.5) f /= 2;
  while (f < baseFreq * 0.67) f *= 2;
  return Math.round(1200 * Math.log2(f / baseFreq) * 10) / 10;
}

/** targetFreq 주변을 coarse scan 한 뒤 최고점 주변 ±step 을 FINE_STEP 으로 다시 훑는다. 반환: 최고점 주파수 */
function scanPeak(buf: Float32Array, sr: number, targetFreq: number, step: number, rangeCents: number): number {
  const scanRange = Math.round(rangeCents / step);
  let bestC = 0;
  let bestMag = -1;
  for (let i = -scanRange; i <= scanRange; i++) {
    const c = i * step;
    const mag = goertzel(buf, sr, targetFreq * Math.pow(2, c / 1200)).magnitude;
    if (mag > bestMag) { bestMag = mag; bestC = c; }
  }
  const fineN = Math.round(step / FINE_STEP);
  let fineC = bestC;
  for (let j = -fineN; j <= fineN; j++) {
    if (j === 0) continue;
    const c = bestC + j * FINE_STEP;
    const mag = goertzel(buf, sr, targetFreq * Math.pow(2, c / 1200)).magnitude;
    if (mag > bestMag) { bestMag = mag; fineC = c; }
  }
  return targetFreq * Math.pow(2, fineC / 1200);
}

export function useCompositeTuner21(
  targetKeyIndex: number,
  onConfirmed?: (result: Composite21Result) => void,
  onStrike?: (cents: number, keyIndex: number) => void,
): UseCompositeTuner21Return {
  const [isListening, setIsListening] = useState(false);
  const [result, setResult] = useState<Composite21Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef      = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const rafRef      = useRef<number | null>(null);
  const bufRef      = useRef<Float32Array | null>(null);
  const isRunningRef = useRef(false);

  // 캡처 상태 (복합2와 동일)
  const peakRmsRef       = useRef(0);
  const captureStartRef  = useRef<number | null>(null);
  const captureBufferRef = useRef<number[]>([]);

  // ② 타건 상태
  const rmsHistoryRef    = useRef<number[]>([]);
  const strikeIdRef      = useRef(0);
  const strikeAtRef      = useRef<number | null>(null);
  const strikePeakRef    = useRef(0);   // 현재 타건 이후 최대 RMS
  const strikeSamplesRef = useRef<StrikeSample[]>([]);
  const strikeEmittedRef = useRef(false);

  const targetKeyRef = useRef(targetKeyIndex);
  useEffect(() => { targetKeyRef.current = targetKeyIndex; }, [targetKeyIndex]);

  const onConfirmedRef = useRef(onConfirmed);
  useEffect(() => { onConfirmedRef.current = onConfirmed; }, [onConfirmed]);
  const onStrikeRef = useRef(onStrike);
  useEffect(() => { onStrikeRef.current = onStrike; }, [onStrike]);

  const resetStrike = useCallback(() => {
    strikeAtRef.current      = null;
    strikeSamplesRef.current = [];
    strikeEmittedRef.current = false;
  }, []);

  // 건반 바뀌면 캡처·타건 리셋
  useEffect(() => {
    peakRmsRef.current       = 0;
    captureStartRef.current  = null;
    captureBufferRef.current = [];
    rmsHistoryRef.current    = [];
    strikePeakRef.current    = 0;
    strikeAtRef.current      = null;
    strikeSamplesRef.current = [];
    strikeEmittedRef.current = false;
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
    resetStrike();
    rmsHistoryRef.current = [];
    setIsListening(false);
    setResult(null);
  }, [resetCapture, resetStrike]);

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
      analyser.fftSize = LONG_WINDOW;
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
        const full     = bufRef.current;
        if (!ctx || !analyser || !full) return;

        if (ctx.state === "suspended") ctx.resume().catch(() => {});

        analyser.getFloatTimeDomainData(full as Float32Array<ArrayBuffer>);

        const ki       = targetKeyRef.current;
        const isLow    = ki <= LOW_KEY_MAX;
        const isHigh   = ki >= HIGH_KEY_THRESHOLD;
        const rmsMin   = isLow ? MIN_RMS_LOW : isHigh ? MIN_RMS_HIGH : MIN_RMS;
        const now      = Date.now();

        // ③ 저음은 8192 전체, 중·고음은 최근 4096 샘플
        const buf = isLow || full.length <= SHORT_WINDOW ? full : full.subarray(full.length - SHORT_WINDOW);
        // 음량(게이트·타건 감지·안정 판정)은 복합2와 같게 항상 최근 4096 샘플로 계산
        //   (8192 전체로 재면 타건 직후 앞쪽 무음이 섞여 피크가 낮게 잡히고, 작은 저음이 안정 판정에 못 들어간다)
        const rms = getRMS(full.length <= SHORT_WINDOW ? full : full.subarray(full.length - SHORT_WINDOW));

        // ② 새 타건 감지 (게이트와 무관하게 RMS 이력으로 판단)
        const hist = rmsHistoryRef.current;
        const prevMin = hist.length > 0 ? Math.min(...hist) : 0;
        const sinceStrike = strikeAtRef.current === null ? Infinity : now - strikeAtRef.current;
        const jump = prevMin > 0 ? rms / prevMin : Infinity;
        const isOnset = rms >= rmsMin * ONSET_MIN_RMS_MULT
          && jump > ONSET_RATIO
          && (jump >= ONSET_JUMP_RATIO || rms >= strikePeakRef.current * ONSET_PEAK_FRAC)
          && sinceStrike >= ONSET_REFRACTORY_MS;
        hist.push(rms);
        if (hist.length > ONSET_HISTORY) hist.shift();
        if (rms > strikePeakRef.current) strikePeakRef.current = rms;

        if (isOnset) {
          // 끝나지 않은 직전 타건이 최소 프레임을 모았으면 그 값으로 확정
          const prev = strikeValue(strikeSamplesRef.current);
          if (!strikeEmittedRef.current && prev !== null && strikeAtRef.current !== null) {
            onStrikeRef.current?.(prev, ki);
          }
          strikeIdRef.current += 1;
          strikePeakRef.current    = 0;
          strikeAtRef.current      = now;
          strikeSamplesRef.current = [];
          strikeEmittedRef.current = false;
        }

        if (rms < rmsMin) {
          // 소리가 끝남 — 아직 확정 못한 타건은 모인 만큼으로 확정 (최소 프레임 충족 시)
          const last = strikeValue(strikeSamplesRef.current);
          if (!strikeEmittedRef.current && strikeAtRef.current !== null && last !== null) {
            strikeEmittedRef.current = true;
            onStrikeRef.current?.(last, ki);
          }
          resetCapture();
          setResult(null);
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        const baseFreq = PIANO_KEYS[ki].freq;
        const sr       = ctx.sampleRate;

        // ── 1. YIN → 게이트 전용 ─────────────────────────────────────
        const winBuf = applyHannWindow(buf);
        const yinFmax      = isHigh ? 8000 : 5000;
        const yinThreshold = isHigh ? 0.10 : 0.12;
        const fYin    = detectPitchYIN(winBuf, sr, 26, yinFmax, yinThreshold);
        const yinCents = fYin > 0 ? yinFreqToCents(fYin, baseFreq) : null;

        // ── 2. Goertzel → 고정 배음(targetPartial) 기반 cent ─────────
        const partial    = targetPartial(ki);
        const targetFreq = baseFreq * partial;

        const gTarget = goertzel(buf, sr, targetFreq);
        const magLo   = goertzel(buf, sr, targetFreq * Math.pow(2, -1.5 / 12)).magnitude;
        const magHi   = goertzel(buf, sr, targetFreq * Math.pow(2,  1.5 / 12)).magnitude;
        const domRatio = isHigh ? 1.1 : DOMINANCE_RATIO;
        const signalOk = gTarget.magnitude > Math.max(magLo, magHi, 1e-9) * domRatio;

        const step      = isLow ? COARSE_STEP_LOW : isHigh ? COARSE_STEP_HIGH : COARSE_STEP_MID;
        const scanCents = isHigh ? SCAN_RANGE_CENTS_HIGH : SCAN_RANGE_CENTS;
        const bestFreq  = scanPeak(winBuf, sr, targetFreq, step, scanCents);
        const measuredBaseHz = bestFreq / partial;
        const goertzelCents  = Math.round(1200 * Math.log2(measuredBaseHz / baseFreq) * 10) / 10;

        // ── 3. 교차검증 (게이트) ─────────────────────────────────────
        const crossValid = isHigh
          ? (signalOk || yinCents !== null)
          : (signalOk && yinCents !== null
              && Math.abs(yinCents - goertzelCents) <= (isLow ? CROSS_VALID_THRESHOLD_LOW : CROSS_VALID_THRESHOLD));

        // ① 값은 Goertzel 단독
        const liveCents = goertzelCents;

        // ── 4. 스트로브 안정화 (복합2와 동일한 규칙) ─────────────────
        const peakThreshold  = isHigh ? PEAK_THRESHOLD_HIGH : PEAK_THRESHOLD;
        const peakRatio      = isHigh ? PEAK_RATIO_HIGH : PEAK_RATIO;
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
          if (captureStartRef.current === null) captureStartRef.current = now;
          // YIN 게이트: YIN 이 값을 냈는데 B 와 크게 다르면 그 프레임은 버린다. YIN 이 못 잡은 프레임은 B 도미넌스(signalOk)로 판단.
          if (crossValid || (signalOk && yinCents === null)) captureBufferRef.current.push(liveCents);
          const elapsed = now - captureStartRef.current;
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

        // ② 현재 타건의 해머 구간 이후 프레임만 모은다
        //    (해머 구간 프레임도 보관하되 표시는 late=false — 소리가 짧을 때만 끝부분을 대신 쓴다)
        if (strikeAtRef.current !== null && signalOk) {
          strikeSamplesRef.current.push({ t: now, cents: liveCents, late: now - strikeAtRef.current >= ONSET_SKIP_MS });
        }
        const ss = strikeSamplesRef.current;
        const lateSs = ss.filter(s => s.late);
        const strikeCents = lateSs.length > 0 ? Math.round(median(lateSs.map(s => s.cents)) * 10) / 10 : null;
        if (!strikeEmittedRef.current && strikeCents !== null && lateSs.length >= STRIKE_MIN_FRAMES
            && lateSs[lateSs.length - 1].t - lateSs[0].t >= STRIKE_COLLECT_MS) {
          strikeEmittedRef.current = true;
          onStrikeRef.current?.(strikeCents, ki);
        }

        const newResult: Composite21Result = {
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
          strikeId: strikeIdRef.current,
          strikeCents,
        };

        setResult(newResult);
        if (finalCents !== null) onConfirmedRef.current?.(newResult);

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
  }, [resetCapture]);

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
        resetStrike();
        setResult(null);
        try { await startListening(); } catch {}
      } else if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch {}
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [startListening, resetCapture, resetStrike]);

  useEffect(() => () => { stopListening(); }, [stopListening]);

  return { isListening, result, startListening, stopListening, error };
}
