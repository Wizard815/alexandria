// Test helpers for the sound and voice features: a generated 1 second WAV
// tone (no real audio in the repo) and a live-event collector.
import type { AddressInfo } from 'node:net';

/** A mono 16-bit WAV of a sine tone. */
export function toneWav(seconds = 1, hz = 440, rate = 8000): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return b;
}

/** Listen to a world's live events as one account. */
export async function listen(base: string, world: string, token: string) {
  const ctl = new AbortController();
  const events: { type: string; data: any }[] = [];
  const res = await fetch(`${base}/api/worlds/${world}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
  (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, stop: () => ctl.abort() };
}

export const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
export const baseOf = (server: any) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
