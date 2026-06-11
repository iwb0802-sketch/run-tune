/**
 * useTuningSession.ts
 * - 로그인 시: Supabase 클라우드 저장
 * - 비로그인 시: localStorage 폴백
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PIANO_KEYS } from "./usePitchDetector";
import { supabase } from '@/lib/supabase/client';

export interface KeyMeasurement {
  keyIndex: number;
  cents: number;          // 스트로브 1회 자동 저장값 (파란 점)
  strobeCents?: number;   // 스트로브 2회 평균값 (주황 삼각형) - 수동 저장
  strobe1?: number;       // 스트로브 1회값 (cents와 동일, 평균 계산용)
  strobe2?: number;       // 스트로브 2회값
  autoCentsRef?: number;  // 자동 피치 참고값 (그래프에 찍히지 않음)
  frequency: number;
  measuredAt: number;
}
export interface TuningSession { id: string; name: string; createdAt: number; measurements: Record<number, KeyMeasurement>; }

const STORAGE_KEY = "piano_tuning_sessions_v2";
const MAX_SESSIONS = 10;

function loadLocal(): TuningSession[] { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function saveLocal(sessions: TuningSession[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)); }

function toDbMeasurements(m: Record<number, KeyMeasurement>): Record<string, any> {
  const r: Record<string, any> = {};
  Object.entries(m).forEach(([k, v]) => { r[k] = v; });
  return r;
}
function fromDbMeasurements(m: Record<string, any>): Record<number, KeyMeasurement> {
  const r: Record<number, KeyMeasurement> = {};
  Object.entries(m || {}).forEach(([k, v]) => { r[Number(k)] = v as KeyMeasurement; });
  return r;
}

export function useTuningSession(userId?: string | null) {
  const [sessions, setSessions] = useState<TuningSession[]>(() => loadLocal());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    const s = loadLocal(); return s[0]?.id ?? null;
  });
  const [undoStack, setUndoStack] = useState<number[]>([]);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 최신 activeSessionId를 ref로 유지 → 클로저 stale 문제 방지
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;

  // 로컬 저장 (비로그인)
  useEffect(() => { if (!userId) saveLocal(sessions); }, [sessions, userId]);

  // 로그인 시 클라우드에서 세션 불러오기
  useEffect(() => {
    if (!userId) { setSessions(loadLocal()); setActiveSessionId(null); return; }
    supabase.from('tuning_sessions').select('*').eq('user_id', userId)
      .order('updated_at', { ascending: false }).limit(MAX_SESSIONS)
      .then(({ data }) => {
        if (data && data.length > 0) {
          const loaded: TuningSession[] = data.map((row: any) => ({
            id: row.id, name: row.name,
            createdAt: new Date(row.created_at).getTime(),
            measurements: fromDbMeasurements(row.measurements || {}),
          }));
          setSessions(loaded);
          setActiveSessionId(loaded[0]?.id ?? null);
        }
      });
  }, [userId]);

  // 클라우드 동기화 (디바운스 800ms)
  const syncToCloud = useCallback((updatedSessions: TuningSession[], changedId: string) => {
    if (!userId) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(async () => {
      const session = updatedSessions.find(s => s.id === changedId);
      if (!session) return;
      await supabase.from('tuning_sessions').upsert({
        id: session.id, user_id: userId, name: session.name,
        measurements: toDbMeasurements(session.measurements),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    }, 800);
  }, [userId]);

  const createSession = useCallback(async (name?: string) => {
    const now = Date.now();
    const sessionName = name || `조율 ${new Date(now).toLocaleDateString("ko-KR")} ${new Date(now).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
    if (userId) {
      const { data, error } = await supabase.from('tuning_sessions')
        .insert({ user_id: userId, name: sessionName, measurements: {} }).select().single();
      if (!error && data) {
        const session: TuningSession = { id: data.id, name: data.name, createdAt: new Date(data.created_at).getTime(), measurements: {} };
        setSessions(prev => [session, ...prev].slice(0, MAX_SESSIONS));
        activeSessionIdRef.current = session.id;
        setActiveSessionId(session.id); setUndoStack([]);
        return session;
      }
    }
    const session: TuningSession = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), name: sessionName, createdAt: now, measurements: {} };
    setSessions(prev => { const u = [session, ...prev].slice(0, MAX_SESSIONS); saveLocal(u); return u; });
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id); setUndoStack([]);
    return session;
  }, [userId]);

  const deleteSession = useCallback(async (id: string) => {
    setSessions(prev => { const u = prev.filter(s => s.id !== id); if (!userId) saveLocal(u); return u; });
    setActiveSessionId(prev => prev === id ? null : prev);
    if (userId) await supabase.from('tuning_sessions').delete().eq('id', id).eq('user_id', userId);
  }, [userId]);

  // 자동 피치 참고값만 저장 (그래프에 찍히지 않음)
  const recordMeasurement = useCallback((keyIndex: number, cents: number, frequency: number) => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    setSessions(prev => {
      const u = prev.map(s => {
        if (s.id !== sid) return s;
        const existing = s.measurements[keyIndex];
        const updated = existing
          ? { ...existing, autoCentsRef: cents }
          : { keyIndex, cents: 0, autoCentsRef: cents, frequency, measuredAt: Date.now() };
        return { ...s, measurements: { ...s.measurements, [keyIndex]: updated } };
      });
      if (!userId) saveLocal(u); else syncToCloud(u, sid);
      return u;
    });
  }, [userId, syncToCloud]);

  /**
   * 스트로브 저장:
   * - 1회: cents(파란 점)에 자동 저장 + strobe1 기록
   * - 2회(수동): strobe1+strobe2 평균 계산 → strobeCents(주황 삼각형)에 저장
   */
  const recordStrobeMeasurement = useCallback((keyIndex: number, strobeCents: number) => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    setSessions(prev => {
      const u = prev.map(s => {
        if (s.id !== sid) return s;
        const existing = s.measurements[keyIndex];
        let updated: KeyMeasurement;
        if (!existing || existing.cents === 0 || !existing.strobe1) {
          updated = {
            ...(existing || { keyIndex, frequency: 0, measuredAt: Date.now() }),
            cents: strobeCents,
            strobe1: strobeCents,
            measuredAt: Date.now(),
          };
        } else {
          const avg = Math.round(((existing.strobe1 ?? strobeCents) + strobeCents) / 2 * 10) / 10;
          updated = {
            ...existing,
            strobe2: strobeCents,
            strobeCents: avg,
            measuredAt: Date.now(),
          };
        }
        return { ...s, measurements: { ...s.measurements, [keyIndex]: updated } };
      });
      if (!userId) saveLocal(u); else syncToCloud(u, sid);
      return u;
    });
    setUndoStack(prev => [...prev, keyIndex]);
  }, [userId, syncToCloud]);

  const undoLastMeasurement = useCallback(() => {
    if (undoStack.length === 0 || !activeSessionId) return null;
    const last = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));
    setSessions(prev => {
      const u = prev.map(s => { if (s.id !== activeSessionId) return s; const m = { ...s.measurements }; delete m[last]; return { ...s, measurements: m }; });
      if (!userId) saveLocal(u); else syncToCloud(u, activeSessionId);
      return u;
    });
    return last;
  }, [activeSessionId, undoStack, userId, syncToCloud]);

  const clearAllMeasurements = useCallback(() => {
    if (!activeSessionId) return;
    setSessions(prev => { const u = prev.map(s => s.id === activeSessionId ? { ...s, measurements: {} } : s); if (!userId) saveLocal(u); else syncToCloud(u, activeSessionId); return u; });
    setUndoStack([]);
  }, [activeSessionId, userId, syncToCloud]);

  const renameSession = useCallback(async (id: string, name: string) => {
    setSessions(prev => { const u = prev.map(s => s.id === id ? { ...s, name } : s); if (!userId) saveLocal(u); return u; });
    if (userId) await supabase.from('tuning_sessions').update({ name }).eq('id', id).eq('user_id', userId);
  }, [userId]);

  const importSession = useCallback((session: TuningSession) => {
    const newSession = { ...session, id: session.id + "_" + Date.now().toString(36) };
    setSessions(prev => { const u = [newSession, ...prev]; if (!userId) saveLocal(u); return u; });
    setActiveSessionId(newSession.id);
    return newSession;
  }, [userId]);

  const chartData = PIANO_KEYS.map((key, i) => {
    const m = activeSession?.measurements[i];
    // 우선순위: 스트로브(cents) > 자동 피치 참고값(autoCentsRef)
    const mainCents = m
      ? (m.cents !== 0 ? m.cents : (m.autoCentsRef ?? null))
      : null;
    return { keyNumber: key.keyNumber, keyIndex: i, noteName: key.noteName, octave: key.octave, isBlack: key.isBlack, cents: mainCents, strobeCents: m?.strobeCents ?? null, measured: !!m && mainCents !== null };
  });

  const measuredCount = activeSession ? Object.keys(activeSession.measurements).length : 0;

  return { sessions, activeSession, activeSessionId, setActiveSessionId, createSession, deleteSession, recordMeasurement, recordStrobeMeasurement, undoLastMeasurement, undoStack, clearAllMeasurements, renameSession, importSession, chartData, measuredCount };
}
