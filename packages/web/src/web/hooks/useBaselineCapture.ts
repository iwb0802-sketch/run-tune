import { useCallback, useEffect, useRef, useState } from "react";

import { useNoteCapture, type NoteCaptureResult } from "./useNoteCapture";

export type BaselineCapturePhase = "idle" | "arming" | "capturing" | "analyzing" | "done" | "error";

export interface BaselineCaptureResult extends NoteCaptureResult {
  audioBlob: Blob;
  mimeType: string;
}

interface UseBaselineCaptureReturn {
  phase: BaselineCapturePhase;
  progress: number;
  result: BaselineCaptureResult | null;
  error: string | null;
  start: () => void;
  cancel: () => void;
  clearResult: () => void;
}

function preferredMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];

  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function toPhase(noteCapturePhase: string): BaselineCapturePhase {
  switch (noteCapturePhase) {
    case "listening":
    case "attack":
    case "wait":
      return "arming";
    case "capture":
      return "capturing";
    case "analyze":
      return "analyzing";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/**
 * 한 번의 기준 타건을 녹음하고, 타격 후 안정 구간의 정밀 분석값을 함께 반환한다.
 * 오디오는 재생을 위해 원본으로 보관하고, 기준값은 useNoteCapture의 중앙값 분석을 사용한다.
 */
export function useBaselineCapture(
  stream: MediaStream | null,
  audioContext: AudioContext | null,
): UseBaselineCaptureReturn {
  const noteCapture = useNoteCapture(stream, audioContext);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [result, setResult] = useState<BaselineCaptureResult | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const captureVersionRef = useRef(0);
  const resultEmittedRef = useRef(false);

  const stopRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      // 녹음 중단 실패는 후속 분석 결과를 막지 않는다.
    }
  }, []);

  const cancel = useCallback(() => {
    captureVersionRef.current += 1;
    resultEmittedRef.current = false;
    stopRecorder();
    noteCapture.stop();
    recorderRef.current = null;
    chunksRef.current = [];
    setAudioBlob(null);
    setResult(null);
    setRecordingError(null);
  }, [noteCapture, stopRecorder]);

  const clearResult = useCallback(() => {
    resultEmittedRef.current = false;
    noteCapture.clearResult();
    setAudioBlob(null);
    setResult(null);
    setRecordingError(null);
  }, [noteCapture]);

  const start = useCallback(() => {
    if (!stream) {
      setRecordingError("먼저 마이크를 켜 주세요.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setRecordingError("이 브라우저에서는 기준 녹음을 지원하지 않습니다.");
      return;
    }

    cancel();
    chunksRef.current = [];
    resultEmittedRef.current = false;

    try {
      const captureVersion = ++captureVersionRef.current;
      const mimeType = preferredMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (captureVersion !== captureVersionRef.current) return;
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (captureVersion === captureVersionRef.current) {
          setRecordingError("오디오 녹음 중 오류가 발생했습니다.");
        }
      };
      recorder.onstop = () => {
        if (captureVersion !== captureVersionRef.current) return;
        const blobType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: blobType });
        setAudioBlob(blob.size > 0 ? blob : null);
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecordingError(null);
      noteCapture.startListening();
    } catch {
      setRecordingError("기준 녹음을 시작할 수 없습니다.");
    }
  }, [cancel, noteCapture, stream]);

  useEffect(() => {
    if (noteCapture.phase === "done" || noteCapture.phase === "error") {
      stopRecorder();
    }
  }, [noteCapture.phase, stopRecorder]);

  useEffect(() => {
    if (!noteCapture.result || !audioBlob || resultEmittedRef.current) return;
    resultEmittedRef.current = true;
    setResult({
      ...noteCapture.result,
      audioBlob,
      mimeType: audioBlob.type || "audio/webm",
    });
  }, [audioBlob, noteCapture.result]);

  useEffect(() => () => {
    stopRecorder();
  }, [stopRecorder]);

  return {
    phase: recordingError ? "error" : toPhase(noteCapture.phase),
    progress: noteCapture.progress,
    result,
    error: recordingError ?? noteCapture.error,
    start,
    cancel,
    clearResult,
  };
}
