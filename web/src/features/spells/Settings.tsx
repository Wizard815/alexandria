// World settings → Spells & mana: the Codex for players, mana instead of
// spell slots (pool, costs, rests, limits) and spell crafting.
import { useState } from 'react';
import { ErrorBox, Field, Switch, useAction, useToast } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { levelText } from './shared.tsx';

const REST: [string, string][] = [['none', 'Nothing'], ['quarter', 'A quarter'], ['half', 'Half'], ['full', 'All of it']];

export default function SpellSettings() {
  const { w, info, isDM, reloadInfo } = useWorld();
  const s: any = info.settings;
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [costs, setCosts] = useState<string[]>(() => (s.spellManaCosts ?? [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]).map(String));
  const pool0 = s.spellManaPool ?? { mode: 'formula', formula: 'level * 4 + mod', table: [] };
  const [pool, setPool] = useState<any>(() => ({ ...pool0, table: (pool0.table ?? []).join(', ') }));
  const max0 = s.spellManaMaxLevel ?? { on: false, table: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 9] };
  const [maxTable, setMaxTable] = useState<string>(() => (max0.table ?? []).join(', '));
  const save = (patch: Record<string, unknown>) => act.run(async () => { await w.updateSettings(patch); await reloadInfo(); toast('Saved'); });
  const nums = (t: string) => t.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (!isDM) return null;
  const sw = (key: string, label: string, help: string, def = false) => (
    <div className="row between" style={{ gap: 10 }}>
      <span className="stack tight"><span>{label}</span><span className="tiny muted">{help}</span></span>
      <Switch checked={s[key] ?? def} label={label} onChange={(v) => void save({ [key]: v })} />
    </div>
  );
  const rest = s.spellManaRest ?? { long: 'full', short: 'none' };
  return (
    <div className="stack">
      <ErrorBox error={act.error} />
      <section className="card stack">
        <h3>Codex</h3>
        {sw('spellsPublicSrd', 'Players may read every SRD spell', 'Off: players read the spells they know and the ones you open one by one.')}
        {sw('spellPlayerStats', 'Players fill in their own spell sheet', 'Class, level and ability scores on their Codex page. Off: only you set them.', true)}
      </section>

      <section className="card stack">
        <h3>Mana instead of spell slots</h3>
        {sw('spellMana', 'Use mana', 'Each character has a mana pool; casting a spell spends its cost.')}
        {s.spellMana && (
          <>
            <Field label="Cost per spell level" help="Cantrip, then levels 1 to 9. A spell can have its own cost in the Codex.">
              <div className="row" style={{ gap: 4 }}>
                {costs.map((c, i) => <input key={i} type="number" min={0} max={999} aria-label={`Mana cost, ${levelText(i)}`} value={c} onChange={(e) => setCosts(costs.map((x, j) => (j === i ? e.target.value : x)))} style={{ width: 56 }} />)}
              </div>
            </Field>
            <div className="row end"><button type="button" className="btn small" disabled={act.busy} onClick={() => void save({ spellManaCosts: costs.map(Number) })}>Save costs</button></div>
            <Field label="Pool size" help={pool.mode === 'formula' ? 'Names: level, mod (spellcasting modifier), int, wis, cha, str, dex, con, intMod … and min, max, floor, ceil.' : 'Twenty numbers: the pool at levels 1 to 20.'}>
              <div className="stack">
                <select value={pool.mode} onChange={(e) => setPool({ ...pool, mode: e.target.value })} aria-label="Pool from"><option value="formula">A formula</option><option value="table">A table by level</option></select>
                {pool.mode === 'formula'
                  ? <input value={pool.formula} onChange={(e) => setPool({ ...pool, formula: e.target.value })} aria-label="Pool formula" />
                  : <input value={pool.table} onChange={(e) => setPool({ ...pool, table: e.target.value })} aria-label="Pool table" />}
              </div>
            </Field>
            <div className="row end"><button type="button" className="btn small" disabled={act.busy} onClick={() => void save({ spellManaPool: { mode: pool.mode, formula: pool.formula, table: nums(pool.table).length === 20 ? nums(pool.table) : pool0.table } })}>Save pool</button></div>
            <div className="row" style={{ gap: 10 }}>
              <Field label="A long rest gives back"><select value={rest.long} onChange={(e) => void save({ spellManaRest: { ...rest, long: e.target.value } })}>{REST.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
              <Field label="A short rest gives back"><select value={rest.short} onChange={(e) => void save({ spellManaRest: { ...rest, short: e.target.value } })}>{REST.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
            </div>
            {sw('spellManaOverdraw', 'Allow casting with too little mana', 'Mana goes below zero; you decide what that costs.')}
            <div className="row between" style={{ gap: 10 }}>
              <span className="stack tight"><span>Limit the spell level mana can cast</span><span className="tiny muted">By character level, 1 to 20.</span></span>
              <Switch checked={!!max0.on} label="Limit the spell level mana can cast" onChange={(v) => void save({ spellManaMaxLevel: { on: v, table: nums(maxTable).length === 20 ? nums(maxTable) : max0.table } })} />
            </div>
            {max0.on && (
              <div className="row" style={{ gap: 6 }}>
                <input value={maxTable} onChange={(e) => setMaxTable(e.target.value)} aria-label="Highest spell level by character level" style={{ flex: 1 }} />
                <button type="button" className="btn small" disabled={act.busy || nums(maxTable).length !== 20} onClick={() => void save({ spellManaMaxLevel: { on: true, table: nums(maxTable) } })}>Save limits</button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card stack">
        <h3>Spell crafting</h3>
        {sw('spellCrafting', 'Learn spells by combining known ones', 'Players see the recipes you make visible, what they can learn now and what each still needs.')}
        {s.spellCrafting && (
          <div className="row" style={{ gap: 10 }}>
            <Field label="Learning a spell"><select value={s.spellCraftApproval ?? 'dm'} onChange={(e) => void save({ spellCraftApproval: e.target.value })}><option value="dm">Waits for my approval</option><option value="auto">Happens at once</option></select></Field>
            <Field label="Recipes I hide"><select value={s.spellCraftHidden ?? 'mystery'} onChange={(e) => void save({ spellCraftHidden: e.target.value })}><option value="mystery">Show as ???</option><option value="hide">Do not show at all</option></select></Field>
          </div>
        )}
      </section>
      {toastNode}
    </div>
  );
}
