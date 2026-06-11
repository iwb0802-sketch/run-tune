/**
 * pitchEngine.ts
 * 야마하 PT-100 방식 피치 분석 엔진
 *
 * 핵심:
 * 1. YIN (시간영역 자기상관) → 1차 후보 주파수
 * 2. HPS 스타일 옵타브 보정 (스펙트럼에서 f, f/2, f/3, f/4, f/5, f/6 후보 평가)
 * 3. PT-100식 타겟 배음 매핑 (저음=6/4배음, 중음=2배음, A3+=기본음)
 * 4. Goertzel 알고리즘 (단일 주파수 위상 추출 → 스트로브)
 */

export const A0_FREQ = 27.5;
export const A4_FREQ = 440;
export const C8_FREQ = 4186.01;

/* ---------- 윈도우 / 통계 ---------- */
export function applyHannWindow(buf: Float32Array): Float32Array {
  const N = buf.length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    out[i] = buf[i] * w;
  }
  return out;
}

export function getRMS(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------- YIN with frequency limits ---------- */
export function detectPitchYIN(
  buf: Float32Array,
  sr: number,
  fMin = 26,
  fMax = 5000,
  threshold = 0.12
): number {
  const half = Math.floor(buf.length / 2);
  const tauMin = Math.max(2, Math.floor(sr / fMax));
  const tauMax = Math.min(half - 1, Math.ceil(sr / fMin));
  const yin = new Float32Array(half);

  for (let tau = tauMin; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < half; i++) {
      const d = buf[i] - buf[i + tau];
      s += d * d;
    }
    yin[tau] = s;
  }
  // cumulative mean normalized difference
  yin[0] = 1;
  let rs = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    rs += yin[tau];
    if (rs > 0) yin[tau] *= tau / rs;
  }

  let tau = tauMin;
  while (tau <= tauMax) {
    if (yin[tau] < threshold) {
      while (tau + 1 <= tauMax && yin[tau + 1] < yin[tau]) tau++;
      break;
    }
    tau++;
  }
  if (tau > tauMax || yin[tau] >= threshold) return -1;

  // parabolic interpolation
  let bt = tau;
  if (tau > tauMin && tau < tauMax) {
    const s0 = yin[tau - 1], s1 = yin[tau], s2 = yin[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) bt = tau + (s2 - s0) / denom;
  }
  return sr / bt;
}

/* ---------- HPS 옥타브 보정 ----------
 * AnalyserNode.getFloatFrequencyData(spectrumDb) 결과를 받음.
 * fYin 주변에서 f/2, f/3, f/4 등 서브하모닉 후보를 평가.
 * 각 후보 c에 대해 점수 = Σ_{k=1..6} magLinear[round(k·c·N/sr)]
 * 가장 점수 높고 27Hz 이상인 후보 채택.
 *
 * keyIndex >= 60 (E5 이상) 은 배음이 희박해서 HPS 오탐 위험 →
 * keyIndex를 넘기면 보정 없이 fYin 그대로 반환.
 */
export function correctOctaveByHPS(
  fYin: number,
  spectrumDb: Float32Array,
  sr: number,
  fftSize: number,
  numHarmonics = 5,
  keyIndex = 0        // 건반 인덱스 (0=A0, 87=C8)
): number {
  // 고음(E5 이상, keyIndex 60+)은 HPS 보정 비활성화
  if (keyIndex >= 60) return fYin;
  if (fYin <= 0) return fYin;
  const binHz = sr / fftSize;
  const N = spectrumDb.length;

  // dB → linear magnitude (0~1 scale, no need for absolute)
  const magAt = (freq: number): number => {
    const bin = Math.round(freq / binHz);
    if (bin < 1 || bin >= N) return 0;
    // peak interpolation across 3 bins
    let maxDb = -Infinity;
    for (let d = -1; d <= 1; d++) {
      const b = bin + d;
      if (b >= 1 && b < N && spectrumDb[b] > maxDb) maxDb = spectrumDb[b];
    }
    if (maxDb === -Infinity || maxDb < -90) return 0;
    return Math.pow(10, maxDb / 20);
  };

  // 후보: f, f/2, f/3, f/4, f/5, f/6 중 27Hz 이상
  const candidates: number[] = [];
  for (let div = 1; div <= 6; div++) {
    const c = fYin / div;
    if (c >= A0_FREQ * 0.97) candidates.push(c);
  }

  const score = (c: number): number => {
    let s = 0;
    for (let k = 1; k <= numHarmonics; k++) {
      if (k * c > sr / 2) break;
      s += magAt(k * c);
    }
    return s;
  };

  const baseScore = score(fYin);
  let bestC = fYin;
  let bestS = baseScore;
  for (const c of candidates) {
    if (c === fYin) continue;
    const s = score(c);
    // 서브하모닉이 충분히 강해야 채택 (1.15배 마진)
    if (s > bestS * 1.15) {
      bestS = s;
      bestC = c;
    }
  }
  return bestC;
}

/* ---------- PT-100식 타겟 배음 매핑 (고정 fallback) ----------
 * keyIndex 0 = A0
 * 실시간 신호가 없을 때 초기값으로 사용.
 */
export function targetPartial(keyIndex: number): number {
  if (keyIndex < 0) return 1;
  if (keyIndex < 12) return 6;   // A0–G#1
  if (keyIndex < 24) return 4;   // A1–G#2
  if (keyIndex < 36) return 2;   // A2–G#3
  return 1;                       // A3 이상
}

/* ---------- 동적 배음 선택 ----------
 * 실제 버퍼에서 후보 배음(2, 4, 6)의 Goertzel magnitude를 비교해
 * 가장 강한 배음을 선택한다.
 *
 * 규칙:
 * - 후보: 해당 건반 기본음 × [2, 4, 6] 중 sr/2 이하인 것만
 * - magnitude가 fallback partial보다 MIN_GAIN_RATIO 이상 강해야 교체
 * - 결과가 sr/2 초과하면 fallback 사용
 *
 * @returns 선택된 partial 숫자 (1, 2, 4, 6 중 하나)
 */
const MIN_GAIN_RATIO = 1.3; // 후보가 기존보다 30% 이상 강해야 교체

export function selectBestPartial(
  buf: Float32Array,
  sr: number,
  keyIndex: number,
  baseFreq: number   // 해당 건반의 평균율 기본음 주파수
): number {
  const fallback = targetPartial(keyIndex);

  // 저음 구간(keyIndex 0~26)만 동적 선택 적용
  if (keyIndex > 26) return fallback;

  const candidates = [2, 4, 6].filter(p => baseFreq * p < sr / 2 && baseFreq * p > 40);

  if (candidates.length === 0) return fallback;

  let bestPartial = fallback;
  let bestMag = goertzel(buf, sr, baseFreq * fallback).magnitude;

  for (const p of candidates) {
    if (p === fallback) continue;
    const mag = goertzel(buf, sr, baseFreq * p).magnitude;
    if (mag > bestMag * MIN_GAIN_RATIO) {
      bestMag = mag;
      bestPartial = p;
    }
  }

  return bestPartial;
}

/* ---------- Goertzel: 단일 주파수 복소 응답 ----------
 * targetFreq 빈의 (real, imag) 반환 → 위상 = atan2(imag, real)
 * 매 프레임 N 곱셈만 필요.
 */
export function goertzel(
  buf: Float32Array,
  sr: number,
  targetFreq: number
): { real: number; imag: number; magnitude: number; phase: number } {
  const N = buf.length;
  const k = (N * targetFreq) / sr;
  const w = (2 * Math.PI * k) / N;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const coeff = 2 * cosW;

  let q0 = 0, q1 = 0, q2 = 0;
  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + buf[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * cosW;
  const imag = q2 * sinW;
  return {
    real,
    imag,
    magnitude: Math.sqrt(real * real + imag * imag) / N,
    phase: Math.atan2(imag, real),
  };
}

/* ---------- 위상차 → cent ----------
 * targetFreq 빈의 위상이 시간 dtSec 동안 deltaPhase만큼 변했을 때,
 * 실제 주파수는 targetFreq + deltaPhase/(2π·dtSec)
 */
export function centsFromPhaseDelta(
  prevPhase: number,
  currPhase: number,
  dtSec: number,
  targetFreq: number
): number {
  // unwrap to [-π, π]
  let dp = currPhase - prevPhase;
  while (dp > Math.PI) dp -= 2 * Math.PI;
  while (dp < -Math.PI) dp += 2 * Math.PI;
  const freqDelta = dp / (2 * Math.PI * dtSec);
  const actual = targetFreq + freqDelta;
  if (actual <= 0) return 0;
  return 1200 * Math.log2(actual / targetFreq);
}
