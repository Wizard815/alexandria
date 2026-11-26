// The Codex's Spell tree tab: the shared tree view (./tree, from the Spell
// Tree app) on this world's /spells/tree and /spells/study routes. Players see
// their own; the DM picks a character.
import { useEffect, useMemo, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import SpellTree from './tree/SpellTree.tsx';
import type { TreeBackend } from './tree/types.ts';

const LIVE = ['spells', 'spells-char', 'spells-study', 'spells-recipes', 'spells-learn', 'settings'];

export default function TreeTab() {
  const { w, isDM, members, on } = useWorld();
  const players = members.filter((m) => m.role === 'player');
  const [aid, setAid] = useState<string>('');
  const who = isDM ? aid || players[0]?.id || '' : 'me';
  const [tick, setTick] = useState(0);
  useEffect(() => on(LIVE, () => setTick((n) => n + 1)), [on]);
  const backend = useMemo<TreeBackend>(() => {
    const acc = isDM ? { accountId: who } : {};
    const q = isDM ? `?accountId=${encodeURIComponent(who)}` : '';
    return {
      tree: () => w.call('GET', `/spells/tree${q}`),
      spell: (id) => w.call('GET', `/spells/s/${encodeURIComponent(id)}`).catch(() => null) as any,
      plan: (spellId, source, lab) => w.call('POST', '/spells/study/plan', { spellId, source, lab, ...acc }),
      studies: () => w.call('GET', `/spells/study${q}`).then((x: any) => x.studies ?? []),
      start: (spellId, o) => w.call('POST', '/spells/study', { spellId, ...o, ...acc }),
      days: (sid, days) => w.call('POST', `/spells/study/${sid}/days`, { days }),
      check: (sid, d20) => w.call('POST', `/spells/study/${sid}/check`, d20 === undefined ? {} : { d20 }),
      scrollCast: (sid) => w.call('POST', `/spells/study/${sid}/scroll-cast`),
      stop: (sid) => w.call('POST', `/spells/study/${sid}/stop`),
      ...(isDM ? { give: (spellId: string) => w.call('POST', `/spells/characters/${encodeURIComponent(who)}/known`, { spellId }) } : {}),
    } as TreeBackend;
  }, [w, isDM, who]);
  if (isDM && !players.length) return <p className="muted">No players in this world yet.</p>;
  return (
    <div className="stack">
      {isDM && (
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span>Character</span>
          <select aria-label="Character" value={who} onChange={(e) => setAid(e.target.value)}>
            {players.map((m) => <option key={m.id} value={m.id}>{m.character_name || m.display_name}</option>)}
          </select>
        </label>
      )}
      <SpellTree key={who} backend={backend} reloadKey={tick} />
    </div>
  );
}
