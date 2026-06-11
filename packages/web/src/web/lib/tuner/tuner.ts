/**
 * tuner.ts - 핵심 튜너 라이브러리 (통합)
 * 88건반 데이터, YIN 피치 감지, PT-100 허용 범위
 */

// ─── 88건반 피아노 키 ───
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

export interface PianoKey {
  midi: number; keyNumber: number; noteName: string;
  octave: number; freq: number; isBlack: boolean;
}

export const PIANO_KEYS: PianoKey[] = Array.from({ length: 88 }, (_, i) => {
  const midi = i + 21;
  const octave = Math.floor(midi / 12) - 1;
  const noteName = NOTE_NAMES[midi % 12];
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const isBlack = [1,3,6,8,10].includes(midi % 12);
  return { midi, keyNumber: i + 1, noteName, octave, freq, isBlack };
});

// ─── PT-100 허용 범위 ───
export const UPPER_ABS = [-9,-8,-7,-6,-6,-5,-4,-4,-3,-3,-2,-2,-1,-1,0,0,0,0,1,1,1,1,2,2,2,2,2,2,2,3,3,3,3,3,3,3,3,4,4,4,4,4,4,4,4,4,5,5,5,5,5,5,6,6,6,6,6,6,7,7,7,7,7,8,8,8,9,9,10,10,11,12,13,15,17,18,20,21,23,25,26,28,30,32,34,37,39,41];
export const LOWER_ABS = [-33,-32,-30,-29,-27,-25,-24,-22,-20,-19,-18,-17,-16,-15,-14,-13,-13,-12,-11,-11,-11,-10,-10,-10,-10,-9,-9,-9,-9,-9,-9,-9,-9,-9,-9,-9,-9,-8,-8,-8,-8,-8,-8,-8,-8,-8,-7,-7,-7,-7,-7,-7,-7,-7,-7,-7,-7,-7,-6,-6,-6,-6,-6,-5,-5,-5,-5,-5,-4,-4,-4,-3,-2,-2,-1,0,1,1,2,3,4,6,7,9,11,13,15,17];

export function isInRange(keyIndex: number, cents: number): boolean {
  return cents >= LOWER_ABS[keyIndex] && cents <= UPPER_ABS[keyIndex];
}

// ─── 주파수 → 센트 변환 ───
export interface CentResult { keyIndex: number; cents: number; }

export function freqToCentOffset(freq: number): CentResult | null {
  if (freq <= 0) return null;
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const midiRound = Math.round(midiFloat);
  const keyIndex = midiRound - 21;
  if (keyIndex < 0 || keyIndex > 87) return null;
  return { keyIndex, cents: (midiFloat - midiRound) * 100 };
}

export function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function correctOctaveError(detected: number, ref: number | null): number {
  if (ref === null) return detected;
  const d = detected - ref;
  if (d === 12 || d === -12 || d === 24 || d === -24) return ref;
  return detected;
}

// ─── YIN 피치 감지 ───
export function detectPitchYIN(buf: Float32Array, sr: number): number {
  const half = Math.floor(buf.length / 2);
  const yin = new Float32Array(half);
  for (let tau = 0; tau < half; tau++) {
    let s = 0;
    for (let i = 0; i < half; i++) { const d = buf[i] - buf[i + tau]; s += d * d; }
    yin[tau] = s;
  }
  yin[0] = 1;
  let rs = 0;
  for (let tau = 1; tau < half; tau++) { rs += yin[tau]; yin[tau] *= tau / rs; }
  const thr = 0.15;
  let tau = 2;
  while (tau < half) {
    if (yin[tau] < thr) { while (tau + 1 < half && yin[tau + 1] < yin[tau]) tau++; break; }
    tau++;
  }
  if (tau === half || yin[tau] >= thr) return -1;
  let bt = tau;
  if (tau > 0 && tau < half - 1) {
    const s0 = yin[tau-1], s1 = yin[tau], s2 = yin[tau+1];
    bt = tau + (s2 - s0) / (2 * (2*s1 - s2 - s0));
  }
  return sr / bt;
}

export function getRMS(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// ─── 피치 결과 ───
export interface PitchResult {
  frequency: number; keyIndex: number; noteName: string;
  octave: number; cents: number; confidence: number; rms: number;
}
