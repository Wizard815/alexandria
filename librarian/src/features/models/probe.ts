// The smallest real request each job can make. Used by Test, Warm up, keep warm
// and the session mode. The prompts are fixed strings: no world text is ever sent.
import type { Deps } from '../../app.ts';
import { chat, embed, rerank, speak, transcribe, ModelUnavailable, type Job } from '../../core/ai.ts';

/** A tiny silent 16 kHz mono WAV for the audio test. */
function silentWav(seconds = 0.5): Uint8Array {
  const n = Math.floor(16000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return new Uint8Array(b);
}

export interface TestResult { ok: boolean; job: Job; ms: number; sample?: string; error?: string }

/** The smallest real request each job can make. Used by Test and Warm up, and by keep warm. */
export async function testJob(d: Deps, job: Job, timeoutMs = 30_000): Promise<TestResult> {
  const t0 = Date.now();
  const done = (sample: string) => ({ ok: true, job, ms: Date.now() - t0, sample: sample.slice(0, 160) });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    if (job === 'chat' || job === 'audit') {
      const r = await chat(d, job, { messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 16, temperature: 0 }, ctl.signal);
      return done(r.content.trim() || '(empty reply)');
    }
    if (job === 'audio') {
      const t = await transcribe(d, silentWav(), 'audio/wav', { filename: 'test.wav' }, ctl.signal);
      return done(t.text || '(no speech heard, which is right for silence)');
    }
    if (job === 'voice') {
      const s = await speak(d, 'Testing, one two three.', { format: 'wav' }, ctl.signal);
      if (!s.audio.length) throw new ModelUnavailable('voice', 'The voice model sent no audio');
      return done(`${s.audio.length} bytes of ${s.mime}`);
    }
    if (job === 'rerank') {
      const r = await rerank(d, 'where the dragon sleeps', ['A cat naps on the windowsill.', 'The dragon sleeps under the mountain.'], { topN: 2 }, ctl.signal);
      return done(`${r.length} scored, best is document ${r[0].index + 1}`);
    }
    const v = await embed(d, ['a tiny test sentence'], ctl.signal);
    if (!v.length || !Array.isArray(v[0]) || !v[0].length) throw new ModelUnavailable('extra', 'The embeddings model sent no vector');
    return done(`${v[0].length}-dimension vector`);
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `Timed out after ${Math.round(timeoutMs / 1000)} seconds` : String(err?.message ?? err);
    return { ok: false, job, ms: Date.now() - t0, error: msg.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

