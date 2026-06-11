import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import { cn } from "@/lib/utils";

export type ManualMatchState =
  | { kind: "idle" }
  | { kind: "wrong"; detectedKeyIndex: number; detectedCents: number }
  | { kind: "matched"; cents: number };

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
    return (
      <div className={cn(
        "px-3 py-2.5 rounded-xl border bg-in-tune/15 border-in-tune/50 text-sm text-center",
      )}>
        <span className="font-bold text-in-tune">✓ 일치합니다</span>
        <span className="ml-2 text-foreground/85 tabular-nums"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {state.cents > 0 ? "+" : ""}{state.cents.toFixed(1)}¢
        </span>
      </div>
    );
  }

  return (
    <div className="px-3 py-2.5 rounded-xl bg-muted/60 border border-border text-sm text-muted-foreground text-center">
      건반을 누르세요…
    </div>
  );
}
