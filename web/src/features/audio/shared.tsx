// Small pieces shared by the audio screens.
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld } from '../../lib/world.tsx';
import { engine, type MicSetting } from './engine.ts';

/** Keep the recording engine pointed at the open world. */
export function useAttach() {
  const { client } = useAuth();
  const { info, isDM } = useWorld();
  useEffect(() => { engine.attach({ baseUrl: window.location.origin, token: client.token ?? '', worldId: info.id, isDM }); }, [client.token, info.id, isDM]);
}

export interface Input { deviceId: string; label: string }

/** The microphones this browser can see. Labels appear once the browser has allowed the mic. */
export async function listInputs(ask: boolean): Promise<{ inputs: Input[]; labelled: boolean; error?: string }> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], labelled: false, error: 'This browser cannot list microphones (it needs https).' };
    if (ask) { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); }
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    return { inputs, labelled: all.some((d) => d.kind === 'audioinput' && !!d.label) };
  } catch (e: any) {
    return { inputs: [], labelled: false, error: e?.name === 'NotAllowedError' ? 'The browser blocked the microphone. Allow it in the address bar and try again.' : String(e?.message ?? e) };
  }
}

export function useInputs() {
  const [state, setState] = useState<{ inputs: Input[]; labelled: boolean; error?: string }>({ inputs: [], labelled: false });
  const reload = async (ask = false) => setState(await listInputs(ask));
  useEffect(() => { void reload(false); navigator.mediaDevices?.addEventListener?.('devicechange', () => void reload(false)); }, []);
  return { ...state, reload };
}

export function Meter({ level }: { level: number }) {
  return <div className="au-meter" role="meter" aria-label="Signal level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(2))}><div style={{ width: `${Math.round(level * 100)}%` }} /></div>;
}

/** Capture the next key press as a hold key. */
export function KeyButton({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const k = (e: KeyboardEvent) => { e.preventDefault(); onChange(e.code === 'Escape' ? '' : e.code); setListening(false); };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [listening, onChange]);
  return (
    <span className="row" style={{ gap: 6 }}>
      <button type="button" className="btn small" onClick={() => setListening(true)}>{listening ? 'Press a key… (Esc clears)' : value ? `Key: ${value.replace(/^Key/, '')}` : 'Set a hold key'}</button>
      {value && !listening && <button type="button" className="btn small ghost" onClick={() => onChange('')} aria-label="Clear the hold key">Clear</button>}
    </span>
  );
}

export const MODE_LABELS: Record<MicSetting['mode'], string> = {
  always: 'Always on',
  'hold-to-talk': 'Hold to talk',
  'hold-to-mute': 'Hold to mute',
  off: 'Off',
};
