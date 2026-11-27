// World settings → House rules: every rule that comes with Alexandria and the
// world's own, on or off, their options, what a rule switches in the world's
// settings, and import / export of rule files (.alxmod.json).
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { askAssistant } from '../agent/prefill.ts';
import { ErrorBox, Loading, Switch, useAction, useToast } from '../../ui/index.tsx';
import { GROUP_LABEL, useHouseRules, type HouseRule, type OptionSpec } from './shared.tsx';

export default function HouseRulesSettings() {
  return (
    <div className="stack">
      <RulesList />
      <MakeHouseRule />
    </div>
  );
}

/** Save a package (what the server's export gives) as a .alxmod.json file. */
function saveFile(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.alxmod.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Every rule this world has (systems by group, then table rules), each with its switch, options and export. */
export function RulesList() {
  const { isGM, w } = useWorld();
  const { rules, list } = useHouseRules();
  const { toastNode, toast } = useToast();
  const act = useAction();
  if (rules.loading && !rules.data) return <Loading />;
  const groups = [...new Set(list.map((r) => r.group).filter(Boolean))] as string[];
  const loose = list.filter((r) => !r.group);
  const done = (t: string) => { toast(t); void rules.reload(); };
  const on = list.filter((r) => r.enabled);
  const exportOn = () => act.run(async () => saveFile('house-rules', await w.call<any>('GET', '/mods/export')));
  return (
    <div className="stack">
      <p className="small muted">
        House rules are your table’s own rules. Each one is a small file: turn it on and it adds what it needs, such as counters on the
        players’ sheets, a chat word like <code>/reroll</code>, rule text for hover cards and the assistant, or a whole system like spell points.
      </p>
      <ErrorBox error={rules.error} />
      {groups.map((g) => (
        <section key={g} className="card stack">
          <h3>{GROUP_LABEL[g] ?? g}</h3>
          <p className="tiny muted">Only one of these is on at a time. With none on, spells use slots as written.</p>
          {list.filter((r) => r.group === g).map((r) => <RuleCard key={r.id} r={r} all={list} gm={isGM} onDone={done} />)}
        </section>
      ))}
      <section className="card stack">
        <h3>Table rules</h3>
        {loose.map((r) => <RuleCard key={r.id} r={r} all={list} gm={isGM} onDone={done} />)}
      </section>
      {isGM && on.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void exportOn()}>Export the {on.length} rule{on.length > 1 ? 's' : ''} that {on.length > 1 ? 'are' : 'is'} on</button>
          <span className="tiny muted">One package file (.alxmod.json) another GM can add under Make or add one.</span>
        </div>
      )}
      <ErrorBox error={act.error} />
      {toastNode}
    </div>
  );
}

const IDEAS: [string, string][] = [
  ['Hero points', 'Hero points: each player starts a session with 1 (most 3). Spend one to add 1d6 to a roll after seeing it.'],
  ['Lingering injuries', 'Lingering injuries: when a character drops to 0 HP they gain an injury point. A long rest removes one. At 3 they have disadvantage on Strength and Dexterity checks.'],
  ['Critical fumbles', 'Critical fumbles: on a natural 1 on an attack the GM may describe a mishap. Players can spend a fumble token (GM-given) to turn it into a plain miss.'],
  ['Session journal XP', 'Journal bonus: the GM gives a journal token to each player who writes a session recap. Spend one for advantage on any check.'],
  ['Downtime', 'Downtime: ready-made activities by tier (common 1 day up to legendary 3 months), players can add their own. When a day passes I press Downtime and each player keeps working, starts something or skips. I can add or take days and set a reward; a task is done when its days are in.'],
  ['Crafting projects', 'Crafting projects: a player starts a project with a name and the gold it costs; each long rest adds 1 day of work, and it is done after the days the item needs. I can drop a project or add days.'],
  ['Spell points', 'Spell points instead of spell slots, using the standard variant table, called "Spell points" on the sheet.'],
];

/** Make a rule with the assistant, or add a file someone shared, plus where whole systems come from. */
export function MakeHouseRule() {
  const { isGM } = useWorld();
  const { rules } = useHouseRules();
  const { toastNode, toast } = useToast();
  const [idea, setIdea] = useState('');
  if (!isGM) return null;
  const ask = () => askAssistant(`Make a house rule for my table: ${idea.trim()}\nRead house_rule_guide first and look at a close example with house_rule_file. Write it as a house rule file, check it with house_rule_check until it has no errors, tell me what it does from the check's preview, and save it with house_rule_save once I agree.`);
  return (
    <div className="stack">
      <section className="card stack">
        <h3>Make one with the assistant</h3>
        <p className="tiny muted">Say the rule in your own words. The assistant writes the file, checks it, shows it to you and saves it when you agree. It starts off; turn it on under Rules.</p>
        <textarea className="input" rows={3} aria-label="Describe your house rule" value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="My players get hero points: one per session, spend one to add 1d6 to a roll." />
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {IDEAS.map(([label, text]) => <button key={label} type="button" className="btn small" onClick={() => setIdea(text)}>{label}</button>)}
          <button type="button" className="btn small primary" disabled={!idea.trim()} onClick={ask}>Ask the assistant</button>
        </div>
      </section>
      <ImportBox onDone={(t) => { toast(t); void rules.reload(); }} />
      <section className="card stack">
        <h3>Bigger than a rule file</h3>
        <p className="small">
          A rule file can add counters, actions, rerolls, chat words, rest and session triggers, sheet cards, rule text and world settings.
          A rule that needs new code, like a whole spell system, is built as an Alexandria feature: a folder under <code>librarian/src/features</code> (and
          <code> web/src/features</code> for screens) that ships its switch as a house rule, the way spell points, MANA and spell crafting do. It then shows up under Rules like any other.
          See <code>docs/MODS.md</code> and <code>docs/FEATURES.md</code>.
        </p>
        <p className="small">
          The rules that come with Alexandria are files in the repo’s <code>mods/</code> folder. Whoever runs the server can drop more rule files or
          packages there (or point <code>ALX_MODS_DIR</code> at a folder of their own) and restart: they show up here for every world.
        </p>
      </section>
      {toastNode}
    </div>
  );
}

function RuleCard({ r, all, gm, onDone }: { r: HouseRule; all: HouseRule[]; gm: boolean; onDone: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const needs = r.needs ?? r.missing ?? [];
  const blocked = needs.length > 0;
  const nameOf = (id: string) => all.find((x) => x.id === id)?.name ?? id;
  const toggle = (on: boolean) => act.run(async () => {
    const sets = Object.keys(r.presets ?? {}).filter((k) => !(r.waiting ?? []).includes(k));
    const lines: string[] = [];
    if (sets.length) lines.push(`This ${on ? 'changes' : 'puts back'} these world settings: ${sets.join(', ')}.`);
    const dependents = on ? [] : all.filter((x) => x.enabled && x.requires?.[r.id]);
    if (on) {
      const needOn = Object.keys(r.requires ?? {}).filter((id) => !all.find((x) => x.id === id)?.enabled);
      if (needOn.length) lines.push(`It needs ${needOn.map(nameOf).join(', ')}, which will be turned on too.`);
      const clash = all.filter((x) => x.enabled && x.id !== r.id && (r.conflicts?.includes(x.id) || x.conflicts?.includes(r.id)));
      if (clash.length) lines.push(`It conflicts with ${clash.map((x) => x.name).join(', ')}, which will be turned off.`);
    } else if (dependents.length) lines.push(`${dependents.map((x) => x.name).join(', ')} ${dependents.length > 1 ? 'need' : 'needs'} it and will be turned off too.`);
    if (lines.length && !window.confirm(`${on ? 'Turn on' : 'Turn off'} ${r.name}?\n\n${lines.join('\n')}`)) return;
    const out = await w.call<any>('PUT', `/mods/${r.id}/enabled`, { on, ...(dependents.length ? { cascade: true } : {}) });
    const also = [out.turnedOn?.length ? `turned on ${out.turnedOn.map(nameOf).join(', ')}` : '', out.turnedOff?.length ? `turned off ${out.turnedOff.map(nameOf).join(', ')}` : ''].filter(Boolean).join('; ');
    onDone(`${r.name} is ${on ? 'on' : 'off'}${also ? ` (${also})` : ''}`);
  });
  const remove = () => act.run(async () => {
    if (!window.confirm(`Remove ${r.name} from this world? Its counters go too.`)) return;
    await w.call('DELETE', `/mods/${r.id}`);
    onDone(`${r.name} removed`);
  });
  const download = () => act.run(async () => saveFile(r.id, await w.call<any>('GET', `/mods/${r.id}/export`)));
  return (
    <div className="stack tight" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span>
          <strong>{r.name}</strong>{' '}
          <span className="tiny muted">v{r.version}{r.author ? ` · ${r.author}` : ''}{r.source === 'imported' ? ' · this world’s own' : ''}</span>
        </span>
        {gm && <Switch checked={r.enabled} label={`${r.name} on`} onChange={(v) => { if (!act.busy && !(v && blocked)) void toggle(v); }} />}
      </div>
      <div className="small">{r.summary}</div>
      {(r.targets?.builtFor.length || r.targets?.worksWith.length || Object.keys(r.requires ?? {}).length) ? (
        <div className="row tiny" style={{ gap: 6, flexWrap: 'wrap' }}>
          {r.targets.builtFor.map((t) => <span key={t.id} className="chip" title={t.ok ? 'Built for this part' : 'This world does not have it'} style={{ opacity: t.ok ? 1 : 0.6 }}>Built for {t.label}{t.ok ? '' : ' (missing)'}</span>)}
          {r.targets.worksWith.map((t) => <span key={t.id} className="chip muted" title={t.ok ? 'Adds to it' : 'Adds to it when it is there'}>Works with {t.label}</span>)}
          {Object.entries(r.requires ?? {}).map(([id, range]) => <span key={id} className="chip muted">Needs {nameOf(id)}{range !== '*' ? ` ${range}` : ''}</span>)}
        </div>
      ) : null}
      {blocked && <ul className="tiny muted" style={{ margin: 0, paddingLeft: 16 }} aria-label={`Why ${r.name} cannot be turned on`}>{needs.map((n) => <li key={n}>{n}</li>)}</ul>}
      {r.commands.length > 0 && <div className="tiny muted">Chat: {r.commands.map((c) => <code key={c} style={{ marginRight: 6 }}>{c}</code>)}</div>}
      <ErrorBox error={act.error} />
      {gm && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(Object.keys(r.optionSpecs).length > 0 || Object.keys(r.presets ?? {}).length > 0 || r.rules.length > 0) && <button type="button" className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide details' : 'Options and details'}</button>}
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void download()}>Export</button>
          {r.source === 'imported' && <button type="button" className="btn small" disabled={act.busy} onClick={() => void remove()}>Remove</button>}
        </div>
      )}
      {open && gm && <Details r={r} onDone={onDone} />}
    </div>
  );
}

function Details({ r, onDone }: { r: HouseRule; onDone: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [vals, setVals] = useState<Record<string, unknown>>(r.options);
  const save = () => act.run(async () => { await w.call('PUT', `/mods/${r.id}/options`, { options: vals }); onDone(`${r.name}: options saved`); });
  const presets = Object.entries(r.presets ?? {});
  return (
    <div className="stack tight">
      {Object.entries(r.optionSpecs).map(([k, s]) => <OptionField key={k} name={k} spec={s} value={vals[k]} onChange={(v) => setVals({ ...vals, [k]: v })} />)}
      {Object.keys(r.optionSpecs).length > 0 && <div><button type="button" className="btn small primary" disabled={act.busy} onClick={() => void save()}>Save options</button></div>}
      <ErrorBox error={act.error} />
      {(r.permissions?.length ?? 0) > 0 && <div className="tiny muted">Uses: {r.permissions!.join(', ')}{r.alexandria ? ` · for Alexandria ${r.alexandria}` : ''}{r.conflicts?.length ? ` · conflicts with ${r.conflicts.join(', ')}` : ''}</div>}
      {presets.length > 0 && (
        <details>
          <summary className="small">World settings this rule sets</summary>
          <ul className="tiny" style={{ margin: 0 }}>
            {presets.map(([k, v]) => <li key={k}><code>{k}</code>: {JSON.stringify(v).slice(0, 120)}{(r.waiting ?? []).includes(k) ? ' (not in this Alexandria yet, skipped)' : ''}</li>)}
          </ul>
        </details>
      )}
      {r.rules.map((x) => <div key={x.term} className="small"><strong>{x.term}.</strong> {x.text}</div>)}
    </div>
  );
}

function OptionField({ name, spec, value, onChange }: { name: string; spec: OptionSpec; value: unknown; onChange: (v: unknown) => void }) {
  const id = `opt-${name}`;
  return (
    <label className="stack tight" htmlFor={id}>
      <span className="small">{spec.label}{spec.help && <span className="tiny muted"> · {spec.help}</span>}</span>
      {spec.type === 'boolean' ? <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        : spec.type === 'int' ? <input id={id} className="input" type="number" min={spec.min} max={spec.max} value={Number(value ?? spec.default)} onChange={(e) => onChange(Math.trunc(Number(e.target.value)))} style={{ maxWidth: 120 }} />
          : spec.type === 'enum' ? <select id={id} className="input" value={String(value ?? spec.default)} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 220 }}>{spec.values.map((v) => <option key={v} value={v}>{v}</option>)}</select>
            : <input id={id} className="input" maxLength={spec.max} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

function ImportBox({ onDone }: { onDone: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [text, setText] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; errors: string[]; notes?: string[]; preview?: string[] | { id: string; lines: string[] }[]; mod?: any; mods?: any[]; package?: { name: string; author: string } | null } | null>(null);
  const parse = () => { try { return JSON.parse(text); } catch { return text; } };
  const run = () => act.run(async () => setCheck(await w.call<any>('POST', '/mods/check', { mod: parse() })));
  const save = () => act.run(async () => {
    const n = check?.mods?.length ?? 1;
    await w.call('POST', '/mods/import', { mod: parse() });
    setText(''); setCheck(null);
    onDone(n > 1 ? `${n} house rules saved. Turn them on under Rules.` : 'House rule saved. Turn it on under Rules.');
  });
  const file = async (f: File | undefined) => { if (f) { setText(await f.text()); setCheck(null); } };
  return (
    <section className="card stack">
      <h3>Add a house rule</h3>
      <p className="tiny muted">Open or paste a rule file or package (.alxmod.json) someone shared. It is checked first, and every rule in it starts off. The format is in docs/MODS.md.</p>
      <textarea className="input" rows={6} aria-label="House rule file" value={text} onChange={(e) => { setText(e.target.value); setCheck(null); }} placeholder='{ "kit": 1, "id": "hero-points", "name": "Hero points", ... }' style={{ fontFamily: 'monospace', fontSize: 12 }} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <label className="btn small">Open a file<input type="file" accept=".json,application/json" hidden onChange={(e) => void file(e.target.files?.[0])} /></label>
        <button type="button" className="btn small" disabled={act.busy || !text.trim()} onClick={() => void run()}>Check</button>
        <button type="button" className="btn small primary" disabled={act.busy || !check?.ok} onClick={() => void save()}>Save to this world</button>
      </div>
      <ErrorBox error={act.error} />
      {check && !check.ok && <ul className="small" role="alert">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {check?.ok && (
        <div className="small">
          Looks good{check.package?.name ? <>: package <strong>{check.package.name}</strong>{check.package.author ? ` by ${check.package.author}` : ''}</> : ''}
          <ul className="small" style={{ margin: '4px 0' }}>{(check.mods ?? [check.mod]).map((m: any, i: number) => {
            const lines = Array.isArray(check.preview) ? (typeof check.preview[0] === 'string' ? (i === 0 ? check.preview as string[] : []) : ((check.preview as { id: string; lines: string[] }[]).find((p) => p.id === m.id)?.lines ?? [])) : [];
            return (
              <li key={m.id}><strong>{m.name}</strong> <span className="tiny muted">v{m.version}{m.summary ? ` · ${m.summary}` : ''}</span>
                {lines.length ? <details><summary className="tiny">What it does</summary><ul className="tiny">{lines.map((l) => <li key={l}>{l}</li>)}</ul></details> : null}
              </li>
            );
          })}</ul>
          {check.notes?.length ? <ul className="tiny">{check.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        </div>
      )}
    </section>
  );
}
