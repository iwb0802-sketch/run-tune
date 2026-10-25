import { useEffect, useRef } from "react";

export type WatchSection = "middle" | "lower" | "upper";

export interface WatchState {
  section: WatchSection;
  canChangeSection: boolean;
  keyIndex: number;
  keyNumber: number;
  note: string;
  liveCents: number | null;
  finalCents: number | null;
  recommendedCents: number | null;
  deviation: number | null;
  listening: boolean;
  canPrev: boolean;
  canNext: boolean;
  /** AUTO 자동 건반 판별 중이면 워치에서 건반/구간을 바꾸지 않는다. */
  autoTarget: boolean;
  /** 현재 세션의 A4(49번) 등록값. 워치 추천값 기준. */
  a4Cents: number | null;
  /** 로그인 계정 ID. 워치는 이 값만으로 활성화하지 않고 서버 검증을 따로 요청한다. */
  account: string | null;
  /** 휴대폰 "현재 책정된 센트값"(새 책정값 → 이전 등록값 → 최근 등록값). */
  assignedCents?: number | null;
  assignedLabel?: string;
  assignedKeyNumber?: number;
  assignedNote?: string;
}

export interface WatchActions {
  prev: () => void;
  next: () => void;
  setSection: (section: WatchSection) => void;
  goToKey: (keyIndex: number) => void;
  /** 현재 Supabase 세션 access token. 네이티브 앱이 서버에 검증만 하고 저장/워치 전송하지 않는다. */
  getAccessToken: () => Promise<string | null>;
  /** 복합2 구간별 건반 순서. */
  sectionOrders: Record<WatchSection, number[]>;
}

declare global {
  interface Window {
    RunTuneWatch?: { postMessage: (message: string) => void };
  }
}

export const WATCH_PROTOCOL = 3;

/** Native WebView bridge only. No server, mic, or detection changes. */
export function useWatchBridge(enabled: boolean, state: WatchState, actions: WatchActions) {
  const current = useRef({ state, actions });
  current.current = { state, actions };
  useEffect(() => {
    if (!enabled) return;
    const send = (message: unknown) => window.RunTuneWatch?.postMessage(JSON.stringify(message));
    const publish = () => send({ type: "state", ...current.current.state, sentAt: Date.now(), protocol: WATCH_PROTOCOL });
    const seen = new Set<string>();
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || typeof detail.id !== "string" || detail.id.length < 1 || detail.id.length > 80) return;
      if (seen.has(detail.id)) return;
      seen.add(detail.id);
      if (seen.size > 100) seen.delete(seen.values().next().value!);
      const { state: s, actions: a } = current.current;

      if (detail.action === "activate") {
        // 토큰은 이 앱의 네이티브 브리지로만 전달한다(일반 브라우저에는 RunTuneWatch가 없다).
        const id = detail.id;
        a.getAccessToken()
          .then((token) => send({ type: "auth", id, accessToken: typeof token === "string" && token.length < 6000 ? token : null }))
          .catch(() => send({ type: "auth", id, accessToken: null }));
        return;
      }

      const validSection = ["middle", "lower", "upper"].includes(detail.section);
      const free = s.canChangeSection && !s.autoTarget;
      let allowed = false;
      if (detail.action === "prev") allowed = free && s.canPrev;
      else if (detail.action === "next") allowed = free && s.canNext;
      else if (detail.action === "section") allowed = free && validSection && detail.section !== s.section;
      else if (detail.action === "goto") {
        allowed = free && validSection && Number.isInteger(detail.keyIndex)
          && a.sectionOrders[detail.section as WatchSection].includes(detail.keyIndex);
      }
      if (allowed) {
        if (detail.action === "prev") a.prev();
        else if (detail.action === "next") a.next();
        else if (detail.action === "section") a.setSection(detail.section);
        else if (detail.section !== s.section || detail.keyIndex !== s.keyIndex) a.goToKey(detail.keyIndex);
      }
      send({ type: "ack", id: detail.id, accepted: allowed });
    };
    window.addEventListener("runtune-watch-command", onCommand);
    publish();
    const timer = window.setInterval(publish, 250);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("runtune-watch-command", onCommand);
      send({ type: "state", listening: false, unavailable: true, sentAt: Date.now(), protocol: WATCH_PROTOCOL });
    };
  }, [enabled]);
}
