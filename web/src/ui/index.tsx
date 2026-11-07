// Shared building blocks. Keep screens made of these so both looks match.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function PageHead({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="lead"><h1>{title}</h1>{lead && <p className="muted">{lead}</p>}</div>
      {children && <div className="row">{children}</div>}
    </header>
  );
}

export function Loading({ what = '' }: { what?: string }) {
  return <p className="muted" role="status">Loading{what ? ` ${what}` : ''}…</p>;
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="error-box" role="alert">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {help && <span className="tiny">{help}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map(([k, text]) => (
        <button key={k} type="button" role="tab" aria-selected={k === value} className="btn small" onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between"><h2>{title}</h2><button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

const VIS_LABEL: Record<string, string> = { dm: 'DM only', party: 'Party', me: 'Only me' };
export function VisChip({ v }: { v: string }) {
  return <span className={`chip ${v === 'party' ? 'teal' : v === 'me' ? '' : 'red'}`}>{VIS_LABEL[v] ?? v}</span>;
}

/** Pick who can see something. `options` limits the choices. */
export function VisibilityPicker({ value, onChange, options = ['dm', 'party'], labels }: { value: string; onChange: (v: any) => void; options?: string[]; labels?: Record<string, string> }) {
  return (
    <div className="tabs" role="radiogroup" aria-label="Who can see this">
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} className={`btn small${value === o ? ' on' : ''}`} onClick={() => onChange(o)}>{labels?.[o] ?? VIS_LABEL[o] ?? o}</button>
      ))}
    </div>
  );
}

/**
 * Render library Markdown safely. [[Wiki links]] become links when `linkTo`
 * is given; "(hidden)" from the leak guard is shown greyed.
 */
export function Markdown({ text, linkTo }: { text: string; linkTo?: (title: string) => string }) {
  const html = useMemo(() => {
    const withLinks = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, label?: string) => {
      const shown = (label ?? t).replace(/[<>&"]/g, '');
      return linkTo ? `<a class="wikilink" href="${linkTo(t.trim()).replace(/"/g, '%22')}">${shown}</a>` : `<span class="wikilink">${shown}</span>`;
    }).replace(/\(hidden\)/g, '<span class="hidden-link">(hidden)</span>');
    const raw = marked.parse(withLinks, { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [text, linkTo]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Small toast for "Saved" and errors. */
export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? <div className="toast" role="status">{msg}</div> : null;
  return { toast: setMsg, toastNode: node };
}

/** Run an async action with busy state and error capture. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e: any) {
      setError(e.message ?? String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
