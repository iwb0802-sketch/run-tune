/**
 * ReferencePage.tsx — 기준음 비교 모드
 *
 * 동작:
 * - 수동모드와 동일한 건반 순서 진행 (useManualSequence)
 * - 각 건반의 ET 주파수를 스피커로 재생 (볼륨 조절 가능)
 * - 마이크로 실측 → ET 대비 cents 오차 표시
 * - 건반 지정 후 치면 비교값이 실시간으로 표시됨
 * - 무료 등급: 마이크 버튼 disabled
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/utils";
import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useTuningSession } from "@/hooks/useTuningSession";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useReferenceTuner } from "@/hooks/useReferenceTuner";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import SectionTabs from "@/pages/manual/SectionTabs";
import TargetNoteBar from "@/pages/manual/TargetNoteBar";
import { useManualSequence } from "@/pages/manual/useManualSequence";

const AUTO_ADVANCE_KEY = "reference_auto_advance_v1";

export default function ReferencePage() {
  const { user, signOut } = useAuth();
  const { isPro, isAdmin } = useUserRole(user?.id);

  // ── 시퀀스 ──────────────────────────────────────────────────────
  const seq = useManualSequence();
  const [autoAdvance, setAutoAdvance] = useState<boolean>(() => {
    try { const v = localStorage.getItem(AUTO_ADVANCE_KEY); return v === null ? true : v === "1"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(AUTO_ADVANCE_KEY, autoAdvance ? "1" : "0"); } catch { /* 무시 */ }
  }, [autoAdvance]);

  // ── 세션 ────────────────────────────────────────────────────────
  const { sessions, activeSession, activeSessionId, setActiveSessionId, createSession,
    recordMeasurement, chartData, measuredCount } = useTuningSession(null);
  const [userName, setUserName] = useState("");
  const [showSessionList, setShowSessionList] = useState(false);
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  // ── 엔진 ────────────────────────────────────────────────────────
  const autoAdvanceRef = useRef(autoAdvance);
  useEffect(() => { autoAdvanceRef.current = autoAdvance; }, [autoAdvance]);

  const handleConfirmed = useCallback(() => {}, []);

  const {
    isPlayingRef, refVolume, toggleReference, setRefVolume,
    isListening, startListening, stopListening, error,
    result, stableCents,
  } = useReferenceTuner(seq.targetKeyIndex, handleConfirmed, 4096);

  useWakeLock(isListening);

  // 자동진행 타이머
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAdvTimer = useCallback(() => {
    if (advanceTimerRef.current) { clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
  }, []);

  // ── 저장 ────────────────────────────────────────────────────────
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const s = await createSession();
    return s?.id ?? null;
  }, [createSession]);

  const handleSave = useCallback(async () => {
    const cents = stableCents ?? result?.cents;
    if (cents === null || cents === undefined) return;
    const sid = await ensureSession();
    if (!sid) return;
    recordMeasurement(seq.targetKeyIndex, cents, result?.frequency ?? PIANO_KEYS[seq.targetKeyIndex].freq);
    sonnerToast.success(
      `건반 ${seq.targetKeyIndex + 1} (${PIANO_KEYS[seq.targetKeyIndex].noteName}${PIANO_KEYS[seq.targetKeyIndex].octave}) ` +
      `${cents > 0 ? "+" : ""}${cents.toFixed(1)}¢ 저장됨`
    );
    if (autoAdvanceRef.current && seq.canNext) {
      clearAdvTimer();
      advanceTimerRef.current = setTimeout(() => { seq.next(); }, 300);
    }
  }, [result, stableCents, seq, ensureSession, recordMeasurement, clearAdvTimer]);

  // targetKeyIndex 변경 시 타이머 초기화
  useEffect(() => { clearAdvTimer(); }, [seq.targetKeyIndex, clearAdvTimer]);
  useEffect(() => () => clearAdvTimer(), [clearAdvTimer]);

  // ── 마이크 토글 ─────────────────────────────────────────────────
  const toggleListening = useCallback(async () => {
    if (!activeSessionIdRef.current) await createSession();
    if (isListening) stopListening();
    else await startListening();
  }, [isListening, startListening, stopListening, createSession]);

  // 표시할 cents 값
  const displayCents = stableCents ?? result?.cents ?? null;
  const displayFreq = result?.frequency ?? null;
  const etFreq = PIANO_KEYS[seq.targetKeyIndex]?.freq ?? 440;

  const centsColor = displayCents === null ? "text-muted-foreground"
    : Math.abs(displayCents) <= 2 ? "text-in-tune"
    : Math.abs(displayCents) <= 8 ? "text-warn"
    : "text-off";

  return (
    <div className="min-h-screen bg-muted/50 flex flex-col" style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>
      {/* 헤더 */}
      <header className="bg-card border-b border-border px-4 py-3 flex flex-col gap-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-foreground leading-tight">Piano Tuning Scope</h1>
            <p className="text-xs text-muted-foreground/80">기준음 비교 모드</p>
          </div>
        </div>
        <div className="flex w-full items-center gap-2 overflow-x-auto pb-0.5 sm:w-auto sm:overflow-visible sm:pb-0">
          {/* 모드 네비 */}
          <nav className="flex shrink-0 items-center gap-1 bg-muted rounded-lg p-0.5 mr-1">
            <Link to="/" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">자동</Link>
            <Link to="/manual" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">수동</Link>
            <Link to="/composite" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">복합</Link>
            <span className="px-3 py-1 text-xs font-bold rounded-md bg-card text-primary shadow-sm">기준음</span>
          </nav>
          {/* 세션 */}
          <button onClick={() => setShowSessionList(v => !v)}
            className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-sm bg-muted hover:bg-muted rounded-lg transition-colors sm:px-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="hidden text-foreground/85 max-w-[120px] truncate md:inline">
              {activeSession ? activeSession.name : "세션 없음"}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button onClick={async () => { const s = await createSession(); if (s) sonnerToast.success(`"${s.name}" 생성됨`); }}
            className="shrink-0 px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors font-medium">
            <span className="sm:hidden">+</span>
            <span className="hidden sm:inline">+ 새 세션</span>
          </button>
          {/* 관리자 */}
          {isAdmin && (
            <Link to="/"
              className="shrink-0 w-8 h-8 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-700 flex items-center justify-center transition-colors"
              title="홈으로">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </Link>
          )}
          <button onClick={() => signOut()}
            className="shrink-0 w-8 h-8 rounded-lg bg-muted hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      {/* 세션 드롭다운 */}
      {showSessionList && (
        <>
          <div className="absolute top-16 right-4 z-50 w-64 bg-card border border-border rounded-xl shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border/60 bg-muted/50">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">세션</span>
            </div>
            {sessions.length === 0 ? (
              <div className="px-4 py-5 text-center text-sm text-muted-foreground/80">세션이 없습니다.</div>
            ) : (
              <div className="max-h-56 overflow-y-auto">
                {sessions.map(s => (
                  <div key={s.id}
                    onClick={() => { setActiveSessionId(s.id); setShowSessionList(false); }}
                    className={cn("px-3 py-2.5 cursor-pointer hover:bg-muted/50 border-b border-border/40",
                      s.id === activeSessionId && "bg-primary-soft")}>
                    <div className={cn("text-sm font-medium truncate", s.id === activeSessionId ? "text-primary" : "text-foreground")}>
                      {s.name}
                    </div>
                    <div className="text-xs text-muted-foreground/80">
                      {Object.keys(s.measurements).length}건반 · {new Date(s.createdAt).toLocaleDateString("ko-KR")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="fixed inset-0 z-40" onClick={() => setShowSessionList(false)} />
        </>
      )}

      <main className="flex-1 container py-4 max-w-6xl mx-auto px-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
          {/* 왼쪽 */}
          <div className="flex flex-col gap-4">

            {/* 구간 탭 + 건반 진행 */}
            <div className="bg-card border border-border rounded-xl px-4 pt-4 pb-3 shadow-sm">
              <SectionTabs section={seq.section} onChange={seq.setSection} />
              <div className="mt-3">
                <TargetNoteBar
                  keyIndex={seq.targetKeyIndex}
                  indexInOrder={seq.indexInOrder}
                  total={seq.total}
                  canPrev={seq.canPrev}
                  canNext={seq.canNext}
                  onPrev={seq.prev}
                  onNext={seq.next}
                />
              </div>
              {/* 자동진행 */}
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setAutoAdvance(v => !v)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all",
                    autoAdvance
                      ? "bg-in-tune-soft border-in-tune/50 text-in-tune"
                      : "bg-muted/50 border-border text-muted-foreground hover:bg-muted"
                  )}>
                  <span className={cn("w-2 h-2 rounded-full", autoAdvance ? "bg-in-tune animate-pulse" : "bg-muted-foreground/30")} />
                  저장 후 자동 진행
                </button>
              </div>
            </div>

            {/* 기준음 + 실측 메인 패널 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-foreground">기준음 비교</h2>
                <div className="text-xs text-muted-foreground/70">
                  ET 기준 · A4 = 440Hz
                </div>
              </div>

              {/* 기준음 정보 */}
              <div className="flex items-center gap-3 mb-4 p-3 bg-muted/40 rounded-xl border border-border/60">
                <div className="flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                      {PIANO_KEYS[seq.targetKeyIndex]?.noteName}{PIANO_KEYS[seq.targetKeyIndex]?.octave}
                    </span>
                    <span className="text-sm text-muted-foreground">건반 {seq.targetKeyIndex + 1}</span>
                  </div>
                  <div className="text-xs text-muted-foreground/80 mt-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    ET: {etFreq.toFixed(2)} Hz
                  </div>
                </div>

                {/* 기준음 재생 버튼 */}
                <button
                  onClick={toggleReference}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all active:scale-[0.97]",
                    isPlayingRef
                      ? "bg-warn hover:bg-warn/90 text-white"
                      : "bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30"
                  )}>
                  {isPlayingRef ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
                      </svg>
                      기준음 끄기
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      기준음 켜기
                    </>
                  )}
                </button>
              </div>

              {/* 볼륨 슬라이더 */}
              <div className="flex items-center gap-3 mb-5 px-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground shrink-0">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
                <input
                  type="range" min={0} max={1} step={0.01}
                  value={refVolume}
                  onChange={e => setRefVolume(parseFloat(e.target.value))}
                  className="flex-1 h-1.5 accent-primary"
                />
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground shrink-0">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
                <span className="text-xs text-muted-foreground w-8 text-right" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {Math.round(refVolume * 100)}%
                </span>
              </div>

              {/* cents 표시 */}
              <div className="flex flex-col items-center gap-2 py-4">
                {/* 게이지 바 */}
                <div className="relative w-full max-w-sm h-6 bg-muted/60 rounded-full overflow-hidden border border-border/50">
                  {/* 중앙선 */}
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border/80 z-10" />
                  {/* ±2¢ 허용 범위 */}
                  <div className="absolute top-0 bottom-0 bg-in-tune/20"
                    style={{ left: `calc(50% - ${(2 / 50) * 50}%)`, width: `${(4 / 50) * 100}%` }} />
                  {/* cents 바 */}
                  {displayCents !== null && (
                    <div
                      className={cn("absolute top-0 bottom-0 transition-all duration-100",
                        Math.abs(displayCents) <= 2 ? "bg-in-tune/70" :
                        Math.abs(displayCents) <= 8 ? "bg-warn/70" : "bg-off/70"
                      )}
                      style={{
                        left: displayCents >= 0 ? "50%" : `${50 + (Math.max(displayCents, -50) / 50) * 50}%`,
                        width: `${(Math.min(Math.abs(displayCents), 50) / 50) * 50}%`,
                      }}
                    />
                  )}
                </div>

                {/* 눈금 */}
                <div className="flex justify-between w-full max-w-sm text-xs text-muted-foreground/60" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  <span>-50¢</span><span>-25¢</span><span>0</span><span>+25¢</span><span>+50¢</span>
                </div>

                {/* 숫자 */}
                <div className={cn("text-5xl font-bold tabular-nums mt-2 transition-colors", centsColor)}
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {displayCents === null ? "—"
                    : `${displayCents > 0 ? "+" : ""}${displayCents.toFixed(1)}¢`}
                </div>

                {/* 실측 주파수 */}
                {displayFreq !== null && (
                  <div className="text-xs text-muted-foreground/70" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    실측: {displayFreq.toFixed(2)} Hz &nbsp;·&nbsp; ET: {etFreq.toFixed(2)} Hz
                  </div>
                )}

                {/* 상태 메시지 */}
                <div className="text-sm text-muted-foreground">
                  {!isListening ? "마이크를 켜고 건반을 눌러주세요"
                    : displayCents === null ? "소리를 감지하는 중..."
                    : Math.abs(displayCents) <= 2 ? "정확합니다 ✓"
                    : Math.abs(displayCents) <= 8 ? "허용 범위 내"
                    : `${Math.abs(displayCents).toFixed(1)}¢ ${displayCents > 0 ? "높음" : "낮음"}`}
                </div>
              </div>

              {/* 저음 안정값 표시 */}
              {seq.targetKeyIndex <= 26 && stableCents !== null && (
                <div className="mt-2 p-2.5 bg-precision/10 border border-precision/30 rounded-lg text-xs text-precision/90 text-center">
                  Goertzel 안정값: {stableCents > 0 ? "+" : ""}{stableCents.toFixed(1)}¢
                </div>
              )}
            </div>

            {/* 그래프 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-foreground/85 mb-3">조율 커브</h3>
              <TuningCurveChart data={chartData} activeKeyIndex={seq.targetKeyIndex} />
            </div>
          </div>

          {/* 오른쪽 */}
          <div className="flex flex-col gap-4">

            {/* 컨트롤 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm flex flex-col gap-3">
              {/* 마이크 버튼 */}
              <button
                onClick={isPro ? toggleListening : undefined}
                disabled={!isPro}
                title={!isPro ? "Pro 이상 등급에서 사용 가능합니다" : undefined}
                className={cn(
                  "w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all duration-150",
                  isPro && "active:scale-[0.97]",
                  !isPro
                    ? "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
                    : isListening
                      ? "bg-off hover:bg-off/90 text-white"
                      : "bg-primary hover:bg-primary/90 text-white"
                )}>
                {!isPro ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    마이크 시작 (Pro 전용)
                  </>
                ) : isListening ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-card animate-pulse" />
                    마이크 끄기
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" strokeWidth="2" />
                      <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" />
                      <line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" strokeWidth="2" />
                    </svg>
                    마이크 켜기
                  </>
                )}
              </button>
              {!isPro && (
                <p className="text-xs text-center text-muted-foreground">
                  🔒 Pro 이상 전용 기능입니다
                </p>
              )}
              {error && <p className="text-xs text-off text-center">{error}</p>}

              {/* 저장 버튼 */}
              <button
                onClick={handleSave}
                disabled={displayCents === null}
                className={cn(
                  "w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all active:scale-[0.97]",
                  displayCents !== null
                    ? "bg-in-tune hover:bg-in-tune/90 text-white"
                    : "bg-muted text-muted-foreground/50 cursor-not-allowed"
                )}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                이 값 저장
              </button>
            </div>

            {/* 세션 정보 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">세션</h3>
                <span className="text-xs text-muted-foreground/80">{measuredCount} / 88</span>
              </div>
              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mb-3">
                <div className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${(measuredCount / 88) * 100}%` }} />
              </div>

              <input
                type="text" placeholder="성명 (PDF에 표시)"
                value={userName} onChange={e => setUserName(e.target.value)}
                className="w-full text-sm border border-border rounded-lg px-3 py-2 mb-2 outline-none focus:border-primary/60"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => activeSession && exportToPdf(activeSession.name, userName, activeSession.measurements)}
                  disabled={measuredCount === 0}
                  className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-all",
                    measuredCount > 0 ? "bg-primary hover:bg-primary/90 text-white" : "bg-muted text-muted-foreground/50 cursor-not-allowed")}>
                  PDF
                </button>
                <button
                  onClick={() => activeSession && exportToImage(activeSession.name, userName, activeSession.measurements)}
                  disabled={measuredCount === 0}
                  className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-all",
                    measuredCount > 0 ? "bg-in-tune hover:bg-in-tune/90 text-white" : "bg-muted text-muted-foreground/50 cursor-not-allowed")}>
                  이미지
                </button>
              </div>
            </div>

            {/* 최근 측정 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm flex-1">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">최근 측정</h3>
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {Object.values(activeSession?.measurements ?? {})
                  .sort((a, b) => b.measuredAt - a.measuredAt)
                  .slice(0, 20)
                  .map((m, i) => {
                    const key = PIANO_KEYS[m.keyIndex];
                    return (
                      <div key={m.keyIndex}
                        className={cn("flex items-center justify-between py-1 px-2 rounded text-xs",
                          i === 0 ? "bg-primary-soft" : "hover:bg-muted/50")}>
                        <span className="text-muted-foreground font-medium w-12" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                          {key.noteName}{key.octave}
                        </span>
                        <span className="text-muted-foreground/80">건반 {m.keyIndex + 1}</span>
                        <span className={cn("font-semibold tabular-nums",
                          Math.abs(m.cents) <= 2 ? "text-in-tune" :
                          Math.abs(m.cents) <= 8 ? "text-warn" : "text-off"
                        )} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                          {m.cents > 0 ? "+" : ""}{m.cents.toFixed(1)}¢
                        </span>
                      </div>
                    );
                  })}
                {measuredCount === 0 && (
                  <p className="text-xs text-muted-foreground/80 text-center py-4">아직 측정된 건반이 없습니다.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
