/**
 * NoteCapturePanel.tsx
 *
 * 하이브리드 노트 캡처 패널
 *
 * 두 가지 모드:
 * - 자동 감지: 타격 감지 → 150ms 대기 → 1.2초 수집 → 이상치 제거 → 중앙값 확정
 * - 즉시 캡처: 버튼 클릭 즉시 1.2초 수집 시작
 *
 * 실시간 바늘/스트로브는 기존 PitchMeter가 담당.
 * 이 패널은 "확정된 최종값"만 표시.
 */

import { cn } from "@/lib/utils";
import { useNoteCapture, NoteCapturePhase } from "@/hooks/useNoteCapture";
import { PIANO_KEYS } from "@/hooks/usePitchDetector";

interface NoteCaptureProps {
  stream:       MediaStream | null;
  audioContext: AudioContext | null;
  isListening:  boolean;
  onSave?: (keyIndex: number, cents: number, frequency: number) => void;
}

// 단계별 안내 메시지
const PHASE_MSG: Record<NoteCapturePhase, string> = {
  idle:      "마이크를 켠 후 아래 버튼을 눌러주세요",
  listening: "건반을 치면 자동으로 캡처 시작됩니다",
  attack:    "타격 감지됨 — 안정화 대기 중...",
  wait:      "타격음 제거 중 (150ms)...",
  capture:   "안정 구간 수집 중...",
  analyze:   "이상치 제거 및 중앙값 계산 중...",
  done:      "분석 완료",
  error:     "오류 발생",
};

// cents 값에 따른 색상
function centColor(cents: number) {
  if (Math.abs(cents) <= 2)  return "text-in-tune";
  if (Math.abs(cents) <= 8)  return "text-warn";
  return "text-off";
}

// cents 값에 따른 배경색
function centBg(cents: number) {
  if (Math.abs(cents) <= 2)  return "bg-in-tune";
  if (Math.abs(cents) <= 8)  return "bg-warn";
  return "bg-off";
}

export default function NoteCapturePanel({
  stream,
  audioContext,
  isListening,
  onSave,
}: NoteCaptureProps) {
  const {
    phase, progress, result, error,
    startListening, startImmediate, stop, clearResult,
  } = useNoteCapture(
    isListening ? stream : null,
    isListening ? audioContext : null,
  );

  const isActive = phase === "listening" || phase === "attack" || phase === "wait" || phase === "capture" || phase === "analyze";
  const showProgress = phase === "capture" || phase === "analyze";

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm flex flex-col gap-3">

      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* 아이콘: 파형 */}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <h3 className="text-sm font-semibold text-foreground">정밀 캡처 분석</h3>
        </div>
        <div className="flex items-center gap-2">
          {/* 단계 배지 */}
          {isActive && (
            <span className="flex items-center gap-1 text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              {phase === "listening" ? "대기" : phase === "capture" ? "수집" : phase === "analyze" ? "분석" : "처리"}
            </span>
          )}
          {result && (
            <button onClick={clearResult} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              초기화
            </button>
          )}
        </div>
      </div>

      {/* 안내 메시지 */}
      <p className="text-xs text-muted-foreground/80 min-h-[1.2em]">
        {!isListening
          ? "마이크를 먼저 시작해 주세요"
          : PHASE_MSG[phase]}
      </p>

      {/* 진행 바 */}
      {showProgress && (
        <div className="flex flex-col gap-1">
          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-100"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground/60">
            <span>수집 중</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        </div>
      )}

      {/* 결과 카드 */}
      {result && phase === "done" && (
        <div className="bg-muted/40 rounded-xl p-4 flex flex-col gap-3 border border-border/60">

          {/* 음이름 + 건반번호 */}
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-1.5">
              <span className="text-4xl font-bold text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {result.noteName}
              </span>
              <span className="text-xl text-muted-foreground font-medium">
                {result.octave}
              </span>
            </div>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              건반 {result.keyIndex + 1}
            </span>
          </div>

          {/* 주파수 */}
          <div className="text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            <span className="text-foreground font-medium">{result.frequency.toFixed(2)}</span>
            <span className="text-muted-foreground"> Hz</span>
            <span className="text-xs text-muted-foreground/60 ml-2">
              (기준 {PIANO_KEYS[result.keyIndex].freq.toFixed(2)} Hz)
            </span>
          </div>

          {/* Cents 편차 — 크게 강조 */}
          <div className="flex items-center gap-3">
            <span
              className={cn("text-4xl font-bold tabular-nums", centColor(result.cents))}
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {result.cents > 0 ? "+" : ""}{result.cents.toFixed(1)}¢
            </span>
            <span className={cn(
              "text-xs px-2 py-0.5 rounded-full font-medium",
              Math.abs(result.cents) <= 2
                ? "bg-in-tune/20 text-in-tune"
                : Math.abs(result.cents) <= 8
                ? "bg-warn/20 text-warn"
                : "bg-off/20 text-off"
            )}>
              {Math.abs(result.cents) <= 2 ? "정확" : Math.abs(result.cents) <= 8 ? "근접" : "조율 필요"}
            </span>
          </div>

          {/* 튜닝 바 (±50¢ 범위) */}
          <div className="relative w-full h-4 bg-muted rounded-full overflow-hidden">
            {/* 중앙선 */}
            <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-border/80 z-10" />
            {/* ±2¢ 허용 구간 */}
            <div className="absolute top-0 bottom-0 bg-in-tune/15 z-0"
              style={{ left: "calc(50% - 2%)", width: "4%" }} />
            {/* 편차 마커 */}
            <div
              className={cn("absolute top-1 bottom-1 w-2 rounded-full z-20 transition-all duration-300", centBg(result.cents))}
              style={{
                left: `calc(50% + ${Math.max(-48, Math.min(48, result.cents))}% - 4px)`,
              }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground/50">
            <span>-50¢</span><span>0</span><span>+50¢</span>
          </div>

          {/* 통계 */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-card rounded-lg p-2 border border-border/60">
              <div className="text-muted-foreground/70 mb-0.5">수집 프레임</div>
              <div className="font-semibold text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {result.frameCount}
              </div>
            </div>
            <div className="bg-card rounded-lg p-2 border border-border/60">
              <div className="text-muted-foreground/70 mb-0.5">신뢰도</div>
              <div className={cn("font-semibold", result.confidence >= 0.8 ? "text-in-tune" : result.confidence >= 0.6 ? "text-warn" : "text-off")}
                style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {Math.round(result.confidence * 100)}%
              </div>
            </div>
          </div>

          {/* 원본 분포 미니 차트 */}
          {result.rawCents.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-xs text-muted-foreground/60">실시간 측정 분포 (이상치 포함)</div>
              <div className="flex items-end gap-px h-8 w-full">
                {(() => {
                  // -20 ~ +20¢ 범위를 40 버킷으로 나눔
                  const BUCKETS = 40;
                  const MIN_C = -20, MAX_C = 20;
                  const buckets = new Array(BUCKETS).fill(0);
                  result.rawCents.forEach(c => {
                    const idx = Math.floor(((c - MIN_C) / (MAX_C - MIN_C)) * BUCKETS);
                    if (idx >= 0 && idx < BUCKETS) buckets[idx]++;
                  });
                  const maxBucket = Math.max(...buckets, 1);
                  return buckets.map((count, i) => {
                    const isCenter = i === Math.floor(BUCKETS / 2);
                    const isMedian = Math.abs(((i / BUCKETS) * (MAX_C - MIN_C) + MIN_C) - result.cents) < (MAX_C - MIN_C) / BUCKETS;
                    return (
                      <div
                        key={i}
                        className={cn(
                          "flex-1 rounded-sm",
                          isMedian ? "bg-primary" : isCenter ? "bg-border" : count > 0 ? "bg-muted-foreground/30" : "bg-transparent"
                        )}
                        style={{ height: `${(count / maxBucket) * 100}%`, minHeight: isCenter ? "2px" : undefined }}
                        title={`${((i / BUCKETS) * (MAX_C - MIN_C) + MIN_C).toFixed(1)}¢: ${count}회`}
                      />
                    );
                  });
                })()}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground/40">
                <span>-20¢</span><span>0</span><span>+20¢</span>
              </div>
            </div>
          )}

          {/* 저장 버튼 */}
          {onSave && (
            <button
              onClick={() => onSave(result.keyIndex, result.cents, result.frequency)}
              className="w-full py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-white text-sm font-semibold transition-all active:scale-[0.97]"
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

      {/* 버튼 영역 */}
      <div className="flex gap-2">
        {/* 자동 감지 버튼 */}
        <button
          onClick={isActive ? stop : startListening}
          disabled={!isListening}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-sm transition-all duration-150",
            !isListening
              ? "bg-muted text-muted-foreground/50 cursor-not-allowed"
              : isActive
              ? "bg-off hover:bg-off/90 text-white active:scale-[0.97]"
              : "bg-primary hover:bg-primary/90 text-white active:scale-[0.97]"
          )}
        >
          {isActive ? (
            <>
              <span className="w-2 h-2 rounded-sm bg-white" />
              중지
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4" /><path d="M12 16h.01" />
              </svg>
              자동 감지
            </>
          )}
        </button>

        {/* 즉시 캡처 버튼 */}
        <button
          onClick={startImmediate}
          disabled={!isListening || isActive}
          className={cn(
            "flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl font-medium text-sm transition-all duration-150 border",
            !isListening || isActive
              ? "bg-muted border-border text-muted-foreground/50 cursor-not-allowed"
              : "bg-muted/50 border-border text-foreground hover:bg-muted active:scale-[0.97]"
          )}
          title="건반을 누른 채로 클릭 — 타격 감지 없이 즉시 수집"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" strokeWidth="2" />
            <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" />
            <line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" strokeWidth="2" />
          </svg>
          즉시
        </button>
      </div>

      {/* 사용 안내 */}
      <div className="text-xs text-muted-foreground/50 space-y-0.5">
        <p><strong className="text-muted-foreground/70">자동 감지:</strong> 건반을 치면 타격 후 150ms 대기 → 1.2초 수집 → 확정</p>
        <p><strong className="text-muted-foreground/70">즉시 캡처:</strong> 건반을 누른 채로 클릭 → 바로 1.2초 수집 시작</p>
      </div>
    </div>
  );
}
