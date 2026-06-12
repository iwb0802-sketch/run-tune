/**
 * usePrecisionSession.ts — v2
 *
 * 수동모드와 동일한 파트별 엔진 방식.
 * 복합 auto+strobe 블렌딩 제거 → 3~5회 수집 후 중앙값 하나로 확정.
 *
 * 엔진 분기:
 *  - keyIndex 0~26 (1~27번):  useTargetedStrobe (배음 분석 → 기본음 절대 cent)
 *  - keyIndex 27~87 (28~88번): usePitchDetector  (YIN+HPS → 절대 cent)
 *
 * MIN_SAMPLES = 3, MAX_SAMPLES = 5
 * 3회 이상 수집되면 중앙값 표시 + 확정 가능
 * 5회 도달 시 자동 확정
 */

import { useState, useCallback, useRef } from "react";

export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 5;

export interface PrecisionMeasurement {
  keyIndex: number;
  centsHistory: number[];
  medianCents: number;
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

const STORAGE_KEY = "piano_precision_sessions_v2";

function loadSessions(): PrecisionSession[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}
function saveSessions(s: PrecisionSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function usePrecisionSession() {
  const [sessions, setSessions] = useState<PrecisionSession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    const s = loadSessions(); return s[0]?.id ?? null;
  });

  // 현재 측정 중인 건반 상태
  const [pendingKeyIndex, setPendingKeyIndex] = useState<number | null>(null);
  const [centsHistory, setCentsHistory] = useState<number[]>([]);
  const [currentLive, setCurrentLive] = useState<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  // Refs (클로저 회피)
  const pendingKeyRef = useRef<number | null>(null);
  const centsHistoryRef = useRef<number[]>([]);
  const currentRoundBufferRef = useRef<number[]>([]);
  const isRoundActiveRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;
  const measuredCount = activeSession ? Object.keys(activeSession.measurements).length : 0;

  // 중앙값 (3회 이상이면 표시)
  const medianCents = centsHistory.length >= MIN_SAMPLES
    ? Math.round(calcMedian(centsHistory) * 10) / 10
    : null;

  const canConfirm = medianCents !== null;
  const canAutoSave = centsHistory.length >= MAX_SAMPLES;

  // ─── 세션 관리 ────────────────────────────────────────────────────

  const resetPending = useCallback(() => {
    pendingKeyRef.current = null;
    centsHistoryRef.current = [];
    currentRoundBufferRef.current = [];
    isRoundActiveRef.current = false;
    setPendingKeyIndex(null);
    setCentsHistory([]);
    setCurrentLive(null);
    setIsCapturing(false);
  }, []);

  const createSession = useCallback((name?: string) => {
    const now = Date.now();
    const n = name || `정밀 ${new Date(now).toLocaleDateString("ko-KR")} ${new Date(now).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
    const session: PrecisionSession = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      name: n,
      createdAt: now,
      measurements: {},
    };
    setSessions(prev => { const u = [session, ...prev].slice(0, 10); saveSessions(u); return u; });
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    resetPending();
    return session;
  }, [resetPending]);

  const clearAllMeasurements = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    setSessions(prev => {
      const u = prev.map(s => s.id === sid ? { ...s, measurements: {} } : s);
      saveSessions(u); return u;
    });
    resetPending();
  }, [resetPending]);

  // ─── 피치 수신 (수동모드의 handlePitchDetected와 동일 방식) ──────
  //
  // PitchDetector(중/고음) 콜백에서 호출.
  // keyIndex가 목표와 같으면 버퍼에 누적.
  const onPitchActive = useCallback((keyIndex: number, cents: number) => {
    if (pendingKeyRef.current !== keyIndex) {
      // 새 건반 전환 → 이전 데이터 초기화
      pendingKeyRef.current = keyIndex;
      centsHistoryRef.current = [];
      currentRoundBufferRef.current = [cents];
      isRoundActiveRef.current = true;
      setPendingKeyIndex(keyIndex);
      setCentsHistory([]);
      setCurrentLive(Math.round(cents * 10) / 10);
      setIsCapturing(true);
      return;
    }
    // 같은 건반 → 현재 타건 버퍼에 추가
    currentRoundBufferRef.current.push(cents);
    isRoundActiveRef.current = true;
    const live = Math.round(calcMedian(currentRoundBufferRef.current) * 10) / 10;
    setCurrentLive(live);
    setIsCapturing(true);
  }, []);

  // 무음 감지 → 현재 타건 버퍼를 1회 확정치로 수집
  const onSilenceDetected = useCallback(() => {
    if (!isRoundActiveRef.current) return;
    if (currentRoundBufferRef.current.length === 0) return;
    if (centsHistoryRef.current.length >= MAX_SAMPLES) {
      currentRoundBufferRef.current = [];
      isRoundActiveRef.current = false;
      setIsCapturing(false);
      setCurrentLive(null);
      return;
    }

    const roundVal = Math.round(calcMedian(currentRoundBufferRef.current) * 10) / 10;
    centsHistoryRef.current = [...centsHistoryRef.current, roundVal];
    currentRoundBufferRef.current = [];
    isRoundActiveRef.current = false;

    setCentsHistory([...centsHistoryRef.current]);
    setIsCapturing(false);
    setCurrentLive(null);
  }, []);

  // ─── 스트로브 확정값 수신 (저음 구간) ────────────────────────────
  //
  // useTargetedStrobe의 strobeCents가 새 값이면 그대로 1회 수집.
  // 저음은 배음 분석을 통해 이미 기본음 기준 절대 cent로 반환됨.
  const onStrobeSample = useCallback((keyIndex: number, cents: number) => {
    if (pendingKeyRef.current !== keyIndex) {
      // 새 건반
      pendingKeyRef.current = keyIndex;
      centsHistoryRef.current = [];
      setPendingKeyIndex(keyIndex);
      setCentsHistory([]);
    }
    if (centsHistoryRef.current.length >= MAX_SAMPLES) return;

    centsHistoryRef.current = [...centsHistoryRef.current, Math.round(cents * 10) / 10];
    setCentsHistory([...centsHistoryRef.current]);
    setCurrentLive(null);
    setIsCapturing(false);
  }, []);

  // ─── 확정 저장 ───────────────────────────────────────────────────
  const confirmCurrent = useCallback((frequency: number) => {
    const ki = pendingKeyRef.current;
    const sid = activeSessionIdRef.current;
    const history = centsHistoryRef.current;
    if (!sid || ki === null || history.length < MIN_SAMPLES) return;

    const median = Math.round(calcMedian(history) * 10) / 10;
    const measurement: PrecisionMeasurement = {
      keyIndex: ki,
      centsHistory: [...history],
      medianCents: median,
      frequency,
      measuredAt: Date.now(),
    };

    setSessions(prev => {
      const u = prev.map(s => s.id === sid
        ? { ...s, measurements: { ...s.measurements, [ki]: measurement } }
        : s);
      saveSessions(u); return u;
    });

    resetPending();
  }, [resetPending]);

  // activeSessionId 변경 시 ref 동기화
  const setActiveSessionIdWithRef = useCallback((id: string) => {
    activeSessionIdRef.current = id;
    setActiveSessionId(id);
  }, []);

  return {
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId: setActiveSessionIdWithRef,
    createSession,
    clearAllMeasurements,
    resetPending,

    // 현재 측정 상태
    pendingKeyIndex,
    centsHistory,
    currentLive,
    isCapturing,
    medianCents,
    canConfirm,
    canAutoSave,
    MIN_SAMPLES,
    MAX_SAMPLES,

    // 이벤트 핸들러
    onPitchActive,
    onSilenceDetected,
    onStrobeSample,
    confirmCurrent,

    measuredCount,
  };
}
