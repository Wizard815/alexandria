// Copying that also works on plain http (a LAN address): browsers hide navigator.clipboard there, so fall back to a hidden text box.
import { useEffect, useRef, useState } from 'react';

export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* blocked: try the old way */ }
  const active = document.activeElement as HTMLElement | null;
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  // Inside an open dialog, so a focus trap does not steal the selection back.
  (active?.closest('[role=dialog]') ?? document.body).appendChild(box);
  box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  box.remove();
  active?.focus?.();
  return ok;
}

/** A button that says whether the copy worked. */
export function CopyButton({ text, label = 'Copy', className = 'btn small' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'' | 'ok' | 'bad'>('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = async () => {
    setState((await copyText(text)) ? 'ok' : 'bad');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(''), 2500);
  };
  return <button type="button" className={className} onClick={() => void go()}><i className={`fa-solid ${state === 'ok' ? 'fa-check' : 'fa-copy'}`} aria-hidden="true" /> {state === 'ok' ? 'Copied' : state === 'bad' ? 'Select it and press Ctrl+C' : label}</button>;
}
