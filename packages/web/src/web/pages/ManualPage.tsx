/**
 * ManualPage.tsx — 수동 조율 페이지
 *
 * 엔진 분기:
 *  - keyIndex 0~26 (1~27번): useTargetedStrobe (Goertzel 배음 분석 → 기본음 절대 cent)
 *  - keyIndex 27~87 (28~88번): usePitchDetector (기존 방식)
 *
 * 저장값은 항상 기본음 기준 절대 cent.
 * stableCents ?? detectedCents 혼합 구조 사용 금지.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { toast as sonnerToast } from "sonner";

import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import { PIANO_KEYS, PitchResult, usePitchDetector } from "@/hooks/usePitchDetector";
import { useTargetedStrobe } from "@/hooks/useTargetedStrobe";
import { useTuningSession } from "@/hooks/useTuningSession";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useBaselineCapture } from "@/hooks/useBaselineCapture";
import { deleteBaselineAudio, getBaselineAudio, saveBaselineAudio } from "@/lib/tuner/baselineAudioStore";
import { cn } from "@/lib/utils";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";

import SectionTabs from "@/pages/manual/SectionTabs";
import TargetNoteBar from "@/pages/manual/TargetNoteBar";
import MatchStatus, { type ManualMatchState } from "@/pages/manual/MatchStatus";
import { useManualSequence } from "@/pages/manual/useManualSequence";

const AUTO_ADVANCE_KEY = "manual_auto_advance_v1";

/** keyIndex 0~26 → 저음 구간 (1~27번) → useTargetedStrobe 사용 */
function isLowRange(keyIndex: number): boolean {
  return keyIndex <= 26;
}

export default function ManualPage() {
  const { user } = useAuth();
  const { isPro } = useUserRole(user?.id);

  const seq = useManualSequence();
  const [autoAdvance, setAutoAdvance] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(AUTO_ADVANCE_KEY);
      return v === null ? true : v === "1";
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(AUTO_ADVANCE_KEY, autoAdvance ? "1" : "0"); } catch { /* ignore */ }
  }, [autoAdvance]);

  const [matchState, setMatchState] = useState<ManualMatchState>({ kind: "idle" });
  const targetKeyRef = useRef(seq.targetKeyIndex);
  useEffect(() => {
    targetKeyRef.current = seq.targetKeyIndex;
    setMatchState({ kind: "idle" });
  }, [seq.targetKeyIndex]);

  const autoAdvanceRef = useRef(autoAdvance);
  useEffect(() => { autoAdvanceRef.current = autoAdvance; }, [autoAdvance]);

  const {
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    createSession,
    recordMeasurement,
    addBaselineTake,
    clearKeyBaseline,
    chartData,
    measuredCount,
  } = useTuningSession(null);

  const [userName, setUserName] = useState("");
  const [showSessionList, setShowSessionList] = useState(false);

  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matchedDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMatchRef = useRef<PitchResult | null>(null);
  const audioPlaybackRef = useRef<HTMLAudioElement | null>(null);
  const [playingTakeId, setPlayingTakeId] = useState<string | null>(null);
  const baselineSavingRef = useRef(false);

  const seqNextRef = useRef(seq.next);
  useEffect(() => { seqNextRef.current = seq.next; }, [seq.next]);

  const clearTimers = useCallback(() => {
    if (advanceTimerRef.current) { clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
    if (matchedDebounceRef.current) { clearTimeout(matchedDebounceRef.current); matchedDebounceRef.current = null; }
    pendingMatchRef.current = null;
  }, []);

  useEffect(() => {
    clearTimers();
    return clearTimers;
  }, [seq.targetKeyIndex, clearTimers]);

  // ─── 세션 보장 헬퍼 ───────────────────────────────────────────────
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const s = await createSession();
    if (s) { activeSessionIdRef.current = s.id; return s.id; }
    return null;
  }, [createSession]);

  // ─── 자동 진행 헬퍼 ──────────────────────────────────────────────
  const scheduleAdvance = useCallback(() => {
    if (!autoAdvanceRef.current) return;
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = setTimeout(() => {
      seqNextRef.current();
    }, 1200);
  }, []);

  // ─── 기록 + 상태 업데이트 헬퍼 ───────────────────────────────────
  const commitMeasurement = useCallback(async (keyIndex: number, cents: number, freq: number) => {
    await ensureSession();
    recordMeasurement(keyIndex, cents, freq);
    const baseline = activeSession?.measurements[keyIndex]?.baseline;
    const relativeCents = baseline ? cents - baseline.cents : cents;
    setMatchState({
      kind: "matched",
      cents: Math.round(relativeCents * 10) / 10,
      toleranceCents: baseline?.toleranceCents,
    });
    scheduleAdvance();
  }, [activeSession, ensureSession, recordMeasurement, scheduleAdvance]);

  // ─── 28~88번: usePitchDetector 콜백 ──────────────────────────────
  const handlePitchDetected = useCallback((result: PitchResult) => {
    if (result.confidence < 0.55) return;
    const target = targetKeyRef.current;

    // 저음 구간은 이 콜백 무시 (useTargetedStrobe가 담당)
    if (isLowRange(target)) return;

    if (result.keyIndex !== target) {
      pendingMatchRef.current = null;
      if (matchedDebounceRef.current) { clearTimeout(matchedDebounceRef.current); matchedDebounceRef.current = null; }
      setMatchState({ kind: "wrong", detectedKeyIndex: result.keyIndex, detectedCents: result.cents });
      return;
    }

    // 목표 일치 → 800ms 디바운스
    pendingMatchRef.current = result;
    if (matchedDebounceRef.current) clearTimeout(matchedDebounceRef.current);
    matchedDebounceRef.current = setTimeout(() => {
      const p = pendingMatchRef.current;
      if (!p || p.keyIndex !== targetKeyRef.current) return;
      // 절대 cent 그대로 저장 (usePitchDetector는 이미 절대 cent 반환)
      commitMeasurement(p.keyIndex, p.cents, p.frequency);
      pendingMatchRef.current = null;
    }, 800);
  }, [commitMeasurement]);

  const { isListening, startListening, stopListening, error, stream, audioContext } =
    usePitchDetector(handlePitchDetected, 4096);
  const baselineCapture = useBaselineCapture(stream, audioContext);

  useWakeLock(isListening);

  // ─── 1~27번: useTargetedStrobe ────────────────────────────────────
  // 저음 구간일 때만 targetKeyIndex를 전달, 아니면 null
  const strobeTarget = isLowRange(seq.targetKeyIndex) ? seq.targetKeyIndex : null;
  const strobe = useTargetedStrobe(
    isListening ? stream : null,
    isListening ? audioContext : null,
    strobeTarget,
    { stableDurationMs: 800, fftSize: 4096 }
  );

  // strobeCents가 새로 확정되면 기록
  const prevStrobeCentsRef = useRef<number | null>(null);
  useEffect(() => {
    const c = strobe.strobeCents;
    if (c === null || c === prevStrobeCentsRef.current) return;
    if (!isLowRange(targetKeyRef.current)) return;

    prevStrobeCentsRef.current = c;
    const keyIndex = targetKeyRef.current;
    const freq = PIANO_KEYS[keyIndex]?.freq ?? 0;
    // 절대 cent 저장 (useTargetedStrobe가 이미 기본음 기준 절대 cent 반환)
    commitMeasurement(keyIndex, c, freq);
  }, [strobe.strobeCents, commitMeasurement]);

  // 목표 음 변경 시 strobe prev 초기화
  useEffect(() => {
    prevStrobeCentsRef.current = null;
  }, [seq.targetKeyIndex]);

  const toggleListening = async () => {
    if (!activeSessionIdRef.current) {
      const s = await createSession();
      if (s) activeSessionIdRef.current = s.id;
    }
    if (isListening) stopListening();
    else await startListening();
  };

  const targetKey = PIANO_KEYS[seq.targetKeyIndex];
  const isLow = isLowRange(seq.targetKeyIndex);
  const keyBaseline = activeSession?.measurements[seq.targetKeyIndex]?.baseline ?? null;

  const playBaselineTake = useCallback(async (audioId: string) => {
    try {
      audioPlaybackRef.current?.pause();
      const blob = await getBaselineAudio(audioId);
      if (!blob) {
        sonnerToast("이 브라우저에 저장된 녹음이 없습니다. 기준값만 동기화된 경우일 수 있습니다.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioPlaybackRef.current = audio;
      setPlayingTakeId(audioId);
      const finish = () => {
        URL.revokeObjectURL(url);
        if (audioPlaybackRef.current === audio) audioPlaybackRef.current = null;
        setPlayingTakeId(current => current === audioId ? null : current);
      };
      audio.onended = finish;
      audio.onerror = finish;
      await audio.play();
    } catch {
      sonnerToast("녹음을 재생할 수 없습니다.");
      setPlayingTakeId(null);
    }
  }, []);

  const clearBaseline = useCallback(async () => {
    if (!keyBaseline) return;
    if (!window.confirm(`${targetKey.noteName}${targetKey.octave}의 기준 녹음 ${keyBaseline.takes.length}개를 초기화할까요?`)) return;
    try {
      await deleteBaselineAudio(keyBaseline.takes.map((take) => take.audioId));
    } catch {
      // 브라우저 오디오 삭제 실패 여부와 관계없이 기준값은 초기화한다.
    }
    clearKeyBaseline(seq.targetKeyIndex);
    setMatchState({ kind: "idle" });
    sonnerToast("기준값을 초기화했습니다.");
  }, [clearKeyBaseline, keyBaseline, seq.targetKeyIndex, targetKey.noteName, targetKey.octave]);

  useEffect(() => {
    const result = baselineCapture.result;
    if (!result || baselineSavingRef.current) return;
    baselineSavingRef.current = true;

    if (result.keyIndex !== targetKeyRef.current) {
      sonnerToast(`목표 음과 다른 ${result.noteName}${result.octave}가 감지되었습니다. 다시 녹음해 주세요.`);
      baselineCapture.clearResult();
      baselineSavingRef.current = false;
      return;
    }

    const takeId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    void saveBaselineAudio(takeId, result.audioBlob)
      .then(() => {
        addBaselineTake(result.keyIndex, {
          id: takeId,
          audioId: takeId,
          frequency: result.frequency,
          cents: result.cents,
          confidence: result.confidence,
          frameCount: result.frameCount,
          capturedAt: Date.now(),
        });
        sonnerToast(`${result.noteName}${result.octave} 기준 타건을 저장했습니다.`);
      })
      .catch(() => sonnerToast("분석값은 저장하지 않았습니다. 오디오 저장 공간을 확인해 주세요."))
      .finally(() => {
        baselineCapture.clearResult();
        baselineSavingRef.current = false;
      });
  }, [addBaselineTake, baselineCapture]);

  useEffect(() => () => {
    audioPlaybackRef.current?.pause();
  }, []);

  // 저음 구간 상태 표시용
  const strobeMatchState: ManualMatchState = (() => {
    if (!isLow) return matchState;
    if (!isListening) return { kind: "idle" };
    if (!strobe.signalOk) return { kind: "idle" };
    if (strobe.isCapturing) return { kind: "idle" };
    if (strobe.strobeCents !== null) {
      const baseline = activeSession?.measurements[seq.targetKeyIndex]?.baseline;
      return {
        kind: "matched",
        cents: Math.round((strobe.strobeCents - (baseline?.cents ?? 0)) * 10) / 10,
        toleranceCents: baseline?.toleranceCents,
      };
    }
    if (strobe.liveCents !== null) {
      const baseline = activeSession?.measurements[seq.targetKeyIndex]?.baseline;
      return {
        kind: "matched",
        cents: Math.round((strobe.liveCents - (baseline?.cents ?? 0)) * 10) / 10,
        toleranceCents: baseline?.toleranceCents,
      };
    }
    return { kind: "idle" };
  })();

  const displayMatchState = isLow ? strobeMatchState : matchState;

  return (
    <div
      className="min-h-screen bg-muted/50 flex flex-col"
      style={{ fontFamily: "'Noto Sans KR', sans-serif" }}
    >
      {/* 헤더 */}
      <header className="bg-card border-b border-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground leading-tight">수동 조율</h1>
            <p className="text-xs text-muted-foreground/80">
              {isLow
                ? `저음 스트로브 모드 (1~27번) · 배음 ${strobe.partial ?? "?"}배`
                : "목표 음 → 건반 → 기록"}
            </p>
          </div>
        </div>

        {/* 모드 전환 */}
        <nav className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          <Link
            to="/"
            className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            자동
          </Link>
          <span className="px-3 py-1 text-xs font-bold rounded-md bg-card text-primary shadow-sm">
            수동
          </span>
          <Link
            to="/composite"
            className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            복합
          </Link>
          <Link
            to="/reference"
            className="px-3 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            기준음
          </Link>
        </nav>
      </header>

      <main className="flex-1 container max-w-3xl mx-auto px-4 py-4 flex flex-col gap-3">
        {/* 구간 선택 */}
        <SectionTabs section={seq.section} onChange={seq.setSection} />

        {/* 목표 음 + 화살표 */}
        <TargetNoteBar
          keyIndex={seq.targetKeyIndex}
          indexInOrder={seq.indexInOrder}
          total={seq.total}
          canPrev={seq.canPrev}
          canNext={seq.canNext}
          onPrev={seq.prev}
          onNext={seq.next}
        />

        {/* 저음 구간: 스트로브 진행 표시 */}
        {isLow && isListening && (
          <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted-foreground">
                스트로브 분석 ({strobe.analysisFreq ? `${strobe.analysisFreq.toFixed(1)} Hz` : "—"})
              </span>
              <span className={cn(
                "text-xs font-bold px-2 py-0.5 rounded-full",
                strobe.signalOk ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
              )}>
                {strobe.signalOk ? "신호 감지" : "신호 없음"}
              </span>
            </div>
            {strobe.isCapturing && (
              <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                <div
                  className="bg-primary h-1.5 rounded-full transition-all"
                  style={{ width: `${strobe.captureProgress * 100}%` }}
                />
              </div>
            )}
            {strobe.liveCents !== null && (
              <p className="text-sm font-bold text-foreground mt-1">
                실시간: {strobe.liveCents > 0 ? "+" : ""}{strobe.liveCents.toFixed(1)}¢
              </p>
            )}
          </div>
        )}

        {/* 녹음 기반 기준점 */}
        <section className="bg-card border border-primary/25 rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-foreground">녹음 기준점</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                같은 건반을 3~5회 녹음해 대표값을 고정하고, 이후 타건은 이 기준과 비교합니다.
              </p>
            </div>
            {keyBaseline && (
              <button
                onClick={() => { void clearBaseline(); }}
                className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-off/35 text-off-foreground hover:bg-off/10"
              >
                기준 초기화
              </button>
            )}
          </div>

          <div className="mt-3 rounded-lg bg-muted/55 border border-border/70 px-3 py-2.5">
            {keyBaseline ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-bold text-primary">{targetKey.noteName}{targetKey.octave} 기준 등록</span>
                <span className="tabular-nums text-foreground/85">{keyBaseline.frequency.toFixed(2)} Hz</span>
                <span className="tabular-nums text-muted-foreground">평균율 {keyBaseline.cents > 0 ? "+" : ""}{keyBaseline.cents.toFixed(1)}¢</span>
                <span className="tabular-nums text-muted-foreground">일치 범위 ±{keyBaseline.toleranceCents.toFixed(1)}¢</span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">아직 기준값이 없습니다. 깨끗한 타건을 녹음해 첫 기준점을 만드세요.</p>
            )}
          </div>

          {baselineCapture.phase !== "idle" && baselineCapture.phase !== "done" && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {baselineCapture.phase === "arming" && "타건을 기다리는 중…"}
                  {baselineCapture.phase === "capturing" && "안정 구간을 녹음·분석 중…"}
                  {baselineCapture.phase === "analyzing" && "대표값을 계산 중…"}
                  {baselineCapture.phase === "error" && (baselineCapture.error ?? "녹음에 실패했습니다.")}
                </span>
                {baselineCapture.phase === "capturing" && <span>{Math.round(baselineCapture.progress * 100)}%</span>}
              </div>
              {baselineCapture.phase === "capturing" && (
                <div className="w-full bg-muted rounded-full h-1.5 mt-1.5">
                  <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${baselineCapture.progress * 100}%` }} />
                </div>
              )}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={baselineCapture.start}
              disabled={!isPro || !isListening || !["idle", "done", "error"].includes(baselineCapture.phase)}
              title={!isListening ? "먼저 마이크를 켜 주세요" : undefined}
              className={cn(
                "flex-1 py-2.5 rounded-xl text-sm font-bold transition-all",
                isPro && isListening && ["idle", "done", "error"].includes(baselineCapture.phase)
                  ? "bg-primary text-white hover:bg-primary/90 active:scale-[0.98]"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {baselineCapture.phase === "arming" ? "타건 대기 중" : baselineCapture.phase === "capturing" ? "기준 녹음·분석 중" : "● 이 음을 기준으로 녹음"}
            </button>
            {(baselineCapture.phase === "arming" || baselineCapture.phase === "capturing" || baselineCapture.phase === "analyzing") && (
              <button
                onClick={baselineCapture.cancel}
                className="px-3 py-2.5 rounded-xl text-sm font-medium border bg-card text-muted-foreground border-border hover:bg-muted"
              >
                취소
              </button>
            )}
          </div>

          {keyBaseline && (
            <div className="mt-3 pt-3 border-t border-border/60">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-foreground/85">저장된 기준 타건 {keyBaseline.takes.length}/5</span>
                <span className="text-[11px] text-muted-foreground">각 녹음은 이 브라우저에서 재생됩니다.</span>
              </div>
              <div className="space-y-1.5">
                {keyBaseline.takes.map((take, index) => (
                  <div key={take.id} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2 text-xs">
                    <button
                      onClick={() => { void playBaselineTake(take.audioId); }}
                      className="w-16 shrink-0 py-1 rounded-md bg-card border border-border font-medium text-foreground hover:bg-muted"
                    >
                      {playingTakeId === take.audioId ? "재생 중" : `재생 ${index + 1}`}
                    </button>
                    <span className="tabular-nums text-foreground/85">{take.frequency.toFixed(2)} Hz</span>
                    <span className="tabular-nums text-muted-foreground">{take.cents > 0 ? "+" : ""}{take.cents.toFixed(1)}¢</span>
                    <span className="ml-auto text-muted-foreground">신뢰도 {Math.round(take.confidence * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 마이크 + 자동 진행 토글 */}
        <div className="flex items-center gap-2">
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
                  : "bg-primary text-white hover:bg-primary/90"
            )}
          >
            {!isPro ? "🔒 마이크 켜기" : isListening ? "■ 마이크 끄기" : "● 마이크 켜기"}
          </button>
          {!isPro && (
            <span className="text-xs text-muted-foreground bg-muted px-2 py-1.5 rounded-lg border border-border whitespace-nowrap">
              Pro 전용
            </span>
          )}
          <label className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-card border border-border cursor-pointer">
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(e) => setAutoAdvance(e.target.checked)}
              className="w-4 h-4 accent-primary"
            />
            <span className="text-xs text-foreground/85 whitespace-nowrap">자동 진행</span>
          </label>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-off/10 border border-off/40 text-xs text-off-foreground">
            {error}
          </div>
        )}

        {/* 상태 메시지 */}
        <MatchStatus state={displayMatchState} isListening={isListening} />

        {/* 그래프 */}
        <div className="bg-card border border-border rounded-xl p-2 shadow-sm">
          <TuningCurveChart
            data={chartData}
            activeKeyIndex={seq.targetKeyIndex}
          />
        </div>

        {/* 하단 컨트롤 */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={seq.prev}
            disabled={!seq.canPrev}
            className={cn(
              "py-2.5 rounded-xl text-sm font-medium border transition-all active:scale-[0.98]",
              seq.canPrev
                ? "bg-card text-foreground border-border hover:bg-muted"
                : "bg-muted/40 text-muted-foreground/40 border-border/60 cursor-not-allowed"
            )}
          >
            ◀ 이전
          </button>
          <button
            onClick={() => {
              clearTimers();
              setMatchState({ kind: "idle" });
              if (seq.canNext) seq.next();
              else sonnerToast("이 구간의 마지막 음입니다.");
            }}
            className="py-2.5 rounded-xl text-sm font-medium border bg-card text-muted-foreground border-border hover:bg-muted transition-all active:scale-[0.98]"
          >
            건너뛰기
          </button>
          <button
            onClick={seq.next}
            disabled={!seq.canNext}
            className={cn(
              "py-2.5 rounded-xl text-sm font-medium border transition-all active:scale-[0.98]",
              seq.canNext
                ? "bg-card text-foreground border-border hover:bg-muted"
                : "bg-muted/40 text-muted-foreground/40 border-border/60 cursor-not-allowed"
            )}
          >
            다음 ▶
          </button>
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
                측정 {measuredCount} / 88 · 현재 목표 {targetKey.noteName}{targetKey.octave} (건반 {targetKey.keyNumber})
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
              className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg font-medium whitespace-nowrap"
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
              className="w-full text-sm border border-border rounded-lg px-3 py-2 outline-none focus:border-primary/60"
            />
            <div className="flex gap-2">
              <button
                onClick={() => activeSession && exportToPdf(
                  activeSession.name,
                  userName,
                  activeSession.measurements as any,
                )}
                disabled={measuredCount === 0}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                  measuredCount > 0 ? "bg-primary text-white" : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                )}
              >
                📄 PDF
              </button>
              <button
                onClick={() => activeSession && exportToImage(
                  activeSession.name,
                  userName,
                  activeSession.measurements as any,
                )}
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
