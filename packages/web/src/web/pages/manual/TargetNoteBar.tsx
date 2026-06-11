import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import { cn } from "@/lib/utils";

interface TargetNoteBarProps {
  keyIndex: number;
  indexInOrder: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export default function TargetNoteBar({
  keyIndex,
  indexInOrder,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: TargetNoteBarProps) {
  const key = PIANO_KEYS[keyIndex];

  return (
    <div className="bg-card border border-border rounded-xl px-3 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        {/* ◀ */}
        <button
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="이전 음"
          className={cn(
            "w-12 h-12 flex items-center justify-center rounded-xl border transition-all active:scale-95",
            canPrev
              ? "bg-muted hover:bg-muted/70 border-border text-foreground"
              : "bg-muted/40 border-border/60 text-muted-foreground/40 cursor-not-allowed"
          )}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        {/* 중앙 음 표시 */}
        <div className="flex-1 text-center">
          <div
            className="text-3xl font-bold tabular-nums text-foreground leading-none"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {key.noteName}
            <span className="text-xl text-muted-foreground ml-0.5">{key.octave}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            건반 {key.keyNumber}
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            진행 {indexInOrder + 1} / {total}
          </div>
        </div>

        {/* ▶ */}
        <button
          onClick={onNext}
          disabled={!canNext}
          aria-label="다음 음"
          className={cn(
            "w-12 h-12 flex items-center justify-center rounded-xl border transition-all active:scale-95",
            canNext
              ? "bg-muted hover:bg-muted/70 border-border text-foreground"
              : "bg-muted/40 border-border/60 text-muted-foreground/40 cursor-not-allowed"
          )}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* 진행 바 */}
      <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-300"
          style={{ width: `${((indexInOrder + 1) / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
