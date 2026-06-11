/**
 * StrobeTuner.tsx
 * PT-100 스타일 스트로브 튜너
 *
 * 동작:
 * 1. 마이크가 실시간 주파수를 감지
 * 2. 스트로브 기준값(targetCents)을 +1/-1 버튼으로 조정
 * 3. 실제 음 - 기준값 = 스트로브 오프셋 → 선이 흐름
 * 4. 선이 멈추면 기준값 = 실제 조율값
 * 5. "이 값으로 저장" 버튼 → 그래프에 기록
 */

import { useEffect, useRef, useState } from "react";

interface StrobeTunerProps {
  detectedCents: number | null;
  stableCents: number | null;
  isCapturing: boolean;
  isActive: boolean;
  onSaveStrobe?: (cents: number) => void;
  stableDuration?: number;
  onStableDurationChange?: (ms: number) => void;
  currentNote?: string | null;      // 스트로브가 감지 중인 음이름
  currentKeyIndex?: number | null;
  /** PT-100 타겟 배음 차수 (1=기본, 2/4/6=옵타브 위) */
  partial?: number | null;
  /** 실제 분석 중인 주파수 (Hz) */
  analysisFreq?: number | null;
}

// PT-100 스타일: 3줄 그룹이 간격을 두고 반복
const GROUP_SIZE = 3;    // 그룹당 선 수
const BAR_WIDTH = 3;     // 선 두께
const BAR_GAP = 2;       // 그룹 내 선 간격
const GROUP_GAP = 18;    // 그룹 간 간격
const GROUP_COUNT = 6;   // 그룹 수
const GROUP_W = GROUP_SIZE * (BAR_WIDTH + BAR_GAP) + GROUP_GAP; // 한 그룹 전체 폭

export default function StrobeTuner({ detectedCents, stableCents, isCapturing, isActive, onSaveStrobe, stableDuration = 1200, onStableDurationChange, currentNote, currentKeyIndex, partial, analysisFreq }: StrobeTunerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [targetCents, setTargetCents] = useState(0);
  // 스트로브는 stableCents만 사용 (detectedCents와 완전 분리)
  // 새 건반 치면 stableCents=null이 되어 스트로브가 멈쳘 상태가 됨
  // stableCents 없으면 detectedCents로 실시간 표시
  const activeStable = stableCents ?? detectedCents;

  // 스트로브 오프셋 = 안정값 - 사용자 조정 기준값
  const strobeOffset = activeStable !== null ? activeStable - targetCents : null;
  const isStopped = strobeOffset !== null && Math.abs(strobeOffset) <= 0.8;

  // 기준값 조정
  const adjustTarget = (delta: number) => {
    setTargetCents(prev => Math.round((prev + delta) * 10) / 10);
  };

  // 안정값으로 기준값 자동 설정
  const syncToDetected = () => {
    if (activeStable !== null) {
      setTargetCents(Math.round(activeStable * 10) / 10);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;
    const TOTAL_W = GROUP_COUNT * GROUP_W;

    const animate = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#080808";
      ctx.fillRect(0, 0, W, H);

      if (!isActive || strobeOffset === null) {
        // 비활성: 희미한 3줄 그룹
        ctx.fillStyle = "rgba(160, 0, 0, 0.2)";
        for (let g = 0; g < GROUP_COUNT + 1; g++) {
          for (let b = 0; b < GROUP_SIZE; b++) {
            const x = g * GROUP_W + b * (BAR_WIDTH + BAR_GAP);
            ctx.fillRect(x, 4, BAR_WIDTH, H - 8);
          }
        }
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      // 속도: 오프셋에 비례
      const speed = (strobeOffset / 50) * 5;
      offsetRef.current = ((offsetRef.current + speed) % TOTAL_W + TOTAL_W) % TOTAL_W;

      // 색상
      const absOff = Math.abs(strobeOffset);
      const brightness = isStopped ? 1 : Math.min(1, 0.45 + (absOff / 12) * 0.55);
      const r = Math.round(235 * brightness);
      const gv = Math.round(20 * brightness);
      const bv = Math.round(20 * brightness);

      // 3줄 그룹 반복 그리기
      ctx.fillStyle = `rgb(${r},${gv},${bv})`;
      for (let gi = -1; gi < GROUP_COUNT + 2; gi++) {
        const groupX = ((gi * GROUP_W) + offsetRef.current) % TOTAL_W;
        for (let bi = 0; bi < GROUP_SIZE; bi++) {
          const x = groupX + bi * (BAR_WIDTH + BAR_GAP);
          if (x > -BAR_WIDTH && x < W + BAR_WIDTH) {
            ctx.fillRect(x, 3, BAR_WIDTH, H - 6);
          }
        }
      }

      // 멈쳘 시 초록 글로우
      if (isStopped) {
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, "rgba(0,255,80,0)");
        grad.addColorStop(0.5, "rgba(0,255,80,0.15)");
        grad.addColorStop(1, "rgba(0,255,80,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isActive, strobeOffset, isStopped]);

  return (
    <div className="bg-instrument rounded-xl overflow-hidden border border-instrument/60">
      {/* 스트로브 캔버스 */}
      <canvas
        ref={canvasRef}
        width={360}
        height={48}
        className="w-full block"
        style={{ imageRendering: "pixelated" }}
      />

      {/* 상태 표시 */}
      <div className="px-3 py-1.5 flex items-center justify-between border-b border-instrument/60">
        <div className="flex items-center gap-2">
          {/* 음이름 표시 */}
          {currentNote && (
            <span className="text-sm font-bold text-white" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {currentNote}
              {currentKeyIndex !== null && currentKeyIndex !== undefined && (
                <span className="text-xs text-muted-foreground ml-1">건반{currentKeyIndex + 1}</span>
              )}
              {partial && partial > 1 && analysisFreq && (
                <span className="text-[10px] text-yellow-400 ml-1.5 font-mono">
                  ×{partial}배음 {analysisFreq.toFixed(0)}Hz
                </span>
              )}
            </span>
          )}
          <span className="text-xs font-medium" style={{
            fontFamily: "'JetBrains Mono', monospace",
            color: isCapturing ? "#f59e0b" : isStopped ? "#22c55e" : strobeOffset === null ? "#4b5563" : strobeOffset > 0 ? "#f97316" : "#60a5fa"
          }}>
            {!isActive ? "대기 중" : isCapturing ? "● 수집 중" : strobeOffset === null ? "무음" : isStopped ? "● 영점" : strobeOffset > 0 ? "▶ 높음" : "◄ 낙음"}
          </span>
        </div>
        <span className="text-xs text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {activeStable !== null ? (
            <>안정: <span className="text-yellow-400">{activeStable > 0 ? "+" : ""}{activeStable.toFixed(1)}¢</span></>
          ) : (
            <span className="text-muted-foreground">대기 중</span>
          )}
        </span>
      </div>

      {/* 기준값 조정 컨트롤 */}
      <div className="px-3 py-2.5 flex items-center gap-2">
        <span className="text-xs text-muted-foreground mr-1">기준</span>

        {/* -10 */}
        <button onClick={() => adjustTarget(-10)}
          className="px-2 py-1 bg-instrument/80 hover:bg-instrument/70 text-muted-foreground/60 text-xs rounded-lg font-mono active:scale-95 transition-all">
          -10
        </button>
        {/* -1 */}
        <button onClick={() => adjustTarget(-1)}
          className="px-2.5 py-1 bg-instrument/80 hover:bg-instrument/70 text-muted-foreground/60 text-xs rounded-lg font-mono active:scale-95 transition-all">
          -1
        </button>

        {/* 기준값 표시 */}
        <div className="flex-1 text-center">
          <span className="text-base font-bold tabular-nums" style={{
            fontFamily: "'JetBrains Mono', monospace",
            color: isStopped ? "#22c55e" : "#e5e7eb"
          }}>
            {targetCents > 0 ? "+" : ""}{targetCents.toFixed(1)}¢
          </span>
        </div>

        {/* +1 */}
        <button onClick={() => adjustTarget(1)}
          className="px-2.5 py-1 bg-instrument/80 hover:bg-instrument/70 text-muted-foreground/60 text-xs rounded-lg font-mono active:scale-95 transition-all">
          +1
        </button>
        {/* +10 */}
        <button onClick={() => adjustTarget(10)}
          className="px-2 py-1 bg-instrument/80 hover:bg-instrument/70 text-muted-foreground/60 text-xs rounded-lg font-mono active:scale-95 transition-all">
          +10
        </button>

        {/* 감지값 동기화 */}
        <button onClick={syncToDetected}
          disabled={detectedCents === null}
          className="px-2 py-1 bg-primary hover:bg-primary/90 text-primary/60 text-xs rounded-lg active:scale-95 transition-all disabled:opacity-30"
          title="감지값으로 기준 맞추기">
          ⟳
        </button>
      </div>

      {/* 안정 구간 시간 조절 */}
      {onStableDurationChange && (
        <div className="px-3 pb-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">안정 대기</span>
          <input
            type="range"
            min={500} max={3000} step={100}
            value={stableDuration}
            onChange={e => onStableDurationChange(Number(e.target.value))}
            className="flex-1 accent-yellow-500 h-1"
          />
          <span className="text-xs text-yellow-400 w-10 text-right" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {(stableDuration / 1000).toFixed(1)}s
          </span>
        </div>
      )}

      {/* 저장 버튼 - 안정값(activeStable)이 있으면 안정값으로, 없으면 기준값으로 저장 */}
      {onSaveStrobe && (
        <div className="px-3 pb-2.5">
          <button
            onClick={() => onSaveStrobe(activeStable !== null ? activeStable : targetCents)}
            disabled={activeStable === null && !isStopped}
            className={`w-full py-2 rounded-xl text-sm font-bold transition-all active:scale-[0.97] ${
              activeStable !== null
                ? "bg-in-tune hover:bg-in-tune/90 text-white"
                : "bg-instrument/80 hover:bg-instrument/70 text-muted-foreground/60 opacity-50"
            }`}
          >
            {activeStable !== null ? "✓ 안정값으로 저장" : "안정값 대기 중..."}
            <span className="ml-2 text-xs opacity-70">
              ({activeStable !== null ? (activeStable > 0 ? "+" : "") + activeStable.toFixed(1) : "--"}¢)
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
