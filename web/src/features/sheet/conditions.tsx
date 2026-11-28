// Conditions on the sheet come from the world's game modules (SRD 5.2, SRD
// 5.1 or whatever the GM imported): the picker lists every condition those
// modules define, and hovering a condition shows its rules summary. A tap
// opens the full text. Common table states that are not rules conditions
// (Concentrating, Blessed…) stay on the list too.
import { useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Loading, Modal } from '../../ui/index.tsx';
import { CONDITIONS } from './shared.tsx';

export interface CondInfo { id: string; term: string; summary: string; module: string; aliases: string[] }
const EXTRAS = ['Concentrating', 'Blessed', 'Hasted', 'Raging', 'Hidden', 'Dodging', 'Inspired'];

/** The conditions the world's modules define, by lower-case name (and alias). */
export function useConditions() {
  const { w } = useWorld();
  const res = useLoad<{ terms: CondInfo[] }>(() => w.call('GET', '/modules/terms?kind=condition&limit=200'), [w], ['modules']);
  const terms = res.data?.terms ?? [];
  const byName = new Map<string, CondInfo>();
  for (const t of terms) for (const n of [t.term, ...(t.aliases ?? [])]) byName.set(n.toLowerCase(), t);
  // No game module with conditions in this world: the usual 5e list, without rules text.
  if (!terms.length) return { byName, names: CONDITIONS };
  const names = [...terms.map((t) => t.term).sort((a, b) => a.localeCompare(b)), ...EXTRAS.filter((x) => !byName.has(x.toLowerCase()))];
  return { byName, names };
}

/** One condition chip: hover or focus shows the rules summary, a tap the full text. */
export function ConditionChip({ name, info, onRemove }: { name: string; info?: CondInfo; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="chip gold sht-cond">
      {info ? <button type="button" className="sht-cond-name" aria-describedby={`cond-${info.id}`} onClick={() => setOpen(true)}>{name}</button> : <span>{name}</span>}
      {info && <span role="tooltip" id={`cond-${info.id}`} className="sht-tip"><strong>{info.term}</strong>{info.summary}<span className="faint"> · {info.module}</span></span>}
      {onRemove && <button type="button" aria-label={`Remove ${name}`} onClick={onRemove}>✕</button>}
      {open && info && <TermModal id={info.id} title={info.term} onClose={() => setOpen(false)} />}
    </span>
  );
}

function TermModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const { w } = useWorld();
  const t = useLoad<any>(() => w.call('GET', `/modules/terms/${encodeURIComponent(id)}`), [w, id]);
  return (
    <Modal title={title} onClose={onClose}>
      {t.loading && !t.data ? <Loading /> : <p className="small" style={{ whiteSpace: 'pre-line' }}>{t.data?.text || t.data?.summary}</p>}
      {t.data?.module && <p className="tiny faint">{t.data.module}{t.data.attribution ? ` · ${t.data.attribution}` : ''}</p>}
    </Modal>
  );
}
