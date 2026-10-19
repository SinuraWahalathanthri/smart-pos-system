/** Scan feedback tones via Web Audio (nothing to download). Sound is never the only signal. */

let ctx: AudioContext | null = null;
let muted = false;

export function setMuted(value: boolean) {
  muted = value;
  try {
    localStorage.setItem("pos-muted", value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem("pos-muted") === "1" || muted;
  } catch {
    return muted;
  }
}

function tone(freq: number, start: number, dur: number, gain = 0.12) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.02);
}

export type Cue = "ok" | "error" | "attention" | "done";

export function playCue(cue: Cue) {
  if (typeof window === "undefined" || isMuted()) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    if (cue === "ok") tone(1500, 0, 0.07);
    else if (cue === "error") {
      tone(260, 0, 0.12);
      tone(200, 0.14, 0.18);
    } else if (cue === "attention") {
      tone(880, 0, 0.1);
      tone(1175, 0.11, 0.14);
    } else {
      tone(988, 0, 0.09);
      tone(1319, 0.1, 0.16);
    }
  } catch {
    /* audio blocked until a user gesture: ignore */
  }
}
