/**
 * recommendedCurve.ts
 * A4 실측값을 기준점으로 삼아 88건반 추천 센트값을 만든다.
 *
 * - 기준선은 PT-100 허용범위의 중앙값(RAILSBACK).
 * - A4(49번 건반)를 실제로 재서 -2.0¢가 나오면 중앙값 전체를 -2.0¢ 평행이동한 값이 추천값이 된다.
 *   A4가 +3.0¢면 전체가 +3.0¢ 올라간다. (RAILSBACK[48] 자체가 0이 아니어도
 *   A4 지점에서 추천값 == 실측 A4가 되도록 오프셋을 잡는다.)
 */

import { RAILSBACK } from "./tuningCurveData";

/** A4 = 49번 건반 = keyIndex 48 */
export const A4_KEY_INDEX = 48;

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A4 실측 센트값 → 커브 오프셋.
 * A4 지점의 추천값이 실측 A4와 정확히 일치하도록 중앙값과의 차이를 오프셋으로 쓴다.
 */
export function offsetFromA4(a4Cents: number): number {
  return round1(a4Cents - RAILSBACK[A4_KEY_INDEX]);
}

/** 오프셋이 적용된 건반별 추천 센트값 */
export function recommendedCentsAt(keyIndex: number, offset: number): number | null {
  if (keyIndex < 0 || keyIndex > 87) return null;
  return round1(RAILSBACK[keyIndex] + offset);
}

/** 88건반 추천 커브 전체 */
export function buildRecommendedCurve(offset: number): number[] {
  return RAILSBACK.map((c) => round1(c + offset));
}
