import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import { cn } from "@/lib/utils";

export type ManualMatchState =
  | { kind: "idle" }
  | { kind: "wrong"; detectedKeyIndex: number; detectedCents: number }
  | { kind: "matched"; cents: number; toleranceCents?: number };

interface MatchStatusProps {
  state: ManualMatchState;
  isListening: boolean;
}

export default function MatchStatus({ state, isListening }: MatchStatusProps) {
  if (!isListening) {
    return (
      <div className="px-3 py-2.5 rounded-xl bg-muted/60 border border-border text-sm text-muted-foreground text-center">
        마이크를 켜고 목표 음을 누르세요
      </div>
    );
  }

  if (state.kind === "wrong") {
    const k = PIANO_KEYS[state.detectedKeyIndex];
    return (
      <div className="px-3 py-2.5 rounded-xl border bg-off/10 border-off/40 text-off-foreground text-sm text-center">
        <span className="font-bold">✕ 잘못된 음입니다</span>
        <span className="ml-2 text-muted-foreground">
          감지: {k.noteName}{k.octave} ({k.keyNumber}번,{" "}
          {state.detectedCents > 0 ? "+" : ""}
          {state.detectedCents.toFixed(1)}¢)
        </span>
      </div>
    );
  }

  if (state.kind === "matched") {
    const hasBaseline = typeof state.toleranceCents === "number";
    const withinBaseline = hasBaseline && Math.abs(state.cents) <= state.toleranceCents!;
    const isGood = !hasBaseline || withinBaseline;

    return (
      <div className={cn(
        "px-3 py-2.5 rounded-xl border text-sm text-center",
        isGood
          ? "bg-in-tune/15 border-in-tune/50"
          : "bg-off/10 border-off/40"
      )}>
        <span className={cn("font-bold", isGood ? "text-in-tune" : "text-off-foreground")}>
          {hasBaseline
            ? (withinBaseline ? "✓ 기준 일치" : "△ 기준 대비 편차")
            : "✓ 음 인식"}
        </span>
        <span className="ml-2 text-foreground/85 tabular-nums"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {state.cents > 0 ? "+" : ""}{state.cents.toFixed(1)}¢
        </span>
        {hasBaseline && (
          <span className="ml-1 text-xs text-muted-foreground">
            (허용 ±{state.toleranceCents!.toFixed(1)}¢)
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-2.5 rounded-xl bg-muted/60 border border-border text-sm text-muted-foreground text-center">
      건반을 누르세요…
    </div>
  );
}
