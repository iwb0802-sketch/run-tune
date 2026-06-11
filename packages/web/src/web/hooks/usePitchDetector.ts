/**
 * usePitchDetector.ts
 * iOS Safari 완전 호환 + PT-100식 옵타브 보정
 *
 * 변경점 (v2):
 * - YIN으로 1차 추정 → HPS 스펙트럼 비교로 옵타브 오류 보정 (A3→A5 해결)
 * - Hann 윈도우 적용 (스펙트럼 누설 ↓)
 * - 주파수 범위 제한 (27Hz–5000Hz)
 * - 기존 majority + median 안정화 로직 유지
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyHannWindow, detectPitchYIN, correctOctaveByHPS,
  getRMS, median,
} from "@/lib/tuner/pitchEngine";

export const PIANO_KEYS = Array.from({ length: 88 }, (_, i) => {
  const midi = i + 21;
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midi / 12) - 1;
  const noteName = noteNames[midi % 12];
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const isBlack = [1, 3, 6, 8, 10].includes(midi % 12);
  return { midi, keyNumber: i + 1, noteName, octave, freq, isBlack };
});

export function freqToCentOffset(freq: number): {
  keyIndex: number; cents: number; note: typeof PIANO_KEYS[0];
} | null {
  if (freq <= 0) return null;
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const midiRound = Math.round(midiFloat);
  const keyIndex = midiRound - 21;
  if (keyIndex < 0 || keyIndex > 87) return null;
  return { keyIndex, cents: (midiFloat - midiRound) * 100, note: PIANO_KEYS[keyIndex] };
}

export interface PitchResult {
  frequency: number; keyIndex: number; noteName: string;
  octave: number; cents: number; confidence: number;
  rms?: number;
}

export interface UsePitchDetectorReturn {
  isListening: boolean;
  currentPitch: PitchResult | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: string | null;
  isRecovering: boolean;
  stream: MediaStream | null;
  audioContext: AudioContext | null;
}

export function usePitchDetector(
  onPitchDetected?: (result: PitchResult) => void,
  fftSize: 4096 | 8192 = 4096
): UsePitchDetectorReturn {
  const [isListening, setIsListening] = useState(false);
  const [currentPitch, setCurrentPitch] = useState<PitchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const specRef = useRef<Float32Array | null>(null);
  const isRunningRef = useRef(false);

  const recentKeys = useRef<number[]>([]);
  const recentCents = useRef<number[]>([]);
  const WINDOW = 15;
  const MIN_MATCH = 8;

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
    setIsListening(false);
    setCurrentPitch(null);
    setIsRecovering(false);
  }, []);

  const startListening = useCallback(async () => {
    try {
      setError(null);
      setIsRecovering(false);

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

        if (rms < 0.003) {
          recentKeys.current = [];
          recentCents.current = [];
          setCurrentPitch(null);
          rafRef.current = requestAnimationFrame(detect);
          return;
        }

        // Hann 윈도우 적용한 시간영역 버퍼로 YIN
        const winBuf = applyHannWindow(buf);
        const fYin = detectPitchYIN(winBuf, ctx.sampleRate, 26, 5000, 0.12);

        if (fYin > 0) {
          // 스펙트럼 가져와서 HPS 옵타브 보정 (고음 keyIndex >= 60은 비활성화)
          analyser.getFloatFrequencyData(spec as Float32Array<ArrayBuffer>);
          const tempKi = freqToCentOffset(fYin)?.keyIndex ?? 0;
          const fCorrected = correctOctaveByHPS(fYin, spec, ctx.sampleRate, analyser.fftSize, 5, tempKi);

          const r = freqToCentOffset(fCorrected);
          if (r) {
            recentKeys.current.push(r.keyIndex);
            recentCents.current.push(r.cents);
            if (recentKeys.current.length > WINDOW) {
              recentKeys.current.shift();
              recentCents.current.shift();
            }

            const counts: Record<number, number> = {};
            recentKeys.current.forEach(k => { counts[k] = (counts[k] || 0) + 1; });
            const [topKey, topCount] = Object.entries(counts)
              .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
            const stableKi = parseInt(topKey);

            if (Number(topCount) >= MIN_MATCH) {
              const centsArr = recentKeys.current
                .map((k, i) => k === stableKi ? recentCents.current[i] : null)
                .filter((v): v is number => v !== null);
              const stableCents = Math.round(median(centsArr) * 10) / 10;

              const result: PitchResult = {
                frequency: fCorrected,
                keyIndex: stableKi,
                noteName: PIANO_KEYS[stableKi].noteName,
                octave: PIANO_KEYS[stableKi].octave,
                cents: stableCents,
                confidence: Number(topCount) / WINDOW,
                rms,
              };

              if (result.confidence >= 0.55) {
                setCurrentPitch(result);
                onPitchDetected?.(result);
              }
            }
          }
        }

        rafRef.current = requestAnimationFrame(detect);
      };

      rafRef.current = requestAnimationFrame(detect);
    } catch (err) {
      let msg = "마이크 접근 실패";
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          msg = "마이크 권한이 거부되었습니다. 설정 > Safari > 마이크를 허용해 주세요.";
        } else if (err.name === "NotFoundError") {
          msg = "마이크를 찾을 수 없습니다.";
        } else if (err.name === "NotReadableError") {
          msg = "마이크를 사용할 수 없습니다. 다른 앱이 마이크를 사용 중일 수 있습니다.";
        } else {
          msg = err.message;
        }
      }
      setError(msg);
      setIsListening(false);
    }
  }, [onPitchDetected, fftSize]);

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
        setCurrentPitch(null);
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
    isListening, currentPitch, startListening, stopListening, error, isRecovering,
    stream: streamRef.current,
    audioContext: ctxRef.current,
  };
}
