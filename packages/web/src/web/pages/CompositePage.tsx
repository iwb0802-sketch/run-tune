/**
 * CompositePage.tsx — 복합 조율 모드
 *
 * 4중 엔진: YIN → HPS → Goertzel → 스트로브
 * - 건반 지정 없이 자동 인식
 * - YIN ↔ Goertzel 교차검증으로 오탐 차단
 * - 안정 구간 900ms 수집 후 최종 확정
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/utils";
import { useCompositeTuner, CompositeResult } from "@/hooks/useCompositeTuner";
import { useTuningSession } from "@/hooks/useTuningSession";
import { useWakeLock } from "@/hooks/useWakeLock";
import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";

const toast = Object.assign(
  (msg: string, opts?: { duration?: number }) => sonnerToast(msg, opts),
  {
    success: (msg: string, opts?: { duration?: number }) => sonnerToast.success(msg, opts),
    error: (msg: string) => sonnerToast.error(msg),
  }
);

function CentsBar({ cents }: { cents: number }) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const pct = ((clamped + 50) / 100) * 100;
  const inTune = Math.abs(cents) <= 2;
  const warn = Math.abs(cents) <= 8;
  const color = inTune ? "bg-in-tune" : warn ? "bg-warn" : "bg-off";

  return (
    <div className="relative w-full h-3 bg-muted rounded-full overflow-hidden">
      {/* 중앙선 */}
      <div className="absolute left-1/2 top-0 w-px h-full bg-border/60 z-10" />
      {/* 바 */}
      <div
        className={cn("absolute top-0.5 h-2 rounded-full transition-all duration-150", color)}
        style={{
          left: clamped >= 0 ? "50%" : `${pct}%`,
          width: `${Math.abs(clamped)}%`,
        }}
      />
    </div>
  );
}

function EngineRow({
  label, cents, active
}: { label: string; cents: number | null; active: boolean }) {
  return (
    <div className={cn(
      "flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-colors",
      active ? "bg-primary/10 border border-primary/30" : "bg-muted/40"
    )}>
      <span className="text-muted-foreground font-medium w-16">{label}</span>
      <span
        className={cn("font-bold tabular-nums w-16 text-right", active ? "text-foreground" : "text-muted-foreground/60")}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {cents !== null ? `${cents > 0 ? "+" : ""}${cents.toFixed(1)}¢` : "—"}
      </span>
    </div>
  );
}

export default function CompositePage() {
  const { user } = useAuth();
  const { isPro } = useUserRole(user?.id);

  const {
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    createSession,
    recordMeasurement,
    undoLastMeasurement,
    undoStack,
    chartData,
    measuredCount,
  } = useTuningSession(null);

  const [userName, setUserName] = useState("");
  const [showSessionList, setShowSessionList] = useState(false);
  const [lastConfirmed, setLastConfirmed] = useState<CompositeResult | null>(null);

  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const s = await createSession();
    if (s) { activeSessionIdRef.current = s.id; return s.id; }
    return null;
  }, [createSession]);

  const handleConfirmed = useCallback(async (r: CompositeResult) => {
    if (r.finalCents === null) return;
    await ensureSession();
    recordMeasurement(r.keyIndex, r.finalCents, r.frequency);
    setLastConfirmed(r);
    toast.success(`${r.noteName}${r.octave} (건반 ${r.keyIndex + 1}) → ${r.finalCents > 0 ? "+" : ""}${r.finalCents.toFixed(1)}¢`);
  }, [ensureSession, recordMeasurement]);

  const { isListening, result, startListening, stopListening, error } =
    useCompositeTuner(handleConfirmed, 4096);

  useWakeLock(isListening);

  const toggleListening = async () => {
    if (isListening) stopListening();
    else await startListening();
  };

  const key = result ? PIANO_KEYS[result.keyIndex] : null;
  const inTune = result?.liveCents !== undefined && Math.abs(result.liveCents) <= 2;
  const warn = result?.liveCents !== undefined && Math.abs(result.liveCents) <= 8;

  return (
    <div className="min-h-screen bg-muted/50 flex flex-col" style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>

      {/* 헤더 */}
      <header className="bg-card border-b border-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-precision rounded-lg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              <path d="M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground leading-tight">복합 조율</h1>
            <p className="text-xs text-muted-foreground/80">YIN · HPS · Goertzel · 스트로브 4중 판단</p>
          </div>
        </div>

        {/* 모드 전환 */}
        <nav className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          <Link to="/" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">자동</Link>
          <Link to="/manual" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">수동</Link>
          <span className="px-3 py-1 text-xs font-bold rounded-md bg-card text-precision shadow-sm">복합</span>
        </nav>
      </header>

      <main className="flex-1 container max-w-3xl mx-auto px-4 py-4 flex flex-col gap-3">

        {/* 메인 피치 표시 */}
        <div className={cn(
          "bg-card border rounded-xl px-5 py-4 shadow-sm transition-colors",
          result?.finalCents !== null && result?.finalCents !== undefined
            ? "border-in-tune/60 bg-in-tune/5"
            : result?.crossValid
            ? "border-precision/40"
            : "border-border"
        )}>
          <div className="flex items-center justify-between mb-3">
            {/* 건반 이름 */}
            <div>
              {key ? (
                <>
                  <span className="text-3xl font-black text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {key.noteName}{key.octave}
                  </span>
                  <span className="text-sm text-muted-foreground ml-2">건반 {key.keyNumber}</span>
                </>
              ) : (
                <span className="text-3xl font-black text-muted-foreground/40" style={{ fontFamily: "'JetBrains Mono', monospace" }}>—</span>
              )}
            </div>

            {/* 신뢰도 배지 */}
            <div className="flex flex-col items-end gap-1">
              <div className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold",
                result?.crossValid ? "bg-in-tune/20 text-in-tune" : "bg-muted text-muted-foreground"
              )}>
                <div className={cn("w-1.5 h-1.5 rounded-full", result?.crossValid ? "bg-in-tune" : "bg-muted-foreground/40")} />
                {result?.crossValid ? "교차검증 ✓" : "검증 대기"}
              </div>
              {result && (
                <span className="text-xs text-muted-foreground/70">
                  신뢰도 {Math.round(result.confidence * 100)}%
                </span>
              )}
            </div>
          </div>

          {/* cents 큰 숫자 */}
          <div className="text-center my-2">
            <span
              className={cn(
                "text-5xl font-black tabular-nums transition-colors",
                inTune ? "text-in-tune" : warn ? "text-warn" : result ? "text-off" : "text-muted-foreground/30"
              )}
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {result
                ? `${result.liveCents > 0 ? "+" : ""}${result.liveCents.toFixed(1)}`
                : "0.0"}
            </span>
            <span className="text-lg text-muted-foreground ml-1">¢</span>
          </div>

          {/* cents 바 */}
          <CentsBar cents={result?.liveCents ?? 0} />

          {/* 캡처 진행 */}
          {result?.isCapturing && (
            <div className="mt-2">
              <div className="w-full bg-muted rounded-full h-1">
                <div
                  className="bg-precision h-1 rounded-full transition-all"
                  style={{ width: `${result.captureProgress * 100}%` }}
                />
              </div>
              <p className="text-xs text-precision/80 mt-0.5 text-center">안정 측정 중...</p>
            </div>
          )}

          {/* 확정 표시 */}
          {result?.finalCents !== null && result?.finalCents !== undefined && (
            <div className="mt-2 text-center">
              <span className="text-xs font-bold text-in-tune bg-in-tune/10 px-3 py-1 rounded-full">
                확정 {result.finalCents > 0 ? "+" : ""}{result.finalCents.toFixed(1)}¢ ✓
              </span>
            </div>
          )}
        </div>

        {/* 엔진 상세 */}
        <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">엔진 상세</h3>
          <div className="space-y-1">
            <EngineRow label="YIN" cents={result?.yinCents ?? null} active={!!result} />
            <EngineRow label="Goertzel" cents={result?.goertzelCents ?? null} active={!!result?.signalOk} />
            <EngineRow
              label="복합"
              cents={result?.liveCents ?? null}
              active={!!result?.crossValid}
            />
          </div>
          {result && !result.crossValid && (
            <p className="text-xs text-warn/80 mt-2 px-1">
              YIN ↔ Goertzel 편차 큼 — YIN 단독 사용 중
            </p>
          )}
        </div>

        {/* 마이크 버튼 */}
        <button
          onClick={isPro ? toggleListening : undefined}
          disabled={!isPro}
          title={!isPro ? "Pro 이상 등급에서 사용 가능합니다" : undefined}
          className={cn(
            "w-full py-3 rounded-xl font-bold text-sm transition-all",
            isPro && "active:scale-[0.98]",
            !isPro
              ? "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
              : isListening ? "bg-off text-white hover:bg-off/90" : "bg-precision text-white hover:bg-precision/90"
          )}
        >
          {!isPro ? "🔒 마이크 켜기 (Pro 전용)" : isListening ? "■ 마이크 끄기" : "● 마이크 켜기"}
        </button>
        {!isPro && (
          <p className="text-xs text-center text-muted-foreground">
            등급을 Pro로 변경하면 마이크를 사용할 수 있습니다.
          </p>
        )}

        {error && (
          <div className="px-3 py-2 rounded-lg bg-off/10 border border-off/40 text-xs text-off-foreground">
            {error}
          </div>
        )}

        {/* 마지막 확정 */}
        {lastConfirmed && (
          <div className="bg-card border border-in-tune/30 rounded-xl px-4 py-3 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">마지막 확정</p>
              <span className="font-bold text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {lastConfirmed.noteName}{lastConfirmed.octave}
              </span>
              <span className="text-sm text-muted-foreground ml-2">건반 {lastConfirmed.keyIndex + 1}</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn("text-lg font-black tabular-nums",
                  Math.abs(lastConfirmed.finalCents ?? 0) <= 2 ? "text-in-tune" :
                  Math.abs(lastConfirmed.finalCents ?? 0) <= 8 ? "text-warn" : "text-off"
                )}
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {(lastConfirmed.finalCents ?? 0) > 0 ? "+" : ""}{(lastConfirmed.finalCents ?? 0).toFixed(1)}¢
              </span>
              {undoStack.length > 0 && (
                <button
                  onClick={() => undoLastMeasurement()}
                  className="text-xs text-muted-foreground hover:text-off px-2 py-1 rounded border border-border"
                >
                  취소
                </button>
              )}
            </div>
          </div>
        )}

        {/* 조율 커브 */}
        <div className="bg-card border border-border rounded-xl p-2 shadow-sm">
          <TuningCurveChart data={chartData} activeKeyIndex={result?.keyIndex} />
        </div>

        {/* 세션 + 내보내기 */}
        <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="relative flex-1 mr-2">
              <button
                onClick={() => setShowSessionList(v => !v)}
                className="flex items-center gap-1.5 text-sm text-foreground/85 hover:text-foreground max-w-full"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="font-semibold truncate max-w-[180px]">
                  {activeSession?.name || "세션 없음"}
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <p className="text-xs text-muted-foreground/80 mt-0.5">
                측정 {measuredCount} / 88
              </p>
              {showSessionList && sessions.length > 0 && (
                <div className="absolute top-full left-0 mt-1 w-64 bg-card border border-border rounded-xl shadow-lg z-20 max-h-48 overflow-y-auto">
                  {sessions.map(s => (
                    <button
                      key={s.id}
                      onClick={() => { setActiveSessionId(s.id); setShowSessionList(false); }}
                      className={cn(
                        "w-full text-left px-3 py-2.5 text-xs hover:bg-muted/50 border-b border-border/40 last:border-0",
                        s.id === activeSessionId ? "bg-primary/10 text-primary font-bold" : "text-foreground/85"
                      )}
                    >
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="text-muted-foreground/80 mt-0.5">
                        {Object.keys(s.measurements).length}건반 측정
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => { createSession(); setShowSessionList(false); }}
              className="px-3 py-1.5 text-sm bg-precision text-white rounded-lg font-medium whitespace-nowrap"
            >
              + 새 세션
            </button>
          </div>
          <div className="flex flex-col gap-2 pt-2 border-t border-border/60">
            <input
              type="text"
              placeholder="성명 입력 (PDF에 표시)"
              value={userName}
              onChange={e => setUserName(e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 outline-none focus:border-precision/60"
            />
            <div className="flex gap-2">
              <button
                onClick={() => activeSession && exportToPdf(activeSession.name, userName, activeSession.measurements as any)}
                disabled={measuredCount === 0}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                  measuredCount > 0 ? "bg-primary text-white" : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                )}
              >
                📄 PDF
              </button>
              <button
                onClick={() => activeSession && exportToImage(activeSession.name, userName, activeSession.measurements as any)}
                disabled={measuredCount === 0}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                  measuredCount > 0 ? "bg-in-tune text-white" : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                )}
              >
                🖼️ 이미지
              </button>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}
