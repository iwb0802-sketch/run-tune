/**
 * CompositePage.tsx — 복합 조율 모드 v2
 *
 * 수동모드 시퀀스 구조 + 4중 엔진(YIN + Goertzel 교차검증 + 스트로브 안정화)
 * - 건반 지정은 수동모드와 동일 (SectionTabs + TargetNoteBar)
 * - 엔진 상세 패널: YIN / Goertzel / 복합 cent 수치 비교
 * - 교차검증 통과 + 900ms 안정 → 자동 확정 + 다음 건반 이동
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/utils";
import { useCompositeTuner } from "@/hooks/useCompositeTuner";
import { useTuningSession } from "@/hooks/useTuningSession";
import { useWakeLock } from "@/hooks/useWakeLock";
import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import { useAuth } from "@/hooks/useAuth";
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

function centsMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

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

export default function CompositePage() {
  const [location] = useLocation();
  const isComposite3 = location === "/composite3";
  // 복합탭2·3은 같은 전용 시퀀스와 고음 처리·센트표 기능을 공유한다.
  const isComposite2 = location === "/composite2" || isComposite3;
  const { user } = useAuth();
  const { isPro } = useUserRole(user?.id);

  // Hooks는 경로 변경에도 동일 순서로 호출하고, 복합탭2에서만 전용 입력 순서를 선택한다.
  const standardSequence = useManualSequence();
  const composite2Sequence = useManualSequence(COMPOSITE2_SECTION_ORDERS);
  const seq = isComposite2 ? composite2Sequence : standardSequence;
  const targetKeyRef = useRef(seq.targetKeyIndex);
  useEffect(() => {
    targetKeyRef.current = seq.targetKeyIndex;
  }, [seq.targetKeyIndex]);

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

  // 건반 변경 시 자동진행 타이머 취소
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

  // 1-indexed 64번 C6은 keyIndex 63이다. 이 구간은 복합탭2 상부 스무딩값을 그래프 저장값으로 쓴다.
  const SMOOTHED_GRAPH_START_KEY = 63;
  const SMOOTHED_GRAPH_LIMIT_CENTS = 50;
  const smoothedUpperCentsRef = useRef<number | null>(null);
  const savedSmoothedGraphKeyRef = useRef<number | null>(null);
  const highRepeatSamplesRef = useRef<HighRepeatSample[]>([]);
  const highRepeatArmedRef = useRef(true);

  const handleConfirmed = useCallback(async (r: typeof result) => {
    if (!r || r.finalCents === null) return;
    // C6~88번 복합탭2는 엔진 finalCents 대신 아래 스무딩 신호 effect가 직접 저장한다.
    if (isComposite2 && r.keyIndex >= SMOOTHED_GRAPH_START_KEY) return;

    await ensureSession();
    recordMeasurement(r.keyIndex, r.finalCents, r.frequency);
    toast.success(
      `${r.noteName}${r.octave} (건반 ${r.keyIndex + 1}) → ${r.finalCents > 0 ? "+" : ""}${r.finalCents.toFixed(1)}¢`,
      { duration: 1800 }
    );
    if (autoAdvanceRef.current) {
      advanceTimerRef.current = setTimeout(() => { seqNextRef.current(); }, 1000);
    }
  }, [ensureSession, isComposite2, recordMeasurement]);

  const { isListening, result, startListening, stopListening, error } =
    useCompositeTuner(seq.targetKeyIndex, handleConfirmed, 4096);

  useWakeLock(isListening);

  const toggleListening = async () => {
    if (isListening) stopListening();
    else {
      if (!activeSessionIdRef.current) {
        const s = await createSession();
        if (s) activeSessionIdRef.current = s.id;
      }
      await startListening();
    }
  };

  const targetKey = PIANO_KEYS[seq.targetKeyIndex];

  // 시험용(구버전) 방식: 복합탭2의 상부값(50~88번)만 최근 200ms 중앙값으로 표시한다.
  // 무음에서는 마지막 표시값을 유지하고, 목표 건반 변경·마이크 정지·다른 탭/구간 전환에서만 초기화한다.
  const isComposite2Upper = isComposite2 && seq.section === "upper";
  const rawLiveCents = result?.liveCents ?? null;
  const smoothWindowRef = useRef<Array<{ t: number; cents: number }>>([]);
  const smoothedUpperKeyRef = useRef<number | null>(null);
  const [smoothedUpperCents, setSmoothedUpperCents] = useState<number | null>(null);
  const [smoothedGraphFinalCents, setSmoothedGraphFinalCents] = useState<number | null>(null);
  const [highRepeatConsensus, setHighRepeatConsensus] = useState<HighRepeatConsensus | null>(null);
  const [highRepeatCount, setHighRepeatCount] = useState(0);

  useEffect(() => {
    if (!isComposite2Upper || !isListening) {
      smoothWindowRef.current = [];
      smoothedUpperCentsRef.current = null;
      smoothedUpperKeyRef.current = null;
      setSmoothedUpperCents(null);
      return;
    }
    // 시험용 구버전과 동일하게 무음에서는 마지막 값을 지우지 않는다.
    if (rawLiveCents === null) return;

    const now = Date.now();
    smoothWindowRef.current.push({ t: now, cents: rawLiveCents });
    smoothWindowRef.current = smoothWindowRef.current.filter((sample) => now - sample.t <= 200);
    const smoothed = Math.round(centsMedian(smoothWindowRef.current.map((sample) => sample.cents)) * 10) / 10;
    if (Number.isFinite(smoothed)) {
      smoothedUpperCentsRef.current = smoothed;
      smoothedUpperKeyRef.current = seq.targetKeyIndex;
      setSmoothedUpperCents(smoothed);
    }
  }, [isComposite2Upper, isListening, rawLiveCents]);

  useEffect(() => {
    smoothWindowRef.current = [];
    smoothedUpperCentsRef.current = null;
    smoothedUpperKeyRef.current = null;
    savedSmoothedGraphKeyRef.current = null;
    highRepeatSamplesRef.current = [];
    highRepeatArmedRef.current = true;
    setSmoothedUpperCents(null);
    setSmoothedGraphFinalCents(null);
    setHighRepeatConsensus(null);
    setHighRepeatCount(0);
  }, [seq.targetKeyIndex]);

  const isComposite2SmoothedGraphRange = isComposite2Upper && seq.targetKeyIndex >= SMOOTHED_GRAPH_START_KEY;
  useEffect(() => {
    if (!isComposite2SmoothedGraphRange || !isListening) return;

    // 신호가 끊긴 뒤 다음 타건을 하나의 새 측정값으로 받을 수 있게 재무장한다.
    if (rawLiveCents === null) {
      highRepeatArmedRef.current = true;
      return;
    }
    if (!highRepeatArmedRef.current || smoothedUpperCents === null) return;
    // 건반을 바꾼 직후 이전 건반의 state가 새 건반에 기록되는 것을 막는다.
    if (smoothedUpperKeyRef.current !== seq.targetKeyIndex) return;
    // ±50¢ 밖은 오인식으로 간주하고 측정 회차에도 포함하지 않는다.
    if (Math.abs(smoothedUpperCents) > SMOOTHED_GRAPH_LIMIT_CENTS) return;

    highRepeatArmedRef.current = false;
    const samples = appendHighRepeatSample(highRepeatSamplesRef.current, {
      cents: smoothedUpperCents,
      capturedAt: Date.now(),
    });
    highRepeatSamplesRef.current = samples;
    setHighRepeatCount(samples.length);

    const consensus = resolveHighRepeatConsensus(samples);
    setHighRepeatConsensus(consensus);
    // 최소 3회 + 단일 우세 덩어리가 확정되기 전에는 그래프에 저장하지 않고 추가 타건을 기다린다.
    if (!consensus || savedSmoothedGraphKeyRef.current === seq.targetKeyIndex) return;

    const keyIndex = seq.targetKeyIndex;
    savedSmoothedGraphKeyRef.current = keyIndex;
    void ensureSession().then(() => {
      recordMeasurement(keyIndex, consensus.value, PIANO_KEYS[keyIndex].freq);
      setSmoothedGraphFinalCents(consensus.value);
      toast.success(
        `${PIANO_KEYS[keyIndex].noteName}${PIANO_KEYS[keyIndex].octave} (건반 ${keyIndex + 1}) → ${consensus.value > 0 ? "+" : ""}${consensus.value.toFixed(1)}¢ · ${consensus.used}회 가중평균`,
        { duration: 2200 },
      );
      if (autoAdvanceRef.current) {
        advanceTimerRef.current = setTimeout(() => { seqNextRef.current(); }, 1000);
      }
    });
  }, [ensureSession, isComposite2SmoothedGraphRange, isListening, rawLiveCents, recordMeasurement, seq.targetKeyIndex, smoothedUpperCents]);

  const displayedLiveCents = isComposite2Upper
    ? smoothedUpperCents ?? rawLiveCents
    : rawLiveCents;
  const displayedFinalCents = isComposite2SmoothedGraphRange
    ? smoothedGraphFinalCents
    : result?.finalCents ?? null;
  // 새 타건이 확정되기 전에는 차트의 파생값이 아니라 세션에 저장된 실제 등록값을 직접 읽는다.
  // 구버전 세션은 객체 키가 0-기반 keyIndex 또는 1-기반 keyNumber로 남아 있을 수 있어 모두 호환한다.
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
  // 선택 건반에 아직 값이 없을 때는 가장 최근 등록값을 보여 주되, 음 이름도 함께 맞춰 표시한다.
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
  const inTune    = displayedLiveCents !== null ? Math.abs(displayedLiveCents) <= 2 : false;
  const warnRange = displayedLiveCents !== null ? Math.abs(displayedLiveCents) <= 8 : false;

  // 측정된 건반인지
  const isMeasured = activeSession
    ? seq.targetKeyIndex in (activeSession.measurements as Record<number, unknown>)
    : false;

  // 복합탭2의 그래프와 동일한 원본(chartData)만 표에 사용한다.
  const centsTableRows = isComposite2
    ? chartData
      .filter((point) => point.measured && point.cents !== null)
      .map((point) => {
        const measurement = activeSession?.measurements[point.keyIndex];
        return {
          ...point,
          frequency: measurement?.frequency ?? PIANO_KEYS[point.keyIndex].freq,
          measuredAt: measurement?.measuredAt ?? null,
        };
      })
    : [];

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
            <h1 className="text-base font-bold text-foreground leading-tight">{isComposite3 ? "복합 조율 3" : isComposite2 ? "복합 조율 2" : "복합 조율"}</h1>
            <p className="text-xs text-muted-foreground/80">YIN · Goertzel 교차검증 · 스트로브 확정</p>
          </div>
        </div>
        <nav className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          <Link to="/"       className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">자동</Link>
          <Link to="/manual" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">수동</Link>
          {isComposite2 ? (
            <Link to="/composite" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">복합</Link>
          ) : (
            <span className="px-3 py-1 text-xs font-bold rounded-md bg-card text-precision shadow-sm">복합</span>
          )}
          {location === "/composite2" ? (
            <span className="px-3 py-1 text-xs font-bold rounded-md bg-card text-precision shadow-sm">복합2</span>
          ) : (
            <Link to="/composite2" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">복합2</Link>
          )}
          {isComposite3 ? (
            <span className="px-3 py-1 text-xs font-bold rounded-md bg-card text-precision shadow-sm">복합3</span>
          ) : (
            <Link to="/composite3" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">복합3</Link>
          )}
          <Link to="/reference" className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors">기준음</Link>
        </nav>
      </header>

      <main className="flex-1 container max-w-3xl mx-auto px-4 py-4 flex flex-col gap-3">

        {isComposite2 && (
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
        <SectionTabs section={seq.section} onChange={seq.setSection} />

        {/* 목표 건반 바 */}
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

        {/* 메인 피치 표시 */}
        <div className={cn(
          "bg-card border rounded-xl px-5 py-4 shadow-sm transition-colors",
          result?.finalCents !== null && result?.finalCents !== undefined
            ? "border-in-tune/60 bg-in-tune/5"
            : result?.crossValid
            ? "border-precision/30"
            : "border-border"
        )}>
          {/* cents 큰 숫자 */}
          <div className="text-center mb-2">
            <span
              className={cn(
                "text-6xl font-black tabular-nums transition-colors duration-100",
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
            <span className="text-xl text-muted-foreground ml-1">¢</span>
          </div>

          {/* cents 바 */}
          <CentsBar cents={displayedLiveCents ?? 0} />

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
                  상부 200ms 스무딩
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
              A ↔ B 편차 큼 — B 단독 사용 중
            </p>
          )}
        </div>

        {/* 마이크 + 자동진행 */}
        <div className="order-2 flex items-center gap-2">
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
                : "bg-precision text-white hover:bg-precision/90"
            )}
          >
            {!isPro ? "🔒 마이크 켜기"
              : isListening ? "■ 마이크 끄기" : "● 마이크 켜기"}
          </button>
          <label className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-card border border-border cursor-pointer">
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
          <TuningCurveChart data={chartData} activeKeyIndex={seq.targetKeyIndex} />
        </div>

        {isComposite2 && (
          <div className="order-1 bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">건반별 센트값</h3>
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
              </div>
              {centsTableRows.length > 0 && (
                <button
                  onClick={() => setShowCentsTable((open) => !open)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-precision bg-precision/10 border border-precision/20 hover:bg-precision/15 transition-colors"
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
                          <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
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

// handleConfirmed 타입 추론용 헬퍼
type result = ReturnType<typeof useCompositeTuner>["result"];
