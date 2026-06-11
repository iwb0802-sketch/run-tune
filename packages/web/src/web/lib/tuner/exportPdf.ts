/**
 * exportPdf.ts
 * 조율 커브 그래프를 PT-100 출력물 형식의 PDF로 내보내기
 * SVG → Canvas → PDF (jsPDF 없이 window.print 방식 사용)
 */

import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import { RAILSBACK, UPPER_TOL, LOWER_TOL, UPPER_ABS, LOWER_ABS } from "@/lib/tuner/tuningCurveData";

const A_INDICES = PIANO_KEYS
  .map((k, i) => ({ ...k, i }))
  .filter(k => k.noteName === "A")
  .map(k => k.i);

interface Measurement {
  keyIndex: number;
  cents: number;
  frequency: number;
  measuredAt: number;
}

// 그래프 Canvas 생성 (PDF와 이미지 공통)
function buildGraphCanvas(
  sessionName: string,
  userName: string,
  measurements: Record<number, Measurement>
): HTMLCanvasElement {
  // Canvas로 그래프 그리기
  const canvas = document.createElement("canvas");
  const DPR = 2;
  const W = 1100, H = 620;  // 가로 A4 비율
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.scale(DPR, DPR);

  const PAD = { top: 40, right: 60, bottom: 100, left: 55 };
  const PW = W - PAD.left - PAD.right;
  const PH = H - PAD.top - PAD.bottom;
  const Y_MIN = -40, Y_MAX = 40, Y_RANGE = 80;

  const xOf = (ki: number) => (ki / 87) * PW;
  const yOf = (c: number) => PH - ((c - Y_MIN) / Y_RANGE) * PH;

  // 배경
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(PAD.left, PAD.top);

  // 소격자 수평 (2센트)
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 0.3;
  for (let c = -40; c <= 40; c += 2) {
    if (c % 10 === 0) continue;
    ctx.beginPath(); ctx.moveTo(0, yOf(c)); ctx.lineTo(PW, yOf(c)); ctx.stroke();
  }

  // 소격자 수직
  for (let i = 0; i < 88; i++) {
    ctx.beginPath(); ctx.moveTo(xOf(i), 0); ctx.lineTo(xOf(i), PH); ctx.stroke();
  }

  // 대격자 수평 (10센트)
  for (let c = -40; c <= 40; c += 10) {
    ctx.strokeStyle = c === 0 ? "#374151" : "#9ca3af";
    ctx.lineWidth = c === 0 ? 1.2 : 0.6;
    ctx.beginPath(); ctx.moveTo(0, yOf(c)); ctx.lineTo(PW, yOf(c)); ctx.stroke();
  }

  // 테두리
  ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, PW, PH);

  // 허용 커브 (계단식)
  ctx.strokeStyle = "#1f2937"; ctx.lineWidth = 1.4;
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    for (let i = 0; i < 88; i++) {
      const absVal = pass === 0 ? UPPER_ABS[i] : LOWER_ABS[i];
      const prevAbsVal = i > 0 ? (pass === 0 ? UPPER_ABS[i-1] : LOWER_ABS[i-1]) : absVal;
      const x0 = xOf(i), x1 = i < 87 ? xOf(i + 1) : xOf(87);
      const y = yOf(absVal);
      if (i === 0) { ctx.moveTo(x0, y); }
      else {
        const prevY = yOf(prevAbsVal);
        ctx.lineTo(x0, prevY); ctx.lineTo(x0, y);
      }
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
  }

  // Y축 왼쪽/오른쪽 눈금
  ctx.fillStyle = "#374151";
  ctx.font = "10px 'JetBrains Mono', monospace";
  for (let c = -40; c <= 40; c += 10) {
    const y = yOf(c);
    const label = c > 0 ? `+${c}` : `${c}`;
    ctx.textAlign = "right"; ctx.fillText(label, -6, y + 3.5);
    ctx.textAlign = "left"; ctx.fillText(label, PW + 6, y + 3.5);
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-4, y); ctx.lineTo(0, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PW, y); ctx.lineTo(PW + 4, y); ctx.stroke();
  }

  // A음 마커
  ctx.fillStyle = "#374151"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
  A_INDICES.forEach(ki => {
    const x = xOf(ki);
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x, -18); ctx.lineTo(x, 0); ctx.stroke();
    ctx.fillText("A", x, -20);
  });

  // X축 레이블
  ctx.fillStyle = "#6b7280"; ctx.font = "8px monospace"; ctx.textAlign = "center";
  [1,10,20,30,40,50,60,70,80,88].forEach(kn => {
    ctx.fillText(`${kn}`, xOf(kn - 1), PH + 12);
  });

  // 측정 점 (우선순위: strobeCents > cents > autoCentsRef)
  Object.values(measurements).forEach((m: any) => {
    const effective =
      typeof m.strobeCents === "number" ? m.strobeCents
      : (typeof m.cents === "number" && m.cents !== 0) ? m.cents
      : (typeof m.autoCentsRef === "number") ? m.autoCentsRef
      : null;
    if (effective === null) return;
    const cx = xOf(m.keyIndex);
    const cy = yOf(effective);
    const inRange = effective >= LOWER_ABS[m.keyIndex] && effective <= UPPER_ABS[m.keyIndex];
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = inRange ? "#1e3a5f" : "#dc2626";
    ctx.fill();
    // 스트로브 평균 별도 마커(주황 삼각형)
    if (typeof m.strobeCents === "number" && m.strobeCents !== effective) {
      const sy = yOf(m.strobeCents);
      ctx.fillStyle = "#ea7a1f";
      ctx.beginPath();
      ctx.moveTo(cx, sy - 4);
      ctx.lineTo(cx - 4, sy + 3);
      ctx.lineTo(cx + 4, sy + 3);
      ctx.closePath();
      ctx.fill();
    }
  });

  // 피아노 건반 (하단)
  const KB_TOP = PH + 16;
  const KB_H = 28;
  const WK_W = PW / 52;
  const whiteKeys: { ki: number; x: number }[] = [];
  let wi = 0;
  for (let i = 0; i < 88; i++) {
    if (!PIANO_KEYS[i].isBlack) { whiteKeys.push({ ki: i, x: wi * WK_W }); wi++; }
  }
  const blackKeys: { ki: number; x: number }[] = [];
  for (let i = 0; i < 88; i++) {
    if (PIANO_KEYS[i].isBlack) {
      const pw = [...whiteKeys].reverse().find(w => w.ki < i);
      if (pw) blackKeys.push({ ki: i, x: pw.x + WK_W * 0.65 });
    }
  }
  whiteKeys.forEach(({ x }) => {
    ctx.fillStyle = "white"; ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 0.5;
    ctx.fillRect(x + 0.3, KB_TOP, WK_W - 0.6, KB_H);
    ctx.strokeRect(x + 0.3, KB_TOP, WK_W - 0.6, KB_H);
  });
  blackKeys.forEach(({ x }) => {
    ctx.fillStyle = "#1f2937";
    ctx.fillRect(x, KB_TOP, WK_W * 0.55, KB_H * 0.62);
  });

  ctx.restore();

  // 하단 정보
  ctx.fillStyle = "#374151";
  ctx.font = "bold 13px 'Noto Sans KR', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("Piano Tuning Scope", PAD.left, H - 18);
  ctx.font = "12px 'Noto Sans KR', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(sessionName, W / 2, H - 18);
  ctx.textAlign = "right";
  const dateStr = new Date().toLocaleDateString("ko-KR");
  ctx.fillText(`성명: ${userName || "___________"}   ${dateStr}`, W - PAD.right, H - 18);

  // 측정 수 표시
  const count = Object.keys(measurements).length;
  ctx.font = "10px monospace"; ctx.fillStyle = "#6b7280"; ctx.textAlign = "left";
  ctx.fillText(`측정: ${count}/88건반`, PAD.left, H - 4);

  return canvas;
}

// PDF 저장 (인쇄 창)
export function exportToPdf(
  sessionName: string,
  userName: string,
  measurements: Record<number, Measurement>
) {
  const canvas = buildGraphCanvas(sessionName, userName, measurements);
  const imgData = canvas.toDataURL("image/png", 1.0);
  const printWin = window.open("", "_blank");
  if (!printWin) { alert("팝업이 차단되었습니다. 팝업을 허용해 주세요."); return; }

  printWin.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>조율 커브 - ${sessionName}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; }
        img { width: 100%; max-width: 1100px; display: block; margin: 0 auto; }
        @page { size: A4 landscape; margin: 10mm; }
        .toolbar {
          position: fixed; top: 0; left: 0; right: 0;
          background: #1e3a5f; padding: 10px 16px;
          display: flex; gap: 10px; align-items: center;
          z-index: 999;
        }
        .btn {
          padding: 8px 20px; border: none; border-radius: 8px;
          font-size: 14px; font-weight: bold; cursor: pointer;
        }
        .btn-print { background: #3b82f6; color: white; }
        .btn-close { background: #6b7280; color: white; }
        .content { padding-top: 56px; }
        @media print {
          .toolbar { display: none; }
          .content { padding-top: 0; }
          body { margin: 0; }
          img { width: 100%; page-break-inside: avoid; }
        }
      </style>
    </head>
    <body>
      <div class="toolbar">
        <button class="btn btn-print" onclick="window.print()">PDF 저장</button>
        <button class="btn btn-close" onclick="window.close()">닫기</button>
      </div>
      <div class="content">
        <img src="${imgData}" />
      </div>
    </body>
    </html>
  `);
  printWin.document.close();
}

// 이미지(PNG) 저장
export function exportToImage(
  sessionName: string,
  userName: string,
  measurements: Record<number, Measurement>
) {
  const canvas = buildGraphCanvas(sessionName, userName, measurements);
  const imgData = canvas.toDataURL("image/png", 1.0);
  const a = document.createElement("a");
  a.href = imgData;
  a.download = `조율커브_${sessionName.replace(/\s+/g, "_")}_${new Date().toLocaleDateString("ko-KR").replace(/\./g, "").replace(/\s/g, "")}.png`;
  a.click();
}
