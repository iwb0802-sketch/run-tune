import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { PIANO_KEYS } from "@/hooks/usePitchDetector";
import type { CompositeResult } from "@/hooks/useCompositeTuner";
import type { TuningSession } from "@/hooks/useTuningSession";
import type { ManualSection, UseManualSequenceReturn } from "@/pages/manual/useManualSequence";
import TuningCurveChart from "@/components/tuner/TuningCurveChart";

type ChartData = React.ComponentProps<typeof TuningCurveChart>["data"];

export interface Composite3CentsRow extends ChartData[number] {
  frequency: number;
  measuredAt: number | null;
}

interface Composite3ConsoleProps {
  seq: UseManualSequenceReturn;
  targetKey: (typeof PIANO_KEYS)[number];
  isMeasured: boolean;
  isListening: boolean;
  result: CompositeResult | null;
  displayedLiveCents: number | null;
  displayedFinalCents: number | null;
  currentAssignedCents: number | null;
  assignedValueLabel: string;
  displayedMeasurementKey: (typeof PIANO_KEYS)[number];
  isPro: boolean;
  autoAdvance: boolean;
  onAutoAdvanceChange: (checked: boolean) => void;
  onToggleListening: () => void;
  isHighRepeatRange: boolean;
  highRepeatCount: number;
  highRepeatUsed: number | null;
  chartData: ChartData;
  centsTableRows: Composite3CentsRow[];
  showCentsTable: boolean;
  onToggleCentsTable: () => void;
  measuredCount: number;
  undoAvailable: boolean;
  onUndo: () => void;
  sessions: TuningSession[];
  activeSession: TuningSession | null;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  userName: string;
  onUserNameChange: (value: string) => void;
  onExportPdf: () => void;
  onExportImage: () => void;
  error: string | null;
}

const SECTION_META: Record<ManualSection, { code: string; title: string; range: string; description: string }> = {
  middle: { code: "M", title: "CENTRAL", range: "49 → 28", description: "중앙 음역" },
  lower: { code: "L", title: "LOW", range: "27 → 1", description: "저음 음역" },
  upper: { code: "H", title: "HIGH", range: "50 → 88", description: "고음 음역" },
};

function centsTone(cents: number | null) {
  if (cents === null) return "text-slate-600";
  if (Math.abs(cents) <= 2) return "text-[#73f7cf]";
  if (Math.abs(cents) <= 8) return "text-[#f8c76c]";
  return "text-[#fb7a8a]";
}

function formatCents(cents: number | null, fallback = "—") {
  if (cents === null) return fallback;
  return `${cents > 0 ? "+" : ""}${cents.toFixed(1)}¢`;
}

function SignalMark({ active, warn = false }: { active: boolean; warn?: boolean }) {
  return (
    <span className={cn(
      "inline-flex h-2 w-2 rounded-full",
      active ? warn ? "bg-[#f8c76c]" : "bg-[#73f7cf] shadow-[0_0_12px_rgba(115,247,207,0.9)]" : "bg-slate-700"
    )} />
  );
}

export default function Composite3Console({
  seq,
  targetKey,
  isMeasured,
  isListening,
  result,
  displayedLiveCents,
  displayedFinalCents,
  currentAssignedCents,
  assignedValueLabel,
  displayedMeasurementKey,
  isPro,
  autoAdvance,
  onAutoAdvanceChange,
  onToggleListening,
  isHighRepeatRange,
  highRepeatCount,
  highRepeatUsed,
  chartData,
  centsTableRows,
  showCentsTable,
  onToggleCentsTable,
  measuredCount,
  undoAvailable,
  onUndo,
  sessions,
  activeSession,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  userName,
  onUserNameChange,
  onExportPdf,
  onExportImage,
  error,
}: Composite3ConsoleProps) {
  const activeMeta = SECTION_META[seq.section];
  const currentState = !isListening
    ? "SYSTEM IDLE"
    : result?.crossValid
      ? "DUAL VERIFIED"
      : result?.isCapturing
        ? "CAPTURING"
        : result
          ? "ANALYZING"
          : "WAITING SIGNAL";
  const currentStateTone = !isListening
    ? "text-slate-400"
    : result?.crossValid
      ? "text-[#73f7cf]"
      : "text-[#f8c76c]";
  const progressPercent = ((seq.indexInOrder + 1) / seq.total) * 100;
  const currentFrequency = result?.frequency ?? targetKey.freq;

  return (
    <div className="min-h-screen bg-[#05080b] text-slate-100 selection:bg-[#73f7cf]/30" style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>
      <div className="pointer-events-none fixed inset-0 opacity-30" style={{ backgroundImage: "linear-gradient(rgba(115,247,207,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(115,247,207,0.035) 1px, transparent 1px)", backgroundSize: "28px 28px" }} />

      <header className="relative border-b border-white/10 bg-[#080f14]/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center border border-[#73f7cf]/30 bg-[#73f7cf]/10 text-[#73f7cf]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                <circle cx="12" cy="12" r="4" />
                <path d="m5.6 5.6 2.8 2.8m7.2 7.2 2.8 2.8m0-12.8-2.8 2.8M8.4 15.6l-2.8 2.8" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-black tracking-[0.16em] text-white">RUN TUNE</p>
                <span className="border border-[#73f7cf]/35 px-1.5 py-0.5 text-[9px] font-black tracking-[0.18em] text-[#73f7cf]">CONSOLE 03</span>
              </div>
              <p className="mt-0.5 text-[11px] tracking-[0.1em] text-slate-500">PRECISION PIANO TUNING SYSTEM</p>
            </div>
          </div>

          <nav className="flex max-w-full gap-1 overflow-x-auto text-xs">
            <Link to="/" className="shrink-0 border border-transparent px-3 py-2 text-slate-400 transition-colors hover:border-white/15 hover:text-white">자동</Link>
            <Link to="/manual" className="shrink-0 border border-transparent px-3 py-2 text-slate-400 transition-colors hover:border-white/15 hover:text-white">수동</Link>
            <Link to="/composite" className="shrink-0 border border-transparent px-3 py-2 text-slate-400 transition-colors hover:border-white/15 hover:text-white">복합</Link>
            <Link to="/composite2" className="shrink-0 border border-transparent px-3 py-2 text-slate-400 transition-colors hover:border-white/15 hover:text-white">복합2</Link>
            <span className="shrink-0 border border-[#73f7cf]/50 bg-[#73f7cf]/10 px-3 py-2 font-bold text-[#73f7cf]">복합3</span>
            <Link to="/reference" className="shrink-0 border border-transparent px-3 py-2 text-slate-400 transition-colors hover:border-white/15 hover:text-white">기준음</Link>
          </nav>
        </div>
      </header>

      <main className="relative mx-auto max-w-[1440px] px-4 py-4 lg:px-6 lg:py-6">
        <div className="mb-4 flex flex-col gap-3 border border-white/10 bg-[#0a1319] px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="relative grid h-11 w-11 place-items-center border border-white/10 bg-[#101f26] font-mono text-xl font-black text-[#73f7cf]">
              {targetKey.noteName}
              <span className="absolute bottom-1 right-1 text-[9px] text-slate-400">{targetKey.octave}</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <SignalMark active={isListening} warn={isListening && !result?.crossValid} />
                <span className={cn("font-mono text-xs font-bold tracking-[0.14em]", currentStateTone)}>{currentState}</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">건반 {targetKey.keyNumber} · 기준 {targetKey.freq.toFixed(2)} Hz · 분석 {currentFrequency.toFixed(2)} Hz</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="font-mono text-slate-500">RUN {String(seq.indexInOrder + 1).padStart(2, "0")} / {String(seq.total).padStart(2, "0")}</span>
            <div className="h-1.5 w-32 overflow-hidden bg-white/10"><div className="h-full bg-[#73f7cf] transition-all duration-300" style={{ width: `${progressPercent}%` }} /></div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_308px]">
          <section className="border border-white/10 bg-[#0a1319] px-3 py-3 xl:col-span-2">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-slate-500">RANGE</span>
                <div className="flex gap-1.5">
                  {(Object.keys(SECTION_META) as ManualSection[]).map((section) => {
                    const meta = SECTION_META[section];
                    const selected = seq.section === section;
                    return <button key={section} onClick={() => seq.setSection(section)} className={cn("border px-3 py-2 font-mono text-[11px] font-bold transition-colors", selected ? "border-[#73f7cf]/60 bg-[#73f7cf]/10 text-[#73f7cf]" : "border-white/10 text-slate-500 hover:border-white/30 hover:text-slate-200")}>{meta.code} · {meta.range}</button>;
                  })}
                </div>
                <span className="hidden text-xs text-slate-500 sm:inline">현재 {activeMeta.description}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select value={activeSessionId ?? ""} onChange={(event) => onSelectSession(event.target.value)} className="min-w-40 border border-white/10 bg-[#0d181f] px-3 py-2 text-xs text-slate-200 outline-none focus:border-[#73f7cf]/70"><option value="">세션 선택</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}</select>
                <button onClick={onCreateSession} className="border border-white/15 px-3 py-2 text-xs font-bold text-slate-300 transition-colors hover:border-[#73f7cf]/60 hover:text-[#73f7cf]">+ 새 세션</button>
              </div>
            </div>
          </section>

          <section className="order-3 border border-[#73f7cf]/35 bg-[#0a1319] p-3 shadow-[0_0_0_1px_rgba(115,247,207,0.04)] xl:order-4 xl:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div><p className="font-mono text-[11px] font-black tracking-[0.2em] text-[#73f7cf]">TUNING MAP · LIVE INPUT</p><p className="mt-0.5 text-xs text-slate-500">입력되는 조율 곡선 · 현재 건반을 중심으로 확인</p></div>
              <span className="border border-[#73f7cf]/30 bg-[#73f7cf]/10 px-2.5 py-1 font-mono text-xs font-black text-[#73f7cf]">{measuredCount}/88</span>
            </div>
            <div className="border border-white/10 bg-white"><TuningCurveChart data={chartData} activeKeyIndex={seq.targetKeyIndex} /></div>
          </section>

          <section className="order-2 border border-white/10 bg-[#0a1319] xl:order-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] font-bold tracking-[0.16em] text-slate-500">TARGET</span>
                <span className="font-mono text-2xl font-black text-white">{targetKey.noteName}<sup className="ml-0.5 text-sm text-[#73f7cf]">{targetKey.octave}</sup></span>
                <span className="border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">K{targetKey.keyNumber}</span>
              </div>
              <div className="h-5 w-px bg-white/10" />
              <div className="flex items-baseline gap-1">
                <span className="font-mono text-[9px] font-bold tracking-[0.16em] text-slate-500">LIVE</span>
                <span className={cn("font-mono text-3xl font-black tracking-[-0.08em]", centsTone(displayedLiveCents))}>{displayedLiveCents === null ? "0.0" : `${displayedLiveCents > 0 ? "+" : ""}${displayedLiveCents.toFixed(1)}`}</span>
                <span className="font-mono text-sm text-slate-500">¢</span>
              </div>
              <div className="flex items-center gap-1.5 sm:ml-auto">
                <span className={cn("border px-1.5 py-1 font-mono text-[9px] font-bold", result?.crossValid ? "border-[#73f7cf]/35 text-[#73f7cf]" : "border-white/10 text-slate-500")}>{result?.crossValid ? "A·B OK" : "VERIFY"}</span>
                <button onClick={seq.prev} disabled={!seq.canPrev} className="border border-white/10 px-2 py-1 font-mono text-xs text-slate-400 hover:border-white/30 disabled:opacity-30">←</button>
                <button onClick={seq.next} disabled={!seq.canNext} className="border border-[#73f7cf]/25 px-2 py-1 font-mono text-xs text-[#73f7cf] hover:bg-[#73f7cf]/10 disabled:opacity-30">→</button>
              </div>
            </div>
            {(result?.isCapturing || (isHighRepeatRange && displayedFinalCents === null && highRepeatCount > 0)) && (
              <div className="border-t border-white/10 px-3 py-1.5 text-[10px] text-[#f8c76c]">{result?.isCapturing ? `안정 측정 중 ${Math.round(result.captureProgress * 100)}%` : highRepeatUsed ? `반복 측정 ${highRepeatUsed}회 가중평균 준비됨` : `고음 반복 측정 ${highRepeatCount}/3`}</div>
            )}
          </section>

          <aside className="order-4 space-y-4 xl:order-3">
            <section className="border border-white/10 bg-[#0a1319] p-3">
              <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#73f7cf]">ASSIGNED VALUE</p>
              <div className="mt-4 flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">{displayedMeasurementKey.keyNumber}번 {displayedMeasurementKey.noteName}{displayedMeasurementKey.octave}</p>
                  <p className="mt-1 text-sm font-bold text-white">확정 센트값 · {assignedValueLabel}</p>
                </div>
                <p className={cn("font-mono text-3xl font-black tracking-[-0.08em]", centsTone(currentAssignedCents))}>{formatCents(currentAssignedCents)}</p>
              </div>
              <div className="mt-4 border-t border-white/10 pt-3 text-xs text-slate-500">확정된 최종값은 그래프와 건반별 기록표에 반영됩니다.</div>
            </section>

            <section className="border border-white/10 bg-[#0a1319] p-4">
              <div className="flex items-center justify-between">
                <div><p className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#73f7cf]">ENGINE STATUS</p><p className="mt-1 text-xs text-slate-500">A·B 독립 분석</p></div>
                <SignalMark active={!!result?.crossValid} warn={!!result && !result.crossValid} />
              </div>
              <div className="mt-4 space-y-2">
                {[
                  ["A / YIN", result?.yinCents ?? null, !!result],
                  ["B / GOERTZEL", result?.goertzelCents ?? null, !!result?.signalOk],
                  ["COMPOSITE", displayedLiveCents, !!result?.crossValid],
                ].map(([label, cents, active]) => (
                  <div key={label as string} className="flex items-center justify-between border border-white/10 bg-[#0d181f] px-3 py-2.5">
                    <span className={cn("font-mono text-[10px] tracking-[0.1em]", active ? "text-slate-200" : "text-slate-600")}>{label as string}</span>
                    <span className={cn("font-mono text-xs font-bold", centsTone(cents as number | null))}>{formatCents(cents as number | null)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="border border-[#73f7cf]/25 bg-[#73f7cf]/[0.05] p-4">
              <div className="flex items-center justify-between gap-3">
                <div><p className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#73f7cf]">CONTROL</p><p className="mt-1 text-xs text-slate-500">마이크와 진행 방식</p></div>
                <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={autoAdvance} onChange={(event) => onAutoAdvanceChange(event.target.checked)} className="h-4 w-4 accent-[#73f7cf]" />자동 진행</label>
              </div>
              <button
                onClick={isPro ? onToggleListening : undefined}
                disabled={!isPro}
                className={cn("mt-4 w-full px-4 py-4 text-sm font-black tracking-[0.08em] transition-all", !isPro ? "cursor-not-allowed bg-slate-700 text-slate-400" : isListening ? "bg-[#fb7a8a] text-[#2a070d] hover:bg-[#ff98a5]" : "bg-[#73f7cf] text-[#06231d] hover:bg-[#a0ffdf]")}
              >{!isPro ? "PRO 전용 마이크" : isListening ? "■ 측정 중지" : "● 정밀 측정 시작"}</button>
              {!isPro && <p className="mt-2 text-center text-[11px] text-slate-500">Pro 등급에서 마이크 측정 기능을 사용할 수 있습니다.</p>}
            </section>
          </aside>
        </div>

        {error && <div className="mt-4 border border-[#fb7a8a]/40 bg-[#fb7a8a]/10 px-4 py-3 text-sm text-[#ffabb6]">{error}</div>}

        <section className="mt-4">
          <div className="border border-white/10 bg-[#0a1319]">
            <div className="flex items-center justify-between border-b border-white/10 p-4">
              <div><p className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#73f7cf]">MEASUREMENT LOG</p><p className="mt-1 text-xs text-slate-500">기록 {centsTableRows.length}건</p></div>
              <button onClick={onToggleCentsTable} className="border border-white/15 px-3 py-2 text-xs font-bold text-slate-300 transition-colors hover:border-[#73f7cf]/60 hover:text-[#73f7cf]">{showCentsTable ? "접기" : "전체 보기"}</button>
            </div>
            <div className="p-4">
              <div className="border border-[#73f7cf]/20 bg-[#73f7cf]/[0.04] p-3">
                <p className="text-[11px] text-slate-500">현재 선택</p>
                <div className="mt-1 flex items-end justify-between"><span className="font-mono text-sm font-black text-white">{displayedMeasurementKey.keyNumber} · {displayedMeasurementKey.noteName}{displayedMeasurementKey.octave}</span><span className={cn("font-mono text-xl font-black", centsTone(currentAssignedCents))}>{formatCents(currentAssignedCents)}</span></div>
              </div>
              {centsTableRows.length === 0 ? (
                <p className="py-8 text-center text-xs leading-6 text-slate-500">아직 기록된 값이 없습니다.<br />측정이 확정되면 이곳에 누적됩니다.</p>
              ) : showCentsTable ? (
                <div className="mt-3 max-h-[420px] overflow-auto border border-white/10">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-[#111f26] text-[10px] tracking-[0.08em] text-slate-500"><tr><th className="px-3 py-3">KEY</th><th className="px-2 py-3">NOTE</th><th className="px-3 py-3 text-right">CENTS</th></tr></thead>
                    <tbody className="divide-y divide-white/10">
                      {centsTableRows.map((row) => <tr key={row.keyIndex} className={cn("bg-[#0d181f]", row.keyIndex === seq.targetKeyIndex && "bg-[#73f7cf]/10")}><td className="px-3 py-2.5 font-mono text-slate-300">{String(row.keyNumber).padStart(2, "0")}</td><td className="px-2 py-2.5 font-mono text-white">{row.noteName}{row.octave}</td><td className={cn("px-3 py-2.5 text-right font-mono font-black", centsTone(row.cents))}>{formatCents(row.cents)}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              ) : <p className="mt-4 text-xs text-slate-500">전체 보기를 눌러 건반별 기록값을 확인하세요.</p>}
            </div>
          </div>
        </section>

        <footer className="mt-4 grid gap-3 border border-white/10 bg-[#0a1319] p-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div><p className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#73f7cf]">EXPORT STATION</p><p className="mt-1 text-xs text-slate-500">{activeSession?.name ?? "세션 없음"} · {measuredCount}건 기록</p></div>
            <input value={userName} onChange={(event) => onUserNameChange(event.target.value)} placeholder="성명 입력 (리포트 표기)" className="border border-white/10 bg-[#0d181f] px-3 py-2.5 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#73f7cf]/60" />
          </div>
          <div className="flex flex-wrap gap-2">
            {undoAvailable && <button onClick={onUndo} className="border border-white/15 px-3 py-2.5 text-xs font-bold text-slate-300 hover:border-[#fb7a8a]/60 hover:text-[#ffabb6]">↶ 되돌리기</button>}
            <button disabled={measuredCount === 0} onClick={onExportPdf} className="border border-white/15 px-3 py-2.5 text-xs font-bold text-slate-300 transition-colors hover:border-[#73f7cf]/60 hover:text-[#73f7cf] disabled:cursor-not-allowed disabled:opacity-30">PDF</button>
            <button disabled={measuredCount === 0} onClick={onExportImage} className="bg-[#73f7cf] px-3 py-2.5 text-xs font-black text-[#06231d] transition-colors hover:bg-[#a0ffdf] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500">이미지</button>
          </div>
        </footer>
      </main>
    </div>
  );
}
