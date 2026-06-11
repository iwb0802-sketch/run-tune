/**
 * sharedAudio.ts
 * 앱 전체에서 AudioContext를 딱 하나만 사용
 * - 마이크 감지와 기준음/맥놀이가 같은 ctx를 공유
 * - ctx.close() 절대 호출 안 함 (iOS에서 오디오 잠김 방지)
 * - 사용자 제스처 시 한 번만 unlock
 */

let _ctx: AudioContext | null = null;
let _unlocked = false;

export function getAudioContext(): AudioContext {
  if (!_ctx || _ctx.state === "closed") {
    _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    _unlocked = false;
  }
  return _ctx;
}

export async function unlockAudio(): Promise<AudioContext> {
  const ctx = getAudioContext();
  if (!_unlocked || ctx.state === "suspended") {
    try {
      await ctx.resume();
      _unlocked = true;
    } catch { /* 무시 */ }
  }
  return ctx;
}

export function isAudioUnlocked(): boolean {
  return _unlocked && !!_ctx && _ctx.state === "running";
}
