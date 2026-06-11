/**
 * usePrecisionSession.ts
 * 정밀 측정 - useRef 기반으로 클로저 문제 해결
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { targetPartial } from "@/lib/tuner/pitchEngine";

export interface PrecisionMeasurement {
  keyIndex: number;
  autoCentsHistory: number[];
  autoMedian: number | null;
  strobeCentsHistory: number[];
  strobeMedian: number | null;
  finalCents: number | null;
  confidence: number;
  frequency: number;
  measuredAt: number;
}

export interface PrecisionSession {
  id: string;
  name: string;
  createdAt: number;
  measurements: Record<number, PrecisionMeasurement>;
}

function calcMedian(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function calcConfidence(autoCount: number, strobeCount: number, autoMedian: number | null, strobeMedian: number | null, blendStrobe: boolean): number {
  let conf = Math.min(autoCount / 3, 1) * 0.6;
  if (autoMedian !== null && strobeMedian !== null && blendStrobe) {
    const diff = Math.abs(autoMedian - strobeMedian);
    if (diff <= 2) conf += 0.4;
    else if (diff <= 5) conf += 0.2;
    else conf += 0.1;
  } else if (strobeCount > 0) conf += 0.1;
  return Math.min(conf, 1);
}

/**
 * finalCents 계산
 * - 중·고음(partial=1, 건반 37+): 스트로브 cent = 기본음 cent → 가중 평균 OK
 * - 베이스(partial>1, 건반 1~36): 스트로브는 배음 cent (inharmonicity로 fundamental cent와 다름)
 *   → autoMedian(YIN 기본음)만 사용, 스트로브는 참고용
 */
function calcFinal(autoMedian: number | null, strobeMedian: number | null, autoCount: number, blendStrobe: boolean): number | null {
  if (autoMedian === null) return null;
  if (strobeMedian === null || !blendStrobe) return autoCount >= 3 ? autoMedian : null;
  const autoWeight = Math.min(autoCount / 5, 0.7);
  return Math.round((autoMedian * autoWeight + strobeMedian * (1 - autoWeight)) * 10) / 10;
}

const STORAGE_KEY = "piano_precision_sessions_v1";
export const MAX_AUTO = 5;
export const MAX_STROBE = 2;

function loadSessions(): PrecisionSession[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveSessions(s: PrecisionSession[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

export function usePrecisionSession() {
  const [sessions, setSessions] = useState<PrecisionSession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    const s = loadSessions(); return s[0]?.id ?? null;
  });

  // UI 표시용 상태
  const [pendingKeyIndex, setPendingKeyIndex] = useState<number | null>(null);
  const [confirmedAuto, setConfirmedAuto] = useState<number[]>([]);
  const [confirmedStrobe, setConfirmedStrobe] = useState<number[]>([]);
  const [currentLive, setCurrentLive] = useState<number | null>(null);
  const [isRoundActive, setIsRoundActive] = useState(false);

  // Ref로 최신 상태 유지 (클로저 문제 방지)
  const pendingKeyRef = useRef<number | null>(null);
  const confirmedAutoRef = useRef<number[]>([]);
  const confirmedStrobeRef = useRef<number[]>([]);
  const currentRoundBufferRef = useRef<number[]>([]);
  const isRoundActiveRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);

  // Ref 동기화
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;

  const resetPending = useCallback(() => {
    pendingKeyRef.current = null;
    confirmedAutoRef.current = [];
    confirmedStrobeRef.current = [];
    currentRoundBufferRef.current = [];
    isRoundActiveRef.current = false;
    setPendingKeyIndex(null);
    setConfirmedAuto([]);
    setConfirmedStrobe([]);
    setCurrentLive(null);
    setIsRoundActive(false);
  }, []);

  const createSession = useCallback((name?: string) => {
    const now = Date.now();
    const n = name || `정밀 ${new Date(now).toLocaleDateString("ko-KR")} ${new Date(now).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
    const session: PrecisionSession = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), name: n, createdAt: now, measurements: {} };
    setSessions(prev => { const u = [session, ...prev].slice(0, 10); saveSessions(u); return u; });
    activeSessionIdRef.current = session.id; // ref 즉시 동기화
    setActiveSessionId(session.id);
    resetPending();
    return session;
  }, [resetPending]);

  const deleteSession = useCallback((id: string) => {
    setSessions(prev => { const u = prev.filter(s => s.id !== id); saveSessions(u); return u; });
    setActiveSessionId(prev => prev === id ? null : prev);
  }, []);

  const renameSession = useCallback((id: string, name: string) => {
    setSessions(prev => { const u = prev.map(s => s.id === id ? { ...s, name } : s); saveSessions(u); return u; });
  }, []);

  /**
   * 피치 감지 중 - Ref 기반으로 클로저 없이 처리
   */
  const onPitchActive = useCallback((keyIndex: number, cents: number) => {
    if (pendingKeyRef.current !== keyIndex) {
      // 새 건반 전환
      pendingKeyRef.current = keyIndex;
      confirmedAutoRef.current = [];
      confirmedStrobeRef.current = [];
      currentRoundBufferRef.current = [cents];
      isRoundActiveRef.current = true;
      setPendingKeyIndex(keyIndex);
      setConfirmedAuto([]);
      setConfirmedStrobe([]);
      setCurrentLive(Math.round(cents * 10) / 10);
      setIsRoundActive(true);
      return;
    }
    // 같은 건반 - 버퍼에 추가
    currentRoundBufferRef.current.push(cents);
    isRoundActiveRef.current = true;
    const live = Math.round(calcMedian(currentRoundBufferRef.current) * 10) / 10;
    setCurrentLive(live);
    setIsRoundActive(true);
  }, []);

  /**
   * 무음 감지 시 - 현재 버퍼를 1회 확정 (Ref 기반)
   */
  const onSilenceDetected = useCallback(() => {
    if (!isRoundActiveRef.current) return;
    if (currentRoundBufferRef.current.length === 0) return;
    if (confirmedAutoRef.current.length >= MAX_AUTO) {
      currentRoundBufferRef.current = [];
      isRoundActiveRef.current = false;
      setIsRoundActive(false);
      setCurrentLive(null);
      return;
    }

    const roundVal = Math.round(calcMedian(currentRoundBufferRef.current) * 10) / 10;
    confirmedAutoRef.current = [...confirmedAutoRef.current, roundVal];
    currentRoundBufferRef.current = [];
    isRoundActiveRef.current = false;

    setConfirmedAuto([...confirmedAutoRef.current]);
    setIsRoundActive(false);
    setCurrentLive(null);
  }, []);

  /**
   * 스트로브 확정값 추가 (Ref 기반)
   */
  const addStrobeCents = useCallback((keyIndex: number, cents: number) => {
    if (pendingKeyRef.current !== keyIndex) return;
    if (confirmedStrobeRef.current.length >= MAX_STROBE) return;
    const val = Math.round(cents * 10) / 10;
    confirmedStrobeRef.current = [...confirmedStrobeRef.current, val];
    setConfirmedStrobe([...confirmedStrobeRef.current]);
  }, []);

  // 계산값 (UI 상태 기반)
  const autoMedian = confirmedAuto.length > 0 ? Math.round(calcMedian(confirmedAuto) * 10) / 10 : null;
  const strobeMedian = confirmedStrobe.length >= 2
    ? Math.round(calcMedian(confirmedStrobe) * 10) / 10
    : confirmedStrobe.length === 1 ? confirmedStrobe[0] : null;
  // 배음 측정 구간(베이스)에서는 스트로브를 finalCents 블렌딩에서 제외 (단위가 다름)
  const blendStrobe = pendingKeyIndex !== null && targetPartial(pendingKeyIndex) === 1;
  const confidence = calcConfidence(confirmedAuto.length, confirmedStrobe.length, autoMedian, strobeMedian, blendStrobe);
  const finalCents = calcFinal(autoMedian, strobeMedian, confirmedAuto.length, blendStrobe);

  // 자동-스트로브 차이 (블렌딩 구간에서만 의미 있음)
  const autoStrobeDiff = blendStrobe && autoMedian !== null && strobeMedian !== null
    ? Math.abs(autoMedian - strobeMedian)
    : null;
  const needsRecheck = autoStrobeDiff !== null && autoStrobeDiff > 5;

  // 자동 3회 채우면 저장. 스트로브는 있으면 블렌딩에 포함, 없으면 autoMedian 단독 사용.
  // 스트로브가 있는데 자동값과 5센트 이상 차이나면 재검 필요 (저장 보류).
  const canAutoSave = confirmedAuto.length >= 3 && !needsRecheck;
  const canConfirm = canAutoSave;

  // 확정 저장
  const confirmCurrent = useCallback((frequency: number) => {
    const ki = pendingKeyRef.current;
    const sid = activeSessionIdRef.current;
    const auto = confirmedAutoRef.current;
    const strobe = confirmedStrobeRef.current;
    if (!sid || ki === null || auto.length < 3) return;

    const autoMed = auto.length > 0 ? Math.round(calcMedian(auto) * 10) / 10 : null;
    const strobeMed = strobe.length >= 2
      ? Math.round(calcMedian(strobe) * 10) / 10
      : strobe.length === 1 ? strobe[0] : null;
    const blend = targetPartial(ki) === 1;
    const final = calcFinal(autoMed, strobeMed, auto.length, blend);
    if (final === null) return;

    const conf = calcConfidence(auto.length, strobe.length, autoMed, strobeMed, blend);
    const measurement: PrecisionMeasurement = {
      keyIndex: ki,
      autoCentsHistory: [...auto],
      autoMedian: autoMed,
      strobeCentsHistory: [...strobe],
      strobeMedian: strobeMed,
      finalCents: final,
      confidence: conf,
      frequency,
      measuredAt: Date.now(),
    };
    setSessions(prev => {
      const u = prev.map(s => s.id === sid
        ? { ...s, measurements: { ...s.measurements, [ki]: measurement } }
        : s);
      saveSessions(u); return u;
    });
  }, []);

  const clearAllMeasurements = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    setSessions(prev => { const u = prev.map(s => s.id === sid ? { ...s, measurements: {} } : s); saveSessions(u); return u; });
    resetPending();
  }, [resetPending]);

  const measuredCount = activeSession ? Object.keys(activeSession.measurements).length : 0;

  return {
    sessions, setSessions, activeSession, activeSessionId, setActiveSessionId,
    createSession, deleteSession, renameSession,
    pendingKeyIndex, confirmedAuto, confirmedStrobe, currentLive, isRoundActive,
    autoMedian, strobeMedian, confidence, finalCents,
    canConfirm, canAutoSave, needsRecheck, autoStrobeDiff,
    MAX_AUTO, MAX_STROBE,
    onPitchActive, onSilenceDetected, addStrobeCents, resetPending,
    confirmCurrent, clearAllMeasurements,
    measuredCount,
  };
}
