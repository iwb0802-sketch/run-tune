/**
 * PitchMeter.tsx
 * Design: Technical Minimalism / Professional Instrument
 * 실시간 음정 감지 결과를 표시하는 미터 컴포넌트
 */

import { PitchResult } from "@/hooks/usePitchDetector";
import { cn } from "@/lib/utils";
import StrobeTuner from "@/components/tuner/StrobeTuner";

interface PitchMeterProps {
  pitch: PitchResult | null;
  isListening: boolean;
  autoSave?: boolean;
  onSave?: () => void;
  onSkip?: () => void;
  onSaveStrobe?: (cents: number) => void;
  stableCents?: number | null;
  isCapturing?: boolean;
  stableDuration?: number;
  onStableDurationChange?: (ms: number) => void;
  strobeNote?: string | null;
  strobeKeyIndex?: number | null;
  strobePartial?: number | null;
  strobeAnalysisFreq?: number | null;
  fftSize?: 4096 | 8192;
  onFftSizeChange?: (size: 4096 | 8192) => void;
}

export default function PitchMeter({ pitch, isListening, autoSave, onSave, onSkip, onSaveStrobe, stableCents, isCapturing, stableDuration, onStableDurationChange, strobeNote, strobeKeyIndex, strobePartial, strobeAnalysisFreq, fftSize = 4096, onFftSizeChange }: PitchMeterProps) {
  const cents = pitch?.cents ?? 0;
  const BAR_MAX = 50;
  const barPercent = Math.min(Math.abs(cents) / BAR_MAX, 1) * 50; // 0~50%
  const barLeft = cents < 0;

  const getCentsColor = (c: number) => {
    const abs = Math.abs(c);
    if (abs <= 2) return "text-in-tune";
    if (abs <= 8) return "text-warn";
    return "text-off";
  };

  const getBarColor = (c: number) => {
    const abs = Math.abs(c);
    if (abs <= 2) return "bg-in-tune";
    if (abs <= 8) return "bg-warn/80";
    return "bg-off";
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      {/* 스트로브 튜너 */}
      <div className="mb-3">
        <StrobeTuner
          detectedCents={pitch?.cents ?? null}
          stableCents={stableCents ?? null}
          isCapturing={isCapturing ?? false}
          isActive={isListening}
          onSaveStrobe={onSaveStrobe}
          stableDuration={stableDuration}
          onStableDurationChange={onStableDurationChange}
          currentNote={strobeNote ?? null}
          currentKeyIndex={strobeKeyIndex ?? null}
          partial={strobePartial ?? null}
          analysisFreq={strobeAnalysisFreq ?? null}
        />
      </div>
      {/* 정확도 모드 토글 */}
      {onFftSizeChange && (
        <div className="mb-3 flex items-center justify-between bg-muted/50 rounded-xl px-3 py-2.5 border border-border/60">
          <div>
            <div className="text-xs font-semibold text-foreground/85">저음역 정확도 모드</div>
            <div className="text-xs text-muted-foreground/80 mt-0.5">
              {fftSize === 8192 ? "⚠️ 저음역 강화 — 처리 속도 느려집니다" : "⚡ 빠름 모드 (1에서 15번 건반 권장)"}
            </div>
          </div>
          <button
            onClick={() => onFftSizeChange(fftSize === 4096 ? 8192 : 4096)}
            className={cn(
              "relative w-12 h-6 rounded-full transition-colors duration-200",
              fftSize === 8192 ? "bg-warn" : "bg-muted-foreground/30"
            )}
          >
            <span className={cn(
              "absolute top-0.5 w-5 h-5 bg-card rounded-full shadow transition-transform duration-200",
              fftSize === 8192 ? "translate-x-6" : "translate-x-0.5"
            )} />
          </button>
        </div>
      )}

      {/* 음이름 + 주파수 */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="flex items-baseline gap-1">
            <span
              className="text-5xl font-bold tracking-tight text-foreground"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {pitch ? `${pitch.noteName}${pitch.octave}` : "--"}
            </span>
            {pitch && (
              <span className="text-sm text-muted-foreground/80 ml-1">
                건반 {pitch.keyIndex + 1}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground/80 mt-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {pitch ? `${pitch.frequency.toFixed(2)} Hz` : "-- Hz"}
          </div>
        </div>

        {/* 센트 오차 */}
        <div className="text-right">
          <div
            className={cn(
              "text-4xl font-bold tabular-nums",
              pitch ? getCentsColor(pitch.cents) : "text-muted-foreground/60",
              { fontFamily: "'JetBrains Mono', monospace" }
            )}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {pitch
              ? `${pitch.cents > 0 ? "+" : ""}${pitch.cents.toFixed(1)}`
              : "±0.0"}
          </div>
          <div className="text-xs text-muted-foreground/80">cent</div>
        </div>
      </div>

      {/* 센트 미터 바 */}
      <div className="relative mb-4">
        <div className="flex items-center gap-1 mb-1">
          <span className="text-xs text-muted-foreground/80 w-8 text-right">-50</span>
          <div className="flex-1 relative h-5 bg-muted rounded-full overflow-hidden border border-border">
            {/* 중앙선 */}
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-muted-foreground/50 z-10" />
            {/* 바 */}
            {pitch && (
              <div
                className={cn(
                  "absolute top-1 bottom-1 rounded-full transition-all duration-100",
                  getBarColor(pitch.cents)
                )}
                style={{
                  width: `${barPercent}%`,
                  left: barLeft ? `${50 - barPercent}%` : "50%",
                }}
              />
            )}
            {/* 눈금 */}
            {[-25, 0, 25].map((v) => (
              <div
                key={v}
                className="absolute top-0 bottom-0 w-px bg-muted-foreground/30"
                style={{ left: `${50 + v}%` }}
              />
            ))}
          </div>
          <span className="text-xs text-muted-foreground/80 w-8">+50</span>
        </div>
        <div className="flex justify-center">
          <span className="text-xs text-muted-foreground/80">
            {pitch
              ? Math.abs(pitch.cents) <= 2
                ? "✓ 정확"
                : Math.abs(pitch.cents) <= 8
                ? "△ 약간 벗어남"
                : "✗ 조율 필요"
              : isListening
              ? "소리를 감지 중..."
              : "마이크를 시작하세요"}
          </span>
        </div>
      </div>

      {/* 저장 / 건너뛰기 버튼 */}
      {pitch && !autoSave && (
        <div className="flex gap-2">
          <button
            onClick={onSave}
            className="flex-1 py-2 bg-primary hover:bg-primary/90 text-white text-sm font-semibold rounded-lg transition-all duration-150 active:scale-[0.97]"
          >
            저장 (Space)
          </button>
          <button
            onClick={onSkip}
            className="px-4 py-2 bg-muted hover:bg-muted text-muted-foreground text-sm font-medium rounded-lg transition-all duration-150 active:scale-[0.97]"
          >
            건너뛰기
          </button>
        </div>
      )}
      {pitch && autoSave && (
        <div className="py-2 text-center text-xs text-in-tune bg-in-tune-soft rounded-lg border border-in-tune/30">
          <span className="animate-pulse">● </span>0.8초 후 자동 저장됩니다
        </div>
      )}
    </div>
  );
}
