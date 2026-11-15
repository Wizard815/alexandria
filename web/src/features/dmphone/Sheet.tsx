import { useEffect, type ReactNode } from 'react';

/** A bottom sheet: tap outside or press Escape to close. Rendered inside the phone root, so its controls share the phone styles. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="dmp-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dmp-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grab" aria-hidden="true" />
        <div className="row">
          <h2 className="grow tx">{title}</h2>
          <button type="button" className="b" onClick={onClose} aria-label="Close"><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Err({ error }: { error: string | null | undefined }) {
  return error ? <div className="err" role="alert">{error}</div> : null;
}
