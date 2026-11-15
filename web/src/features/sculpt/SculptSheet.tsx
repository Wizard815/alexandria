// A template opened in a side sheet from anywhere (combat, a library page, quick gen, the stage).
import { useEffect, useState } from 'react';
import { ErrorBox, Loading } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import Workshop from './Workshop.tsx';
import type { OutputKey, SculptContext, Tpl, Values } from './types.ts';
import './sculpt.css';

export interface SheetProps {
  /** A template key ("encounter"), id or name. */
  template: string;
  values?: Values;
  context?: SculptContext;
  /** Sculpt as soon as it opens. */
  autoSculpt?: boolean;
  /** Outputs to tick on opening. */
  preset?: Partial<Record<OutputKey, boolean>>;
  onClose: () => void;
  onDone?: (what: string) => void;
}

export default function SculptSheet({ template, values, context, autoSculpt, preset, onClose, onDone }: SheetProps) {
  const { w } = useWorld();
  const [tpl, setTpl] = useState<Tpl | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    w.call<{ templates: Tpl[] }>('GET', '/sculpt/templates').then((r) => {
      const t = r.templates.find((x) => x.id === template || x.key === template || x.name.toLowerCase() === template.toLowerCase());
      if (!live) return;
      if (t) setTpl(t); else setErr(`There is no template called “${template}”.`);
    }).catch((e) => { if (live) setErr(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [w, template]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sculpt-sheet-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sculpt-sheet" role="dialog" aria-modal="true" aria-label={tpl ? `Sculpt: ${tpl.name}` : 'Sculpting'}>
        <div className="row between"><strong>Sculpting</strong><button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">✕</button></div>
        <ErrorBox error={err} />
        {!tpl && !err ? <Loading /> : tpl && <Workshop tpl={tpl} initial={values} context={context} autoSculpt={autoSculpt} preset={preset} onDone={onDone} />}
      </div>
    </div>
  );
}
