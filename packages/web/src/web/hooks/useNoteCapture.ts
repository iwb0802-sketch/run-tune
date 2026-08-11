/**
 * useNoteCapture.ts  (v1)
 *
 * 하이브리드 피치 캡처 엔진
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  IDLE  →  ATTACK(타격감지)  →  WAIT(150ms)  →             │
 * │  CAPTURE(0.8~1.5초 프레임 수집)  →  ANALYZE  →  DONE      │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 핵심 아이디어 (사용자 설계):
 * 1. 타격 직후 0~150ms는 타격음이 강해 피치 불안정 → 건너뜀
 * 2. 이후 안정 구간에서 20~50 프레임 수집 (YIN + HPS 옥타브 보정)
 * 3. 최빈 건반(keyIndex)을 기준으로 이상치(±IQR*1.5) 제거
 * 4. 남은 cents 값의 중앙값 → 최종 확정
 * 5. 실시간 바늘/스트로브는 별도 훅이 담당 — 이 훅은 "확정값"만 생산
 *
 * 외부 스트림/AudioContext를 공유받아 추가 마이크 권한 요청 없음.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyHannWindow,
  correctOctaveByHPS,
  detectPitchYIN,
  getRMS,
  median,
} from "@/lib/tuner/pitchEngine";
import { freqToCentOffset, PIANO_KEYS } from "./usePitchDetector";

// ── 파라미터 ─────────────────────────────────────────────────────
const ATTACK_RMS_THRESHOLD = 0.015;   // 타격 감지 RMS 임계값
const ATTACK_HOLD_FRAMES   = 3;       // 연속 N 프레임 이상이어야 타격으로 인정
const WAIT_MS              = 150;     // 타격 후 대기 (ms)
const CAPTURE_MS           = 1200;   // 안정 구간 수집 시간 (ms)
const FRAME_INTERVAL_MS    = 32;     // ~30fps
const MIN_FRAMES           = 12;     // 최소 유효 프레임 수
const FFT_SIZE             = 8192;
const SILENCE_RMS          = 0.002;  // 이 이하면 무음으로 간주 → 캡처 중단

// ── 타입 ─────────────────────────────────────────────────────────
export type NoteCapturePhase =
  | "idle"       // 대기
  | "listening"  // 타격 감지 대기 중
  | "attack"     // 타격 감지됨
  | "wait"       // 150ms 대기
  | "capture"    // 안정 구간 수집 중
  | "analyze"    // 분석 중
  | "done"       // 완료
  | "error";

export interface NoteCaptureResult {
  keyIndex:   number;
  noteName:   string;
  octave:     number;
  frequency:  number;   // 중앙값 주파수
  cents:      number;   // 이상치 제거 후 중앙값 cents
  confidence: number;   // 유효 프레임 / 전체 프레임
  frameCount: number;   // 수집된 유효 프레임 수
  rawCents:   number[]; // 디버그용 원본 cents 배열
}

export interface UseNoteCaptureReturn {
  phase:       NoteCapturePhase;
  progress:    number;              // 0~1 (capture 단계 진행률)
  result:      NoteCaptureResult | null;
  error:       string | null;
  /** 자동 감지 시작 (타격 대기 상태로 진입) */
  startListening: () => void;
  /** 즉시 캡처 시작 (타격 감지 없이 바로 수집) */
  startImmediate: () => void;
  stop:        () => void;
  clearResult: () => void;
}

export function useNoteCapture(
  stream:       MediaStream | null,
  audioContext: AudioContext | null,
): UseNoteCaptureReturn {
  const [phase,    setPhase]    = useState<NoteCapturePhase>("idle");
  const [progress, setProgress] = useState(0);
  const [result,   setResult]   = useState<NoteCaptureResult | null>(null);
  const [error,    setError]    = useState<string | null>(null);

  // 내부 상태 ref (setState 없이 루프에서 직접 읽기)
  const phaseRef       = useRef<NoteCapturePhase>("idle");
  const abortRef       = useRef(false);
  const analyserRef    = useRef<AnalyserNode | null>(null);
  const sourceRef      = useRef<MediaStreamAudioSourceNode | null>(null);
  const timeBufRef     = useRef<Float32Array | null>(null);
  const specBufRef     = useRef<Float32Array | null>(null);
  const loopIdRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 수집 버퍼
  const frameKeysRef   = useRef<number[]>([]);
  const frameCentsRef  = useRef<number[]>([]);
  const frameFreqsRef  = useRef<number[]>([]);
  const attackCountRef = useRef(0);
  const captureStartRef= useRef(0);

  // ── 분석기 연결 ───────────────────────────────────────────────
  const ensureAnalyser = useCallback((): boolean => {
    if (!stream || !audioContext) return false;
    if (analyserRef.current) return true;

    try {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      const src = audioContext.createMediaStreamSource(stream);
      src.connect(analyser);
      analyserRef.current = analyser;
      sourceRef.current   = src;
      timeBufRef.current  = new Float32Array(FFT_SIZE);
      specBufRef.current  = new Float32Array(analyser.frequencyBinCount);
      return true;
    } catch {
      return false;
    }
  }, [stream, audioContext]);

  const disconnectAnalyser = useCallback(() => {
    try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
    analyserRef.current = null;
    sourceRef.current   = null;
    timeBufRef.current  = null;
    specBufRef.current  = null;
  }, []);

  // ── 이상치 제거 (IQR 방식) ────────────────────────────────────
  const removeOutliers = (arr: number[]): number[] => {
    if (arr.length < 4) return arr;
    const sorted = [...arr].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lo  = q1 - iqr * 1.5;
    const hi  = q3 + iqr * 1.5;
    return arr.filter(v => v >= lo && v <= hi);
  };

  // ── 단일 프레임 피치 분석 ─────────────────────────────────────
  const analyseFrame = useCallback((): { keyIndex: number; cents: number; freq: number; rms: number } | null => {
    const analyser = analyserRef.current;
    const timeBuf  = timeBufRef.current;
    const specBuf  = specBufRef.current;
    const ctx      = audioContext;
    if (!analyser || !timeBuf || !specBuf || !ctx) return null;

    analyser.getFloatTimeDomainData(timeBuf as Float32Array<ArrayBuffer>);
    const rms = getRMS(timeBuf);
    if (rms < SILENCE_RMS) return null;

    const windowed = applyHannWindow(timeBuf);
    const fYin     = detectPitchYIN(windowed, ctx.sampleRate, 26, 5000, 0.12);
    if (fYin <= 0) return null;

    analyser.getFloatFrequencyData(specBuf as Float32Array<ArrayBuffer>);
    const tempKi     = freqToCentOffset(fYin)?.keyIndex ?? 0;
    const fCorrected = correctOctaveByHPS(fYin, specBuf, ctx.sampleRate, analyser.fftSize, 5, tempKi);
    const r          = freqToCentOffset(fCorrected);
    if (!r) return null;

    return { keyIndex: r.keyIndex, cents: r.cents, freq: fCorrected, rms };
  }, [audioContext]);

  // ── 최종 분석 ─────────────────────────────────────────────────
  const finalizeCapture = useCallback((): NoteCaptureResult | null => {
    const keys  = frameKeysRef.current;
    const cents = frameCentsRef.current;
    const freqs = frameFreqsRef.current;
    if (keys.length < MIN_FRAMES) return null;

    // 최빈 건반 선택
    const counts: Record<number, number> = {};
    keys.forEach(k => { counts[k] = (counts[k] || 0) + 1; });
    const [topKeyStr, topCount] = Object.entries(counts)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    const topKey    = parseInt(topKeyStr);
    const totalFrames = keys.length;

    // 최빈 건반의 cents/freq만 추출
    const keyCents = keys.map((k, i) => k === topKey ? cents[i] : null).filter((v): v is number => v !== null);
    const keyFreqs = keys.map((k, i) => k === topKey ? freqs[i] : null).filter((v): v is number => v !== null);
    if (keyCents.length < 3) return null;

    // IQR 이상치 제거
    const cleanCents = removeOutliers(keyCents);
    const cleanFreqs = removeOutliers(keyFreqs);
    if (cleanCents.length < 3) return null;

    const medCents = Math.round(median(cleanCents) * 10) / 10;
    const sortedFreqs = [...cleanFreqs].sort((a, b) => a - b);
    const medFreq  = sortedFreqs[Math.floor(sortedFreqs.length / 2)];
    const confidence = Number(topCount) / totalFrames;

    return {
      keyIndex:   topKey,
      noteName:   PIANO_KEYS[topKey].noteName,
      octave:     PIANO_KEYS[topKey].octave,
      frequency:  medFreq,
      cents:      medCents,
      confidence,
      frameCount: cleanCents.length,
      rawCents:   keyCents,
    };
  }, []);

  // ── 루프 중단 ─────────────────────────────────────────────────
  const stopLoop = useCallback(() => {
    abortRef.current = true;
    if (loopIdRef.current) { clearTimeout(loopIdRef.current); loopIdRef.current = null; }
  }, []);

  const stop = useCallback(() => {
    stopLoop();
    disconnectAnalyser();
    phaseRef.current = "idle";
    setPhase("idle");
    setProgress(0);
    frameKeysRef.current  = [];
    frameCentsRef.current = [];
    frameFreqsRef.current = [];
    attackCountRef.current = 0;
  }, [stopLoop, disconnectAnalyser]);

  const clearResult = useCallback(() => {
    setResult(null);
    setError(null);
    setPhase("idle");
    setProgress(0);
    phaseRef.current = "idle";
  }, []);

  // ── 캡처 루프 (CAPTURE 단계) ──────────────────────────────────
  const runCaptureLoop = useCallback(() => {
    captureStartRef.current = performance.now();
    frameKeysRef.current  = [];
    frameCentsRef.current = [];
    frameFreqsRef.current = [];

    const tick = () => {
      if (abortRef.current) return;

      const elapsed = performance.now() - captureStartRef.current;
      const prog    = Math.min(elapsed / CAPTURE_MS, 1);
      setProgress(prog);

      const frame = analyseFrame();
      if (frame) {
        frameKeysRef.current.push(frame.keyIndex);
        frameCentsRef.current.push(frame.cents);
        frameFreqsRef.current.push(frame.freq);
      }

      if (elapsed < CAPTURE_MS) {
        loopIdRef.current = setTimeout(tick, FRAME_INTERVAL_MS);
      } else {
        // 분석 단계
        phaseRef.current = "analyze";
        setPhase("analyze");
        const r = finalizeCapture();
        if (r) {
          setResult(r);
          phaseRef.current = "done";
          setPhase("done");
        } else {
          setError("충분한 피치 데이터를 수집하지 못했습니다. 건반을 더 길게 눌러주세요.");
          phaseRef.current = "error";
          setPhase("error");
        }
        setProgress(1);
        disconnectAnalyser();
      }
    };
    tick();
  }, [analyseFrame, finalizeCapture, disconnectAnalyser]);

  // ── 대기 후 캡처 시작 ─────────────────────────────────────────
  const startCaptureAfterWait = useCallback(() => {
    phaseRef.current = "wait";
    setPhase("wait");
    loopIdRef.current = setTimeout(() => {
      if (abortRef.current) return;
      phaseRef.current = "capture";
      setPhase("capture");
      runCaptureLoop();
    }, WAIT_MS);
  }, [runCaptureLoop]);

  // ── 타격 감지 루프 ────────────────────────────────────────────
  const runAttackLoop = useCallback(() => {
    attackCountRef.current = 0;

    const tick = () => {
      if (abortRef.current) return;
      if (phaseRef.current !== "listening") return;

      const analyser = analyserRef.current;
      const timeBuf  = timeBufRef.current;
      if (!analyser || !timeBuf) return;

      analyser.getFloatTimeDomainData(timeBuf as Float32Array<ArrayBuffer>);
      const rms = getRMS(timeBuf);

      if (rms >= ATTACK_RMS_THRESHOLD) {
        attackCountRef.current++;
        if (attackCountRef.current >= ATTACK_HOLD_FRAMES) {
          // 타격 감지!
          phaseRef.current = "attack";
          setPhase("attack");
          startCaptureAfterWait();
          return;
        }
      } else {
        attackCountRef.current = 0;
      }

      loopIdRef.current = setTimeout(tick, FRAME_INTERVAL_MS);
    };
    tick();
  }, [startCaptureAfterWait]);

  // ── 공개 API ──────────────────────────────────────────────────

  /** 자동 감지: 타격 대기 상태로 진입 */
  const startListening = useCallback(() => {
    stopLoop();
    abortRef.current = false;
    setResult(null);
    setError(null);
    setProgress(0);

    if (!ensureAnalyser()) {
      setError("마이크가 연결되어 있지 않습니다. 먼저 마이크를 시작해 주세요.");
      phaseRef.current = "error";
      setPhase("error");
      return;
    }

    phaseRef.current = "listening";
    setPhase("listening");
    runAttackLoop();
  }, [stopLoop, ensureAnalyser, runAttackLoop]);

  /** 즉시 캡처: 타격 감지 없이 바로 수집 시작 */
  const startImmediate = useCallback(() => {
    stopLoop();
    abortRef.current = false;
    setResult(null);
    setError(null);
    setProgress(0);

    if (!ensureAnalyser()) {
      setError("마이크가 연결되어 있지 않습니다. 먼저 마이크를 시작해 주세요.");
      phaseRef.current = "error";
      setPhase("error");
      return;
    }

    phaseRef.current = "capture";
    setPhase("capture");
    runCaptureLoop();
  }, [stopLoop, ensureAnalyser, runCaptureLoop]);

  // stream/audioContext가 바뀌면 분석기 재연결
  useEffect(() => {
    disconnectAnalyser();
    // listening 중이었으면 재시작
    if (phaseRef.current === "listening") {
      if (ensureAnalyser()) runAttackLoop();
    }
  }, [stream, audioContext, disconnectAnalyser, ensureAnalyser, runAttackLoop]);

  // 언마운트 시 정리
  useEffect(() => () => { stop(); }, [stop]);

  return { phase, progress, result, error, startListening, startImmediate, stop, clearResult };
}
