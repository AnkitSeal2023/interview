"use client";

import { useEffect, useRef, useState } from "react";

// ---------- interviewer voice (streamed Coqui TTS, layered fallbacks) ----------
//
// Playback stack, best-first (text is ALWAYS revealed, audio degrades gracefully):
//   1. NDJSON sentence stream (/api/tts-stream) → each sentence's audio scheduled and its
//      text revealed exactly when the audio starts (~ gapless, speech-synced captions)
//   2. Whole-question blob (/api/tts) via HTMLAudio — if Web Audio is blocked or the stream
//      produced nothing; full text is revealed instantly in both cases
//   3. Browser speechSynthesis — if the TTS service itself is down
// Mid-stream failure AFTER some sentences scheduled already started playing → do NOT replay
// (that would duplicate the voice); reveal the remaining text silently.

let audioCtx: AudioContext | null = null;
let currentEl: HTMLAudioElement | null = null;
let pendingReveals: ReturnType<typeof setTimeout>[] = [];
let voiceGeneration = 0;
let activeRequest: AbortController | null = null;
const VOICE_RATE = 1.18;

function stopAllVoice() {
  voiceGeneration++;
  activeRequest?.abort();
  activeRequest = null;
  pendingReveals.forEach(clearTimeout);
  pendingReveals = [];
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (currentEl) {
    currentEl.pause();
    currentEl = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

class TtsStreamError extends Error {
  constructor(msg: string, public sentencesStarted: number, public scheduledUntil: number) {
    super(msg);
  }
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

async function playStreamed(text: string, onSentence: (revealed: string) => void,
  isCurrent: () => boolean,
  onState: (state: VoiceState) => void,
  requestSignal: AbortSignal,
): Promise<void> {
  let started = 0;
  let nextAt = 0;
  const fail = (msg: string): never => {
    throw new TtsStreamError(msg, started, nextAt);
  };
  const res = await fetch("/api/tts-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: requestSignal,
  });
  const body = res.body;
  if (!res.ok || !body) fail(`tts-stream ${res.status}`);

  const reader = body!.getReader();
  const dec = new TextDecoder();
  let carry = "";
  let revealed = "";

  const revealNow = (add: string) => {
    revealed = revealed ? `${revealed} ${add}` : add;
    onSentence(revealed);
  };
  const revealAtAudioStart = (ctx: AudioContext, add: string, atTime: number) => {
    const delay = Math.max(0, (atTime - ctx.currentTime) * 1000) - 40;
    pendingReveals.push(setTimeout(() => {
      if (audioCtx === ctx) revealNow(add); // skip if playback was reset meanwhile
    }, delay));
  };

  const handleLine = async (raw: string) => {
    if (!isCurrent()) return;
    const j = JSON.parse(raw) as { b64?: string; text?: string; error?: string };
    if (j.error) fail(j.error);
    if (!j.b64) {
      if (j.text) revealNow(j.text); // text-only line: show it, no audio
      return;
    }
    audioCtx = audioCtx ?? new AudioContext();
    const ctx = audioCtx;
    const buf = await ctx.decodeAudioData(b64ToBuf(j.b64));
    if (!isCurrent()) return;
    if (ctx.state !== "running") {
      // autoplay policy: needs the page's prior user activation; race so we never hang
      await Promise.race([
        ctx.resume(),
        new Promise((r) => setTimeout(r, 700)),
      ]);
      // TS narrows state after the resume; compare via string to avoid false narrowing
      if ((ctx.state as string) !== "running") fail("audio blocked — falling back");
    }
    const t = Math.max(nextAt, ctx.currentTime + 0.02);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = VOICE_RATE;
    src.connect(ctx.destination);
    src.start(t);
    nextAt = t + buf.duration / VOICE_RATE; // back-to-back, no gap
    started++;
    onState("speaking");
    if (j.text) revealAtAudioStart(ctx, j.text, t); // caption synced to the voice
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });
    const nl = carry.lastIndexOf("\n");
    if (nl < 0) continue;
    for (const line of carry.slice(0, nl).split("\n")) {
      if (line.trim()) await handleLine(line);
    }
    carry = carry.slice(nl + 1);
  }
  if (started === 0) fail("no audio received");
  if (isCurrent() && audioCtx && nextAt > audioCtx.currentTime) {
    await new Promise((resolve) => window.setTimeout(
      resolve,
      Math.max(0, (nextAt - audioCtx!.currentTime) * 1000),
    ));
  }
}

async function playWholeBlob(
  text: string,
  isCurrent: () => boolean,
): Promise<void> {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  // A newer speak()/stopAllVoice() may have taken over while this blob was
  // downloading. Playing it now would leak a stale, unstoppable voice on top
  // of the new one — drop it instead.
  if (!isCurrent()) return;
  const el = new Audio(URL.createObjectURL(await r.blob()));
  currentEl = el;
  el.playbackRate = VOICE_RATE;
  await new Promise<void>((resolve, reject) => {
    el.addEventListener("ended", () => resolve(), { once: true });
    el.addEventListener("error", () =>
      reject(new Error("audio playback failed")), { once: true });
    // stopAllVoice() pauses us mid-playback — resolve instead of hanging forever
    el.addEventListener("pause", () => resolve(), { once: true });
    void el.play().catch(reject);
  });
}

function playBrowserSynth(text: string): Promise<void> {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = VOICE_RATE;
  return new Promise((resolve) => {
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

// onSentence drives the speech-synced caption in the UI. Every failure path reveals
// the full text first, so a broken voice never hides the question.
export function speak(text: string, enabled: boolean,
                      onSentence?: (revealed: string) => void,
                      onState?: (state: VoiceState) => void,
                      onFinished?: () => void): () => void {
  if (!enabled || typeof window === "undefined" || !text) {
    onFinished?.();
    return () => {};
  }
  stopAllVoice();
  const generation = voiceGeneration;
  const request = new AbortController();
  activeRequest = request;
  const isCurrent = () => generation === voiceGeneration;
  const finish = () => {
    if (isCurrent()) {
      if (activeRequest === request) activeRequest = null;
      onState?.("idle");
      onFinished?.();
    }
  };
  onState?.("loading");
  const revealAll = () => onSentence?.(text);
  playStreamed(text, (r) => onSentence?.(r), isCurrent, (state) => onState?.(state),
    request.signal).then(finish).catch((e: unknown) => {
    if (!isCurrent()) return;
    revealAll();
    const midStream = e instanceof TtsStreamError && e.sentencesStarted > 0;
    if (midStream) {
      const waitMs = Math.max(0, ((e as TtsStreamError).scheduledUntil
        - (audioCtx?.currentTime ?? 0)) * 1000);
      return new Promise((resolve) => window.setTimeout(resolve, waitMs)).then(finish);
    }
    return playWholeBlob(text, isCurrent)
      .then(finish)
      .catch(() => {
        if (!isCurrent()) return;
        return playBrowserSynth(text).then(finish);
      });
  });
  return () => {
    if (isCurrent()) stopAllVoice();
  };
}

export type VoiceState = "idle" | "loading" | "speaking";

// ---------- mic recording → /api/stt ----------
export type MicState = "idle" | "recording" | "transcribing";

export function useStt(onText: (t: string) => void) {
  const [state, setState] = useState<MicState>("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      discardRef.current = false;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (discardRef.current) {
          // user chose "Stop recording": drop the clip entirely — nothing processed
          discardRef.current = false;
          chunksRef.current = [];
          setState("idle");
          return;
        }
        setState("transcribing");
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
          const fd = new FormData();
          fd.append("file", blob, "clip.webm");
          const r = await fetch("/api/stt", { method: "POST", body: fd });
          if (!r.ok) throw new Error(`stt ${r.status}`);
          const j = await r.json();
          if (j.text) onText(j.text);
        } catch (e) {
          alert(`transcription failed: ${e}`);
        }
        setState("idle");
      };
      rec.start();
      recRef.current = rec;
      setState("recording");
    } catch (e) {
      alert(`microphone unavailable: ${e}`);
      setState("idle");
    }
  };

  // discard=true drops the recording without transcribing (nothing is processed);
  // default stop() transcribes the clip and delivers it via onText.
  const stop = (discard = false) => {
    if (discard) discardRef.current = true;
    if (recRef.current?.state === "recording") recRef.current.stop();
  };

  useEffect(
    () => () => {
      try {
        stop();
      } catch {
        /* unmount */
      }
    },
    [],
  );

  return { state, start, stop };
}
