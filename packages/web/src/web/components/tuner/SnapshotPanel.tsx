/**
 * SnapshotPanel.tsx
 *
 * 순간 녹음(스냅샷) 분석 패널
 * - 버튼 클릭 → 1.5초 녹음 → 음정 + cents 표시
 * - 결과를 세션에 저장하거나 닫기 가능
 */

import { cn } from "@/lib/utils";
import { useSnapshotAnalyzer } from "@/hooks/useSnapshotAnalyzer";
import { PIANO_KEYS } from "@/hooks/usePitchDetector";

interface SnapshotPanelProps {
  /** 이미 열린 마이크 스트림 (있으면 재사용) */
  sharedStream?: MediaStream | null;
  sharedAudioContext?: AudioContext | null;
  /** 결과를 세션에 저장하는 콜백 */
  onSave?: (keyIndex: number, cents: number, frequency: number) => void;
  /** 녹음 시간 (ms, 기본 1500) */
  durationMs?: number;
}

const STATUS_LABELS: Record<string, string> = {
  idle: "건반을 누른 채로 버튼을 클릭하세요",
  requesting: "마이크 권한 요청 중...",
  recording: "녹음 중...",
  analyzing: "분석 중...",
  done: "분석 완료",
  error: "오류 발생",
};

export default function SnapshotPanel({
  sharedStream,
  sharedAudioContext,
  onSave,
  durationMs = 1500,
}: SnapshotPanelProps) {
  const { status, progress, result, error, startSnapshot, clearResult } =
    useSnapshotAnalyzer(sharedStream, sharedAudioContext);

  const isActive = status === "recording" || status === "requesting" || status === "analyzing";

  const centColor =
    result === null
      ? "text-muted-foreground"
      : Math.abs(result.cents) <= 2
      ? "text-in-tune"
      : Math.abs(result.cents) <= 8
      ? "text-warn"
      : "text-off";

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm flex flex-col gap-3">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-primary"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <h3 className="text-sm font-semibold text-foreground">순간 녹음 분석</h3>
        </div>
        {result && (
          <button
            onClick={clearResult}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            초기화
          </button>
        )}
      </div>

      {/* 안내 */}
      <p className="text-xs text-muted-foreground/80">
        {STATUS_LABELS[status] ?? ""}
      </p>

      {/* 진행 바 (녹음 중) */}
      {(status === "recording" || status === "analyzing") && (
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-100"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}

      {/* 결과 표시 */}
      {result && status === "done" && (
        <div className="bg-muted/50 rounded-xl p-4 flex flex-col gap-2">
          {/* 음이름 + 옥타브 */}
          <div className="flex items-baseline gap-2">
            <span
              className="text-4xl font-bold text-foreground"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {result.noteName}
            </span>
            <span className="text-xl text-muted-foreground font-medium">
              {result.octave}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">
              건반 {result.keyIndex + 1}
            </span>
          </div>

          {/* 주파수 */}
          <div className="text-sm text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {result.frequency.toFixed(2)} Hz
            <span className="ml-2 text-xs">
              (기준: {PIANO_KEYS[result.keyIndex].freq.toFixed(2)} Hz)
            </span>
          </div>

          {/* Cents 편차 */}
          <div className={cn("text-3xl font-bold tabular-nums", centColor)} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {result.cents > 0 ? "+" : ""}
            {result.cents.toFixed(1)}¢
          </div>

          {/* 튜닝 상태 바 */}
          <div className="relative w-full h-3 bg-muted rounded-full overflow-hidden mt-1">
            {/* 중앙선 */}
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border" />
            {/* 편차 표시 */}
            <div
              className={cn(
                "absolute top-0.5 bottom-0.5 rounded-full transition-all duration-300",
                Math.abs(result.cents) <= 2
                  ? "bg-in-tune"
                  : Math.abs(result.cents) <= 8
                  ? "bg-warn"
                  : "bg-off"
              )}
              style={{
                width: "8px",
                left: `calc(50% + ${Math.max(-48, Math.min(48, result.cents))}% - 4px)`,
              }}
            />
          </div>

          {/* 신뢰도 */}
          <div className="text-xs text-muted-foreground/70">
            신뢰도 {Math.round(result.confidence * 100)}%
          </div>

          {/* 저장 버튼 */}
          {onSave && (
            <button
              onClick={() => onSave(result.keyIndex, result.cents, result.frequency)}
              className="mt-1 w-full py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-white text-sm font-semibold transition-all active:scale-[0.97]"
            >
              세션에 저장
            </button>
          )}
        </div>
      )}

      {/* 오류 */}
      {error && (
        <p className="text-xs text-off bg-off/10 rounded-lg px-3 py-2">{error}</p>
      )}

      {/* 녹음 버튼 */}
      <button
        onClick={() => startSnapshot({ durationMs })}
        disabled={isActive}
        className={cn(
          "flex items-center justify-center gap-2 w-full py-3 rounded-xl font-semibold text-sm transition-all duration-150",
          isActive
            ? "bg-muted text-muted-foreground cursor-not-allowed"
            : "bg-primary hover:bg-primary/90 text-white active:scale-[0.97]"
        )}
      >
        {isActive ? (
          <>
            <span className="w-2 h-2 rounded-full bg-off animate-pulse" />
            {status === "recording"
              ? `녹음 중... ${Math.round(progress * 100)}%`
              : status === "analyzing"
              ? "분석 중..."
              : "준비 중..."}
          </>
        ) : (
          <>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path
                d="M19 10v2a7 7 0 0 1-14 0v-2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
              <line
                x1="12"
                y1="19"
                x2="12"
                y2="23"
                stroke="currentColor"
                strokeWidth="2"
              />
              <line
                x1="8"
                y1="23"
                x2="16"
                y2="23"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            순간 녹음 분석
          </>
        )}
      </button>

      {/* 사용 안내 */}
      <p className="text-xs text-muted-foreground/60 text-center">
        피아노 건반을 누른 상태에서 버튼을 클릭하면 {durationMs / 1000}초간 녹음 후 자동 분석됩니다
      </p>
    </div>
  );
}
