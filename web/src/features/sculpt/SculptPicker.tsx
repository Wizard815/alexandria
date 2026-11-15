// "Sculpt from this page" / "New card from template": pick a template, and it opens in a side sheet. DM only.
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import SculptSheet from './SculptSheet.tsx';
import type { OutputKey, SculptContext } from './types.ts';

export interface PickerEntry { key: string; label: string }
const FROM_PAGE: PickerEntry[] = [
  { key: 'npc', label: 'An NPC' }, { key: 'shop', label: 'A shop' }, { key: 'scene-dm', label: 'A scene' }, { key: 'tavern', label: 'A tavern' },
  { key: 'rumours', label: 'Rumours' }, { key: 'quest-hook', label: 'A quest hook' }, { key: 'encounter', label: 'An encounter' },
];

export default function SculptPicker({ label = 'Sculpt from this page', pageId, entries = FROM_PAGE, preset, autoSculpt, className = 'btn small' }: {
  label?: string; pageId?: string; entries?: PickerEntry[]; preset?: Partial<Record<OutputKey, boolean>>; autoSculpt?: boolean; className?: string;
}) {
  const { isDM } = useWorld();
  const [open, setOpen] = useState(false);
  const [tpl, setTpl] = useState<string | null>(null);
  if (!isDM) return null;
  const context: SculptContext | undefined = pageId ? { page: pageId } : undefined;
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <span role="menu" className="card" style={{ position: 'absolute', zIndex: 30, left: 0, top: '100%', marginTop: 4, padding: 6, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 170 }}>
          {entries.map((e) => <button key={e.key} type="button" role="menuitem" className="btn small ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setTpl(e.key); setOpen(false); }}>{e.label}</button>)}
        </span>
      )}
      {tpl && <SculptSheet template={tpl} context={context} preset={preset} autoSculpt={autoSculpt} onClose={() => setTpl(null)} />}
    </span>
  );
}
