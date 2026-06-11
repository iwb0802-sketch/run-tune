/**
 * TuningCurveChart.tsx
 * Design: Technical Minimalism / Professional Instrument
 *
 * 그래프 내부 줌/패닝:
 * - 마우스 휠: X축 줌인/아웃 (그래프 내부만)
 * - 터치 핀치: X축 줌인/아웃
 * - 마우스/터치 드래그: 좌우 패닝
 * - 리셋 버튼: 전체 보기로 복귀
 */

import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import { RAILSBACK, UPPER_TOL, LOWER_TOL, UPPER_ABS, LOWER_ABS } from "@/lib/tuner/tuningCurveData";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface ChartDataPoint {
  keyNumber: number;
  keyIndex: number;
  noteName: string;
  octave: number;
  isBlack: boolean;
  cents: number | null;        // 자동 피치 값
  strobeCents?: number | null; // 스트로브 값
  measured: boolean;
}

interface TuningCurveChartProps {
  data: ChartDataPoint[];
  activeKeyIndex?: number | null;
  showStrobeOnly?: boolean;
}

// 허용 범위 데이터는 tuningCurveData.ts에서 import

const A_INDICES = PIANO_KEYS
  .map((k, i) => ({ ...k, i }))
  .filter(k => k.noteName === "A")
  .map(k => k.i);

export default function TuningCurveChart({ data, activeKeyIndex, showStrobeOnly = false }: TuningCurveChartProps) {
  const SVG_W = 960;
  const SVG_H = 480;
  const PAD = { top: 30, right: 52, bottom: 110, left: 48 };
  const PW = SVG_W - PAD.left - PAD.right;
  const PH = SVG_H - PAD.top - PAD.bottom;
  const Y_MIN = -40;
  const Y_MAX = 40;
  const Y_RANGE = Y_MAX - Y_MIN;

  // 줌/패닝 상태: xStart(0~1), xEnd(0~1) — 보이는 X 범위
  const [xView, setXView] = useState({ start: 0, end: 1 });
  const [viewMode, setViewMode] = useState<'all' | 'strobe'>('all');
  const isZoomed = xView.start > 0.001 || xView.end < 0.999;

  // 드래그 상태
  const dragRef = useRef<{ startX: number; startView: { start: number; end: number } } | null>(null);
  // 핀치 상태
  const pinchRef = useRef<{ dist: number; midX: number; startView: { start: number; end: number } } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // SVG 픽셀 → 정규화 X (0~1)
  const pxToNorm = useCallback((clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const svgX = ((clientX - rect.left) / rect.width) * SVG_W - PAD.left;
    return Math.max(0, Math.min(1, svgX / PW));
  }, []);

  // 줌 적용 (중심점 기준)
  const applyZoom = useCallback((factor: number, centerNorm: number) => {
    setXView(prev => {
      const span = prev.end - prev.start;
      const newSpan = Math.max(0.05, Math.min(1, span * factor)); // 최소 5%, 최대 100%
      // 중심점 유지
      const centerInView = (centerNorm - prev.start) / span;
      let newStart = centerNorm - centerInView * newSpan;
      let newEnd = newStart + newSpan;
      if (newStart < 0) { newStart = 0; newEnd = newSpan; }
      if (newEnd > 1) { newEnd = 1; newStart = 1 - newSpan; }
      return { start: newStart, end: newEnd };
    });
  }, []);

  // 마우스 휠
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.15 : 0.87;
    const centerNorm = pxToNorm(e.clientX);
    applyZoom(factor, centerNorm);
  }, [pxToNorm, applyZoom]);

  // 마우스 드래그
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: pxToNorm(e.clientX), startView: xView };
  }, [pxToNorm, xView]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return;
    const dx = pxToNorm(e.clientX) - dragRef.current.startX;
    const span = dragRef.current.startView.end - dragRef.current.startView.start;
    let newStart = dragRef.current.startView.start - dx;
    let newEnd = newStart + span;
    if (newStart < 0) { newStart = 0; newEnd = span; }
    if (newEnd > 1) { newEnd = 1; newStart = 1 - span; }
    setXView({ start: newStart, end: newEnd });
  }, [pxToNorm]);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // 터치 핀치 + 드래그
  const getTouchDist = (t: React.TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const getTouchMidX = (t: React.TouchList) => (t[0].clientX + t[1].clientX) / 2;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchRef.current = {
        dist: getTouchDist(e.touches),
        midX: pxToNorm(getTouchMidX(e.touches)),
        startView: xView,
      };
      dragRef.current = null;
    } else if (e.touches.length === 1) {
      dragRef.current = { startX: pxToNorm(e.touches[0].clientX), startView: xView };
      pinchRef.current = null;
    }
  }, [pxToNorm, xView]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2 && pinchRef.current) {
      const newDist = getTouchDist(e.touches);
      const factor = pinchRef.current.dist / newDist;
      const midNorm = pxToNorm(getTouchMidX(e.touches));
      const span = pinchRef.current.startView.end - pinchRef.current.startView.start;
      const newSpan = Math.max(0.05, Math.min(1, span * factor));
      const centerInView = (midNorm - pinchRef.current.startView.start) / span;
      let newStart = midNorm - centerInView * newSpan;
      let newEnd = newStart + newSpan;
      if (newStart < 0) { newStart = 0; newEnd = newSpan; }
      if (newEnd > 1) { newEnd = 1; newStart = 1 - newSpan; }
      setXView({ start: newStart, end: newEnd });
    } else if (e.touches.length === 1 && dragRef.current) {
      const dx = pxToNorm(e.touches[0].clientX) - dragRef.current.startX;
      const span = dragRef.current.startView.end - dragRef.current.startView.start;
      let newStart = dragRef.current.startView.start - dx;
      let newEnd = newStart + span;
      if (newStart < 0) { newStart = 0; newEnd = span; }
      if (newEnd > 1) { newEnd = 1; newStart = 1 - span; }
      setXView({ start: newStart, end: newEnd });
    }
  }, [pxToNorm]);

  const handleTouchEnd = useCallback(() => {
    dragRef.current = null;
    pinchRef.current = null;
  }, []);

  // 전역 mousemove/mouseup 등록
  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // SVG에 wheel 이벤트 (passive:false 필요)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // ── 좌표 변환 ──
  // SVG 자체를 넓히서 확대하므로 xOf는 단순 비례 좌표
  const xOf = useCallback((ki: number) => {
    return (ki / 87) * PW;
  }, []);

  const yOf = (c: number) => PH - ((c - Y_MIN) / Y_RANGE) * PH;

  // 보이는 건반 범위 - SVG 전체 확대 방식이므로 항상 전체 범위
  const visStart = 0;
  const visEnd = 87;

  // 허용 커브 (계단식)
  const stepPath = useMemo(() => {
    const upper: string[] = [];
    const lower: string[] = [];
    for (let i = visStart; i <= visEnd; i++) {
      const x0 = xOf(i);
      const x1 = i < 87 ? xOf(i + 1) : xOf(87);
      const yu = yOf(UPPER_ABS[i]);
      const yl = yOf(LOWER_ABS[i]);
      if (i === visStart) {
        upper.push(`M ${x0.toFixed(1)} ${yu.toFixed(1)}`);
        lower.push(`M ${x0.toFixed(1)} ${yl.toFixed(1)}`);
      } else {
        const prevYu = yOf(UPPER_ABS[i - 1]);
        const prevYl = yOf(LOWER_ABS[i - 1]);
        upper.push(`L ${x0.toFixed(1)} ${prevYu.toFixed(1)} L ${x0.toFixed(1)} ${yu.toFixed(1)}`);
        lower.push(`L ${x0.toFixed(1)} ${prevYl.toFixed(1)} L ${x0.toFixed(1)} ${yl.toFixed(1)}`);
      }
      upper.push(`L ${x1.toFixed(1)} ${yu.toFixed(1)}`);
      lower.push(`L ${x1.toFixed(1)} ${yl.toFixed(1)}`);
    }
    return { upper: upper.join(" "), lower: lower.join(" ") };
  }, [visStart, visEnd, xOf]);

  // Y축 눈금
  const yMajor = [-40,-30,-20,-10,0,10,20,30,40];
  const yMinor: number[] = [];
  for (let c = -40; c <= 40; c += 2) { if (!yMajor.includes(c)) yMinor.push(c); }

  // X축 레이블 (보이는 범위 내)
  const xLabels = [1,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,88].filter(kn => {
    const norm = (kn - 1) / 87;
    return norm >= xView.start - 0.02 && norm <= xView.end + 0.02;
  });

  // 피아노 건반
  const KB_H = 32;
  const KB_TOP = PH + 14;
  const WK_W = PW / (52 * (xView.end - xView.start)); // 줌에 따라 넓어짐

  const whiteKeyPositions: { ki: number; x: number }[] = [];
  let wIdx = 0;
  for (let i = 0; i < 88; i++) {
    if (!PIANO_KEYS[i].isBlack) {
      whiteKeyPositions.push({ ki: i, x: wIdx * (PW / 52) });
      wIdx++;
    }
  }

  const blackKeyPositions: { ki: number; x: number }[] = [];
  for (let i = 0; i < 88; i++) {
    if (PIANO_KEYS[i].isBlack) {
      const prevWhite = [...whiteKeyPositions].reverse().find(w => w.ki < i);
      if (prevWhite) blackKeyPositions.push({ ki: i, x: prevWhite.x + (PW / 52) * 0.65 });
    }
  }

  // 건반 X → 뷰 좌표 (SVG 전체 확대 방식에서는 같음)
  const keyXInView = (rawX: number) => rawX;

  return (
    <div className="w-full relative select-none overflow-x-auto">
      {/* 전체보기 + 힌트 */}
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <span className="text-xs text-gray-300">
          {isZoomed ? `${Math.round(1 / (xView.end - xView.start))}× 확대 중` : "휘/핀치로 확대"}
        </span>
        {isZoomed && (
          <button
            onClick={() => setXView({ start: 0, end: 1 })}
            className="flex items-center gap-1 px-2.5 py-1 bg-muted border border-border rounded-lg text-xs text-muted-foreground hover:bg-muted/80 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            전체 보기
          </button>
        )}
      </div>

      {/* SVG 전체를 zoom에 따라 넓히 렌더링 → Y축 눈금도 함께 커짐 */}
      {/* 확대 시는 컨테이너 스크롤로 좌우 이동, 핀치로 확대 */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="block"
        style={{
          width: `${Math.round(100 / (xView.end - xView.start))}%`,
          minWidth: 320,
          fontFamily: "'JetBrains Mono', monospace",
          // 확대 시는 스크롤 허용, 전체 보기에서는 핀치만 작동
          touchAction: isZoomed ? "pan-x" : "none",
          cursor: isZoomed ? "default" : "grab",
        }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={(e) => {
          // 핀치(2손가락)일 때만 기본 스크롤 막고 줌 적용
          if (e.touches.length === 2) {
            e.preventDefault();
            handleTouchMove(e);
          }
          // 1손가락 드래그는 확대 시 컨테이너 스크롤로 처리
          else if (!isZoomed) {
            handleTouchMove(e);
          }
        }}
        onTouchEnd={handleTouchEnd}
      >
        <rect width={SVG_W} height={SVG_H} fill="white" />

        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* 클리핑 마스크 */}
          <defs>
            <clipPath id="plotClip">
              <rect x={0} y={-PAD.top} width={PW} height={SVG_H} />
            </clipPath>
          </defs>

          {/* 소격자 수평 */}
          {yMinor.map(c => (
            <line key={`ym${c}`} x1={0} y1={yOf(c)} x2={PW} y2={yOf(c)} stroke="#d1d5db" strokeWidth={0.3} />
          ))}

          {/* 소격자 수직 (보이는 범위만) */}
          <g clipPath="url(#plotClip)">
            {Array.from({ length: 88 }, (_, i) => {
              const x = xOf(i);
              if (x < -5 || x > PW + 5) return null;
              return <line key={`xm${i}`} x1={x} y1={0} x2={x} y2={PH} stroke="#e5e7eb" strokeWidth={0.25} />;
            })}
          </g>

          {/* 대격자 수평 */}
          {yMajor.map(c => (
            <line key={`yM${c}`} x1={0} y1={yOf(c)} x2={PW} y2={yOf(c)}
              stroke={c === 0 ? "#374151" : "#9ca3af"} strokeWidth={c === 0 ? 1.2 : 0.6} />
          ))}

          {/* 테두리 */}
          <rect x={0} y={0} width={PW} height={PH} fill="none" stroke="#374151" strokeWidth={1} />

          {/* 허용 커브 */}
          <g clipPath="url(#plotClip)">
            <path d={stepPath.upper} fill="none" stroke="#1f2937" strokeWidth={1.4} />
            <path d={stepPath.lower} fill="none" stroke="#1f2937" strokeWidth={1.4} />
          </g>

          {/* Y축 왼쪽 */}
          {yMajor.map(c => (
            <g key={`yl${c}`}>
              <line x1={-4} y1={yOf(c)} x2={0} y2={yOf(c)} stroke="#374151" strokeWidth={1} />
              <text x={-7} y={yOf(c) + 3.5} textAnchor="end" fontSize={9} fill="#374151">
                {c > 0 ? `+${c}` : c}
              </text>
            </g>
          ))}
          {yMinor.map(c => (
            <line key={`ylt${c}`} x1={-2} y1={yOf(c)} x2={0} y2={yOf(c)} stroke="#6b7280" strokeWidth={0.6} />
          ))}

          {/* Y축 오른쪽 */}
          {yMajor.map(c => (
            <g key={`yr${c}`}>
              <line x1={PW} y1={yOf(c)} x2={PW + 4} y2={yOf(c)} stroke="#374151" strokeWidth={1} />
              <text x={PW + 7} y={yOf(c) + 3.5} textAnchor="start" fontSize={9} fill="#374151">
                {c > 0 ? `+${c}` : c}
              </text>
            </g>
          ))}
          {yMinor.map(c => (
            <line key={`yrt${c}`} x1={PW} y1={yOf(c)} x2={PW + 2} y2={yOf(c)} stroke="#6b7280" strokeWidth={0.6} />
          ))}

          {/* X축 레이블 */}
          <g clipPath="url(#plotClip)">
            {xLabels.map(kn => (
              <text key={`xl${kn}`} x={xOf(kn - 1)} y={PH + 10} textAnchor="middle" fontSize={7.5} fill="#6b7280">{kn}</text>
            ))}
          </g>

          {/* A음 세로 구분선 (그래프 내부) */}
          <g clipPath="url(#plotClip)">
            {A_INDICES.map(ki => (
              <line key={`av${ki}`}
                x1={xOf(ki)} y1={0} x2={xOf(ki)} y2={PH}
                stroke="#94a3b8" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.7}
              />
            ))}
          </g>

          {/* 상단 A음 마커 */}
          <g clipPath="url(#plotClip)">
            {A_INDICES.map(ki => {
              const x = xOf(ki);
              return (
                <g key={`a${ki}`}>
                  <line x1={x} y1={-18} x2={x} y2={0} stroke="#374151" strokeWidth={1.2} />
                  <text x={x} y={-20} textAnchor="middle" fontSize={9} fill="#374151" fontWeight="700">A</text>
                </g>
              );
            })}
          </g>

          {/* 현재 감지 수직선 */}
          {activeKeyIndex != null && (
            <line x1={xOf(activeKeyIndex)} y1={0} x2={xOf(activeKeyIndex)} y2={PH}
              stroke="#ef4444" strokeWidth={1} strokeDasharray="4,3" opacity={0.6} />
          )}

          {/* 자동 피치 점 (파란/빨강) - 스트로브만 보기 모드에서는 숨김 */}
          {!showStrobeOnly && (<g clipPath="url(#plotClip)">
            {data.map(d => {
              if (d.cents === null) return null;
              const cx = xOf(d.keyIndex);
              const cy = yOf(d.cents);
              const isActive = d.keyIndex === activeKeyIndex;
              const inRange = d.cents >= LOWER_ABS[d.keyIndex] && d.cents <= UPPER_ABS[d.keyIndex];
              const fill = isActive ? "#ef4444" : inRange ? "#1e3a5f" : "#dc2626";
              const r = isActive ? 5 : 3.5;
              return (
                <circle key={`auto-${d.keyIndex}`} cx={cx} cy={cy} r={Math.min(r, 6)}
                  fill={fill} stroke={isActive ? "#fca5a5" : "none"} strokeWidth={isActive ? 2 : 0} opacity={0.92}>
                  <title>{`[자동] 건반 ${d.keyNumber} (${d.noteName}${d.octave}): ${d.cents > 0 ? "+" : ""}${d.cents.toFixed(1)}¢`}</title>
                </circle>
              );
            })}
          </g>)}

          {/* 스트로브 점 (주황 다이아몬드) - 버튼 눌렀을 때만 표시 */}
          <g clipPath="url(#plotClip)">
            {data.map(d => {
              if (!d.strobeCents) return null;
              const cx = xOf(d.keyIndex);
              const cy = yOf(d.strobeCents);
              const inRange = d.strobeCents >= LOWER_ABS[d.keyIndex] && d.strobeCents <= UPPER_ABS[d.keyIndex];
              const fill = inRange ? "#d97706" : "#f97316";
              return (
                <g key={`strobe-${d.keyIndex}`}>
                  <polygon
                    points={`${cx},${cy-5} ${cx+4.5},${cy+3} ${cx-4.5},${cy+3}`}
                    fill={fill} opacity={0.9}>
                    <title>{`[스트로브] 건반 ${d.keyNumber} (${d.noteName}${d.octave}): ${d.strobeCents > 0 ? "+" : ""}${d.strobeCents.toFixed(1)}¢`}</title>
                  </polygon>
                  {/* 자동과 스트로브 차이 선 */}
                  {d.cents !== null && (
                    <line x1={cx} y1={yOf(d.cents)} x2={cx} y2={cy}
                      stroke="#d97706" strokeWidth={0.8} strokeDasharray="2,2" opacity={0.5} />
                  )}
                </g>
              );
            })}
          </g>

          {/* 피아노 건반 (하단) */}
          <g transform={`translate(0, ${KB_TOP})`} clipPath="url(#plotClip)">
            {whiteKeyPositions.map(({ ki, x }) => {
              const vx = keyXInView(x);
              if (vx < -WK_W || vx > PW + WK_W) return null;
              const isActive = ki === activeKeyIndex;
              return (
                <rect key={`wk${ki}`} x={vx + 0.3} y={0}
                  width={Math.max(1, WK_W - 0.6)} height={KB_H}
                  fill={isActive ? "#bfdbfe" : "white"} stroke="#6b7280" strokeWidth={0.5} />
              );
            })}
            {blackKeyPositions.map(({ ki, x }) => {
              const vx = keyXInView(x);
              if (vx < -WK_W || vx > PW + WK_W) return null;
              const isActive = ki === activeKeyIndex;
              return (
                <rect key={`bk${ki}`} x={vx} y={0}
                  width={Math.max(0.5, WK_W * 0.55)} height={KB_H * 0.62}
                  fill={isActive ? "#1e40af" : "#1f2937"} rx={0.8}
                  stroke="white" strokeWidth={0.8} />
              );
            })}
            {/* 건반 번호 */}
            {xLabels.map(kn => {
              const ki = kn - 1;
              const wk = whiteKeyPositions.find(w => w.ki === ki);
              const bk = blackKeyPositions.find(b => b.ki === ki);
              const rawX = wk ? wk.x + (PW / 52) / 2 : bk ? bk.x + WK_W * 0.275 : 0;
              const vx = keyXInView(rawX);
              if (vx < 0 || vx > PW) return null;
              return (
                <text key={`kn${kn}`} x={vx} y={KB_H + 11} textAnchor="middle" fontSize={7} fill="#6b7280">{kn}</text>
              );
            })}

            {/* 피아노 건반 아래 A음 마커 + 건반 번호 */}
            {A_INDICES.map(ki => {
              const wk = whiteKeyPositions.find(w => w.ki === ki);
              if (!wk) return null;
              const vx = keyXInView(wk.x + (PW / 52) / 2);
              if (vx < 0 || vx > PW) return null;
              const keyNum = ki + 1;
              const octave = PIANO_KEYS[ki].octave;
              return (
                <g key={`ab${ki}`}>
                  {/* A 텍스트 */}
                  <text x={vx} y={KB_H + 22} textAnchor="middle" fontSize={7} fontWeight="bold" fill="#374151">A{octave}</text>
                  {/* 건반 번호 */}
                  <text x={vx} y={KB_H + 31} textAnchor="middle" fontSize={6} fill="#94a3b8">{keyNum}</text>
                  {/* 위로 선 */}
                  <line x1={vx} y1={0} x2={vx} y2={-4} stroke="#374151" strokeWidth={0.8} />
                </g>
              );
            })}
          </g>
        </g>
      </svg>


    </div>
  );
}
