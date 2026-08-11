/**
 * useSnapshotAnalyzer.ts
 *
 * 순간 녹음(스냅샷) 분석 훅
 *
 * 동작 방식:
 * 1. "녹음" 버튼 클릭 → 마이크 열기 (없으면 새로 열기, 있으면 공유)
 * 2. durationMs 동안 오디오 버퍼 수집
 * 3. 수집 완료 후 YIN + HPS 알고리즘으로 피치 분석
 * 4. 결과(음이름, 옥타브, 주파수, cents) 반환
 * 5. 마이크는 공유 스트림이면 닫지 않음
 */

import { useCallback, useRef, useState } from "react";
import {
  applyHannWindow,
  correctOctaveByHPS,
  detectPitchYIN,
  getRMS,
  median,
} from "@/lib/tuner/pitchEngine";
import { freqToCentOffset, PIANO_KEYS } from "./usePitchDetector";

export interface SnapshotResult {
  frequency: number;
  keyIndex: number;
  noteName: string;
  octave: number;
  cents: number;
  confidence: number;
  rms: number;
  durationMs: number;
}

export type SnapshotStatus =
  | "idle"
  | "requesting"   // 마이크 권한 요청 중
  | "recording"    // 녹음 중
  | "analyzing"    // 분석 중
  | "done"         // 완료
  | "error";

export interface UseSnapshotAnalyzerReturn {
  status: SnapshotStatus;
  progress: number;          // 0~1 (녹음 진행률)
  result: SnapshotResult | null;
  error: string | null;
  startSnapshot: (opts?: { durationMs?: number }) => Promise<void>;
  clearResult: () => void;
}

const FFT_SIZE = 8192;
const DEFAULT_DURATION_MS = 1500; // 1.5초 녹음
const FRAME_INTERVAL_MS = 32;     // ~30fps 분석 프레임

export function useSnapshotAnalyzer(
  /** 외부에서 이미 열린 스트림/컨텍스트가 있으면 재사용 */
  sharedStream?: MediaStream | null,
  sharedAudioContext?: AudioContext | null
): UseSnapshotAnalyzerReturn {
  const [status, setStatus] = useState<SnapshotStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SnapshotResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef(false);
  const ownStreamRef = useRef<MediaStream | null>(null);
  const ownCtxRef = useRef<AudioContext | null>(null);

  const clearResult = useCallback(() => {
    setResult(null);
    setStatus("idle");
    setProgress(0);
    setError(null);
  }, []);

  const startSnapshot = useCallback(
    async (opts?: { durationMs?: number }) => {
      const durationMs = opts?.durationMs ?? DEFAULT_DURATION_MS;
      abortRef.current = false;
      setError(null);
      setResult(null);
      setProgress(0);

      // ── 1. 마이크 스트림 확보 ──────────────────────────────────────────
      let stream: MediaStream;
      let ctx: AudioContext;
      let ownedStream = false;
      let ownedCtx = false;

      try {
        if (sharedStream && sharedStream.active) {
          stream = sharedStream;
        } else {
          setStatus("requesting");
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
              audio: {
                echoCancellation: false,
                autoGainControl: false,
                noiseSuppression: false,
              },
            });
          }
          ownedStream = true;
          ownStreamRef.current = stream;
        }

        if (sharedAudioContext && sharedAudioContext.state !== "closed") {
          ctx = sharedAudioContext;
          if (ctx.state === "suspended") await ctx.resume();
        } else {
          ctx = new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext)({ sampleRate: 44100 });
          ownedCtx = true;
          ownCtxRef.current = ctx;
          if (ctx.state === "suspended") await ctx.resume();
        }
      } catch (err) {
        let msg = "마이크 접근 실패";
        if (err instanceof Error) {
          if (
            err.name === "NotAllowedError" ||
            err.name === "PermissionDeniedError"
          ) {
            msg = "마이크 권한이 거부되었습니다.";
          } else if (err.name === "NotFoundError") {
            msg = "마이크를 찾을 수 없습니다.";
          } else {
            msg = err.message;
          }
        }
        setError(msg);
        setStatus("error");
        return;
      }

      // ── 2. 분석기 설정 ────────────────────────────────────────────────
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;

      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);

      const timeBuf = new Float32Array(analyser.fftSize);
      const specBuf = new Float32Array(analyser.frequencyBinCount);

      // ── 3. 녹음 루프 ─────────────────────────────────────────────────
      setStatus("recording");

      const collectedFreqs: number[] = [];
      const collectedCents: number[] = [];
      const collectedKeys: number[] = [];
      const startTime = performance.now();

      await new Promise<void>((resolve) => {
        const tick = () => {
          if (abortRef.current) {
            resolve();
            return;
          }

          const elapsed = performance.now() - startTime;
          setProgress(Math.min(elapsed / durationMs, 1));

          if (elapsed >= durationMs) {
            resolve();
            return;
          }

          analyser.getFloatTimeDomainData(timeBuf as Float32Array<ArrayBuffer>);
          const rms = getRMS(timeBuf);

          if (rms >= 0.003) {
            const windowed = applyHannWindow(timeBuf);
            const fYin = detectPitchYIN(windowed, ctx.sampleRate, 26, 5000, 0.12);
            if (fYin > 0) {
              analyser.getFloatFrequencyData(specBuf as Float32Array<ArrayBuffer>);
              const tempKi = freqToCentOffset(fYin)?.keyIndex ?? 0;
              const fCorrected = correctOctaveByHPS(
                fYin,
                specBuf,
                ctx.sampleRate,
                analyser.fftSize,
                5,
                tempKi
              );
              const r = freqToCentOffset(fCorrected);
              if (r) {
                collectedFreqs.push(fCorrected);
                collectedCents.push(r.cents);
                collectedKeys.push(r.keyIndex);
              }
            }
          }

          setTimeout(tick, FRAME_INTERVAL_MS);
        };
        tick();
      });

      // ── 4. 분석 ──────────────────────────────────────────────────────
      setStatus("analyzing");
      setProgress(1);

      // 자원 정리 (자체 소유한 것만)
      src.disconnect();
      if (ownedStream) {
        stream.getTracks().forEach((t) => t.stop());
        ownStreamRef.current = null;
      }
      if (ownedCtx) {
        ctx.close();
        ownCtxRef.current = null;
      }

      if (abortRef.current || collectedKeys.length === 0) {
        setStatus("idle");
        setProgress(0);
        return;
      }

      // 최빈 건반 선택
      const counts: Record<number, number> = {};
      collectedKeys.forEach((k) => {
        counts[k] = (counts[k] || 0) + 1;
      });
      const [topKeyStr, topCount] = Object.entries(counts).sort(
        (a, b) => Number(b[1]) - Number(a[1])
      )[0];
      const topKey = parseInt(topKeyStr);
      const confidence = Number(topCount) / collectedKeys.length;

      // 해당 건반의 cents 중앙값
      const centsForKey = collectedKeys
        .map((k, i) => (k === topKey ? collectedCents[i] : null))
        .filter((v): v is number => v !== null);

      const freqsForKey = collectedKeys
        .map((k, i) => (k === topKey ? collectedFreqs[i] : null))
        .filter((v): v is number => v !== null);

      const medianCents = Math.round(median(centsForKey) * 10) / 10;
      const medianFreq =
        freqsForKey.sort((a, b) => a - b)[Math.floor(freqsForKey.length / 2)] ??
        PIANO_KEYS[topKey].freq;

      const rmsValues: number[] = [];
      // RMS 평균 (간단히 마지막 값 사용)
      const timeBufFinal = new Float32Array(FFT_SIZE);
      const avgRms = rmsValues.length > 0
        ? rmsValues.reduce((s, v) => s + v, 0) / rmsValues.length
        : 0;
      void timeBufFinal; // unused

      const snapshotResult: SnapshotResult = {
        frequency: medianFreq,
        keyIndex: topKey,
        noteName: PIANO_KEYS[topKey].noteName,
        octave: PIANO_KEYS[topKey].octave,
        cents: medianCents,
        confidence,
        rms: avgRms,
        durationMs,
      };

      setResult(snapshotResult);
      setStatus("done");
    },
    [sharedStream, sharedAudioContext]
  );

  return { status, progress, result, error, startSnapshot, clearResult };
}
