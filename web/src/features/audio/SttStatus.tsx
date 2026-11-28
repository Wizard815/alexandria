// What this device's own speech to text is doing, for the GM's setup page and the player's mic page.
import type { SttView } from './stt.ts';

const speed = (rtf: number | null) => (rtf === null ? '' : rtf <= 0 ? '' : `${(1 / Math.max(0.01, rtf)).toFixed(rtf > 0.5 ? 1 : 0)}× faster than real time`);

/** A one-glance banner: transcribing on this device (and how fast), loading the model, or the server doing it. */
export function DeviceSttNote({ view: v, player }: { view: SttView; player?: boolean }) {
  if (v.mode === 'server' && v.state === 'off') return null;
  const engine = v.backend === 'webgpu' ? 'graphics card (WebGPU)' : v.backend === 'wasm' ? 'processor (WebAssembly)' : '';
  if (v.state === 'loading') {
    return (
      <div className="au-stt-note loading" role="status" aria-live="polite">
        <strong><i className="fa-solid fa-spinner fa-spin" aria-hidden="true" /> Getting ready to transcribe on this device</strong>
        <span className="tiny">Loading {v.model} for the {engine}{v.progress !== null ? ` · ${Math.round(v.progress * 100)}%` : ''}. The server transcribes {player ? 'your' : 'this'} mic until it is ready.</span>
        {v.progress !== null && <div className="au-meter" role="progressbar" aria-label="Model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.progress * 100)}><div style={{ width: `${Math.round(v.progress * 100)}%` }} /></div>}
      </div>
    );
  }
  if (v.state === 'ready' || v.state === 'running' || v.state === 'behind') {
    return (
      <div className={`au-stt-note on${v.state === 'behind' ? ' behind' : ''}`} role="status" aria-live="polite" data-stt-state={v.state}>
        <strong><i className="fa-solid fa-microchip" aria-hidden="true" /> Transcribing on this device</strong>
        <span className="tiny">{v.model} on the {engine}{v.rtf !== null ? ` · ${speed(v.rtf)}` : ''}{v.done ? ` · ${v.done} chunk${v.done === 1 ? '' : 's'} done` : ''}{v.handed ? ` · ${v.handed} handed to the server` : ''}</span>
        {v.state === 'behind' && <span className="tiny">This device is falling behind, so the server is helping. Nothing is lost.</span>}
      </div>
    );
  }
  if (v.state === 'off' && !v.note) return null;
  return (
    <div className="au-stt-note server" role="status" data-stt-state={v.state}>
      <strong><i className="fa-solid fa-server" aria-hidden="true" /> The server transcribes {player ? 'your' : 'this computer’s'} mic</strong>
      {v.note && <span className="tiny">{v.note}</span>}
    </div>
  );
}
