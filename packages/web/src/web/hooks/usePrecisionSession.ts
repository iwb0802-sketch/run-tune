/**
 * usePrecisionSession.ts — v2
 *
 * 자동저장 로직:
 *  - 3회 달성 → saveCurrentToSession (패널 유지, 계속 측정 가능)
 *  - 4~5회 구간 → 확정버튼 활성 → confirmCurrent (패널 유지)
 *  - 5회 달성 → saveCurrentToSession (패널 유지)
 *  - 다음 건반 이동 시 → resetPending
 *
 * 엔진 분기:
 *  - keyIndex 0~26  (1~27번):  useTargetedStrobe
 *  - keyIndex 27~87 (28~88번): usePitchDetector
 */

import { useState, useCallback, useRef } from "react";

/** 3회 달성 → 자동저장 (패널 유지) */
export const AUTO_SAVE_SAMPLES = 3;
/** 5회 달성 → 자동저장 (최대) */
export const MAX_SAMPLES = 5;
/** @deprecated 하위 호환 */
export const MIN_SAMPLES = AUTO_SAVE_SAMPLES;

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

  const [pendingKeyIndex, setPendingKeyIndex] = useState<number | null>(null);
  const [centsHistory, setCentsHistory] = useState<number[]>([]);
  const [currentLive, setCurrentLive] = useState<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  const pendingKeyRef = useRef<number | null>(null);
  const centsHistoryRef = useRef<number[]>([]);
  const currentRoundBufferRef = useRef<number[]>([]);
  const isRoundActiveRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;
  const measuredCount = activeSession ? Object.keys(activeSession.measurements).length : 0;

  const medianCents = centsHistory.length >= AUTO_SAVE_SAMPLES
    ? Math.round(calcMedian(centsHistory) * 10) / 10
    : null;

  /** 정확히 3회 달성 → 자동저장 트리거 */
  const shouldAutoSave3 = centsHistory.length === AUTO_SAVE_SAMPLES;
  /** 5회 달성 → 자동저장 트리거 */
  const shouldAutoSave5 = centsHistory.length === MAX_SAMPLES;
  /** 4~5회 구간 → 확정버튼 활성 */
  const canConfirm = centsHistory.length >= AUTO_SAVE_SAMPLES && centsHistory.length <= MAX_SAMPLES;

  // ─── 세션 관리 ───────────────────────────────────────────────────

  /** pending 상태만 초기화 (건반 이동 시 호출) */
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
    const s: PrecisionSession = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      name: n, createdAt: now, measurements: {},
    };
    setSessions(prev => { const u = [s, ...prev].slice(0, 10); saveSessions(u); return u; });
    activeSessionIdRef.current = s.id;
    setActiveSessionId(s.id);
    resetPending();
    return s;
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

  // ─── 저장만 (패널 유지) ───────────────────────────────────────────
  /** 현재 centsHistory를 세션에 저장. resetPending 호출 안 함 → 패널 유지. */
  const saveCurrentToSession = useCallback((frequency: number) => {
    const ki = pendingKeyRef.current;
    const sid = activeSessionIdRef.current;
    const history = centsHistoryRef.current;
    if (!sid || ki === null || history.length < AUTO_SAVE_SAMPLES) return;

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
    // pendingKeyRef/centsHistoryRef 유지 → 추가 측정 가능
  }, []);

  // ─── 저장 + 패널 유지 (수동 확정) ───────────────────────────────
  /** 확정버튼 누를 때: 저장하고 패널은 유지. resetPending은 건반 이동 시. */
  const confirmCurrent = useCallback((frequency: number) => {
    saveCurrentToSession(frequency);
    // 패널 유지 — resetPending 호출 안 함
  }, [saveCurrentToSession]);

  // ─── 피치 수신 ───────────────────────────────────────────────────
  const onPitchActive = useCallback((keyIndex: number, cents: number) => {
    if (pendingKeyRef.current !== keyIndex) {
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
    if (centsHistoryRef.current.length >= MAX_SAMPLES) return; // 이미 최대
    currentRoundBufferRef.current.push(cents);
    isRoundActiveRef.current = true;
    const live = Math.round(calcMedian(currentRoundBufferRef.current) * 10) / 10;
    setCurrentLive(live);
    setIsCapturing(true);
  }, []);

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

  const onStrobeSample = useCallback((keyIndex: number, cents: number) => {
    if (pendingKeyRef.current !== keyIndex) {
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

    pendingKeyIndex,
    centsHistory,
    currentLive,
    isCapturing,
    medianCents,
    canConfirm,
    shouldAutoSave3,
    shouldAutoSave5,
    AUTO_SAVE_SAMPLES,
    MIN_SAMPLES,
    MAX_SAMPLES,

    onPitchActive,
    onSilenceDetected,
    onStrobeSample,
    saveCurrentToSession,
    confirmCurrent,

    measuredCount,
  };
}
