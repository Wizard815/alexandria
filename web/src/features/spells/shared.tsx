// Shared parts of the Codex: types, the spell card, the search box with every
// filter, and the mana bar.
import { useMemo, useState, type ReactNode } from 'react';
import { Empty, Loading, Markdown } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';

export interface Spell {
  id: string; name: string; level: number; school: string; classes: string[]; castingTime: string; ritual: boolean; range: string;
  components: { v: boolean; s: boolean; m: boolean }; componentsText: string; material: string; materialCost: boolean; materialConsumed: boolean;
  duration: string; concentration: boolean; damageTypes: string[]; saves: string[]; attack: string; text?: string; source: string; builtin: boolean;
  attribution: string; line: string; manaCost: number; known: boolean; how?: string;
  // GM only
  kind?: string; public?: boolean; manaOverride?: number | null; dmNotes?: string;
}
export interface Stub { id: string; name: string; level: number; school: string; line: string }
export type Missing =
  | { kind: 'spell'; id: string; name: string }
  | { kind: 'item'; name: string; need: number; have: number }
  | { kind: 'stat'; ability: string; need: number; have: number | null }
  | { kind: 'level'; need: number; have: number | null }
  | { kind: 'mana'; need: number; have: number | null };
export interface RecipeView {
  id: string; tier: number; result: Stub; prereqs: Stub[]; items: { name: string; qty: number; consumed: boolean; have?: number; itemId?: string }[];
  stats: Record<string, number>; minLevel: number | null; manaCost: number | null;
  status?: 'learned' | 'ready' | 'locked'; missing?: Missing[]; met?: number; total?: number; pending?: string | null;
  visibility?: 'visible' | 'hidden'; dmNotes?: string; draft?: boolean; createdBy?: string;
}
export interface Mana { on: boolean; now?: number | null; max?: number | null; manual?: boolean; maxCastLevel?: number | null }
export interface Character {
  accountId: string; name: string; class: string; level: number | null; abilities: Record<string, number>; castingAbility: string; manaMax: number | null;
  mana: Mana; from: { level?: string; abilities?: string[] }; known?: Spell[] | number;
}

export const ABILITIES: [string, string][] = [['str', 'STR'], ['dex', 'DEX'], ['con', 'CON'], ['int', 'INT'], ['wis', 'WIS'], ['cha', 'CHA']];
export const ABILITY_NAME: Record<string, string> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const levelText = (n: number) => (n === 0 ? 'Cantrip' : `Level ${n}`);

export function missingText(m: Missing): string {
  switch (m.kind) {
    case 'spell': return `Know ${m.name}`;
    case 'item': return `${m.need} × ${m.name} (you have ${m.have})`;
    case 'stat': return `${ABILITY_NAME[m.ability] ?? m.ability} ${m.need} (${m.have ?? 'not set'})`;
    case 'level': return `Level ${m.need} (${m.have ?? 'not set'})`;
    case 'mana': return `${m.need} mana (${m.have ?? 'none'})`;
  }
}

export function ManaBar({ mana, label = 'Mana' }: { mana: Mana; label?: string }) {
  if (!mana.on) return null;
  if (mana.max === null || mana.max === undefined) return <p className="tiny muted">{label}: set your level to get a pool.</p>;
  const now = mana.now ?? mana.max;
  const pct = mana.max > 0 ? Math.max(0, Math.min(100, (now / mana.max) * 100)) : 0;
  return (
    <div className="spl-mana" data-testid="mana">
      <div className="row between"><strong>{label}</strong><span className="spl-mana-num" aria-label={`${label} ${now} of ${mana.max}`}>{now} / {mana.max}</span></div>
      <div className="spl-bar" role="meter" aria-valuemin={0} aria-valuemax={mana.max} aria-valuenow={now} aria-label={label}><span style={{ width: `${pct}%` }} /></div>
      {mana.maxCastLevel !== null && mana.maxCastLevel !== undefined && <span className="tiny muted">Casts spells up to level {mana.maxCastLevel}.</span>}
    </div>
  );
}

export function SpellFacts({ s }: { s: Spell }) {
  const rows: [string, ReactNode][] = [
    ['Casting time', <>{s.castingTime}{s.ritual ? ' or ritual' : ''}</>],
    ['Range', s.range],
    ['Components', s.componentsText || '—'],
    ['Duration', <>{s.concentration ? 'Concentration, ' : ''}{s.duration}</>],
  ];
  if (s.classes.length) rows.push(['Classes', s.classes.join(', ')]);
  if (s.damageTypes.length) rows.push(['Damage', s.damageTypes.join(', ')]);
  if (s.saves.length) rows.push(['Save', s.saves.join(', ')]);
  if (s.attack) rows.push(['Attack', `${s.attack[0].toUpperCase()}${s.attack.slice(1)} spell attack`]);
  return <dl className="spl-facts">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** A spell in full: the line, the facts, the text and where it came from. */
export function SpellCard({ s, mana, actions }: { s: Spell; mana?: Mana; actions?: ReactNode }) {
  return (
    <article className="spl-card stack" aria-label={s.name}>
      <div className="row between top">
        <div className="stack tight"><h2 style={{ margin: 0 }}>{s.name}</h2><span className="muted">{s.line}</span></div>
        <span className="row" style={{ gap: 6 }}>
          {mana?.on && <span className="chip gold" title="Mana cost">{s.manaCost} mana</span>}
          {s.known && <span className="chip green">Known</span>}
          {s.public && <span className="chip teal">Public</span>}
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {s.concentration && <span className="chip">Concentration</span>}
        {s.ritual && <span className="chip">Ritual</span>}
        {s.materialCost && <span className="chip">Costly material</span>}
        {s.materialConsumed && <span className="chip">Consumed</span>}
      </div>
      <SpellFacts s={s} />
      {s.text !== undefined ? <Markdown text={s.text} /> : null}
      {s.dmNotes ? <div className="note"><strong>GM notes.</strong> {s.dmNotes}</div> : null}
      {actions}
      <p className="tiny faint">{s.source}{s.attribution ? ` · ${s.attribution}` : ''}</p>
    </article>
  );
}

/** Load one spell in full. */
export function useSpell(id: string | null) {
  const { w } = useWorld();
  return useLoad<Spell | null>(() => (id ? w.call('GET', `/spells/s/${encodeURIComponent(id)}`) : Promise.resolve(null)), [w, id], ['spells', 'spells-char']);
}

// ---- search with every filter ---------------------------------------------------------------------------

const TRI: [string, string][] = [['', 'Any'], ['1', 'Yes'], ['0', 'No']];
export interface Filters { [k: string]: string }

export function SpellSearch({ onPick, picked, extra = '', badge, label = 'Find a spell' }: { onPick: (s: Spell) => void; picked?: string | null; extra?: string; badge?: (s: Spell) => ReactNode; label?: string }) {
  const { w } = useWorld();
  const [f, setF] = useState<Filters>({});
  const set = (k: string, v: string) => setF((o) => ({ ...o, [k]: v }));
  const qs = useMemo(() => Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'), [f]);
  const facets = useLoad<any>(() => w.call('GET', '/spells/facets'), [w], ['spells', 'spells-char']);
  const list = useLoad<{ total: number; spells: Spell[] }>(() => w.call('GET', `/spells/list?limit=200&${qs}${extra ? `&${extra}` : ''}`), [w, qs, extra], ['spells', 'spells-char']);
  const nOn = Object.entries(f).filter(([k, v]) => v !== '' && k !== 'q').length;
  const sel = (k: string, lab: string, opts: [string, string][]) => (
    <label className="field spl-f"><span className="tiny">{lab}</span><select aria-label={lab} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
  );
  const txt = (k: string, lab: string, ph: string) => (
    <label className="field spl-f"><span className="tiny">{lab}</span><input aria-label={lab} placeholder={ph} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></label>
  );
  const fc = facets.data ?? {};
  const any = (xs: string[] = []): [string, string][] => [['', 'Any'], ...xs.map((x): [string, string] => [x, x])];
  return (
    <div className="stack spl-search">
      <label className="field"><span className="sr-only">{label}</span><input type="search" placeholder="Find a spell by name…" value={f.q ?? ''} onChange={(e) => set('q', e.target.value)} aria-label={label} /></label>
      <details className="spl-filters">
        <summary>Filters{nOn ? ` (${nOn})` : ''}</summary>
        <div className="spl-fgrid">
          {sel('level', 'Level', [['', 'Any'], ['0', 'Cantrip'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string, string] => [String(n), String(n)])])}
          {sel('school', 'School', any(fc.schools))}
          {sel('class', 'Class', any(fc.classes))}
          {sel('castingTime', 'Casting time', [['', 'Any'], ['action', 'Action'], ['bonus', 'Bonus action'], ['reaction', 'Reaction'], ['long', 'Minutes or hours']])}
          {txt('range', 'Range', 'self, touch, 60 feet')}
          {txt('duration', 'Duration', 'minute, hour…')}
          {sel('concentration', 'Concentration', TRI)}
          {sel('ritual', 'Ritual', TRI)}
          {sel('v', 'Verbal (V)', TRI)}
          {sel('s', 'Somatic (S)', TRI)}
          {sel('m', 'Material (M)', TRI)}
          {txt('material', 'Material text', 'diamond…')}
          {sel('costly', 'Costly material', TRI)}
          {sel('consumed', 'Material consumed', TRI)}
          {sel('damage', 'Damage type', any(fc.damageTypes))}
          {sel('save', 'Saving throw', any(fc.saves))}
          {sel('source', 'Source', any(fc.sources))}
          {sel('text', 'Search the text too', [['', 'No'], ['1', 'Yes']])}
        </div>
        {nOn > 0 && <button type="button" className="btn small ghost" onClick={() => setF({ q: f.q ?? '' })}>Clear filters</button>}
      </details>
      <div className="list spl-list" role="list" aria-label="Spells">
        {list.loading && !list.data ? <div style={{ padding: 12 }}><Loading /></div> : (list.data?.spells ?? []).length ? list.data!.spells.map((s) => (
          <button key={s.id} type="button" role="listitem" className={`list-item${picked === s.id ? ' active' : ''}`} aria-current={picked === s.id || undefined} onClick={() => onPick(s)}>
            <span className="stack tight grow"><strong>{s.name}</strong><span className="tiny muted">{s.line}</span></span>
            {badge?.(s)}
          </button>
        )) : <Empty>No spells match.</Empty>}
      </div>
      {list.data && list.data.total > list.data.spells.length && <p className="tiny muted">Showing {list.data.spells.length} of {list.data.total}. Narrow it down with the filters.</p>}
    </div>
  );
}

export const CSS = `
.spl-name { background: none; border: 0; padding: 0; min-height: 40px; color: inherit; font: inherit; text-align: left; cursor: pointer; text-decoration: underline dotted; }
.spl-mana { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
.spl-mana-num { font-variant-numeric: tabular-nums; font-weight: 700; }
.spl-bar { height: 10px; border-radius: 999px; background: var(--line); overflow: hidden; }
.spl-bar > span { display: block; height: 100%; background: linear-gradient(90deg, var(--teal), var(--accent)); }
.spl-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 14px; margin: 0; }
.spl-facts dt { font-size: 12px; color: var(--muted); } .spl-facts dd { margin: 0; }
.spl-filters summary { cursor: pointer; }
.spl-fgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 8px; }
.spl-f select, .spl-f input { width: 100%; min-width: 0; }
.spl-list { max-height: 60vh; overflow: auto; margin: 0 -18px; }
.spl-recipe { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.spl-recipe.ready { border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok) inset; background: color-mix(in srgb, var(--ok) 8%, transparent); }
.spl-recipe.mystery { border-style: dashed; color: var(--muted); }
.spl-recipe.draft { border-style: dashed; border-color: var(--accent); }
.spl-plus { color: var(--muted); }
.spl-miss { margin: 0; padding-left: 18px; color: var(--danger-text); font-size: 14px; }
.spl-tiers { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 6px; align-items: flex-start; }
.spl-tier { flex: 0 0 240px; display: flex; flex-direction: column; gap: 8px; }
.spl-abil { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; }
.spl-abil input { width: 100%; min-width: 0; text-align: center; }
@media (max-width: 640px) { .spl-abil { grid-template-columns: repeat(3, minmax(0, 1fr)); } .spl-list { max-height: none; } }
`;
