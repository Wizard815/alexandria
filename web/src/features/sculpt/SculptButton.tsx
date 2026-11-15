// A small entry point other screens drop in: a button that opens a template in a side sheet. DM only.
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import SculptSheet from './SculptSheet.tsx';
import type { OutputKey, SculptContext, Values } from './types.ts';

export default function SculptButton({ template, label, values, context, autoSculpt, preset, onDone, className = 'btn small' }: {
  template: string; label: string; values?: Values; context?: SculptContext; autoSculpt?: boolean; preset?: Partial<Record<OutputKey, boolean>>; onDone?: (what: string) => void; className?: string;
}) {
  const { isDM } = useWorld();
  const [open, setOpen] = useState(false);
  if (!isDM) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      {open && <SculptSheet template={template} values={values} context={context} autoSculpt={autoSculpt} preset={preset} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}
