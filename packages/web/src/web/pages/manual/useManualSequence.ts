/**
 * useManualSequence.ts
 * 수동 조율 페이지의 구간/진행 상태 훅
 *
 * 구간 (0-indexed keyIndex):
 *  - middle: 60→27 (1-indexed: 61→28, C3~A5)
 *  - lower:  26→0  (1-indexed: 27→1,  1번~C3)
 *  - upper:  61→87 (1-indexed: 62→88, A5~88번)
 */
import { useCallback, useMemo, useState } from "react";

export type ManualSection = "middle" | "lower" | "upper";

function range(start: number, endInclusive: number, step: number): number[] {
  const out: number[] = [];
  if (step > 0) {
    for (let v = start; v <= endInclusive; v += step) out.push(v);
  } else {
    for (let v = start; v >= endInclusive; v += step) out.push(v);
  }
  return out;
}

export const SECTION_ORDERS: Record<ManualSection, number[]> = {
  middle: range(60, 27, -1),
  lower: range(26, 0, -1),
  upper: range(61, 87, +1),
};

/**
 * 복합탭2 전용 순서(1-indexed):
 * - 하부: 27 → 1
 * - 중앙: 49 → 28 (내림차순)
 * - 상부: 50 → 88 (오름차순)
 */
export const COMPOSITE2_SECTION_ORDERS: Record<ManualSection, number[]> = {
  lower: range(26, 0, -1),
  middle: range(48, 27, -1),
  upper: range(49, 87, +1),
};

export const SECTION_LABELS: Record<ManualSection, string> = {
  middle: "중앙값",
  lower: "하부값",
  upper: "상부값",
};

export interface UseManualSequenceReturn {
  section: ManualSection;
  setSection: (s: ManualSection) => void;
  indexInOrder: number;
  total: number;
  targetKeyIndex: number;
  canPrev: boolean;
  canNext: boolean;
  prev: () => void;
  next: () => void;
  /** 감지된 건반으로 해당 구간과 진행 위치를 직접 이동한다. */
  goToKey: (keyIndex: number) => void;
}

export function useManualSequence(
  sectionOrders: Record<ManualSection, number[]> = SECTION_ORDERS,
): UseManualSequenceReturn {
  const [section, setSectionState] = useState<ManualSection>("middle");
  // 각 구간별 진행 인덱스 보관
  const [indices, setIndices] = useState<Record<ManualSection, number>>({
    middle: 0,
    lower: 0,
    upper: 0,
  });

  const order = sectionOrders[section];
  const indexInOrder = indices[section];
  const targetKeyIndex = order[indexInOrder];
  const total = order.length;

  const setSection = useCallback((s: ManualSection) => {
    setSectionState(s);
  }, []);

  const prev = useCallback(() => {
    setIndices((prev) => ({
      ...prev,
      [section]: Math.max(0, prev[section] - 1),
    }));
  }, [section, sectionOrders]);

  const next = useCallback(() => {
    setIndices((prev) => ({
      ...prev,
      [section]: Math.min(sectionOrders[section].length - 1, prev[section] + 1),
    }));
  }, [section, sectionOrders]);

  const goToKey = useCallback((keyIndex: number) => {
    for (const candidateSection of Object.keys(sectionOrders) as ManualSection[]) {
      const candidateIndex = sectionOrders[candidateSection].indexOf(keyIndex);
      if (candidateIndex < 0) continue;
      setSectionState(candidateSection);
      setIndices((prev) => ({ ...prev, [candidateSection]: candidateIndex }));
      return;
    }
  }, [sectionOrders]);

  return useMemo(
    () => ({
      section,
      setSection,
      indexInOrder,
      total,
      targetKeyIndex,
      canPrev: indexInOrder > 0,
      canNext: indexInOrder < total - 1,
      prev,
      next,
      goToKey,
    }),
    [section, setSection, indexInOrder, total, targetKeyIndex, prev, next, goToKey]
  );
}
