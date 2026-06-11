/**
 * useStrobeDetector.ts (v3)
 * 자동피치(usePitchDetector)와 동일한 알고리즘 사용 — YIN + HPS 옥타브 보정.
 * 결과를 스트로브 UI용으로 가공할 뿐, 인식 방식은 자동피치와 완전히 동일.
 *
 * 흐름:
 * 1. referenceKeyIndex(타겟 건반)가 정해지면 그 건반 주변만 cents 측정
 * 2. RMS 피크 후 안정 구간 동안 cents 중앙값 → strobeCents 출력
 */

import { useEffect, useRef, useState } from "react";
import { PIANO_KEYS, freqToCentOffset } from "./usePitchDetector";
import {
  applyHannWindow, detectPitchYIN, correctOctaveByHPS,
  getRMS, median,
} from "@/lib/tuner/pitchEngine";

export interface StrobeState {
  strobeCents: number | null;
  isCapturing: boolean;
  captureProgress: number;
  currentNote: string | null;
  currentKeyIndex: number | null;
  analysisFreq: number | null;
  partial: number | null;
}

export function useStrobeDetector(
  stream: MediaStream | null,
  audioContext: AudioContext | null,
  stableDurationMs: number = 800,
  fftSize: 4096 | 8192 = 4096,
  referenceKeyIndex: number | null = null
): StrobeState {
  const [strobeCents, setStrobeCents] = useState<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState(0);
  const [currentNote, setCurrentNote] = useState<string | null>(null);
  const [currentKeyIndex, setCurrentKeyIndex] = useState<number | null>(null);
  const [analysisFreq, setAnalysisFreq] = useState<number | null>(null);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const specRef = useRef<Float32Array | null>(null);

  const lastKeyRef = useRef<number | null>(null);
  const peakRmsRef = useRef(0);
  const captureStartRef = useRef<number | null>(null);
  const captureBufferRef = useRef<number[]>([]);

  const refKeyRef = useRef<number | null>(referenceKeyIndex);
  useEffect(() => {
    refKeyRef.current = referenceKeyIndex;
    if (referenceKeyIndex !== null) {
      setAnalysisFreq(PIANO_KEYS[referenceKeyIndex].freq);
    } else {
      setAnalysisFreq(null);
    }
  }, [referenceKeyIndex]);

  const PEAK_RATIO = 0.55;
  const MIN_SAMPLES = 8;

  useEffect(() => {
    if (!stream || !audioContext) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
      analyserRef.current = null;
      bufRef.current = null;
      specRef.current = null;
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
    specRef.current = new Float32Array(analyser.frequencyBinCount);

    const detect = () => {
      const an = analyserRef.current;
      const buf = bufRef.current;
      const spec = specRef.current;
      if (!an || !buf || !spec) { rafRef.current = requestAnimationFrame(detect); return; }

      an.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
      const rms = getRMS(buf);

      if (rms < 0.003) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      // 새 건반 감지 (RMS 급상승)
      if (rms > peakRmsRef.current * 1.5 && rms > 0.02) {
        peakRmsRef.current = rms;
        captureStartRef.current = null;
        captureBufferRef.current = [];
        setIsCapturing(false);
        setCaptureProgress(0);
        setStrobeCents(null);
      } else if (rms > peakRmsRef.current) {
        peakRmsRef.current = rms;
      }

      const refKey = refKeyRef.current;
      if (refKey === null) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      if (lastKeyRef.current !== null && lastKeyRef.current !== refKey) {
        captureBufferRef.current = [];
        captureStartRef.current = null;
        setStrobeCents(null);
      }
      lastKeyRef.current = refKey;
      setCurrentNote(`${PIANO_KEYS[refKey].noteName}${PIANO_KEYS[refKey].octave}`);
      setCurrentKeyIndex(refKey);

      // 안정 구간(피크 후 하강)에서만 수집
      const isStable = rms < peakRmsRef.current * PEAK_RATIO && peakRmsRef.current > 0.015;
      if (!isStable) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      // === 자동피치와 동일한 알고리즘: Hann + YIN + HPS ===
      const winBuf = applyHannWindow(buf);
      const fYin = detectPitchYIN(winBuf, audioContext.sampleRate, 26, 5000, 0.12);
      if (fYin <= 0) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }
      an.getFloatFrequencyData(spec as Float32Array<ArrayBuffer>);
      const fCorrected = correctOctaveByHPS(fYin, spec, audioContext.sampleRate, an.fftSize, 5);

      const r = freqToCentOffset(fCorrected);
      if (!r) { rafRef.current = requestAnimationFrame(detect); return; }

      // 타겟 건반에 대한 cent 편차 (다른 건반이면 옥타브 차 고려)
      const targetFreq = PIANO_KEYS[refKey].freq;
      const cent = 1200 * Math.log2(fCorrected / targetFreq);

      // 옥타브 차 이상 벗어나면 무시 (잘못된 건반 검출)
      if (Math.abs(cent) > 80) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      if (captureStartRef.current === null) {
        captureStartRef.current = Date.now();
        setIsCapturing(true);
      }
      captureBufferRef.current.push(cent);

      const elapsed = Date.now() - captureStartRef.current;
      setCaptureProgress(Math.min(elapsed / stableDurationMs, 1));

      if (elapsed >= stableDurationMs && captureBufferRef.current.length >= MIN_SAMPLES) {
        const med = Math.round(median(captureBufferRef.current) * 10) / 10;
        setStrobeCents(med);
        setIsCapturing(false);
        setCaptureProgress(0);
        captureBufferRef.current = [];
        captureStartRef.current = null;
        peakRmsRef.current = 0;
      }

      rafRef.current = requestAnimationFrame(detect);
    };

    rafRef.current = requestAnimationFrame(detect);

    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      try { source.disconnect(); } catch { /* ignore */ }
      analyserRef.current = null;
      bufRef.current = null;
      specRef.current = null;
      peakRmsRef.current = 0;
      captureStartRef.current = null;
      captureBufferRef.current = [];
    };
  }, [stream, audioContext, stableDurationMs, fftSize]);

  return {
    strobeCents, isCapturing, captureProgress,
    currentNote, currentKeyIndex, analysisFreq,
    partial: 1,
  };
}
