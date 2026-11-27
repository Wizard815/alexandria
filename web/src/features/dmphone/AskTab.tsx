// Ask: the GM's assistant on a phone. This is the real chat (agent/Chat.tsx) in its phone layout, so streaming,
// past chats, dictation, read-aloud and approval cards are the desktop's own. This file adds what is particular to the
// table: the session-so-far card, the combatant picked on Now, and the GM's own one-tap prompts.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Markdown } from '../../ui/index.tsx';
import Chat, { type ChatContext } from '../agent/Chat.tsx';
import type { Combatant } from './NowTab.tsx';
import { Sheet } from './Sheet.tsx';
import { buzz, lsGet, lsSet } from './hooks.ts';
import { DEFAULT_QUICK, MAX_QUICK, useQuickPrompts, type QuickPrompt } from './quick.ts';

/** A combatant as a line of context for the assistant. */
export function combatantLine(x: Combatant): string {
  const bits = [
    `initiative ${x.initiative}`,
    x.ac != null ? `AC ${x.ac}` : '',
    x.hp !== null ? `HP ${x.hp}/${x.max_hp}` : '',
    (x.temp_hp ?? 0) > 0 ? `${x.temp_hp} temporary HP` : '',
    x.concentration ? `concentrating on ${x.concentration.spell}${x.concentration.dc !== null ? ` (save DC ${x.concentration.dc})` : ''}` : '',
    x.death_saves && !x.death_saves.stable && !x.death_saves.dead ? `death saves ${x.death_saves.successes} successes, ${x.death_saves.failures} failures` : '',
    ...(x.effects ?? []).map((e) => e.name),
    x.hidden ? 'hidden from the players' : '',
  ].filter(Boolean);
  return `${x.name}${x.is_pc ? ' (a player character)' : ''}: ${bits.join(', ')}`;
}

export default function AskTab({ focus, turn, setFocus }: { focus: { id: string; name: string } | null; turn: { id: string; name: string } | null; setFocus: (f: { id: string; name: string } | null) => void }) {
  const { w, info } = useWorld();
  const [quick, saveQuick] = useQuickPrompts(info.id);
  const [editing, setEditing] = useState(false);

  const context: ChatContext | null = focus && {
    label: focus.name,
    drop: () => setFocus(null),
    // Read at send time: HP and conditions change by the minute in a fight.
    get: async () => {
      const x: Combatant | undefined = (await w.combat())?.combatants?.find((c: Combatant) => c.id === focus.id);
      return x ? `The GM has this combatant open on their phone (the fight as it is now): ${combatantLine(x)}` : undefined;
    },
  };

  return (
    <>
      <Chat phone harness="dm" placeholder="Ask, or tell it what to do…" header={<SoFar />} context={context} quickPrompts={quick} onEditQuick={() => setEditing(true)}
        attachable={!focus && turn ? { label: turn.name, attach: () => { buzz(8); setFocus(turn); } } : null} />
      {editing && <QuickEditor list={quick} onSave={saveQuick} onClose={() => setEditing(false)} />}
    </>
  );
}

/** The summary of the session so far (the GM's own, with everything they can read), folded away until wanted. */
function SoFar() {
  const { w } = useWorld();
  const [open, setOpen] = useState(() => lsGet('alx.dmphone.sofar') === '1');
  const st = useLoad<any>(() => w.call('GET', '/audio/status'), [w], ['recording']);
  const sid: string | null = st.data?.session?.id ?? st.data?.lastSession?.id ?? null;
  const sum = useLoad<any>(() => (sid ? w.call('GET', `/audio/sessions/${sid}/summary`) : Promise.resolve(null)), [w, sid], ['audio-summary']);
  if (!sid) return null;
  const live = !!st.data?.session;
  const text = String(sum.data?.text ?? '').trim();
  const toggle = () => { buzz(8); setOpen((v) => { lsSet('alx.dmphone.sofar', v ? '0' : '1'); return !v; }); };
  return (
    <div className="sofar" data-testid="sofar">
      <button type="button" className="b full sofar-head" aria-expanded={open} aria-controls="sofar-body" onClick={toggle}>
        <i className={`fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}`} aria-hidden="true" />
        <span className="grow tx" style={{ textAlign: 'left' }}>Session so far</span>
        <span className={`pill ${live ? 'red' : ''}`}>{live ? 'Recording' : 'Last session'}</span>
      </button>
      {open && <div id="sofar-body" className="sofar-body">{text ? <Markdown text={text} /> : <span className="sub">{sum.loading ? 'Loading…' : 'No summary yet. It is written as the session is transcribed.'}</span>}</div>}
    </div>
  );
}

function QuickEditor({ list, onSave, onClose }: { list: QuickPrompt[]; onSave: (v: QuickPrompt[]) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<QuickPrompt[]>(list);
  const set = (i: number, p: Partial<QuickPrompt>) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const done = () => { onSave(draft.filter((x) => x.label.trim() && x.text.trim()).map((x) => ({ label: x.label.trim().slice(0, 30), text: x.text.trim() }))); onClose(); };
  return (
    <Sheet title="Quick prompts" onClose={done}>
      <span className="sub">One tap sends the whole prompt. Kept on this device only.</span>
      {draft.map((q, i) => (
        <div key={i} className="c" role="group" aria-label={`Prompt ${i + 1}`}>
          <label className="f">Button<input value={q.label} maxLength={30} onChange={(e) => set(i, { label: e.target.value })} /></label>
          <label className="f">What it asks<textarea value={q.text} maxLength={600} onChange={(e) => set(i, { text: e.target.value })} /></label>
          <div className="grid g2">
            <button type="button" className="b" disabled={i === 0} onClick={() => setDraft((d) => { const n = [...d]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}><i className="fa-solid fa-arrow-up" aria-hidden="true" /> Earlier</button>
            <button type="button" className="b danger" aria-label={`Remove ${q.label || 'this prompt'}`} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}><i className="fa-solid fa-trash" aria-hidden="true" /> Remove</button>
          </div>
        </div>
      ))}
      <button type="button" className="b" disabled={draft.length >= MAX_QUICK} onClick={() => setDraft((d) => [...d, { label: '', text: '' }])}><i className="fa-solid fa-plus" aria-hidden="true" /> Add a prompt</button>
      <button type="button" className="b" onClick={() => setDraft(DEFAULT_QUICK)}>Back to the standard prompts</button>
      <button type="button" className="b primary big full" onClick={done}>Done</button>
    </Sheet>
  );
}
