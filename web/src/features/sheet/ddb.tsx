// Importing a character from D&D Beyond, and the Character module that shows
// it. There is no official D&D Beyond API: the import reads the character JSON
// the D&D Beyond site uses for itself, so every screen here says it can break
// without notice, and a player can paste the JSON by hand instead.
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { dateLong } from '../../lib/format.ts';
import { ErrorBox, Modal, useAction } from '../../ui/index.tsx';

export const DDB_WARNING = 'D&D Beyond has no official API. This import reads the character data the D&D Beyond site uses for itself, so it can break or change without notice. Check the numbers after importing.';
const AB = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type Ab = (typeof AB)[number];

export interface DdbCharacter {
  source: 'dndbeyond'; ddbId: string; url: string; importedAt: string;
  name: string; race: string; background: string; alignment: string;
  classes: { name: string; subclass: string; level: number }[]; level: number;
  abilities: Record<Ab, number>; castingAbility: string;
  hp: { max: number; now: number; temp: number }; ac: number | null; speed: number | null; prof: number;
  saves: Ab[]; skills: { name: string; expertise: boolean }[]; languages: string[]; feats: string[];
  spells: { name: string; level: number }[]; items: { name: string; qty: number; equipped: boolean }[];
  coins: Partial<Record<'pp' | 'gp' | 'ep' | 'sp' | 'cp', number>>; conditions: string[];
  // Added later: a character imported before these existed has none of them.
  initiative?: number; passivePerception?: number; inspiration?: boolean;
  hitDice?: { die: number; total: number; used: number }[];
  slots?: { level: number; max: number; used: number }[]; pact?: { level: number; max: number; used: number } | null;
  attacks?: { name: string; hit: number; damage: string; range: string }[];
  features?: { name: string; from: string }[];
  uses?: { name: string; max: number; used: number; reset: string }[];
  traits?: { personality: string; ideals: string; bonds: string; flaws: string; backstory: string };
}
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
/** Filled and empty dots for used and left (slots, uses). */
const Dots = ({ max, used, label }: { max: number; used: number; label: string }) => (
  <span className="sht-tokens" role="img" aria-label={`${label}: ${max - used} of ${max} left`}>{Array.from({ length: Math.min(max, 12) }, (_, i) => <span key={i} className={i < max - used ? 'on' : ''} />)}</span>
);

const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const mod = (score: number) => Math.floor((score - 10) / 2);
const classLine = (c: DdbCharacter) => c.classes.map((k) => `${k.name}${k.subclass ? ` (${k.subclass})` : ''} ${k.level}`).join(' / ');

export function DdbWarning({ short = false }: { short?: boolean }) {
  return (
    <p className="sht-warn" role="note" data-testid="ddb-warning">
      <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" />
      <span>{short ? 'Unofficial D&D Beyond import: it can break without notice.' : DDB_WARNING}</span>
    </p>
  );
}

/** The Character module: the imported summary, read-only, with Update for the owner and the DM. */
export function CharacterMod({ c, onUpdate }: { c: DdbCharacter; onUpdate?: () => void }) {
  if (!c?.name) return <span className="tiny muted">No character imported yet.</span>;
  const spellsBy = c.spells.reduce<Record<number, string[]>>((o, s) => { (o[s.level] ??= []).push(s.name); return o; }, {});
  const coins = (['pp', 'gp', 'ep', 'sp', 'cp'] as const).filter((k) => c.coins[k]).map((k) => `${c.coins[k]} ${k}`).join(', ');
  return (
    <div className="stack tight" data-testid="ddb-character">
      <div>
        <strong>{c.name}</strong>
        <div className="tiny muted">{[c.race, classLine(c), c.background, c.alignment].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="sht-stats">
        {AB.map((k) => (
          <div key={k} className={c.saves.includes(k) ? 'save' : ''} title={c.saves.includes(k) ? 'Proficient in this saving throw' : undefined}>
            <span className="tiny faint">{k.toUpperCase()}</span><strong>{sign(mod(c.abilities[k]))}</strong><span className="tiny muted">{c.abilities[k]}</span>
          </div>
        ))}
      </div>
      <div className="row tiny" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span title="Armour class, worked out from worn armour; check it on D&D Beyond">AC <strong>{c.ac ?? '—'}</strong></span>
        <span>Speed <strong>{c.speed ?? '—'}</strong></span>
        <span>Level <strong>{c.level}</strong></span>
        <span>Proficiency <strong>{sign(c.prof)}</strong></span>
        {c.initiative !== undefined && <span>Initiative <strong>{sign(c.initiative)}</strong></span>}
        {c.passivePerception !== undefined && <span>Passive Perception <strong>{c.passivePerception}</strong></span>}
        {c.inspiration && <span className="chip teal">Inspiration</span>}
      </div>
      {(c.hitDice?.length ?? 0) > 0 && <div className="tiny"><span className="faint">Hit dice </span>{c.hitDice!.map((h) => `${h.total - h.used}/${h.total} d${h.die}`).join(', ')}</div>}
      {((c.slots?.length ?? 0) > 0 || c.pact) && (
        <div className="stack tight tiny" aria-label="Spell slots">
          <span className="faint">Spell slots (when imported)</span>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {c.slots!.map((x) => <span key={x.level} className="row" style={{ gap: 4 }}>{ORD[x.level]} <Dots max={x.max} used={x.used} label={`${ORD[x.level]} level slots`} /></span>)}
            {c.pact && <span className="row" style={{ gap: 4 }}>Pact ({ORD[c.pact.level]}) <Dots max={c.pact.max} used={c.pact.used} label="Pact slots" /></span>}
          </div>
        </div>
      )}
      {(c.attacks?.length ?? 0) > 0 && (
        <div className="stack tight tiny">
          <span className="faint" title="Worked out from worn weapons, assuming proficiency; check it on D&D Beyond">Attacks</span>
          <ul className="sht-list">{c.attacks!.map((a, i) => <li key={i}><span className="grow">{a.name}{a.range && <span className="faint"> · {a.range}</span>}</span><strong>{sign(a.hit)}</strong><span className="muted">{a.damage}</span></li>)}</ul>
        </div>
      )}
      {(c.uses?.length ?? 0) > 0 && (
        <div className="stack tight tiny">
          <span className="faint">Limited uses (when imported; they are counters on your sheet)</span>
          <ul className="sht-list">{c.uses!.map((u) => <li key={u.name}><span className="grow">{u.name}{u.reset && <span className="faint"> · {u.reset}</span>}</span><Dots max={u.max} used={u.used} label={u.name} /></li>)}</ul>
        </div>
      )}
      {c.skills.length > 0 && <div className="tiny"><span className="faint">Skills </span>{c.skills.map((s) => s.name + (s.expertise ? ' (expertise)' : '')).join(', ')}</div>}
      {c.languages.length > 0 && <div className="tiny"><span className="faint">Languages </span>{c.languages.join(', ')}</div>}
      {c.feats.length > 0 && <div className="tiny"><span className="faint">Feats </span>{c.feats.join(', ')}</div>}
      {(c.features?.length ?? 0) > 0 && (
        <details className="tiny"><summary>Features and traits ({c.features!.length})</summary>
          <ul className="sht-list">{c.features!.map((f) => <li key={f.name}><span className="grow">{f.name}</span><span className="faint">{f.from}</span></li>)}</ul>
        </details>
      )}
      {c.spells.length > 0 && (
        <details className="tiny"><summary>Spells ({c.spells.length})</summary>
          <ul className="sht-list">{Object.entries(spellsBy).map(([lvl, names]) => <li key={lvl} style={{ alignItems: 'flex-start' }}><span className="faint" style={{ minWidth: 52 }}>{lvl === '0' ? 'Cantrips' : `Level ${lvl}`}</span><span className="grow" style={{ whiteSpace: 'normal' }}>{names.join(', ')}</span></li>)}</ul>
        </details>
      )}
      {(c.items.length > 0 || coins) && (
        <details className="tiny"><summary>On D&amp;D Beyond: {c.items.length} items{coins ? `, ${coins}` : ''}</summary>
          <ul className="sht-list sht-scroll">{c.items.map((it, i) => <li key={i}><span className="grow">{it.name}{it.equipped && <span className="faint"> (worn)</span>}</span>{it.qty !== 1 && <span className="muted">×{it.qty}</span>}</li>)}</ul>
        </details>
      )}
      {c.traits && Object.values(c.traits).some(Boolean) && (
        <details className="tiny"><summary>Personality and backstory</summary>
          <div className="stack tight" style={{ marginTop: 4 }}>
            {([['Personality', c.traits.personality], ['Ideals', c.traits.ideals], ['Bonds', c.traits.bonds], ['Flaws', c.traits.flaws]] as const).filter(([, v]) => v).map(([k, v]) => <div key={k}><span className="faint">{k} </span>{v}</div>)}
            {c.traits.backstory && <p className="sht-scroll" style={{ whiteSpace: 'pre-line', margin: 0, maxHeight: 200 }}>{c.traits.backstory}</p>}
          </div>
        </details>
      )}
      <div className="row between tiny faint" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span>From {c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">D&amp;D Beyond</a> : 'D&D Beyond'}{c.importedAt ? `, ${dateLong(c.importedAt)}` : ''}</span>
        {onUpdate && <button type="button" className="btn small" onClick={onUpdate} data-testid="ddb-update"><i className="fa-solid fa-rotate" aria-hidden="true" /> Update</button>}
      </div>
      <DdbWarning short />
    </div>
  );
}

interface Applied { character: DdbCharacter; warning: string; applied: string[]; notes: string[]; learned?: number }

/**
 * Read a character (link or pasted JSON), show what will change, then import.
 * Items go through Inventory one by one, so a player's wait for the DM's
 * approval like any other new item.
 */
export function ImportModal({ account, own, dm, url: startUrl = '', onClose, onDone }: { account: string; own: boolean; dm: boolean; url?: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [url, setUrl] = useState(startUrl);
  const [paste, setPaste] = useState(false);
  const [json, setJson] = useState('');
  const [preview, setPreview] = useState<DdbCharacter | null>(null);
  const [opt, setOpt] = useState({ health: true, conditions: true, name: true, stats: true, sheetStats: true, counters: true, spells: false, items: false });
  const [progress, setProgress] = useState('');
  const src = () => (paste ? { json } : { url });
  const path = `/sheet/${own ? 'me' : account}/import/ddb`;

  const read = () => act.run(async () => {
    const out = await w.call<Applied>('POST', path, { ...src(), dryRun: true });
    setPreview(out.character);
  });
  const go = () => act.run(async () => {
    const out = await w.call<Applied>('POST', path, { ...src(), apply: { health: opt.health, conditions: opt.conditions, name: opt.name, stats: opt.stats, sheetStats: opt.sheetStats, counters: opt.counters, spells: dm && opt.spells } });
    let sent = 0, skipped = 0;
    if (opt.items && preview?.items.length) {
      const have = await w.call<any>('GET', '/inventory', undefined, { owner: own ? 'me' : account });
      const names = new Set((have?.items ?? []).map((it: any) => String(it.name).toLowerCase()));
      for (const it of preview.items) {
        if (names.has(it.name.toLowerCase()) || it.qty < 1) { skipped++; continue; }
        setProgress(`Sending ${it.name} to Inventory…`);
        await w.call('POST', '/inventory', { owner: own ? 'me' : account, name: it.name, qty: it.qty, note: 'From D&D Beyond', reason: 'Imported from D&D Beyond' });
        sent++;
      }
      setProgress('');
    }
    const parts = [`Imported ${out.character.name}`];
    if (sent) parts.push(`${sent} item${sent === 1 ? '' : 's'} sent to Inventory${!dm ? ' for the DM to approve' : ''}`);
    if (skipped) parts.push(`${skipped} already there`);
    if (out.learned) parts.push(`${out.learned} known spell${out.learned === 1 ? '' : 's'} added`);
    onDone([...parts, ...out.notes].join('. '));
  });
  const box = (k: keyof typeof opt, label: string, hint?: string) => (
    <label className="row small" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'center' }}>
      <input type="checkbox" style={{ flex: 'none' }} checked={opt[k]} onChange={() => setOpt((o) => ({ ...o, [k]: !o[k] }))} />
      <span style={{ flex: 1, minWidth: 0 }}>{label}{hint && <span className="tiny faint"> {hint}</span>}</span>
    </label>
  );

  return (
    <Modal title="Import from D&D Beyond" onClose={onClose}>
      <div className="stack" data-testid="ddb-import">
        <DdbWarning />
        {!preview ? <>
          {!paste
            ? <label className="stack tight small">Character link
                <input className="sht-in" inputMode="url" placeholder="https://www.dndbeyond.com/characters/12345678" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) read(); }} data-testid="ddb-url" />
                <span className="tiny faint">The character must be public: on D&amp;D Beyond open it, then Home › Character Settings › Character Privacy › Public.</span>
              </label>
            : <label className="stack tight small">Character JSON
                <textarea value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"id": 12345678, "success": true, "data": { … } }' style={{ minHeight: 140, fontFamily: 'monospace', fontSize: 12 }} />
                <span className="tiny faint">Open character-service.dndbeyond.com/character/v5/character/&lt;id&gt; in a browser (the number from the character link), copy everything on the page and paste it here.</span>
              </label>}
          <button type="button" className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setPaste((v) => !v)}>{paste ? 'Use a link instead' : 'The link does not work? Paste the JSON'}</button>
          <ErrorBox error={act.error} />
          <button type="button" className="btn primary" disabled={act.busy || !(paste ? json.trim() : url.trim())} onClick={read} data-testid="ddb-read">{act.busy ? 'Reading…' : 'Read character'}</button>
        </> : <>
          <div className="card" style={{ padding: 10 }}>
            <strong>{preview.name}</strong>
            <div className="tiny muted">{[preview.race, classLine(preview)].filter(Boolean).join(' · ')}</div>
            <div className="tiny" style={{ marginTop: 4 }}>HP {preview.hp.now}/{preview.hp.max}{preview.hp.temp ? ` (+${preview.hp.temp} temp)` : ''} · AC {preview.ac ?? '—'} · {preview.spells.length} spells · {preview.items.length} items{preview.conditions.length ? ` · ${preview.conditions.join(', ')}` : ''}</div>
          </div>
          <div className="stack tight">
            <span className="tiny faint">The Character module always updates. Also:</span>
            {box('sheetStats', 'Fill the Stats module: AC, initiative, speed, passives, spell DC', '(your own rows stay)')}
            {box('health', 'Set HP, max HP and temporary HP', '(logged as an import)')}
            {preview.conditions.length > 0 && box('conditions', `Add conditions: ${preview.conditions.join(', ')}`)}
            {box('name', `Use “${preview.name}” as the character name`)}
            {box('stats', 'Class, level and ability scores for spells and mana')}
            {((preview.uses?.length ?? 0) + (preview.hitDice?.length ?? 0)) > 0 && box('counters', `Counters for ${[...(preview.uses ?? []).map((u) => u.name), 'hit dice'].slice(0, 4).join(', ')}${(preview.uses?.length ?? 0) > 3 ? '…' : ''}`, '(same names are updated)')}
            {preview.items.length > 0 && box('items', `Send ${preview.items.length} items to Inventory`, dm ? '(skips ones already there)' : '(the DM approves them; skips ones already there)')}
            {dm && preview.spells.length > 0 && box('spells', `Add ${preview.spells.length} known spells`, '(ones in this world’s spell list)')}
          </div>
          {progress && <span className="tiny muted" role="status">{progress}</span>}
          <ErrorBox error={act.error} />
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn" onClick={() => setPreview(null)} disabled={act.busy}>Back</button>
            <button type="button" className="btn primary grow" onClick={go} disabled={act.busy} data-testid="ddb-apply">{act.busy ? 'Importing…' : 'Import'}</button>
          </div>
        </>}
      </div>
    </Modal>
  );
}
