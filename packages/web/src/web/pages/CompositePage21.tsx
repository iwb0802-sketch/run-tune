/**
 * CompositePage21.tsx — 복합 조율 2-1 (실험 탭, /composite2-1)
 *
 * 복합2(/composite2)의 화면·시퀀스·세션·고음 반복 합의 흐름을 그대로 따르되,
 * 엔진은 useCompositeTuner21 을 쓰고 고음(64번~) 저장 방식을 고쳤다.
 *  ① 값 = Goertzel 단독(0.1¢ 정밀 탐색), YIN 은 교차검증 게이트에만 사용
 *  ② 64번~ : 각 타건마다 해머 구간을 버린 뒤 "그 타건"의 중앙값만 반복 측정 1회로 저장
 *     (복합2처럼 직전 타건의 표시값이 저장되거나, 신호 끊김마다 재무장되지 않음)
 *  ③ 저음 8192 창 + 고정 배음(targetPartial)
 *
 * 복합2 코드(CompositePage.tsx / useCompositeTuner.ts)는 건드리지 않는다.
 * 워치 연결: 복합2와 같은 브리지(useWatchBridge)를 /composite2-1 에서도 켠다(engine: "composite2-1").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/utils";
import { useCompositeTuner21, type Composite21Result } from "@/hooks/useCompositeTuner21";
import { useTuningSession } from "@/hooks/useTuningSession";
import { useWakeLock } from "@/hooks/useWakeLock";
import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import { offsetFromA4, A4_KEY_INDEX, recommendedCentsAt } from "@/lib/tuner/recommendedCurve";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import { useAuth } from "@/hooks/useAuth";
import { useWatchBridge } from "@/hooks/useWatchBridge";
import { supabase } from "@/lib/supabase/client";
import { useUserRole } from "@/hooks/useUserRole";
import SectionTabs from "@/pages/manual/SectionTabs";
import TargetNoteBar from "@/pages/manual/TargetNoteBar";
import { COMPOSITE2_SECTION_ORDERS, useManualSequence } from "@/pages/manual/useManualSequence";
import {
  appendHighRepeatSample,
  resolveHighRepeatConsensus,
  type HighRepeatConsensus,
  type HighRepeatSample,
} from "@/lib/tuner/highRepeatConsensus";

const toast = Object.assign(
  (msg: string, opts?: { duration?: number }) => sonnerToast(msg, opts),
  {
    success: (msg: string, opts?: { duration?: number }) => sonnerToast.success(msg, opts),
    error:   (msg: string) => sonnerToast.error(msg),
  }
);

function CentsBar({ cents }: { cents: number }) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const inTune  = Math.abs(cents) <= 2;
  const warn    = Math.abs(cents) <= 8;
  const color   = inTune ? "bg-in-tune" : warn ? "bg-warn" : "bg-off";
  return (
    <div className="relative w-full h-3 bg-muted rounded-full overflow-hidden">
      <div className="absolute left-1/2 top-0 w-px h-full bg-border/60 z-10" />
      <div
        className={cn("absolute top-0.5 h-2 rounded-full transition-all duration-100", color)}
        style={{
          left:  clamped >= 0 ? "50%" : `${((clamped + 50) / 100) * 100}%`,
          width: `${Math.abs(clamped)}%`,
        }}
      />
    </div>
  );
}

function EngineRow({ label, cents, active, highlight }: {
  label: string; cents: number | null; active: boolean; highlight?: boolean;
}) {
  return (
    <div className={cn(
      "flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-colors",
      highlight ? "bg-precision/10 border border-precision/30"
        : active  ? "bg-muted/60 border border-border"
        : "bg-muted/30"
    )}>
      <span className={cn("font-semibold w-20", highlight ? "text-precision" : "text-muted-foreground")}>
        {label}
      </span>
      <span
        className={cn(
          "font-bold tabular-nums w-16 text-right",
          highlight ? "text-foreground" : active ? "text-foreground/80" : "text-muted-foreground/40"
        )}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {cents !== null ? `${cents > 0 ? "+" : ""}${cents.toFixed(1)}¢` : "—"}
      </span>
    </div>
  );
}

export default function CompositePage21() {
  const isComposite3 = false;
  const isComposite2 = true;
  const { user } = useAuth();
  const { isPro } = useUserRole(user?.id);
  const [location] = useLocation();

  const seq = useManualSequence(COMPOSITE2_SECTION_ORDERS);

  const {
    sessions, activeSession, activeSessionId, setActiveSessionId,
    createSession, recordMeasurement, undoLastMeasurement, undoStack,
    chartData, measuredCount,
  } = useTuningSession(null);

  const [userName,        setUserName]        = useState("");
  const [showSessionList, setShowSessionList] = useState(false);
  const [showCentsTable,  setShowCentsTable]  = useState(false);
  const [autoAdvance,     setAutoAdvance]     = useState(true);

  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const seqNextRef = useRef(seq.next);
  useEffect(() => { seqNextRef.current = seq.next; }, [seq.next]);

  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoAdvanceRef  = useRef(autoAdvance);
  useEffect(() => { autoAdvanceRef.current = autoAdvance; }, [autoAdvance]);

  useEffect(() => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, [seq.targetKeyIndex]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const s = await createSession();
    if (s) { activeSessionIdRef.current = s.id; return s.id; }
    return null;
  }, [createSession]);

  // ── 2-1 LOGIC START ── (테스트 벤치가 이 구간을 그대로 잘라 실행한다)
  // 1-indexed 64번 C6 = keyIndex 63 부터는 타건별 반복 측정 합의로 저장한다.
  const REPEAT_START_KEY = 63;
  const REPEAT_LIMIT_CENTS = 50;
  const targetKeyRef = useRef(seq.targetKeyIndex);
  targetKeyRef.current = seq.targetKeyIndex;
  const highRepeatSamplesRef = useRef<HighRepeatSample[]>([]);
  const savedRepeatKeyRef = useRef<number | null>(null);
  const [highRepeatConsensus, setHighRepeatConsensus] = useState<HighRepeatConsensus | null>(null);
  const [highRepeatCount, setHighRepeatCount] = useState(0);
  const [repeatFinalCents, setRepeatFinalCents] = useState<number | null>(null);
  const [heldUpperCents, setHeldUpperCents] = useState<number | null>(null);

  const handleConfirmed = useCallback(async (r: Composite21Result) => {
    if (!r || r.finalCents === null) return;
    // 64번~ 은 아래 handleStrike 가 저장한다.
    if (r.keyIndex >= REPEAT_START_KEY) return;
    if (r.keyIndex !== targetKeyRef.current) return;

    await ensureSession();
    recordMeasurement(r.keyIndex, r.finalCents, r.frequency);
    toast.success(
      `${r.noteName}${r.octave} (건반 ${r.keyIndex + 1}) → ${r.finalCents > 0 ? "+" : ""}${r.finalCents.toFixed(1)}¢`,
      { duration: 1800 }
    );
    if (autoAdvanceRef.current) {
      advanceTimerRef.current = setTimeout(() => { seqNextRef.current(); }, 1000);
    }
  }, [ensureSession, recordMeasurement]);

  // ② 타건 1회 = 그 타건 자신의 안정 구간 중앙값 1개. 엔진이 타건마다 정확히 한 번 호출한다.
  const handleStrike = useCallback((cents: number, keyIndex: number) => {
    if (keyIndex < REPEAT_START_KEY || keyIndex !== targetKeyRef.current) return;
    if (!Number.isFinite(cents) || Math.abs(cents) > REPEAT_LIMIT_CENTS) return;

    const samples = appendHighRepeatSample(highRepeatSamplesRef.current, { cents, capturedAt: Date.now() });
    highRepeatSamplesRef.current = samples;
    setHighRepeatCount(samples.length);
    const consensus = resolveHighRepeatConsensus(samples);
    setHighRepeatConsensus(consensus);
    if (!consensus || savedRepeatKeyRef.current === keyIndex) return;

    savedRepeatKeyRef.current = keyIndex;
    setRepeatFinalCents(consensus.value);
    void ensureSession().then(() => {
      recordMeasurement(keyIndex, consensus.value, PIANO_KEYS[keyIndex].freq);
      toast.success(
        `${PIANO_KEYS[keyIndex].noteName}${PIANO_KEYS[keyIndex].octave} (건반 ${keyIndex + 1}) → ${consensus.value > 0 ? "+" : ""}${consensus.value.toFixed(1)}¢ · ${consensus.used}회 가중평균`,
        { duration: 2200 },
      );
      if (autoAdvanceRef.current) {
        advanceTimerRef.current = setTimeout(() => { seqNextRef.current(); }, 1000);
      }
    });
  }, [ensureSession, recordMeasurement]);

  const fixedTuner = useCompositeTuner21(seq.targetKeyIndex, handleConfirmed, handleStrike);
  const isListening = fixedTuner.isListening;
  const error = fixedTuner.error;
  const result: Composite21Result | null = fixedTuner.result;

  useEffect(() => {
    highRepeatSamplesRef.current = [];
    savedRepeatKeyRef.current = null;
    setHighRepeatConsensus(null);
    setHighRepeatCount(0);
    setRepeatFinalCents(null);
    setHeldUpperCents(null);
  }, [seq.targetKeyIndex]);

  // 상부(50~88번) 표시값: 현재 타건의 해머 구간 이후 중앙값. 무음에서는 마지막 값을 유지한다.
  const isUpper = seq.section === "upper";
  const rawLiveCents = result?.liveCents ?? null;
  const strikeCents = result && result.keyIndex === seq.targetKeyIndex ? result.strikeCents : null;
  useEffect(() => {
    if (!isUpper || !isListening) { setHeldUpperCents(null); return; }
    if (strikeCents !== null) setHeldUpperCents(strikeCents);
  }, [isUpper, isListening, strikeCents]);

  const isRepeatRange = isUpper && seq.targetKeyIndex >= REPEAT_START_KEY;
  const displayedLiveCents = isUpper
    ? strikeCents ?? (result ? rawLiveCents : heldUpperCents)
    : rawLiveCents;
  const displayedFinalCents = isRepeatRange
    ? repeatFinalCents
    : result?.finalCents ?? null;
  // ── 2-1 LOGIC END ──

  useWakeLock(isListening);

  const ensureActiveSession = async () => {
    if (activeSessionIdRef.current) return;
    const s = await createSession();
    if (s) activeSessionIdRef.current = s.id;
  };

  const toggleListening = async () => {
    if (fixedTuner.isListening) fixedTuner.stopListening();
    else { await ensureActiveSession(); await fixedTuner.startListening(); }
  };

  const targetKey = PIANO_KEYS[seq.targetKeyIndex];
  const isComposite2Upper = isUpper;
  const isComposite2SmoothedGraphRange = isRepeatRange;

  const allMeasurements = Object.values(activeSession?.measurements ?? {});
  const selectedMeasurement = activeSession?.measurements[seq.targetKeyIndex]
    ?? activeSession?.measurements[targetKey.keyNumber]
    ?? allMeasurements.find((measurement) =>
      measurement.keyIndex === seq.targetKeyIndex || measurement.keyIndex === targetKey.keyNumber
    );
  const storedCents = (measurement: typeof selectedMeasurement) => measurement
    ? measurement.strobeCents
      ?? measurement.strobe1
      ?? measurement.autoCentsRef
      ?? measurement.baseline?.cents
      ?? measurement.cents
    : null;
  const registeredCents = storedCents(selectedMeasurement);

  const a4Measurement = activeSession?.measurements[A4_KEY_INDEX]
    ?? activeSession?.measurements[A4_KEY_INDEX + 1]
    ?? allMeasurements.find((measurement) =>
      measurement.keyIndex === A4_KEY_INDEX || measurement.keyIndex === A4_KEY_INDEX + 1
    );
  const a4Cents = storedCents(a4Measurement);
  const recommendedOffset = a4Cents !== null && a4Cents !== undefined ? offsetFromA4(a4Cents) : null;
  const targetRecommendedCents = recommendedOffset !== null
    ? recommendedCentsAt(seq.targetKeyIndex, recommendedOffset)
    : null;
  const latestMeasurement = allMeasurements.reduce<typeof selectedMeasurement>((latest, measurement) =>
    !latest || measurement.measuredAt > latest.measuredAt ? measurement : latest,
    undefined,
  );
  const latestRegisteredCents = storedCents(latestMeasurement);
  const currentAssignedCents = displayedFinalCents ?? registeredCents ?? latestRegisteredCents;
  const hasNewAssignedCents = displayedFinalCents !== null;
  const isSelectedRegistered = registeredCents !== null;
  const displayedMeasurementKey = hasNewAssignedCents || isSelectedRegistered
    ? targetKey
    : latestMeasurement ? PIANO_KEYS[latestMeasurement.keyIndex] ?? targetKey : targetKey;
  const assignedValueLabel = hasNewAssignedCents
    ? "새 책정값"
    : isSelectedRegistered ? "이전 등록값" : latestRegisteredCents !== null ? "최근 등록값" : "책정 대기";
  // 워치 연결(복합2와 같은 필드). 현재 건반에 해당하는 값만 전송한다. 2-1 에는 AUTO 가 없다.
  const watchHasCurrentSignal = isListening && result?.keyIndex === seq.targetKeyIndex;
  const watchLiveCents = watchHasCurrentSignal ? displayedLiveCents : null;
  useWatchBridge(location === "/composite2-1", {
    section: seq.section,
    canChangeSection: true,
    keyIndex: seq.targetKeyIndex,
    keyNumber: targetKey.keyNumber,
    note: `${targetKey.noteName}${targetKey.octave}`,
    liveCents: watchLiveCents,
    finalCents: watchHasCurrentSignal ? displayedFinalCents : null,
    recommendedCents: targetRecommendedCents,
    deviation: watchLiveCents !== null && targetRecommendedCents !== null
      ? Math.round((watchLiveCents - targetRecommendedCents) * 10) / 10 : null,
    listening: isListening,
    canPrev: seq.canPrev,
    canNext: seq.canNext,
    autoTarget: false,
    a4Cents: typeof a4Cents === "number" && Number.isFinite(a4Cents) ? a4Cents : null,
    account: user?.id ?? null,
    assignedCents: typeof currentAssignedCents === "number" && Number.isFinite(currentAssignedCents) ? currentAssignedCents : null,
    assignedLabel: assignedValueLabel,
    assignedKeyNumber: displayedMeasurementKey.keyNumber,
    assignedNote: `${displayedMeasurementKey.noteName}${displayedMeasurementKey.octave}`,
    engine: "composite2-1",
  }, {
    prev: seq.prev,
    next: seq.next,
    setSection: seq.setSection,
    goToKey: seq.goToKey,
    getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    sectionOrders: COMPOSITE2_SECTION_ORDERS,
  });
  const inTune    = displayedLiveCents !== null ? Math.abs(displayedLiveCents) <= 2 : false;
  const warnRange = displayedLiveCents !== null ? Math.abs(displayedLiveCents) <= 8 : false;

  const isMeasured = activeSession
    ? seq.targetKeyIndex in (activeSession.measurements as Record<number, unknown>)
    : false;

  const centsTableRows = chartData
    .filter((point) => point.measured && point.cents !== null)
    .map((point) => {
      const measurement = activeSession?.measurements[point.keyIndex];
      return {
        ...point,
        frequency: measurement?.frequency ?? PIANO_KEYS[point.keyIndex].freq,
        measuredAt: measurement?.measuredAt ?? null,
      };
    });

  return (
    <div className={cn(
      "min-h-screen flex flex-col",
      isComposite3 ? "bg-[#f3f8f7]" : "bg-muted/50"
    )} style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>

      {/* 헤더 */}
      <header className={cn(
        "border-b px-4 py-3 shadow-sm",
        isComposite3
          ? "bg-[#0c1d26] border-[#1b3944] text-white"
          : "bg-card border-border"
      )}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-precision rounded-lg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              <path d="M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className={cn("text-base font-bold leading-tight", isComposite3 ? "text-white" : "text-foreground")}>복합 조율 2-1</h1>
              <span className="rounded-full bg-precision/10 px-2 py-0.5 text-[10px] font-bold text-precision">실험</span>
              {isComposite3 && <span className="rounded-full bg-[#37d2b0]/15 px-2 py-0.5 text-[10px] font-black tracking-[0.14em] text-[#7cf0d6]">PRECISION</span>}
            </div>
            <p className={cn("text-xs", isComposite3 ? "text-slate-300" : "text-muted-foreground/80")}>B 단독 값 · A 는 검증용 · 고음 타건별 측정</p>
          </div>
        </div>
        <nav className="mt-3 flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-0.5 sm:mt-0">
          <Link to="/"       className="shrink-0 px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">자동</Link>
          <Link to="/manual" className="shrink-0 px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">수동</Link>
          <Link to="/composite" className="shrink-0 px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">복합</Link>
          <Link to="/composite2" className="shrink-0 px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">복합2</Link>
          <span className="shrink-0 px-3 py-1 text-xs font-bold rounded-md bg-card text-precision shadow-sm">복합2-1</span>
          <Link to="/composite3" className="shrink-0 px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">복합3</Link>
          <Link to="/reference" className="shrink-0 px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">기준음</Link>
        </nav>
      </header>

      <main className={cn(
        "flex-1 container mx-auto px-4 py-4 flex flex-col",
        isComposite3 ? "max-w-5xl gap-4 pb-8" : "max-w-3xl gap-3"
      )}>

        {isComposite2 && !isComposite3 && (
          <div className={cn(
            "bg-card border rounded-xl px-4 py-3 shadow-sm flex items-center justify-between",
            currentAssignedCents !== null ? "border-in-tune/60 bg-in-tune/5" : "border-border"
          )}>
            <div>
              <p className="text-xs font-semibold text-muted-foreground">현재 책정된 센트값</p>
              <p className="text-xs text-muted-foreground/80 mt-0.5">그래프·건반별 표에 기록되는 최종값</p>
            </div>
            <div className={cn(
              "text-3xl font-black tabular-nums",
              currentAssignedCents === null ? "text-muted-foreground/30"
                : Math.abs(currentAssignedCents) <= 2 ? "text-in-tune"
                : Math.abs(currentAssignedCents) <= 8 ? "text-warn"
                : "text-off"
            )} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {currentAssignedCents === null ? "—" : `${currentAssignedCents > 0 ? "+" : ""}${currentAssignedCents.toFixed(1)}¢`}
            </div>
          </div>
        )}

        {/* 구간 탭 */}
        <section className={cn(isComposite3 && "rounded-2xl border border-[#dcebe7] bg-white p-3 shadow-sm")}>
          {isComposite3 && <p className="mb-2 px-1 text-[11px] font-black tracking-[0.12em] text-[#168d79]">01 · MEASUREMENT RANGE</p>}
          <SectionTabs section={seq.section} onChange={seq.setSection} />
        </section>

        {/* 목표 건반 바 */}
        <section className={cn(isComposite3 && "rounded-2xl border border-[#dcebe7] bg-white p-3 shadow-sm")}>
          {isComposite3 && <div className="mb-2 flex items-center justify-between px-1"><p className="text-[11px] font-black tracking-[0.12em] text-[#168d79]">02 · TARGET NOTE</p><p className="text-xs font-semibold text-muted-foreground">진행 {seq.indexInOrder + 1} / {seq.total}</p></div>}
          <TargetNoteBar
            keyIndex={seq.targetKeyIndex}
            indexInOrder={seq.indexInOrder}
            total={seq.total}
            canPrev={seq.canPrev}
            canNext={seq.canNext}
            onPrev={seq.prev}
            onNext={seq.next}
            isMeasured={isMeasured}
          />
        </section>

        {/* 메인 피치 표시 */}
        <div className={cn(
          isComposite3
            ? "bg-white border-[#cfe4dd] rounded-2xl px-5 py-5 shadow-[0_12px_28px_rgba(17,59,54,0.08)] transition-colors"
            : "bg-card border rounded-xl px-5 py-4 shadow-sm transition-colors",
          result?.finalCents !== null && result?.finalCents !== undefined
            ? "border-in-tune/60 bg-in-tune/5"
            : result?.crossValid
            ? "border-precision/30"
            : "border-border"
        )}>
          {isComposite3 && (
            <div className="mb-3 flex items-center justify-between border-b border-[#dbece7] pb-3">
              <div>
                <p className="text-[11px] font-black tracking-[0.12em] text-[#168d79]">03 · LIVE CENTS</p>
                <p className="mt-1 text-xs text-muted-foreground">현재 타건의 실시간 편차</p>
              </div>
              <span className={cn(
                "rounded-full px-2.5 py-1 text-xs font-bold",
                !isListening ? "bg-muted text-muted-foreground"
                  : result?.crossValid ? "bg-[#dcf8f0] text-[#0d816d]"
                  : "bg-[#fff5db] text-[#b77913]"
              )}>{!isListening ? "마이크 대기" : result?.crossValid ? "A·B 검증 완료" : "신호 분석 중"}</span>
            </div>
          )}
          {/* cents 큰 숫자 */}
          <div className={cn("text-center", isComposite3 ? "mb-3 py-1" : "mb-2")}>
            <span
              className={cn(
                isComposite3 ? "text-7xl sm:text-8xl" : "text-6xl",
                "font-black tabular-nums transition-colors duration-100",
                inTune    ? "text-in-tune"
                : warnRange ? "text-warn"
                : result    ? "text-off"
                : "text-muted-foreground/25"
              )}
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {displayedLiveCents !== null
                ? `${displayedLiveCents > 0 ? "+" : ""}${displayedLiveCents.toFixed(1)}`
                : "0.0"}
            </span>
            <span className={cn("text-muted-foreground ml-1", isComposite3 ? "text-2xl" : "text-xl")}>¢</span>
          </div>

          {/* cents 바 */}
          <CentsBar cents={displayedLiveCents ?? 0} />
          {isComposite3 && <div className="mt-2 flex justify-between text-[11px] font-semibold text-muted-foreground"><span>−50¢</span><span className="text-[#168d79]">목표 0¢</span><span>+50¢</span></div>}

          {/* 캡처 진행 */}
          {result?.isCapturing && (
            <div className="mt-2.5">
              <div className="w-full bg-muted rounded-full h-1.5">
                <div
                  className="bg-precision h-1.5 rounded-full transition-all duration-100"
                  style={{ width: `${result.captureProgress * 100}%` }}
                />
              </div>
              <p className="text-xs text-precision/80 mt-1 text-center">안정 측정 중...</p>
            </div>
          )}

          {/* 확정 */}
          {displayedFinalCents !== null && (
            <div className="mt-2 text-center">
              <span className="text-sm font-bold text-in-tune bg-in-tune/10 px-3 py-1 rounded-full">
                ✓ 확정 {displayedFinalCents > 0 ? "+" : ""}{displayedFinalCents.toFixed(1)}¢
              </span>
            </div>
          )}

          {isComposite2SmoothedGraphRange && displayedFinalCents === null && highRepeatCount > 0 && (
            <p className="mt-2 text-center text-xs text-precision/90">
              {highRepeatConsensus
                ? `고음 반복 ${highRepeatConsensus.used}회 가중평균 준비됨`
                : highRepeatCount < 3
                  ? `고음 반복 측정 ${highRepeatCount}/3 · 같은 건반을 다시 타건하세요`
                  : `고음 반복 ${highRepeatCount}회 · 우세 덩어리 판정 대기 중`}
            </p>
          )}

          {/* 신호 없음 */}
          {isListening && !result && displayedLiveCents === null && (
            <p className="text-xs text-center text-muted-foreground mt-2">
              마이크를 켜고 건반을 눌러주세요
            </p>
          )}
        </div>

        {/* 엔진 상세 */}
        <div className="order-last bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">엔진 상세</h3>
              {isComposite2Upper && (
                <span className="text-[10px] font-semibold text-precision bg-precision/10 border border-precision/20 px-1.5 py-0.5 rounded-full">
                  타건별 중앙값
                </span>
              )}
            </div>
            {result && (
              <span className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold",
                result.crossValid
                  ? "bg-in-tune/15 text-in-tune"
                  : "bg-warn/15 text-warn"
              )}>
                <span className={cn("w-1.5 h-1.5 rounded-full", result.crossValid ? "bg-in-tune" : "bg-warn")} />
                {result.crossValid ? "교차검증 ✓" : "A 단독"}
              </span>
            )}
          </div>
          <div className="space-y-1">
            <EngineRow
              label="A"
              cents={result?.yinCents ?? null}
              active={!!result}
            />
            <EngineRow
              label="B"
              cents={result?.goertzelCents ?? null}
              active={!!result?.signalOk}
            />
            <EngineRow
              label="복합 (확정값)"
              cents={displayedLiveCents}
              active={!!result}
              highlight={!!result?.crossValid}
            />
          </div>
          {result && !result.crossValid && (
            <p className="text-xs text-warn/80 mt-2 px-1">
              A ↔ B 편차 큼 — 이 프레임은 확정 계산에서 제외
            </p>
          )}
        </div>

        {/* 마이크 + 자동진행 */}
        <div className={cn("order-2 flex items-center gap-2", isComposite3 && "rounded-2xl border border-[#dcebe7] bg-white p-3 shadow-sm")}>
          <button
            onClick={isPro ? toggleListening : undefined}
            disabled={!isPro}
            title={!isPro ? "Pro 이상 등급에서 사용 가능합니다" : undefined}
            className={cn(
              "flex-1 py-2.5 rounded-xl font-bold text-sm transition-all",
              isPro && "active:scale-[0.98]",
              !isPro
                ? "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
                : isListening
                ? "bg-off text-white hover:bg-off/90"
                : isComposite3 ? "bg-[#0d2731] text-white hover:bg-[#164552]" : "bg-precision text-white hover:bg-precision/90"
            )}
          >
            {!isPro ? "🔒 마이크 켜기"
              : isListening ? "■ 마이크 끄기" : isComposite3 ? "● 정밀 측정 시작" : "● 마이크 켜기"}
          </button>
          <label className={cn("flex items-center gap-2 px-3 py-2.5 rounded-xl border cursor-pointer", isComposite3 ? "bg-[#f5fbf9] border-[#cfe4dd]" : "bg-card border-border")}>
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={e => setAutoAdvance(e.target.checked)}
              className="w-4 h-4 accent-precision"
            />
            <span className="text-xs text-foreground/85 whitespace-nowrap">자동 진행</span>
          </label>
        </div>

        {!isPro && (
          <p className="order-3 text-xs text-center text-muted-foreground">Pro 등급으로 변경하면 마이크를 사용할 수 있습니다.</p>
        )}

        {error && (
          <div className="order-3 px-3 py-2 rounded-lg bg-off/10 border border-off/40 text-xs text-off">
            {error}
          </div>
        )}

        {/* 되돌리기 */}
        {undoStack.length > 0 && (
          <button
            onClick={() => undoLastMeasurement()}
            className="order-4 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
          >
            ↩ 마지막 측정 취소
          </button>
        )}

        {/* 조율 커브 */}
        <div className="order-5 bg-card border border-border rounded-xl p-2 shadow-sm">
          <TuningCurveChart data={chartData} activeKeyIndex={seq.targetKeyIndex} recommendedOffset={isComposite2 ? recommendedOffset : null} />
        </div>

        {isComposite2 && (
          <div className={cn("order-1 bg-card border rounded-xl shadow-sm overflow-hidden", isComposite3 && "rounded-2xl border-[#cfe4dd] shadow-[0_12px_28px_rgba(17,59,54,0.08)]")}>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-foreground">건반별 센트값</h3>{isComposite3 && <span className="rounded-full bg-[#dcf8f0] px-2 py-0.5 text-[10px] font-bold text-[#0d816d]">기록 관리</span>}</div>
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <span className="font-semibold text-foreground/85">{assignedValueLabel === "최근 등록값" ? "최근" : "현재"} {displayedMeasurementKey.keyNumber}번 {displayedMeasurementKey.noteName}{displayedMeasurementKey.octave}</span>
                  <span className={cn(
                    "font-black tabular-nums",
                    currentAssignedCents === null ? "text-muted-foreground/50"
                      : Math.abs(currentAssignedCents) <= 2 ? "text-in-tune"
                      : Math.abs(currentAssignedCents) <= 8 ? "text-warn"
                      : "text-off"
                  )}>
                    {currentAssignedCents === null
                      ? "책정 대기"
                      : `${currentAssignedCents > 0 ? "+" : ""}${currentAssignedCents.toFixed(1)}¢`}
                    {!hasNewAssignedCents && currentAssignedCents !== null && ` · ${assignedValueLabel}`}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">그래프에 기록된 측정값 · {centsTableRows.length}건반</p>
                {recommendedOffset !== null ? (
                  <p className="mt-1 text-xs text-[#7c3aed]">
                    A4 {a4Cents !== null && a4Cents !== undefined && a4Cents > 0 ? "+" : ""}{(a4Cents ?? 0).toFixed(1)}¢ 기준 추천 커브 적용
                    {targetRecommendedCents !== null && ` · 현재 ${targetKey.keyNumber}번 추천 ${targetRecommendedCents > 0 ? "+" : ""}${targetRecommendedCents.toFixed(1)}¢`}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground/70">A4(49번 건반)를 측정하면 그 값을 기준으로 추천 센트가 표시됩니다.</p>
                )}
              </div>
              {centsTableRows.length > 0 && (
                <button
                  onClick={() => setShowCentsTable((open) => !open)}
                  className={cn("shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors", isComposite3 ? "text-[#0d816d] bg-[#dcf8f0] border-[#b5edde] hover:bg-[#c9f3e7]" : "text-precision bg-precision/10 border-precision/20 hover:bg-precision/15")}
                >
                  {showCentsTable ? "전체표 접기" : "전체표 펼치기"}
                  <span className={cn("transition-transform", showCentsTable && "rotate-180")}>⌄</span>
                </button>
              )}
            </div>
            {centsTableRows.length === 0 ? (
              <p className="border-t border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">기록된 센트값이 없습니다. 건반을 측정하면 표에 추가됩니다.</p>
            ) : showCentsTable ? (
              <div className="border-t border-border/70 max-h-[32rem] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/95 backdrop-blur border-b border-border z-10">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 font-semibold">건반</th>
                      <th className="px-3 py-2.5 font-semibold">음</th>
                      <th className="px-3 py-2.5 font-semibold text-right">센트</th>
                      <th className="px-3 py-2.5 font-semibold text-right">추천</th>
                      <th className="px-3 py-2.5 font-semibold text-right">편차</th>
                      <th className="px-4 py-2.5 font-semibold text-right">기록 Hz</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {centsTableRows.map((row) => {
                      const cents = row.cents as number;
                      const centsClass = Math.abs(cents) <= 2
                        ? "text-in-tune"
                        : Math.abs(cents) <= 8
                          ? "text-warn"
                          : "text-off";
                      const recommended = recommendedOffset !== null
                        ? recommendedCentsAt(row.keyIndex, recommendedOffset)
                        : null;
                      const deviation = recommended !== null ? Math.round((cents - recommended) * 10) / 10 : null;
                      const deviationClass = deviation === null
                        ? "text-muted-foreground/50"
                        : Math.abs(deviation) <= 2
                          ? "text-in-tune"
                          : Math.abs(deviation) <= 5
                            ? "text-warn"
                            : "text-off";
                      return (
                        <tr key={row.keyIndex} className={cn(
                          "hover:bg-muted/40 transition-colors",
                          row.keyIndex === seq.targetKeyIndex && "bg-precision/5"
                        )}>
                          <td className="px-4 py-2.5 font-medium tabular-nums">{row.keyNumber}</td>
                          <td className="px-3 py-2.5 font-semibold">{row.noteName}{row.octave}</td>
                          <td className={cn("px-3 py-2.5 text-right font-bold tabular-nums", centsClass)}>
                            {cents > 0 ? "+" : ""}{cents.toFixed(1)}¢
                          </td>
                          <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-[#7c3aed]">
                            {recommended === null
                              ? "—"
                              : `${recommended > 0 ? "+" : ""}${recommended.toFixed(1)}¢`}
                          </td>
                          <td className={cn("px-3 py-2.5 text-right font-bold tabular-nums", deviationClass)}>
                            {deviation === null
                              ? "—"
                              : `${deviation > 0 ? "+" : ""}${deviation.toFixed(1)}¢`}
                          </td>                          <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                            {row.frequency.toFixed(2)} Hz
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}

        {/* 세션 + 내보내기 */}
        <div className="order-6 bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="relative flex-1 mr-2">
              <button
                onClick={() => setShowSessionList(v => !v)}
                className="flex items-center gap-1.5 text-sm text-foreground/85 hover:text-foreground"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="font-semibold truncate max-w-[180px]">{activeSession?.name || "세션 없음"}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <p className="text-xs text-muted-foreground/80 mt-0.5">측정 {measuredCount} / 88</p>
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
              >📄 PDF</button>
              <button
                onClick={() => activeSession && exportToImage(activeSession.name, userName, activeSession.measurements as any)}
                disabled={measuredCount === 0}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                  measuredCount > 0 ? "bg-in-tune text-white" : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                )}
              >🖼️ 이미지</button>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}
