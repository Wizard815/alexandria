// Read the assistant's replies aloud, on the DM's own device only. The text goes to the world's own text-to-speech model
// (POST /agent/speak, DM only) and the audio is played here, never on the table speakers. The choice is remembered per
// browser. Also home to the spoken-request notice: when the DM says "Minerva, <request>" while recording, the reply
// arrives as a live event to the DM alone and is shown as a small notice (and read aloud if that is on).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { useAuth } from '../../lib/auth.tsx';

const ALOUD_KEY = 'alx-agent-aloud';
const SPOKEN_KEY = 'alx-agent-spoken';

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** The remembered chat of this world and role, shared by the chat itself and the notice that opens a chat. */
export const chatKey = (world: string, harness: string) => `alx-agent-chat:${world}:${harness}`;
export const rememberedChat = (k: string): string | null => read(k);
export const rememberChat = (k: string, v: string) => write(k, v);
export const OPEN_CHAT = 'alx-agent-open-chat';

// ---- the switch ----
// Kept in memory too, so it still works for the page's life where storage is blocked.
let memAloud = false;
const subs = new Set<() => void>();
const aloudNow = (): boolean => { const v = read(ALOUD_KEY); return v === null ? memAloud : v === '1'; };
const setAloudNow = (v: boolean) => { memAloud = v; write(ALOUD_KEY, v ? '1' : '0'); if (!v) stopSpeaking(); subs.forEach((f) => f()); };
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === ALOUD_KEY) subs.forEach((f) => f()); });

export function useReadAloud(): [boolean, (v: boolean) => void] {
  const on = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, aloudNow, () => false);
  return [on, setAloudNow];
}

// ---- playing ----
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let generation = 0;

export function stopSpeaking() {
  generation++;
  if (audio) { audio.pause(); audio.src = ''; audio = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

/** Speak a reply. Resolves with an error line to show, or null. A newer call (or stopSpeaking) cancels this one. */
export async function speakAloud(world: string, token: string | null | undefined, text: string): Promise<string | null> {
  stopSpeaking();
  const mine = generation;
  try {
    const r = await fetch(`${window.location.origin}/api/worlds/${encodeURIComponent(world)}/agent/speak`, { method: 'POST', headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return j.error ?? `Reading aloud failed (${r.status})`; }
    const blob = await r.blob();
    if (mine !== generation) return null;
    objectUrl = URL.createObjectURL(blob);
    audio = new Audio(objectUrl);
    audio.onended = () => { if (mine === generation) stopSpeaking(); };
    await audio.play();
    return null;
  } catch (e: any) {
    // A browser may refuse to start sound before the page has been clicked: say so, the switch itself is a click.
    return e?.name === 'NotAllowedError' ? 'The browser blocked the sound. Click the page, then try again.' : e?.message ?? 'Reading aloud failed';
  }
}

/**
 * True the first time this browser sees `id`. With the docked panel and the pop-out window both open, each hears the same
 * event; without this the reply would be read twice. Storage that will not work means no dedupe, which beats silence.
 */
export function claimSpoken(id: string): boolean {
  if (!id) return true;
  try {
    if (localStorage.getItem(SPOKEN_KEY) === id) return false;
    localStorage.setItem(SPOKEN_KEY, id);
  } catch { /* no storage: speak */ }
  return true;
}

/** The speaker switch in the chat. */
export function AloudToggle({ note, phone }: { note?: string; phone?: boolean }) {
  const [on, setOn] = useReadAloud();
  return (
    <button type="button" className={`${phone ? 'b chip' : 'chip ag-quick-btn'}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setOn(!on)} data-testid="ag-aloud"
      title={note || (on ? 'Replies are read aloud on this device only. Click to turn off.' : 'Read replies aloud on this device only (not the table speakers)')}>
      <i className={`fa-solid ${on ? 'fa-volume-high' : 'fa-volume-xmark'}`} aria-hidden="true" /> Read aloud{on ? ': on' : ''}
    </button>
  );
}

interface Spoken { chatId: string; text: string; request?: string; pending?: number }

/**
 * Listens for the reply to a spoken "Minerva, ..." request. It lives outside the chat so it works with the panel
 * collapsed. Clicking the notice opens that chat; `onOpen` lets the panel unfold itself.
 */
export function SpokenNotice({ onOpen, phone }: { onOpen?: () => void; phone?: boolean }) {
  const { on, info, isDM } = useWorld();
  const { client } = useAuth();
  const [shown, setShown] = useState<Spoken | null>(null);
  const world = info?.id ?? '';

  useEffect(() => {
    if (!isDM) return;
    return on(['agent'], (e) => {
      const d: any = e.data;
      if (d?.kind !== 'spoken' || !d.chatId || typeof d.text !== 'string') return;
      // The DM phone covers the screen and shows its own notice; the layout's (behind it) must not take the event first.
      if (!phone && document.querySelector('[data-testid="dmphone"]')) return;
      if (!claimSpoken(`${d.messageId ?? d.chatId}`)) return;
      setShown({ chatId: d.chatId, text: d.text, request: d.request, pending: d.pending });
      if (aloudNow()) void speakAloud(world, client.token, d.text);
    });
  }, [on, isDM, client, world, phone]);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 15_000);
    return () => clearTimeout(t);
  }, [shown]);

  const open = useCallback(() => {
    if (!shown) return;
    rememberChat(chatKey(world, 'dm'), shown.chatId);
    window.dispatchEvent(new CustomEvent(OPEN_CHAT, { detail: { chatId: shown.chatId } }));
    onOpen?.();
    setShown(null);
  }, [shown, world, onOpen]);

  if (!shown) return null;
  const line = shown.text.replace(/\s+/g, ' ').trim();
  return (
    <div className="toast ag-toast" role="status" data-testid="ag-spoken">
      <button type="button" className="ag-toast-open" onClick={open} aria-label="Open this reply in the assistant">
        <strong>{shown.request ? `You asked: ${shown.request}` : 'The assistant answered'}</strong>
        <span className="tiny">{line.slice(0, 160)}{line.length > 160 ? '…' : ''}{shown.pending ? ` (${shown.pending} proposal${shown.pending === 1 ? '' : 's'} waiting)` : ''}</span>
      </button>
      <button type="button" className="ag-x" aria-label="Dismiss" onClick={() => setShown(null)}>×</button>
    </div>
  );
}
