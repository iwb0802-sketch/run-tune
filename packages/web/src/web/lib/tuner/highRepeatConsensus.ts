/*
 * highRepeatConsensus.ts
 *
 * 복합탭2 C6~C8(64~88번) 고음용 반복 측정 확정기.
 * 유효한 스무딩 센트값을 최소 3회 모으고, 5¢ 이내로 이어지는 가장 큰 덩어리만
 * 가중평균한다. 두 덩어리의 크기가 같으면 추가 타건을 기다린다.
 */

export interface HighRepeatSample {
  cents: number;
  capturedAt: number;
}

export interface HighRepeatConsensus {
  value: number;
  used: number;
  total: number;
  spread: number;
}

export const HIGH_REPEAT_MIN_SAMPLES = 3;
export const HIGH_REPEAT_LINK_CENTS = 5;
export const HIGH_REPEAT_MAX_SAMPLES = 12;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 센트값을 정렬한 뒤 이웃한 값의 거리가 5¢ 이하이면 같은 음역 덩어리로 묶는다.
 * 예: 20, 40, 41, 45 → [20], [40, 41, 45]
 * 예: 20, 40, 41, 20, 25 → [20, 20, 25], [40, 41]
 */
function clusterByRange(samples: HighRepeatSample[]): HighRepeatSample[][] {
  const sorted = [...samples].sort((a, b) => a.cents - b.cents);
  const clusters: HighRepeatSample[][] = [];
  let cluster: HighRepeatSample[] = [];

  for (const sample of sorted) {
    if (cluster.length === 0 || sample.cents - cluster[cluster.length - 1].cents <= HIGH_REPEAT_LINK_CENTS) {
      cluster.push(sample);
    } else {
      clusters.push(cluster);
      cluster = [sample];
    }
  }
  if (cluster.length > 0) clusters.push(cluster);
  return clusters;
}

/**
 * 한 개의 우세 덩어리만 존재하고 최소 3회가 모인 경우 가중평균을 반환한다.
 * 덩어리 중앙에서 멀수록 영향력을 줄여 가장자리에 있는 값을 완만하게 감쇠한다.
 */
export function resolveHighRepeatConsensus(samples: HighRepeatSample[]): HighRepeatConsensus | null {
  if (samples.length < HIGH_REPEAT_MIN_SAMPLES) return null;

  const clusters = clusterByRange(samples).sort((a, b) => b.length - a.length);
  const selected = clusters[0];
  if (!selected || selected.length < HIGH_REPEAT_MIN_SAMPLES) return null;
  // 두 덩어리가 팽팽하면 임의의 중간값을 만들지 않고 다음 타건을 기다린다.
  if (clusters[1] && clusters[1].length >= selected.length) return null;

  const values = selected.map((sample) => sample.cents);
  const center = median(values);
  const halfSpread = Math.max((Math.max(...values) - Math.min(...values)) / 2, 0.5);
  let numerator = 0;
  let denominator = 0;

  for (const sample of selected) {
    const normalizedDistance = (sample.cents - center) / halfSpread;
    const weight = 1 / (1 + normalizedDistance * normalizedDistance);
    numerator += sample.cents * weight;
    denominator += weight;
  }
  if (denominator <= 0) return null;

  return {
    value: Math.round((numerator / denominator) * 10) / 10,
    used: selected.length,
    total: samples.length,
    spread: Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10,
  };
}

export function appendHighRepeatSample(
  samples: HighRepeatSample[],
  sample: HighRepeatSample,
): HighRepeatSample[] {
  const next = [...samples, sample];
  return next.length > HIGH_REPEAT_MAX_SAMPLES ? next.slice(next.length - HIGH_REPEAT_MAX_SAMPLES) : next;
}
