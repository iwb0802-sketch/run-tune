/**
 * PrecisionPage.tsx — v2
 *
 * 엔진 분기:
 *  - keyIndex 0~26  (1~27번):  useTargetedStrobe
 *  - keyIndex 27~87 (28~88번): usePitchDetector
 *
 * 자동저장 로직:
 *  - 3회 달성 → 즉시 자동저장 + 다음 건반
 *  - 4~5회 구간 → 확정버튼 활성 (더 측정하고 싶으면 수동 확정)
 *  - 5회 달성 → 자동저장
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { usePitchDetector, PIANO_KEYS } from "@/hooks/usePitchDetector";
import { useTargetedStrobe } from "@/hooks/useTargetedStrobe";
import { useWakeLock } from "@/hooks/useWakeLock";
import { usePrecisionSession } from "@/hooks/usePrecisionSession";
import { UPPER_ABS, LOWER_ABS } from "@/lib/tuner/tuningCurveData";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import { cn } from "@/lib/utils";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useManualSequence } from "@/pages/manual/useManualSequence";
import SectionTabs from "@/pages/manual/SectionTabs";
import TargetNoteBar from "@/pages/manual/TargetNoteBar";

function isLowRange(keyIndex: number): boolean {
  return keyIndex <= 26;
}

function isInRange(keyIndex: number, cents: number): boolean {
  return cents >= LOWER_ABS[keyIndex] && cents <= UPPER_ABS[keyIndex];
}

// ─── 측정내역서 패널 ───────────────────────────────────────────────
function MeasurementSummary({ measurements }: { measurements: Record<number, any> }) {
  const list = Object.values(measurements).sort((a, b) => a.keyIndex - b.keyIndex);
  if (!list.length) return null;

  const passCount = list.filter(m => isInRange(m.keyIndex, m.medianCents)).length;
  const avgDeviation = list.reduce((sum, m) => sum + Math.abs(m.medianCents), 0) / list.length;
  const mean = list.reduce((sum, m) => sum + m.medianCents, 0) / list.length;

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        측정 내역서
      </h3>

      {/* 요약 통계 */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="bg-muted/50 rounded-lg p-2 text-center">
          <div
            className="text-lg font-extrabold text-precision"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {passCount}/{list.length}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">허용범위 통과</div>
        </div>
        <div className="bg-muted/50 rounded-lg p-2 text-center">
          <div
            className="text-lg font-extrabold text-foreground"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {avgDeviation.toFixed(1)}¢
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">평균 편차</div>
        </div>
        <div className="bg-muted/50 rounded-lg p-2 text-center">
          <div
            className={cn(
              "text-lg font-extrabold",
              mean > 0 ? "text-warn" : mean < 0 ? "text-precision" : "text-in-tune"
            )}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {mean > 0 ? "+" : ""}{mean.toFixed(1)}¢
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">평균치</div>
        </div>
      </div>

      {/* 건반별 목록 */}
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
            <tr>
              <th className="text-left px-2 py-1.5 text-muted-foreground font-semibold">건반</th>
              <th className="text-right px-2 py-1.5 text-muted-foreground font-semibold">측정값</th>
              <th className="text-right px-2 py-1.5 text-muted-foreground font-semibold">회차</th>
              <th className="text-right px-2 py-1.5 text-muted-foreground font-semibold">판정</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m, idx) => {
              const key = PIANO_KEYS[m.keyIndex];
              const inR = isInRange(m.keyIndex, m.medianCents);
              return (
                <tr
                  key={m.keyIndex}
                  className={cn(
                    "border-b border-border/40 last:border-0",
                    idx % 2 === 0 ? "bg-transparent" : "bg-muted/20"
                  )}
                >
                  <td className="px-2 py-1.5">
                    <span
                      className="font-bold text-foreground/85"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {key.noteName}{key.octave}
                    </span>
                    <span className="text-muted-foreground/60 ml-1">#{m.keyIndex + 1}</span>
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right font-bold tabular-nums",
                      inR ? "text-precision" : "text-off"
                    )}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {m.medianCents > 0 ? "+" : ""}{m.medianCents.toFixed(1)}¢
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground/70">
                    {m.centsHistory.length}회
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                      inR
                        ? "bg-precision/15 text-precision"
                        : "bg-off/15 text-off"
                    )}>
                      {inR ? "OK" : "NG"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 최근 확정 목록 ────────────────────────────────────────────────
function PrecisionResultList({ measurements }: { measurements: Record<number, any> }) {
  const [expandedKey, setExpandedKey] = useState<number | null>(null);
  const sorted = Object.values(measurements)
    .sort((a, b) => b.measuredAt - a.measuredAt)
    .slice(0, 10);

  if (!sorted.length) return null;

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        최근 확정
      </h3>
      <div className="space-y-1 max-h-52 overflow-y-auto">
        {sorted.map((m, idx) => {
          const key = PIANO_KEYS[m.keyIndex];
          const inR = isInRange(m.keyIndex, m.medianCents);
          const isExpanded = expandedKey === m.keyIndex;
          return (
            <div key={m.keyIndex}>
              <div
                onClick={() => setExpandedKey(isExpanded ? null : m.keyIndex)}
                className={cn(
                  "flex items-center justify-between py-1.5 px-2 rounded text-xs cursor-pointer transition-colors",
                  idx === 0 ? "bg-precision-soft" : "hover:bg-muted/50"
                )}
              >
                <span
                  className="text-foreground/85 font-semibold w-10"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {key.noteName}{key.octave}
                </span>
                <span className="text-muted-foreground/60 flex-1">#{m.keyIndex + 1}</span>
                <span className="text-muted-foreground/60 mr-2">{m.centsHistory.length}회</span>
                <div className="flex items-center gap-1">
                  <span
                    className={cn("font-bold tabular-nums", inR ? "text-precision" : "text-off")}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {m.medianCents > 0 ? "+" : ""}{m.medianCents.toFixed(1)}¢
                  </span>
                  <span className="text-muted-foreground/50 text-[10px]">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </div>
              {isExpanded && (
                <div className="mx-2 mb-1 bg-muted/40 rounded-lg p-2 border border-border/50">
                  <table className="w-full text-xs">
                    <tbody>
                      {m.centsHistory.map((c: number, i: number) => (
                        <tr key={i} className="border-b border-border/40 last:border-0">
                          <td className="py-1 text-primary">{i + 1}회</td>
                          <td
                            className="py-1 text-right font-mono font-semibold text-foreground/85"
                            style={{ fontFamily: "'JetBrains Mono', monospace" }}
                          >
                            {c > 0 ? "+" : ""}{c.toFixed(1)}¢
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-precision-soft">
                        <td className="py-1.5 text-precision font-bold">중앙값</td>
                        <td
                          className="py-1.5 text-right font-mono font-bold"
                          style={{ color: inR ? "#7c3aed" : "#dc2626", fontFamily: "'JetBrains Mono', monospace" }}
                        >
                          {m.medianCents > 0 ? "+" : ""}{m.medianCents.toFixed(1)}¢
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 메인 페이지 ───────────────────────────────────────────────────
export default function PrecisionPage() {
  const { user } = useAuth();
  const { isPro } = useUserRole(user?.id);

  const seq = useManualSequence();
  const session = usePrecisionSession();
  const {
    sessions, activeSession, activeSessionId, createSession, measuredCount,
    pendingKeyIndex, centsHistory, currentLive, isCapturing,
    medianCents, canConfirm, shouldAutoSave3, shouldAutoSave5,
    AUTO_SAVE_SAMPLES, MAX_SAMPLES,
    onPitchActive, onSilenceDetected, onStrobeSample,
    saveCurrentToSession, confirmCurrent, clearAllMeasurements, resetPending,
    setActiveSessionId,
  } = session;

  const targetKeyIndex = seq.targetKeyIndex;
  const isLow = isLowRange(targetKeyIndex);

  const [showGuide, setShowGuide] = useState(true);
  const [userName, setUserName] = useState("");
  const [showSessionList, setShowSessionList] = useState(false);
  const [summaryView, setSummaryView] = useState<"recent" | "all">("recent");

  useWakeLock(true);

  const targetKeyRef = useRef(targetKeyIndex);
  useEffect(() => {
    targetKeyRef.current = targetKeyIndex;
    resetPending();
  }, [targetKeyIndex, resetPending]);

  // ─── 중/고음: usePitchDetector ────────────────────────────────────
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePitch = useCallback((result: any) => {
    if (result.confidence < 0.55) return;
    const target = targetKeyRef.current;
    if (isLowRange(target)) return;
    if (Math.abs(result.keyIndex - target) > 3) return;
    onPitchActive(target, result.cents);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => onSilenceDetected(), 500);
  }, [onPitchActive, onSilenceDetected]);

  const { isListening, currentPitch, startListening, stopListening, error, stream, audioContext } =
    usePitchDetector(handlePitch);

  // ─── 저음: useTargetedStrobe ──────────────────────────────────────
  const strobeTarget = isLow ? targetKeyIndex : null;
  const strobe = useTargetedStrobe(
    isListening ? stream : null,
    isListening ? audioContext : null,
    strobeTarget,
    { stableDurationMs: 1000, fftSize: 4096 }
  );

  const prevStrobeCentsRef = useRef<number | null>(null);
  useEffect(() => {
    const c = strobe.strobeCents;
    if (c === null) { prevStrobeCentsRef.current = null; return; }
    if (c === prevStrobeCentsRef.current) return;
    if (!isLowRange(targetKeyRef.current)) return;
    prevStrobeCentsRef.current = c;
    onStrobeSample(targetKeyRef.current, c);
  }, [strobe.strobeCents, onStrobeSample]);

  useEffect(() => { prevStrobeCentsRef.current = null; }, [targetKeyIndex]);

  // ─── 자동저장 트리거 ─────────────────────────────────────────────
  // 3회, 5회 달성 시 saveCurrentToSession (패널 유지, resetPending 안 함)
  const autoSavedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (pendingKeyIndex === null) return;
    const freq = PIANO_KEYS[pendingKeyIndex]?.freq ?? (currentPitch?.frequency ?? 0);

    // 3회 자동저장
    const k3 = `${pendingKeyIndex}-3`;
    if (shouldAutoSave3 && !autoSavedRef.current.has(k3)) {
      autoSavedRef.current.add(k3);
      saveCurrentToSession(freq);
      // 패널 유지 — 4~5회 추가 측정 가능
    }

    // 5회 자동저장
    const k5 = `${pendingKeyIndex}-5`;
    if (shouldAutoSave5 && !autoSavedRef.current.has(k5)) {
      autoSavedRef.current.add(k5);
      saveCurrentToSession(freq);
      // 패널 유지
    }
  }, [shouldAutoSave3, shouldAutoSave5, pendingKeyIndex]);

  useEffect(() => {
    if (pendingKeyIndex === null) autoSavedRef.current = new Set();
  }, [pendingKeyIndex]);

  const toggleListening = async () => {
    if (!activeSessionId) createSession();
    if (isListening) stopListening();
    else await startListening();
  };

  // 차트 데이터 — sessions state 직접 참조 (확정 즉시 반영)
  const currentMeasurements = sessions.find(s => s.id === activeSessionId)?.measurements ?? {};
  const chartData = PIANO_KEYS.map((key, i) => {
    const m = currentMeasurements[i];
    return {
      keyNumber: key.keyNumber, keyIndex: i,
      noteName: key.noteName, octave: key.octave,
      isBlack: key.isBlack,
      cents: m ? m.medianCents : null,
      measured: !!m,
    };
  });

  const liveDisplayCents = isLow
    ? (strobe.liveCents ?? null)
    : (currentLive ?? (currentPitch?.cents ?? null));

  const existingMeasurement = pendingKeyIndex !== null
    ? currentMeasurements[pendingKeyIndex]
    : null;

  return (
    <div
      className="min-h-screen bg-muted/50 flex flex-col"
      style={{ fontFamily: "'Noto Sans KR', sans-serif" }}
    >
      {/* 헤더 */}
      <header className="bg-card border-b border-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-precision rounded-lg flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4l3 3" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground leading-tight">정밀 측정 모드</h1>
            <p className="text-xs text-muted-foreground/80">
              {isLow
                ? `저음 스트로브 · 배음 ${strobe.partial ?? "?"}배 · 3회 자동저장`
                : `피치 감지 · 3회 자동저장`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {measuredCount > 0 && (
            <span className="text-xs font-bold text-precision bg-precision-soft px-2 py-1 rounded-lg">
              {measuredCount}/88
            </span>
          )}
          <button
            onClick={() => setShowGuide(v => !v)}
            className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-muted-foreground text-sm font-bold"
          >?</button>
        </div>
      </header>

      {/* 구간 탭 */}
      <div className="px-4 pt-3">
        <SectionTabs section={seq.section} onChange={seq.setSection} />
      </div>
      <div className="px-4 pt-2 pb-1">
        <TargetNoteBar
          keyIndex={targetKeyIndex}
          indexInOrder={seq.indexInOrder}
          total={seq.total}
          canPrev={seq.canPrev}
          canNext={seq.canNext}
          onPrev={seq.prev}
          onNext={seq.next}
        />
      </div>

      <main className="flex-1 container py-4 max-w-6xl mx-auto px-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">

          {/* 왼쪽 컬럼 */}
          <div className="flex flex-col gap-4 order-1 lg:col-start-1">

            {/* 조율 커브 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground/85">조율 커브</h3>
                <div className="flex items-center gap-2 text-xs text-muted-foreground/80">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-precision inline-block" />확정값
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-off inline-block" />범위외
                  </span>
                </div>
              </div>
              <TuningCurveChart data={chartData} activeKeyIndex={targetKeyIndex} />
            </div>

            {/* 마이크 */}
            <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between shadow-sm">
              <button
                onClick={isPro ? toggleListening : undefined}
                disabled={!isPro}
                title={!isPro ? "Pro 이상 등급에서 사용 가능합니다" : undefined}
                className={cn(
                  "flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all",
                  isPro && "active:scale-[0.97]",
                  !isPro
                    ? "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
                    : isListening
                      ? "bg-off text-white"
                      : "bg-precision hover:bg-precision/90 text-white"
                )}
              >
                {!isPro
                  ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>마이크 시작</>
                  : isListening
                    ? <><span className="w-2 h-2 rounded-full bg-card animate-pulse" />감지 중지</>
                    : <>🎤 마이크 시작</>
                }
              </button>
              {!isPro && (
                <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-lg border border-border">
                  Pro 전용
                </span>
              )}
              {isPro && measuredCount > 0 && (
                <button
                  onClick={() => { if (confirm("초기화?")) clearAllMeasurements(); }}
                  className="text-xs text-muted-foreground/80 hover:text-off"
                >초기화</button>
              )}
              {error && <span className="text-xs text-off">{error}</span>}
            </div>
          </div>

          {/* 오른쪽 컬럼 */}
          <div className="flex flex-col gap-4 order-2 lg:col-start-2 lg:row-span-2">

            {/* 현재 측정 패널 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
              {/* 패널 상단: 타겟 건반 + 화살표 내비게이션 */}
              <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-border/60">
                <div className="flex items-center gap-1.5 min-w-0">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                    측정 중
                  </h3>
                  <span className="text-[10px] text-muted-foreground/50">·</span>
                  <span
                    className="text-sm font-bold text-precision truncate"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {PIANO_KEYS[targetKeyIndex].noteName}{PIANO_KEYS[targetKeyIndex].octave}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">
                    #{targetKeyIndex + 1}
                  </span>
                  {(() => {
                    const measured = currentMeasurements[targetKeyIndex];
                    if (!measured) return null;
                    const inR = isInRange(targetKeyIndex, measured.medianCents);
                    return (
                      <span className={cn(
                        "text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap",
                        inR ? "bg-precision/15 text-precision" : "bg-off/15 text-off"
                      )}>
                        {measured.medianCents > 0 ? "+" : ""}{measured.medianCents.toFixed(1)}¢
                      </span>
                    );
                  })()}
                </div>
                {/* 화살표 + 회차 카운터 */}
                <div className="flex items-center gap-1 shrink-0">
                  {pendingKeyIndex !== null && (
                    <span className="text-[10px] text-muted-foreground/60 bg-muted px-1.5 py-0.5 rounded-full mr-1">
                      {centsHistory.length}/{MAX_SAMPLES}
                    </span>
                  )}
                  <button
                    onClick={seq.prev}
                    disabled={!seq.canPrev}
                    className={cn(
                      "w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold transition-colors",
                      seq.canPrev
                        ? "bg-muted hover:bg-muted/70 text-foreground/80 active:scale-95"
                        : "bg-muted/40 text-muted-foreground/30 cursor-not-allowed"
                    )}
                    title="이전 건반"
                  >‹</button>
                  <button
                    onClick={seq.next}
                    disabled={!seq.canNext}
                    className={cn(
                      "w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold transition-colors",
                      seq.canNext
                        ? "bg-muted hover:bg-muted/70 text-foreground/80 active:scale-95"
                        : "bg-muted/40 text-muted-foreground/30 cursor-not-allowed"
                    )}
                    title="다음 건반"
                  >›</button>
                </div>
              </div>

              {pendingKeyIndex !== null ? (
                <>
                  {/* 저음 스트로브 진행 상태 */}
                  {isLowRange(pendingKeyIndex) && isListening && (
                    <div className="mb-3 px-3 py-2 bg-muted/50 rounded-xl border border-border/60 text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-muted-foreground">
                          스트로브 ({strobe.analysisFreq ? `${strobe.analysisFreq.toFixed(1)} Hz` : "—"})
                        </span>
                        <span className={cn(
                          "font-bold px-2 py-0.5 rounded-full",
                          strobe.signalOk ? "bg-in-tune/20 text-in-tune" : "bg-muted text-muted-foreground/60"
                        )}>
                          {strobe.signalOk ? "신호 감지" : "신호 없음"}
                        </span>
                      </div>
                      {strobe.isCapturing && (
                        <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                          <div
                            className="bg-precision h-1.5 rounded-full transition-all"
                            style={{ width: `${strobe.captureProgress * 100}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* 수집 내역 테이블 */}
                  {centsHistory.length > 0 && (
                    <div className="border border-border/60 rounded-xl overflow-hidden mb-3">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/50 border-b border-border/60">
                            <th className="text-left px-3 py-2 text-muted-foreground font-semibold">회차</th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-semibold">측정값</th>
                          </tr>
                        </thead>
                        <tbody>
                          {centsHistory.map((c, i) => (
                            <tr key={i} className="border-b border-border/40 last:border-0">
                              <td className="px-3 py-1.5 text-primary font-medium">{i + 1}회</td>
                              <td
                                className="px-3 py-1.5 text-right font-bold text-foreground tabular-nums"
                                style={{ fontFamily: "'JetBrains Mono', monospace" }}
                              >
                                {c > 0 ? "+" : ""}{c.toFixed(1)}¢
                              </td>
                            </tr>
                          ))}
                          {/* 진행 중 실시간 */}
                          {isCapturing && currentLive !== null && !isLowRange(pendingKeyIndex) && (
                            <tr className="bg-yellow-50/60 border-b border-border/40">
                              <td className="px-3 py-1.5 text-yellow-600 font-medium">
                                <span className="animate-pulse">{centsHistory.length + 1}회 진행...</span>
                              </td>
                              <td
                                className="px-3 py-1.5 text-right font-mono text-yellow-600 tabular-nums"
                                style={{ fontFamily: "'JetBrains Mono', monospace" }}
                              >
                                {currentLive > 0 ? "+" : ""}{currentLive.toFixed(1)}¢
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* 실시간 (수집 전) */}
                  {centsHistory.length === 0 && liveDisplayCents !== null && (
                    <div className="flex items-center justify-between px-3 py-2.5 bg-muted/40 rounded-xl border border-border/60 mb-3 text-xs">
                      <span className="text-muted-foreground">실시간</span>
                      <span
                        className="font-mono font-bold text-foreground/80 tabular-nums"
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                      >
                        {liveDisplayCents > 0 ? "+" : ""}{liveDisplayCents.toFixed(1)}¢
                      </span>
                    </div>
                  )}

                  {/* 중앙값 결과 */}
                  {medianCents !== null && (
                    <div className="bg-precision-soft border border-precision/30 rounded-xl p-3 mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-precision">
                          중앙값 ({centsHistory.length}회)
                        </span>
                        <span
                          className="text-xs font-semibold"
                          style={{
                            color: pendingKeyIndex !== null && isInRange(pendingKeyIndex, medianCents)
                              ? "#7c3aed" : "#dc2626"
                          }}
                        >
                          {pendingKeyIndex !== null && isInRange(pendingKeyIndex, medianCents)
                            ? "✓ 허용 범위" : "✗ 범위 초과"}
                        </span>
                      </div>
                      <div
                        className="text-2xl font-extrabold tabular-nums"
                        style={{
                          color: pendingKeyIndex !== null && isInRange(pendingKeyIndex, medianCents)
                            ? "#7c3aed" : "#dc2626",
                          fontFamily: "'JetBrains Mono', monospace"
                        }}
                      >
                        {medianCents > 0 ? "+" : ""}{medianCents.toFixed(1)}¢
                      </div>
                    </div>
                  )}

                  {/* 진행 안내 */}
                  {centsHistory.length < AUTO_SAVE_SAMPLES && !isCapturing && (
                    <div className="text-xs text-muted-foreground/70 text-center py-1 mb-2">
                      {isLowRange(pendingKeyIndex)
                        ? `건반을 치면 스트로브가 자동 수집 (${AUTO_SAVE_SAMPLES - centsHistory.length}회 더 필요)`
                        : `건반을 치고 떼세요 (${AUTO_SAVE_SAMPLES - centsHistory.length}회 더 필요)`
                      }
                    </div>
                  )}

                  {/* 3회 자동저장 완료 배지 */}
                  {centsHistory.length >= AUTO_SAVE_SAMPLES && (
                    <div className={cn(
                      "flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg mb-2",
                      shouldAutoSave5
                        ? "text-in-tune bg-in-tune-soft"
                        : "text-precision bg-precision-soft"
                    )}>
                      <span className={cn(
                        "w-2 h-2 rounded-full",
                        shouldAutoSave5 ? "bg-in-tune animate-pulse" : "bg-precision"
                      )} />
                      {shouldAutoSave5
                        ? `${MAX_SAMPLES}회 달성 → 자동 저장됨`
                        : `저장됨 · 4~5회 더 측정하거나 다음 건반으로 이동하세요`
                      }
                    </div>
                  )}

                  {/* 확정 버튼 (3회 이상 구간: 저장 + 패널 유지) */}
                  {canConfirm && (
                    <button
                      onClick={() => {
                        const freq = PIANO_KEYS[pendingKeyIndex]?.freq ?? (currentPitch?.frequency ?? 0);
                        confirmCurrent(freq);
                      }}
                      className="w-full py-3 rounded-xl text-sm font-bold transition-all active:scale-[0.97] bg-precision hover:bg-precision/90 text-white mb-1"
                    >
                      ✓ {medianCents! > 0 ? "+" : ""}{medianCents!.toFixed(1)}¢ 확정 ({centsHistory.length}회)
                    </button>
                  )}

                  {/* 기존 기록 덮어쓰기 안내 */}
                  {existingMeasurement && (
                    <p className="text-xs text-muted-foreground/70 text-center mt-1">
                      기존: {existingMeasurement.medianCents > 0 ? "+" : ""}{existingMeasurement.medianCents.toFixed(1)}¢ ({existingMeasurement.centsHistory.length}회) → 덮어쓰기
                    </p>
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-muted-foreground/80">
                  <div className="text-3xl mb-2">🎹</div>
                  <p className="text-sm">마이크를 켜고<br />건반을 눌러주세요</p>
                  <p className="text-xs mt-2 text-muted-foreground/60">
                    {isLow ? "저음: 스트로브 자동 수집" : "중/고음: 건반을 치고 떼세요"}
                  </p>
                  <p className="text-xs mt-1 text-muted-foreground/50">
                    3회 → 자동저장 | 4~5회 → 확정버튼
                  </p>
                </div>
              )}
            </div>

            {/* 측정 내역서 / 최근 확정 탭 */}
            {measuredCount > 0 && (
              <div>
                <div className="flex gap-1 mb-2">
                  <button
                    onClick={() => setSummaryView("recent")}
                    className={cn(
                      "flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                      summaryView === "recent"
                        ? "bg-precision text-white"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    )}
                  >최근 확정</button>
                  <button
                    onClick={() => setSummaryView("all")}
                    className={cn(
                      "flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                      summaryView === "all"
                        ? "bg-precision text-white"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    )}
                  >측정 내역서</button>
                </div>
                {summaryView === "recent"
                  ? <PrecisionResultList measurements={currentMeasurements} />
                  : <MeasurementSummary measurements={currentMeasurements} />
                }
              </div>
            )}
          </div>

          {/* 세션 + 내보내기 */}
          <div className="flex flex-col gap-4 order-3 lg:order-1 lg:col-start-1">
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
                    <span className="font-semibold truncate max-w-[160px]">
                      {activeSession?.name || "세션 없음"}
                    </span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <p className="text-xs text-muted-foreground/80 mt-0.5">
                    {measuredCount} / 88건반 측정 완료
                  </p>
                  {showSessionList && (
                    <div className="absolute top-full left-0 mt-1 w-64 bg-card border border-border rounded-xl shadow-lg z-20 max-h-48 overflow-y-auto">
                      {sessions.map(s => (
                        <button
                          key={s.id}
                          onClick={() => { setActiveSessionId(s.id); setShowSessionList(false); }}
                          className={cn(
                            "w-full text-left px-3 py-2.5 text-xs hover:bg-muted/50 border-b border-border/40 last:border-0",
                            s.id === activeSessionId
                              ? "bg-precision-soft text-precision font-bold"
                              : "text-foreground/85"
                          )}
                        >
                          <div className="font-medium truncate">{s.name}</div>
                          <div className="text-muted-foreground/80 mt-0.5">
                            {Object.keys(s.measurements).length}건반 확정
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => { createSession(); setShowSessionList(false); }}
                  className="px-3 py-1.5 text-sm bg-precision text-white rounded-lg font-medium whitespace-nowrap"
                >+ 새 세션</button>
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
                    onClick={() => activeSession && exportToPdf(
                      activeSession.name, userName,
                      Object.fromEntries(
                        Object.entries(currentMeasurements).map(([k, v]) => [k, { ...v, cents: v.medianCents }])
                      )
                    )}
                    disabled={measuredCount === 0}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                      measuredCount > 0
                        ? "bg-precision text-white"
                        : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                    )}
                  >📄 PDF</button>
                  <button
                    onClick={() => activeSession && exportToImage(
                      activeSession.name, userName,
                      Object.fromEntries(
                        Object.entries(currentMeasurements).map(([k, v]) => [k, { ...v, cents: v.medianCents }])
                      )
                    )}
                    disabled={measuredCount === 0}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                      measuredCount > 0
                        ? "bg-in-tune text-white"
                        : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                    )}
                  >🖼️ 이미지</button>
                </div>
              </div>
            </div>

            {/* 안내 카드 */}
            {showGuide && (
              <div className="bg-precision-soft border border-precision/30 rounded-2xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-sm font-bold text-precision">📌 정밀 측정 사용법</h3>
                  <button onClick={() => setShowGuide(false)} className="text-precision/65 text-xs">닫기</button>
                </div>
                <div className="text-xs text-precision space-y-2 leading-relaxed">
                  <div>
                    <p className="font-bold mb-0.5">중앙부 · 상부 (28~88번)</p>
                    <ol className="list-decimal list-inside space-y-0.5 pl-1">
                      <li>마이크 켜기 → 건반을 칩니다</li>
                      <li>손을 떼면 1회 수집</li>
                      <li><strong>3회 달성 → 자동 저장</strong></li>
                      <li>4~5회는 확정 버튼으로 수동 저장</li>
                    </ol>
                  </div>
                  <div>
                    <p className="font-bold mb-0.5">하부 (1~27번)</p>
                    <ol className="list-decimal list-inside space-y-0.5 pl-1">
                      <li>마이크 켜기 → 건반을 칩니다</li>
                      <li>스트로브가 안정되면 자동 수집</li>
                      <li><strong>3회 달성 → 자동 저장</strong></li>
                    </ol>
                  </div>
                  <p className="text-precision/75">💡 5회 수집 시에도 자동 저장됩니다</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
