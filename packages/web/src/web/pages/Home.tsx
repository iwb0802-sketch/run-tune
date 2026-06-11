/**
 * Home.tsx
 * Design: Technical Minimalism / Professional Instrument
 *
 * 개선사항:
 * - 자동저장 모드: 안정 감지 시 자동 저장 (수동저장 모드 병행)
 * - 되돌리기(Undo): 직전 저장 건반 삭제 (Ctrl+Z / 버튼)
 * - 마이크 복구 중 상태 표시
 */

import PitchMeter from "@/components/tuner/PitchMeter";
import ReferenceAudioPanel from "@/components/tuner/ReferenceAudioPanel";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import { usePitchDetector, PIANO_KEYS, PitchResult } from "@/hooks/usePitchDetector";
import { useTuningSession } from "@/hooks/useTuningSession";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import { useStrobeDetector } from "@/hooks/useStrobeDetector";


import { useWakeLock } from "@/hooks/useWakeLock";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import AdminPage from "@/pages/AdminPage";
import PrecisionPage from "@/pages/PrecisionPage";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";

import { toast as sonnerToast } from "sonner";

// toast: callable + .success/.error (replaces inline implementation)
const toast: ((msg: string, opts?: { duration?: number }) => void) & {
  success: (msg: string, opts?: { duration?: number }) => void;
  error: (msg: string) => void;
} = Object.assign(
  (msg: string, opts?: { duration?: number }) => sonnerToast(msg, opts),
  {
    success: (msg: string, opts?: { duration?: number }) => sonnerToast.success(msg, opts),
    error: (msg: string) => sonnerToast.error(msg),
  }
);

export default function Home() {
  const { user, signOut } = useAuth();
  const { isAdmin, isPro } = useUserRole(user?.id);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showPrecision, setShowPrecision] = useState(false);
  const [
    userName, setUserName
  ] = useState("");
  const [showExportModal, setShowExportModal] = useState(false);

  const {
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    createSession,
    deleteSession,
    recordMeasurement,
    recordStrobeMeasurement,
    undoLastMeasurement,
    undoStack,
    clearAllMeasurements,
    renameSession,
    importSession,
    chartData,
    measuredCount,
  } = useTuningSession(null);

  const handleExportPdf = useCallback(() => {
    if (!activeSession) return;
    exportToPdf(activeSession.name, userName, activeSession.measurements);
  }, [activeSession, userName]);

  const handleExportImage = useCallback(() => {
    if (!activeSession) return;
    exportToImage(activeSession.name, userName, activeSession.measurements);
  }, [activeSession, userName]);


  const [stableDuration, setStableDuration] = useState(800); // ms (0.8초 기본값)
  const [fftSize, setFftSize] = useState<4096 | 8192>(4096); // 기본: 빠름 모드

  const [pendingPitch, setPendingPitch] = useState<PitchResult | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [showAudio, setShowAudio] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [autoSave, setAutoSave] = useState(true); // 자동저장 모드 (기본값: ON)
  const [showStrobeOnly, setShowStrobeOnly] = useState(false);
  // autoSave를 ref로도 유지 → 타이머/콜백에서 항상 최신값 참조
  const autoSaveRef = useRef(true);
  const pendingRef = useRef<PitchResult | null>(null);

  // 자동저장 딜레이 타이머
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // autoSave 상태 변경 시 ref도 동기화 + 타이머 즉시 취소
  const handleSetAutoSave = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    setAutoSave(prev => {
      const next = typeof val === "function" ? val(prev) : val;
      autoSaveRef.current = next;
      // OFF로 바꿀 때 대기 중인 타이머 즉시 취소
      if (!next && autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      return next;
    });
  }, []);

  // activeSessionId를 ref로도 유지 → 마이크 시작 시 캡처된 stale closure 회피
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const handlePitchDetected = useCallback((result: PitchResult) => {
    if (result.confidence >= 0.55) {
      setPendingPitch(result);
      pendingRef.current = result;
      // 자동저장 모드 — ref로 최신값 확인
      if (autoSaveRef.current && activeSessionIdRef.current) {
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = setTimeout(() => {
          if (!autoSaveRef.current) return;
          const p = pendingRef.current;
          if (!p) return;
          recordMeasurement(p.keyIndex, p.cents, p.frequency);
          setPendingPitch(null);
          pendingRef.current = null;
        }, 800);
      }
    }
  }, [recordMeasurement]);

  const { isListening, currentPitch, startListening, stopListening, error, isRecovering, stream, audioContext } =
    usePitchDetector(handlePitchDetected, fftSize);

  // 화면 꺼짐 방지 - 마이크 켜지면 자동 활성화
  useWakeLock(isListening);

  // 스트로브 독립 감지 (자동 센트와 완전 분리)
  const { strobeCents: stableCents, isCapturing, captureProgress, currentNote: strobeNote, currentKeyIndex: strobeKeyIndex, analysisFreq: strobeAnalysisFreq, partial: strobePartial } = useStrobeDetector(
    isListening ? stream : null,
    isListening ? audioContext : null,
    stableDuration,
    fftSize,
    currentPitch?.keyIndex ?? null  // 자동 피치 기준 건반으로 옵타브 보정
  );

  // 스트로브 1회 자동저장 - 안정값 감지 시 자동으로 파란 점에 기록
  const lastAutoStrobeKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (stableCents !== null && strobeKeyIndex !== null && activeSessionIdRef.current) {
      if (lastAutoStrobeKeyRef.current === strobeKeyIndex) return;
      lastAutoStrobeKeyRef.current = strobeKeyIndex;
      recordStrobeMeasurement(strobeKeyIndex, stableCents);
    }
    if (stableCents === null) {
      lastAutoStrobeKeyRef.current = null;
    }
  }, [stableCents, strobeKeyIndex, recordStrobeMeasurement]);

  // 수동 저장
  const saveCurrent = useCallback(() => {
    const p = pendingRef.current;
    if (!p || !activeSessionIdRef.current) return;
    recordMeasurement(p.keyIndex, p.cents, p.frequency);
    toast.success(`건반 ${p.keyIndex + 1} (${p.noteName}${p.octave}) ${p.cents > 0 ? "+" : ""}${p.cents.toFixed(1)}¢ 저장됨`);
    setPendingPitch(null);
    pendingRef.current = null;
  }, [recordMeasurement]);

  const skipCurrent = useCallback(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    setPendingPitch(null);
    pendingRef.current = null;
  }, []);

  // 되돌리기
  const handleUndo = useCallback(() => {
    const removed = undoLastMeasurement();
    if (removed !== null) {
      const key = PIANO_KEYS[removed];
      toast(`↩ 건반 ${removed + 1} (${key.noteName}${key.octave}) 삭제됨`, { duration: 2000 });
    } else {
      toast("되돌릴 항목이 없습니다.");
    }
  }, [undoLastMeasurement]);

  // 자동저장 모드 전환 시 타이머 초기화
  useEffect(() => {
    if (!autoSave) {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    }
  }, [autoSave]);

  // 키보드 단축키
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space" && !autoSave) { e.preventDefault(); saveCurrent(); }
      if (e.code === "Escape") { e.preventDefault(); skipCurrent(); }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); handleUndo(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveCurrent, skipCurrent, handleUndo, autoSave]);

  const toggleListening = async () => {
    if (!activeSessionIdRef.current) {
      const s = await createSession();
      if (s) activeSessionIdRef.current = s.id; // ref 즉시 동기화
    }
    if (isListening) { stopListening(); }
    else { await startListening(); }
  };

  const handleNewSession = async () => {
    const s = await createSession();
    if (s) toast.success(`새 세션 "${s.name}" 생성됨`);
    setShowSessions(false);
  };

  const handleRenameSubmit = (id: string) => {
    if (renameValue.trim()) { renameSession(id, renameValue.trim()); toast.success("이름 변경됨"); }
    setRenamingId(null); setRenameValue("");
  };

  const displayPitch = currentPitch || pendingPitch;
  const visibleSession = activeSession ?? {
    id: "draft-session",
    name: "새 조율 세션",
    createdAt: Date.now(),
    measurements: {},
  };

  return (
    <div className="min-h-screen bg-muted/50 flex flex-col" style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>
      {/* 헤더 */}
      <header className="bg-card border-b border-border px-4 py-3 flex flex-col gap-3 shadow-sm relative sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-foreground leading-tight">Piano Tuning Scope</h1>
            <p className="text-xs text-muted-foreground/80">피아노 조율 커브 측정기</p>
          </div>
        </div>
          <div className="flex w-full items-center gap-2 overflow-x-auto pb-0.5 sm:w-auto sm:overflow-visible sm:pb-0">
          {/* 모드 전환: 자동 / 수동 / 복합 */}
          <nav className="flex shrink-0 items-center gap-1 bg-muted rounded-lg p-0.5 mr-1">
            <span className="px-3 py-1 text-xs font-bold rounded-md bg-card text-primary shadow-sm">
              자동
            </span>
            <Link
              to="/manual"
              className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors"
            >
              수동
            </Link>
            <Link
              to="/composite"
              className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors"
            >
              복합
            </Link>
          </nav>
          <button onClick={() => setShowSessions(!showSessions)}
            className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-sm bg-muted hover:bg-muted rounded-lg transition-colors sm:px-3"
            aria-label="세션 선택">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="hidden text-foreground/85 max-w-[120px] truncate md:inline">{activeSession ? activeSession.name : "세션 없음"}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button onClick={handleNewSession}
            className="shrink-0 px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors font-medium"
            aria-label="새 세션">
            <span className="sm:hidden">+</span>
            <span className="hidden sm:inline">+ 새 세션</span>
          </button>
          {/* 정밀 측정 버튼 */}
          <button
            onClick={() => setShowPrecision(true)}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-1.5 text-sm bg-precision hover:bg-precision/90 text-white rounded-lg transition-colors font-medium"
            title="정밀 측정 모드">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
            <span className="whitespace-nowrap">정밀측정</span>
          </button>

          {/* 관리자 버튼 */}
          {isAdmin && (
            <button onClick={() => setShowAdmin(true)}
              className="shrink-0 w-8 h-8 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-700 flex items-center justify-center transition-colors"
              title="관리자 대시보드">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </button>
          )}

          {/* 로그아웃 버튼 */}
          <button onClick={() => signOut()}
            title={user?.email || '로그아웃'}
            className="shrink-0 w-8 h-8 rounded-lg bg-muted hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>

        </div>
      </header>

      {/* 관리자 대시보드 모달 */}
      {showAdmin && <AdminPage onClose={() => setShowAdmin(false)} />}

      {/* 정밀 측정 페이지 (전체 화면 오버레이) */}
      {showPrecision && (
        <div className="fixed inset-0 z-50 bg-card overflow-y-auto">
          <div className="sticky top-0 z-10 bg-card border-b border-border px-4 py-2 flex items-center gap-2">
            <button onClick={() => setShowPrecision(false)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              돌아가기
            </button>
          </div>
          <PrecisionPage />
        </div>
      )}

      {/* 기준음/맥놀이 고정 바 */}
      <ReferenceAudioPanel />

      {/* 세션 드롭다운 */}
      {showSessions && (
        <div className="absolute top-16 right-4 z-50 w-72 bg-card border border-border rounded-xl shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-border/60 bg-muted/50">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">저장된 세션</span>
          </div>
          {sessions.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground/80">세션이 없습니다.<br />새 세션을 만들어 시작하세요.</div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {sessions.map((s) => (
                <div key={s.id}
                  className={cn("flex items-center gap-2 px-3 py-2.5 hover:bg-muted/50 cursor-pointer border-b border-border/40",
                    s.id === activeSessionId && "bg-primary-soft")}>
                  {renamingId === s.id ? (
                    <input autoFocus value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => handleRenameSubmit(s.id)}
                      onKeyDown={e => { if (e.key === "Enter") handleRenameSubmit(s.id); if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); } }}
                      className="flex-1 text-sm border border-primary/40 rounded px-2 py-0.5 outline-none"
                      onClick={e => e.stopPropagation()} />
                  ) : (
                    <div className="flex-1 min-w-0" onClick={() => { setActiveSessionId(s.id); setShowSessions(false); }}>
                      <div className={cn("text-sm font-medium truncate", s.id === activeSessionId ? "text-primary" : "text-foreground")}>{s.name}</div>
                      <div className="text-xs text-muted-foreground/80">{Object.keys(s.measurements).length}건반 · {new Date(s.createdAt).toLocaleDateString("ko-KR")}</div>
                    </div>
                  )}
                  <button onClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameValue(s.name); }}
                    className="p-1 text-muted-foreground/80 hover:text-muted-foreground rounded">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button onClick={e => { e.stopPropagation(); if (confirm("삭제할까요?")) deleteSession(s.id); }}
                    className="p-1 text-muted-foreground/80 hover:text-off rounded">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {showSessions && <div className="fixed inset-0 z-40" onClick={() => setShowSessions(false)} />}

      {/* 메인 */}
      <main className="flex-1 container py-4 max-w-6xl mx-auto px-4">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
            {/* 왼쪽 */}
            <div className="flex flex-col gap-4">
              {/* 세션 정보 바 */}
              <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{visibleSession.name}</h2>
                    <p className="text-xs text-muted-foreground/80">
                      {measuredCount} / 88건반 측정 완료
                      {measuredCount > 0 && <span className="ml-2 text-primary">({Math.round((measuredCount / 88) * 100)}%)</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all duration-300"
                        style={{ width: `${(measuredCount / 88) * 100}%` }} />
                    </div>
                    {measuredCount > 0 && (
                      <button onClick={() => { if (confirm("모든 측정 데이터를 초기화할까요?")) { clearAllMeasurements(); toast.success("초기화됨"); } }}
                        className="text-xs text-muted-foreground/80 hover:text-off transition-colors">초기화</button>
                    )}
                  </div>
                </div>
                {/* 내보내기 버튼 행 */}
                <div className="flex flex-col gap-2 pt-2 border-t border-border/60">
                  {/* 성명 입력 */}
                  <input
                    type="text"
                    placeholder="성명 입력 (PDF에 표시)"
                    value={userName}
                    onChange={e => setUserName(e.target.value)}
                    className="w-full text-sm border border-border rounded-lg px-3 py-2 outline-none focus:border-primary/60 text-foreground/85"
                  />
                  {/* PDF + 이미지 버튼 */}
                  <div className="flex gap-2">
                    <button
                      onClick={handleExportPdf}
                      disabled={measuredCount === 0}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl text-sm font-bold transition-all active:scale-[0.97]",
                        measuredCount > 0
                          ? "bg-primary hover:bg-primary/90 text-white shadow-sm"
                          : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                      )}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/>
                        <polyline points="9 15 12 18 15 15"/>
                      </svg>
                      PDF
                    </button>
                    <button
                      onClick={handleExportImage}
                      disabled={measuredCount === 0}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl text-sm font-bold transition-all active:scale-[0.97]",
                        measuredCount > 0
                          ? "bg-in-tune hover:bg-in-tune/90 text-white shadow-sm"
                          : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                      )}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                      </svg>
                      이미지
                    </button>
                  </div>
                </div>
              </div>

              {/* 그래프 */}
              <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-foreground/85">조율 커브 (Tuning Curve)</h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground/80 flex-wrap">
                    <span className="flex items-center gap-1">
                      <span className="w-5 h-px bg-instrument/80 inline-block" style={{ borderTopStyle: "solid" }} />허용 범위
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-full bg-primary inline-block" />자동
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-full bg-off inline-block" />범위외
                    </span>
                    <span className="flex items-center gap-1">
                      <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="5,0 10,9 0,9" fill="#d97706"/></svg>스트로브
                    </span>
                    {/* 스트로브만 보기 토글 */}
                    <button
                      onClick={() => setShowStrobeOnly(v => !v)}
                      className={cn(
                        "px-2 py-0.5 rounded-md text-xs font-medium border transition-all",
                        showStrobeOnly
                          ? "bg-warn text-white border-warn"
                          : "bg-card text-muted-foreground border-border hover:border-warn/60 hover:text-warn"
                      )}
                    >
                      {showStrobeOnly ? "▲ 스트로브만" : "△ 스트로브만"}
                    </button>
                  </div>
                </div>
                <TuningCurveChart data={chartData} activeKeyIndex={displayPitch?.keyIndex ?? null} showStrobeOnly={showStrobeOnly} />
              </div>

              {/* 컨트롤 바 */}
              <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between shadow-sm flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {/* 마이크 버튼 */}
                  <button
                    onClick={isPro ? toggleListening : undefined}
                    disabled={!isPro}
                    title={!isPro ? "Pro 이상 등급에서 사용 가능합니다" : undefined}
                    className={cn(
                      "flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all duration-150",
                      isPro && "active:scale-[0.97]",
                      !isPro
                        ? "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
                        : isListening ? "bg-off hover:bg-off/90 text-white" : "bg-primary hover:bg-primary/90 text-white"
                    )}>
                    {!isPro ? (
                      <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>마이크 시작</>
                    ) : isListening ? (
                      <><span className="w-2 h-2 rounded-full bg-card animate-pulse" />감지 중지</>
                    ) : (
                      <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" strokeWidth="2" />
                        <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" />
                        <line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" strokeWidth="2" />
                      </svg>마이크 시작</>
                    )}
                  </button>
                  {/* 무료 등급 안내 */}
                  {!isPro && (
                    <span className="text-xs text-muted-foreground bg-muted px-2.5 py-1.5 rounded-lg border border-border">
                      🔒 Pro 이상 전용
                    </span>
                  )}

                  {/* 복구 중 표시 */}
                  {isRecovering && (
                    <span className="flex items-center gap-1.5 text-xs text-warn bg-warn-soft px-2.5 py-1.5 rounded-lg border border-warn/40">
                      <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      마이크 복구 중...
                    </span>
                  )}

                  {/* 자동저장 토글 */}
                  <button onClick={() => handleSetAutoSave(v => !v)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-150 border",
                      autoSave
                        ? "bg-in-tune-soft border-in-tune/50 text-in-tune"
                        : "bg-muted/50 border-border text-muted-foreground hover:bg-muted"
                    )}>
                    <span className={cn("w-2 h-2 rounded-full", autoSave ? "bg-in-tune animate-pulse" : "bg-muted-foreground/30")} />
                    {autoSave ? "자동저장 ON" : "자동저장 OFF"}
                  </button>

                  {/* 되돌리기 버튼 */}
                  <button onClick={handleUndo}
                    disabled={undoStack.length === 0}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-150 border",
                      undoStack.length > 0
                        ? "bg-muted/50 border-border text-foreground/85 hover:bg-muted active:scale-[0.97]"
                        : "bg-muted/50 border-border/60 text-muted-foreground/60 cursor-not-allowed"
                    )}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                    </svg>
                    되돌리기
                    {undoStack.length > 0 && (
                      <span className="text-xs bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 leading-none">
                        {undoStack.length}
                      </span>
                    )}
                  </button>

                  {error && <span className="text-xs text-off">{error}</span>}
                </div>

                {/* 단축키 안내 (수동 모드일 때만) */}
                {!autoSave && (
                  <div className="text-xs text-muted-foreground/80">
                    <kbd className="px-1.5 py-0.5 bg-muted border border-border rounded text-muted-foreground font-mono">Space</kbd> 저장 &nbsp;
                    <kbd className="px-1.5 py-0.5 bg-muted border border-border rounded text-muted-foreground font-mono">Esc</kbd> 건너뛰기 &nbsp;
                    <kbd className="px-1.5 py-0.5 bg-muted border border-border rounded text-muted-foreground font-mono">Ctrl+Z</kbd> 되돌리기
                  </div>
                )}
                {autoSave && (
                  <div className="text-xs text-in-tune">
                    안정 감지 후 0.8초 뒤 자동 저장됩니다 &nbsp;
                    <kbd className="px-1.5 py-0.5 bg-in-tune-soft border border-in-tune/40 rounded text-in-tune font-mono">Ctrl+Z</kbd> 되돌리기
                  </div>
                )}
              </div>
            </div>

            {/* 오른쪽 */}
            <div className="flex flex-col gap-4">

              <PitchMeter
                pitch={displayPitch}
                isListening={isListening}
                autoSave={autoSave}
                onSave={saveCurrent}
                onSkip={skipCurrent}
                stableCents={stableCents}
                isCapturing={isCapturing}
                stableDuration={stableDuration}
                onStableDurationChange={setStableDuration}
                strobeNote={strobeNote}
                strobeKeyIndex={strobeKeyIndex}
                strobePartial={strobePartial}
                strobeAnalysisFreq={strobeAnalysisFreq}
                fftSize={fftSize}
                onFftSizeChange={setFftSize}
                onSaveStrobe={(strobeCents) => {
                  if (!activeSessionId) return;
                  // 스트로브 값은 strobeCents 필드에만 저장 (자동 피치는 덮지 않음)
                  const ki = strobeKeyIndex ?? displayPitch?.keyIndex;
                  if (ki === null || ki === undefined) return;
                  recordStrobeMeasurement(ki, strobeCents);
                  toast.success(`스트로브 저장: 건반 ${ki + 1} ${strobeCents > 0 ? "+" : ""}${strobeCents.toFixed(1)}¢`);
                }}
              />

              {/* 측정 현황 */}
              <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">측정 현황</h3>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-primary-soft rounded-lg p-2.5 text-center">
                    <div className="text-2xl font-bold text-primary" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{measuredCount}</div>
                    <div className="text-xs text-primary/80">측정 완료</div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-2.5 text-center">
                    <div className="text-2xl font-bold text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{88 - measuredCount}</div>
                    <div className="text-xs text-muted-foreground/80">미측정</div>
                  </div>
                </div>
                {measuredCount > 0 && (() => {
                  const measured = chartData.filter(d => d.cents !== null);
                  const avg = measured.reduce((s, d) => s + (d.cents ?? 0), 0) / measured.length;
                  const max = Math.max(...measured.map(d => d.cents ?? 0));
                  const min = Math.min(...measured.map(d => d.cents ?? 0));
                  return (
                    <div className="space-y-1.5 text-xs" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                      <div className="flex justify-between text-muted-foreground">
                        <span>평균 오차</span>
                        <span className={avg > 0 ? "text-warn" : avg < 0 ? "text-primary" : "text-in-tune"}>
                          {avg > 0 ? "+" : ""}{avg.toFixed(1)}¢
                        </span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>최대</span><span className="text-off">+{max.toFixed(1)}¢</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>최소</span><span className="text-primary/80">{min.toFixed(1)}¢</span>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* 최근 측정 */}
              <div className="bg-card border border-border rounded-xl p-4 shadow-sm flex-1">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">최근 측정</h3>
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {Object.values(visibleSession.measurements)
                    .sort((a, b) => b.measuredAt - a.measuredAt)
                    .slice(0, 20)
                    .map((m, idx) => {
                      const key = PIANO_KEYS[m.keyIndex];
                      const isLatest = idx === 0;
                      return (
                        <div key={m.keyIndex}
                          className={cn("flex items-center justify-between py-1 px-2 rounded text-xs",
                            isLatest ? "bg-primary-soft" : "hover:bg-muted/50")}>
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
