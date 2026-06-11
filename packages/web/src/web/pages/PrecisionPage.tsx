/**
 * PrecisionPage.tsx - 정밀 측정 페이지
 * 안정 피치 감지 즉시 1회 확정 (쿨다운 1.5초)
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { usePitchDetector, PIANO_KEYS } from "@/hooks/usePitchDetector";
import { useStrobeDetector } from "@/hooks/useStrobeDetector";
import { useWakeLock } from "@/hooks/useWakeLock";
import { usePrecisionSession } from "@/hooks/usePrecisionSession";
import { UPPER_ABS, LOWER_ABS } from "@/lib/tuner/tuningCurveData";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";
import StrobeTuner from "@/components/tuner/StrobeTuner";
import { cn } from "@/lib/utils";
import { exportToPdf, exportToImage } from "@/lib/tuner/exportPdf";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";

function isInRange(keyIndex: number, cents: number): boolean {
  return cents >= LOWER_ABS[keyIndex] && cents <= UPPER_ABS[keyIndex];
}

// 최근 확정 목록 컴포넌트 - 탭하면 상세 내역 펼치기
function PrecisionResultList({ measurements }: { measurements: Record<number, any> }) {
  const [expandedKey, setExpandedKey] = useState<number | null>(null);
  const sorted = Object.values(measurements).sort((a, b) => b.measuredAt - a.measuredAt).slice(0, 20);

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">최근 확정</h3>
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {sorted.map((m, idx) => {
          const key = PIANO_KEYS[m.keyIndex];
          const inR = m.finalCents !== null && isInRange(m.keyIndex, m.finalCents);
          const isExpanded = expandedKey === m.keyIndex;
          return (
            <div key={m.keyIndex}>
              {/* 요약 행 */}
              <div
                onClick={() => setExpandedKey(isExpanded ? null : m.keyIndex)}
                className={cn("flex items-center justify-between py-1.5 px-2 rounded text-xs cursor-pointer transition-colors",
                  idx === 0 ? "bg-precision-soft" : "hover:bg-muted/50")}>
                <span className="text-foreground/85 font-semibold w-10" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {key.noteName}{key.octave}
                </span>
                <span className="text-muted-foreground/80">건반 {m.keyIndex + 1}</span>
                <span className="text-muted-foreground/60">자{m.autoCentsHistory.length}+스{m.strobeCentsHistory.length}</span>
                <div className="flex items-center gap-1">
                  <span className={cn("font-bold tabular-nums", inR ? "text-precision" : "text-off")}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {m.finalCents !== null ? `${m.finalCents > 0 ? "+" : ""}${m.finalCents.toFixed(1)}¢` : "--"}
                  </span>
                  <span className="text-muted-foreground/60">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </div>
              {/* 상세 내역 */}
              {isExpanded && (
                <div className="mx-2 mb-2 bg-muted/50 rounded-lg p-2 border border-border/60">
                  <table className="w-full text-xs">
                    <tbody>
                      {m.autoCentsHistory.map((c: number, i: number) => (
                        <tr key={`a${i}`} className="border-b border-border/60">
                          <td className="py-1 text-primary">자동 피치</td>
                          <td className="py-1 text-center text-muted-foreground/80">{i + 1}회</td>
                          <td className="py-1 text-right font-mono font-semibold text-foreground/85">{c > 0 ? "+" : ""}{c.toFixed(1)}¢</td>
                        </tr>
                      ))}
                      {m.autoMedian !== null && m.autoCentsHistory.length >= 2 && (
                        <tr className="border-b border-border/60 bg-primary-soft">
                          <td className="py-1 text-primary font-bold">자동 중앙값</td>
                          <td className="py-1 text-center text-primary/70">{m.autoCentsHistory.length}회</td>
                          <td className="py-1 text-right font-mono font-bold text-primary">{m.autoMedian > 0 ? "+" : ""}{m.autoMedian.toFixed(1)}¢</td>
                        </tr>
                      )}
                      {m.strobeCentsHistory.map((c: number, i: number) => (
                        <tr key={`s${i}`} className="border-b border-border/60">
                          <td className="py-1 text-warn">스트로브</td>
                          <td className="py-1 text-center text-muted-foreground/80">{i + 1}회</td>
                          <td className="py-1 text-right font-mono font-semibold text-foreground/85">{c > 0 ? "+" : ""}{c.toFixed(1)}¢</td>
                        </tr>
                      ))}
                      {m.strobeMedian !== null && m.strobeCentsHistory.length >= 2 && (
                        <tr className="border-b border-border/60 bg-warn-soft">
                          <td className="py-1 text-warn font-bold">스트로브 중앙값</td>
                          <td className="py-1 text-center text-warn/80">{m.strobeCentsHistory.length}회</td>
                          <td className="py-1 text-right font-mono font-bold text-warn">{m.strobeMedian > 0 ? "+" : ""}{m.strobeMedian.toFixed(1)}¢</td>
                        </tr>
                      )}
                      <tr className="bg-precision-soft">
                        <td className="py-1.5 text-precision font-bold">최종값</td>
                        <td className="py-1.5 text-center text-precision/65">정확도 {Math.round((m.confidence ?? 0) * 100)}%</td>
                        <td className="py-1.5 text-right font-mono font-bold" style={{ color: inR ? '#7c3aed' : '#dc2626' }}>
                          {m.finalCents > 0 ? "+" : ""}{m.finalCents?.toFixed(1)}¢
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

export default function PrecisionPage() {
  const { user } = useAuth();
  const { isPro } = useUserRole(user?.id);

  const session = usePrecisionSession();
  const {
    activeSession, activeSessionId, createSession, measuredCount,
    pendingKeyIndex, confirmedAuto, confirmedStrobe, currentLive, isRoundActive,
    autoMedian, strobeMedian, confidence, finalCents,
    canConfirm, canAutoSave, needsRecheck, autoStrobeDiff,
    MAX_AUTO, MAX_STROBE,
    onPitchActive, onSilenceDetected, addStrobeCents,
    confirmCurrent, clearAllMeasurements,
  } = session;

  const [showGuide, setShowGuide] = useState(true);
  const [userName, setUserName] = useState("");
  const [showSessionList, setShowSessionList] = useState(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useWakeLock(true);

  // 피치 감지 중 → 버퍼 누적, 0.5초 무음 → 1회 확정
  const handlePitch = useCallback((result: any) => {
    if (result.confidence < 0.55) return;
    onPitchActive(result.keyIndex, result.cents);
    // 무음 타이머 리셋 (0.5초 무음 = 타건 종료)
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      onSilenceDetected();
    }, 500);
  }, [onPitchActive, onSilenceDetected]);

  const { isListening, currentPitch, startListening, stopListening, error, stream, audioContext } =
    usePitchDetector(handlePitch);

  const { strobeCents } = useStrobeDetector(
    isListening ? stream : null,
    isListening ? audioContext : null,
    1200,
    4096,
    pendingKeyIndex  // 자동 피치가 확정한 건반 기준으로 옵타브 보정
  );

  // 스트로브 확정값 추가 - 새 값이 들어올 때마다 저장
  const prevStrobeRef = useRef<number | null>(null);
  useEffect(() => {
    if (strobeCents === null) {
      // 스트로브 리셋 시 prevRef도 리셋
      prevStrobeRef.current = null;
      return;
    }
    if (pendingKeyIndex !== null && strobeCents !== prevStrobeRef.current) {
      prevStrobeRef.current = strobeCents;
      addStrobeCents(pendingKeyIndex, strobeCents);
    }
  }, [strobeCents, pendingKeyIndex, addStrobeCents]);

  // 자동저장: 3회+1회 충족 시 자동 기입 (키 인덱스 기준 1회 보장)
  // - autoSavedRef.boolean 대신 lastSavedKey 사용 → 새 건반으로 넘어가면 무조건 다시 발동
  const lastSavedKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      canAutoSave &&
      finalCents !== null &&
      activeSessionId &&
      pendingKeyIndex !== null &&
      lastSavedKeyRef.current !== pendingKeyIndex
    ) {
      lastSavedKeyRef.current = pendingKeyIndex;
      confirmCurrent(currentPitch?.frequency ?? 0);
    }
    // 키가 바뀌었거나 측정 리셋되면 마지막 저장 키도 해제
    if (pendingKeyIndex === null) lastSavedKeyRef.current = null;
  }, [canAutoSave, finalCents, activeSessionId, pendingKeyIndex]);

  const toggleListening = async () => {
    if (!activeSessionId) createSession();
    if (isListening) stopListening();
    else await startListening();
  };

  const chartData = PIANO_KEYS.map((key, i) => {
    const m = activeSession?.measurements[i];
    return {
      keyNumber: key.keyNumber, keyIndex: i,
      noteName: key.noteName, octave: key.octave,
      isBlack: key.isBlack,
      cents: m ? m.finalCents : null,
      measured: !!m,
    };
  });

  const confidenceColor = confidence >= 0.8 ? "#16a34a" : confidence >= 0.5 ? "#d97706" : "#94a3b8";
  const confidenceLabel = confidence >= 0.8 ? "높음" : confidence >= 0.5 ? "보통" : "낮음";

  return (
    <div className="min-h-screen bg-muted/50 flex flex-col" style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>
      {/* 헤더 */}
      <header className="bg-card border-b border-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-precision rounded-lg flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground leading-tight">정밀 측정 모드</h1>
            <p className="text-xs text-muted-foreground/80">안정 감지 즉시 1회 확정 · 3회+스트로브1회 자동저장</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {measuredCount > 0 && (
            <span className="text-xs font-bold text-precision bg-precision-soft px-2 py-1 rounded-lg">
              {measuredCount}/88
            </span>
          )}
          <button onClick={() => setShowGuide(v => !v)}
            className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-muted-foreground text-sm font-bold">?</button>
        </div>
      </header>

      {/* 안내 카드 */}
      {showGuide && (
        <div className="mx-4 mt-3 bg-precision-soft border border-precision/30 rounded-2xl p-4">
          <div className="flex items-start justify-between mb-2">
            <h3 className="text-sm font-bold text-precision">📌 정밀 측정이란?</h3>
            <button onClick={() => setShowGuide(false)} className="text-precision/65 text-xs">닫기</button>
          </div>
          <div className="text-xs text-precision space-y-1.5 leading-relaxed">
            <p><strong>왜 사용하나요?</strong><br/>
            같은 건반을 여러 번 측정한 값의 중앙값을 사용하면 더 정확한 조율값을 얻을 수 있습니다.</p>
            <p><strong>사용 방법</strong></p>
            <ol className="list-decimal list-inside space-y-0.5 pl-1">
              <li>마이크 시작 버튼을 탭합니다</li>
              <li>건반을 칩니다 → 안정 감지 즉시 <strong>1회 확정</strong></li>
              <li>1.5초 후 같은 건반을 다시 칩니다 → <strong>2회 확정</strong></li>
              <li>3회 반복 후 스트로브가 안정되면 자동으로 수집</li>
              <li><strong>3회 + 스트로브 1회</strong> 충족 시 자동 저장</li>
              <li>최대 5회까지 추가 측정 후 교체 가능</li>
            </ol>
            <p className="text-precision/75">💡 같은 건반은 1.5초 간격으로 쳐주세요</p>
          </div>
        </div>
      )}

      <main className="flex-1 container py-4 max-w-6xl mx-auto px-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          {/* 왼쪽 */}
          <div className="flex flex-col gap-4">
            {/* 세션 + 내보내기 */}
            <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                {/* 세션 선택 드롭다운 */}
                <div className="relative flex-1 mr-2">
                  <button
                    onClick={() => setShowSessionList(v => !v)}
                    className="flex items-center gap-1.5 text-sm text-foreground/85 hover:text-foreground max-w-full">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="font-semibold truncate max-w-[160px]">{activeSession?.name || "세션 없음"}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <p className="text-xs text-muted-foreground/80 mt-0.5">{measuredCount} / 88건반 측정 완료</p>
                  {/* 세션 목록 */}
                  {showSessionList && (
                    <div className="absolute top-full left-0 mt-1 w-64 bg-card border border-border rounded-xl shadow-lg z-20 max-h-48 overflow-y-auto">
                      {session.sessions.map(s => (
                        <button key={s.id}
                          onClick={() => { session.setActiveSessionId(s.id); setShowSessionList(false); }}
                          className={cn("w-full text-left px-3 py-2.5 text-xs hover:bg-muted/50 border-b border-border/40 last:border-0",
                            s.id === activeSessionId ? "bg-precision-soft text-precision font-bold" : "text-foreground/85")}>
                          <div className="font-medium truncate">{s.name}</div>
                          <div className="text-muted-foreground/80 mt-0.5">{Object.keys(s.measurements).length}건반 확정</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button onClick={() => { createSession(); setShowSessionList(false); }}
                  className="px-3 py-1.5 text-sm bg-precision text-white rounded-lg font-medium whitespace-nowrap">+ 새 세션</button>
              </div>
              <div className="flex flex-col gap-2 pt-2 border-t border-border/60">
                <input type="text" placeholder="성명 입력 (PDF에 표시)" value={userName}
                  onChange={e => setUserName(e.target.value)}
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 outline-none focus:border-precision/60" />
                <div className="flex gap-2">
                  <button
                    onClick={() => activeSession && exportToPdf(activeSession.name, userName,
                      Object.fromEntries(Object.entries(activeSession.measurements).map(([k, v]) => [k, { ...v, cents: v.finalCents ?? 0 }])))}
                    disabled={measuredCount === 0}
                    className={cn("flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                      measuredCount > 0 ? "bg-precision text-white" : "bg-muted text-muted-foreground/60 cursor-not-allowed")}>
                    📄 PDF
                  </button>
                  <button
                    onClick={() => activeSession && exportToImage(activeSession.name, userName,
                      Object.fromEntries(Object.entries(activeSession.measurements).map(([k, v]) => [k, { ...v, cents: v.finalCents ?? 0 }])))}
                    disabled={measuredCount === 0}
                    className={cn("flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold",
                      measuredCount > 0 ? "bg-in-tune text-white" : "bg-muted text-muted-foreground/60 cursor-not-allowed")}>
                    🖼️ 이미지
                  </button>
                </div>
              </div>
            </div>

            {/* 조율 커브 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground/85">조율 커브 (정밀 측정값)</h3>
                <div className="flex items-center gap-2 text-xs text-muted-foreground/80">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-precision inline-block" />확정값</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-off inline-block" />범위외</span>
                </div>
              </div>
              <TuningCurveChart data={chartData} activeKeyIndex={pendingKeyIndex} />
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
                    : isListening ? "bg-off text-white" : "bg-precision hover:bg-precision/90 text-white"
                )}>
                {!isPro
                  ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>마이크 시작</>
                  : isListening ? <><span className="w-2 h-2 rounded-full bg-card animate-pulse" />감지 중지</> : <>🎤 마이크 시작</>
                }
              </button>
              {!isPro && (
                <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-lg border border-border">Pro 전용</span>
              )}
              {isPro && measuredCount > 0 && (
                <button onClick={() => { if (confirm("초기화?")) clearAllMeasurements(); }}
                  className="text-xs text-muted-foreground/80 hover:text-off">초기화</button>
              )}
              {error && <span className="text-xs text-off">{error}</span>}
            </div>
          </div>

          {/* 오른쪽 */}
          <div className="flex flex-col gap-4">
            {/* 현재 측정 패널 */}
            <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">현재 측정 중</h3>

              {pendingKeyIndex !== null ? (
                <>
                  <div className="text-center mb-4">
                    <div className="text-4xl font-bold text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                      {PIANO_KEYS[pendingKeyIndex].noteName}{PIANO_KEYS[pendingKeyIndex].octave}
                    </div>
                    <div className="text-xs text-muted-foreground/80 mt-0.5">건반 {pendingKeyIndex + 1}</div>
                  </div>

                  {/* 측정값 표 */}
                  <div className="border border-border/60 rounded-xl overflow-hidden mb-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-muted/50 border-b border-border/60">
                          <th className="text-left px-3 py-2 text-muted-foreground font-semibold">구분</th>
                          <th className="text-center px-2 py-2 text-muted-foreground font-semibold">회차</th>
                          <th className="text-right px-3 py-2 text-muted-foreground font-semibold">값</th>
                        </tr>
                      </thead>
                      <tbody>
                        {confirmedAuto.map((c, i) => (
                          <tr key={`auto-${i}`} className="border-b border-border/40">
                            <td className="px-3 py-1.5 text-primary font-medium">자동 피치</td>
                            <td className="px-2 py-1.5 text-center">
                              <span className="bg-primary-soft text-primary px-1.5 py-0.5 rounded font-bold">{i + 1}회 확정</span>
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono font-bold text-foreground">
                              {c > 0 ? "+" : ""}{c.toFixed(1)}¢
                            </td>
                          </tr>
                        ))}
                        {/* 현재 타건 중 */}
                        {isRoundActive && currentLive !== null && confirmedAuto.length < MAX_AUTO && (
                          <tr className="bg-yellow-50 border-b border-border/40">
                            <td className="px-3 py-1.5 text-yellow-600 font-medium">자동 피치</td>
                            <td className="px-2 py-1.5 text-center">
                              <span className="bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded animate-pulse">{confirmedAuto.length + 1}회 진행 중...</span>
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono text-yellow-600">
                              {currentLive > 0 ? "+" : ""}{currentLive.toFixed(1)}¢
                            </td>
                          </tr>
                        )}
                        {confirmedAuto.length >= 2 && autoMedian !== null && (
                          <tr className="bg-primary-soft border-b border-border/60">
                            <td className="px-3 py-1.5 text-primary font-bold">자동 중앙값</td>
                            <td className="px-2 py-1.5 text-center text-primary/80">{confirmedAuto.length}회</td>
                            <td className="px-3 py-1.5 text-right font-mono font-bold text-primary">
                              {autoMedian > 0 ? "+" : ""}{autoMedian.toFixed(1)}¢
                            </td>
                          </tr>
                        )}
                        {confirmedStrobe.map((c, i) => (
                          <tr key={`strobe-${i}`} className="border-b border-border/40">
                            <td className="px-3 py-1.5 text-warn font-medium">스트로브</td>
                            <td className="px-2 py-1.5 text-center">
                              <span className="bg-warn-soft text-warn px-1.5 py-0.5 rounded font-bold">{i + 1}회 확정</span>
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono font-bold text-foreground">
                              {c > 0 ? "+" : ""}{c.toFixed(1)}¢
                            </td>
                          </tr>
                        ))}
                        {confirmedStrobe.length >= 2 && strobeMedian !== null && (
                          <tr className="bg-warn-soft border-b border-border/60">
                            <td className="px-3 py-1.5 text-warn font-bold">스트로브 중앙값</td>
                            <td className="px-2 py-1.5 text-center text-warn">{confirmedStrobe.length}회</td>
                            <td className="px-3 py-1.5 text-right font-mono font-bold text-warn">
                              {strobeMedian > 0 ? "+" : ""}{strobeMedian.toFixed(1)}¢
                            </td>
                          </tr>
                        )}
                        {confirmedAuto.length === 0 && (
                          <tr>
                            <td colSpan={3} className="px-3 py-3 text-center text-muted-foreground/60 text-xs">
                              건반을 쳐주세요
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* 종합 결과 */}
                  {finalCents !== null && (
                    <div className="bg-precision-soft border border-violet-100 rounded-xl p-3 mb-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-precision">종합 최종값</span>
                        <span className="text-xs font-bold" style={{ color: confidenceColor }}>
                          정확도 {Math.round(confidence * 100)}% ({confidenceLabel})
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-2xl font-extrabold" style={{
                          color: isInRange(pendingKeyIndex, finalCents) ? "#7c3aed" : "#dc2626",
                          fontFamily: "'JetBrains Mono', monospace"
                        }}>
                          {finalCents > 0 ? "+" : ""}{finalCents.toFixed(1)}¢
                        </div>
                        <div className="text-xs" style={{ color: isInRange(pendingKeyIndex, finalCents) ? "#7c3aed" : "#dc2626" }}>
                          {isInRange(pendingKeyIndex, finalCents) ? "✓ 허용 범위 내" : "✗ 허용 범위 초과"}
                        </div>
                      </div>
                      <div className="h-1.5 bg-precision-soft rounded-full mt-2 overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-300"
                          style={{ width: `${confidence * 100}%`, backgroundColor: confidenceColor }} />
                      </div>
                    </div>
                  )}

                  {/* 재측정 경고 */}
                  {needsRecheck && autoStrobeDiff !== null && (
                    <div className="flex items-start gap-2 text-xs text-off bg-off-soft border border-red-200 px-3 py-2 rounded-lg mb-2">
                      <span className="text-off mt-0.5">⚠️</span>
                      <div>
                        <p className="font-bold">재측정 필요</p>
                        <p className="text-off">자동({autoMedian !== null ? `${autoMedian > 0 ? '+' : ''}${autoMedian.toFixed(1)}¢` : '--'})와 스트로브({strobeMedian !== null ? `${strobeMedian > 0 ? '+' : ''}${strobeMedian.toFixed(1)}¢` : '--'}) 차이: {autoStrobeDiff.toFixed(1)}¢ (5¢ 초과)</p>
                      </div>
                    </div>
                  )}

                  {canAutoSave && (
                    <div className="flex items-center gap-1.5 text-xs text-in-tune bg-in-tune-soft px-3 py-2 rounded-lg mb-2">
                      <span className="w-2 h-2 rounded-full bg-in-tune animate-pulse" />
                      자동저장 완료 — 계속 측정하면 갱신됩니다
                    </div>
                  )}

                  <button
                    onClick={() => confirmCurrent(currentPitch?.frequency ?? 0)}
                    disabled={!canConfirm || finalCents === null}
                    className={cn("w-full py-3 rounded-xl text-sm font-bold transition-all active:scale-[0.97]",
                      canConfirm && finalCents !== null
                        ? canAutoSave ? "bg-in-tune hover:bg-in-tune/90 text-white" : "bg-precision hover:bg-precision/90 text-white"
                        : "bg-muted text-muted-foreground/60 cursor-not-allowed")}>
                    {canConfirm && finalCents !== null
                      ? canAutoSave
                        ? `↑ 교체: ${finalCents > 0 ? "+" : ""}${finalCents.toFixed(1)}¢ (자동${confirmedAuto.length}+스${confirmedStrobe.length})`
                        : `✓ ${finalCents > 0 ? "+" : ""}${finalCents.toFixed(1)}¢ 으로 확정`
                      : needsRecheck
                        ? `⚠️ 재측정 필요 (차이 ${autoStrobeDiff?.toFixed(1)}¢)`
                        : confirmedAuto.length < 3
                          ? `자동 피치 ${3 - confirmedAuto.length}회 더 필요`
                          : `스트로브 1회 더 필요`}
                  </button>
                </>
              ) : (
                <div className="text-center py-8 text-muted-foreground/80">
                  <div className="text-3xl mb-2">🎹</div>
                  <p className="text-sm">마이크를 켜고<br/>건반을 눌러주세요</p>
                  <p className="text-xs mt-2 text-muted-foreground/60">안정 감지 즉시 1회 확정</p>
                </div>
              )}
            </div>

            {/* 스트로브 튜너 */}
            <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
              <div className="px-4 pt-3 pb-1">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">스트로브 튜너</h3>
              </div>
              <StrobeTuner
                detectedCents={currentPitch?.cents ?? null}
                stableCents={strobeCents ?? null}
                isCapturing={strobeCents === null && isListening}
                isActive={isListening}
              />
            </div>

            {/* 최근 확정 - 탭하면 상세 내역 표시 */}
            {measuredCount > 0 && (
              <PrecisionResultList measurements={activeSession?.measurements ?? {}} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
