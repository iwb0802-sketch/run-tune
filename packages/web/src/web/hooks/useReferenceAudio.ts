/**
 * useReferenceAudio.ts
 * 공유 AudioContext 사용 - 마이크와 같은 ctx
 * ctx.close() 절대 호출 안 함
 */

import { unlockAudio } from "@/lib/tuner/sharedAudio";
import { useCallback, useEffect, useRef, useState } from "react";

export type BeatRate = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export function useReferenceAudio() {
  const [isPlayingRef, setIsPlayingRef] = useState(false);
  const [isPlayingBeat, setIsPlayingBeat] = useState(false);
  const [currentBeatRate, setCurrentBeatRate] = useState<BeatRate>(1);

  const oscsRef = useRef<OscillatorNode[]>([]);
  const gainsRef = useRef<GainNode[]>([]);

  const stopAll = useCallback(() => {
    const ctx = gainsRef.current.length > 0 ? oscsRef.current[0]?.context : null;
    if (ctx) {
      const now = ctx.currentTime;
      gainsRef.current.forEach(g => {
        try {
          g.gain.setValueAtTime(g.gain.value, now);
          g.gain.linearRampToValueAtTime(0, now + 0.04);
        } catch { /* 무시 */ }
      });
    }
    setTimeout(() => {
      oscsRef.current.forEach(o => { try { o.stop(); } catch { /* 무시 */ } });
      oscsRef.current = [];
      gainsRef.current = [];
    }, 50);
    setIsPlayingRef(false);
    setIsPlayingBeat(false);
  }, []);

  const playFreqs = useCallback(async (freqs: number[]) => {
    // 기존 재생 중지
    oscsRef.current.forEach(o => { try { o.stop(); } catch { /* 무시 */ } });
    oscsRef.current = [];
    gainsRef.current = [];

    try {
      // 공유 ctx unlock (사용자 제스처 내에서 호출됨)
      const ctx = await unlockAudio();
      const now = ctx.currentTime;

      freqs.forEach(freq => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.value = freq;

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.45, now + 0.015);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);

        oscsRef.current.push(osc);
        gainsRef.current.push(gain);
      });
    } catch (e) {
      console.warn("Audio play failed:", e);
    }
  }, []);

  const toggleReferenceNote = useCallback(async () => {
    if (isPlayingRef) { stopAll(); return; }
    if (isPlayingBeat) stopAll();
    setIsPlayingRef(true);
    setIsPlayingBeat(false);
    await playFreqs([440]);
  }, [isPlayingRef, isPlayingBeat, stopAll, playFreqs]);

  const toggleBeat = useCallback(async (rate: BeatRate) => {
    if (isPlayingBeat && currentBeatRate === rate) { stopAll(); return; }
    if (isPlayingRef) stopAll();
    setCurrentBeatRate(rate);
    setIsPlayingBeat(true);
    setIsPlayingRef(false);
    await playFreqs([440, 440 + rate]);
  }, [isPlayingBeat, isPlayingRef, currentBeatRate, stopAll, playFreqs]);

  useEffect(() => {
    return () => {
      oscsRef.current.forEach(o => { try { o.stop(); } catch { /* 무시 */ } });
      oscsRef.current = [];
      gainsRef.current = [];
    };
  }, []);

  return { isPlayingRef, isPlayingBeat, currentBeatRate, toggleReferenceNote, toggleBeat, stopAll };
}
