/**
 * ReferenceAudioPanel.tsx
 * 헤더 바로 아래 고정 바:
 * - [기준음] 버튼: 누르면 440Hz 재생/정지
 * - [맥놀이 ▼] 버튼: 누르면 1~10 드롭다운 메뉴
 */

import { useReferenceAudio, BeatRate } from "@/hooks/useReferenceAudio";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

const BEAT_RATES: BeatRate[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export default function ReferenceAudioBar() {
  const {
    isPlayingRef,
    isPlayingBeat,
    currentBeatRate,
    toggleReferenceNote,
    toggleBeat,
    stopAll,
  } = useReferenceAudio();

  const [showBeatMenu, setShowBeatMenu] = useState(false);
  const beatMenuRef = useRef<HTMLDivElement>(null);

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    if (!showBeatMenu) return;
    const handler = (e: MouseEvent) => {
      if (beatMenuRef.current && !beatMenuRef.current.contains(e.target as Node)) {
        setShowBeatMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBeatMenu]);

  return (
    <div className="bg-card border-b border-border px-4 py-2 flex items-center gap-2 shadow-sm">
      {/* 기준음 버튼 */}
      <button
        onClick={toggleReferenceNote}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.97] border",
          isPlayingRef
            ? "bg-warn border-warn text-white"
            : "bg-muted border-border text-foreground/85 hover:bg-muted"
        )}
      >
        {isPlayingRef ? (
          <>
            <span className="flex gap-0.5 items-end h-3.5">
              {[2,4,3,5,2].map((h, i) => (
                <span key={i} className="w-0.5 bg-card rounded-full animate-pulse inline-block"
                  style={{ height: `${h * 2}px`, animationDelay: `${i * 0.1}s` }} />
              ))}
            </span>
            기준음 재생 중
          </>
        ) : (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            기준음
          </>
        )}
      </button>

      {/* 맥놀이 버튼 + 드롭다운 */}
      <div className="relative" ref={beatMenuRef}>
        <button
          onClick={() => setShowBeatMenu(v => !v)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.97] border",
            isPlayingBeat
              ? "bg-primary border-primary text-white"
              : showBeatMenu
              ? "bg-primary-soft border-primary/40 text-primary"
              : "bg-muted border-border text-foreground/85 hover:bg-muted"
          )}
        >
          {isPlayingBeat ? (
            <>
              <span className="flex gap-0.5 items-end h-3.5">
                {[2,4,3,5,2].map((h, i) => (
                  <span key={i} className="w-0.5 bg-card rounded-full animate-pulse inline-block"
                    style={{ height: `${h * 2}px`, animationDelay: `${i * 0.12}s` }} />
                ))}
              </span>
              맥놀이 {currentBeatRate}회/초
            </>
          ) : (
            <>맥놀이</>
          )}
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={cn("transition-transform duration-150", showBeatMenu ? "rotate-180" : "")}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* 드롭다운 메뉴 */}
        {showBeatMenu && (
          <div className="absolute top-full left-0 mt-1.5 z-50 bg-card border border-border rounded-2xl shadow-xl overflow-hidden"
            style={{ minWidth: 200, animation: "dropDown 0.12s ease-out" }}>
            <style>{`
              @keyframes dropDown {
                from { opacity: 0; transform: translateY(-6px) scale(0.97); }
                to   { opacity: 1; transform: translateY(0) scale(1); }
              }
            `}</style>
            <div className="px-3 py-2 border-b border-border/60 bg-muted/50">
              <span className="text-xs font-semibold text-muted-foreground">맥놀이 횟수 선택 (회/초)</span>
            </div>
            <div className="grid grid-cols-5 gap-1 p-2">
              {BEAT_RATES.map(rate => {
                const isActive = isPlayingBeat && currentBeatRate === rate;
                return (
                  <button
                    key={rate}
                    onClick={() => { toggleBeat(rate); setShowBeatMenu(false); }}
                    className={cn(
                      "flex flex-col items-center py-2.5 rounded-xl text-sm font-bold transition-all duration-100 active:scale-[0.93]",
                      isActive
                        ? "bg-primary text-white"
                        : "bg-muted/50 text-foreground/85 hover:bg-primary-soft hover:text-primary"
                    )}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {rate}
                    <span className="text-[9px] font-normal opacity-70 mt-0.5">회/초</span>
                  </button>
                );
              })}
            </div>
            {isPlayingBeat && (
              <div className="px-3 pb-2">
                <div className="text-xs text-primary bg-primary-soft rounded-lg py-1.5 text-center border border-primary/20"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  440Hz + {440 + currentBeatRate}Hz · {currentBeatRate}회/초
                </div>
              </div>
            )}
            {/* 정지 버튼 */}
            {(isPlayingRef || isPlayingBeat) && (
              <div className="px-2 pb-2">
                <button
                  onClick={() => { stopAll(); setShowBeatMenu(false); }}
                  className="w-full py-2 text-xs text-off bg-off-soft hover:bg-off-soft rounded-xl border border-off/30 font-semibold transition-colors"
                >
                  ■ 모두 정지
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 재생 중 상태 표시 */}
      {(isPlayingRef || isPlayingBeat) && (
        <button
          onClick={stopAll}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs text-off bg-off-soft border border-off/30 rounded-lg hover:bg-off-soft transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
          정지
        </button>
      )}
    </div>
  );
}
