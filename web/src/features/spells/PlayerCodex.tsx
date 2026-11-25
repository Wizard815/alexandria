// The player's Codex: my spells (cast them with mana), what I can learn now
// (highlighted), what comes next and what it still needs, every spell I may
// read, and my spell sheet (class, level, ability scores).
import { useState, type ReactNode } from 'react';
import { ErrorBox, Field, Loading, Modal, PageHead, Tabs, useAction, useToast, Empty } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { ABILITIES, ManaBar, SpellCard, SpellSearch, levelText, missingText, useSpell, type Character, type RecipeView, type Spell } from './shared.tsx';

type Tab = 'mine' | 'learn' | 'all';

export function RecipeCard({ r, children }: { r: RecipeView; children?: ReactNode }) {
  const known = (id: string) => !(r.missing ?? []).some((m) => m.kind === 'spell' && m.id === id);
  return (
    <div className={`spl-recipe${r.status === 'ready' ? ' ready' : ''}${r.draft ? ' draft' : ''}`} data-testid={`recipe-${r.result.name}`} aria-label={`Recipe for ${r.result.name}`}>
      <div className="row between top">
        <div className="stack tight"><strong>{r.result.name}</strong><span className="tiny muted">{r.result.line} · tier {r.tier}</span></div>
        <span className="row" style={{ gap: 6 }}>
          {r.status === 'ready' && <span className="chip green">Ready to learn</span>}
          {r.status === 'locked' && <span className="chip">Locked</span>}
          {r.status === 'learned' && <span className="chip teal">Learned</span>}
          {r.draft && <span className="chip gold">Draft</span>}
          {r.visibility === 'hidden' && <span className="chip red">Hidden from players</span>}
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {r.prereqs.map((p, i) => <span key={p.id} className="row" style={{ gap: 6 }}>{i > 0 && <span className="spl-plus">+</span>}<span className={`chip${r.status && known(p.id) ? ' green' : ''}`}>{p.name}</span></span>)}
      </div>
      {(r.items.length > 0 || Object.keys(r.stats).length > 0 || r.minLevel || r.manaCost) && (
        <div className="tiny muted">
          {[...r.items.map((it) => `${it.qty} × ${it.name}${it.consumed ? ' (used up)' : ''}${it.have !== undefined ? ` · have ${it.have}` : ''}`),
            ...Object.entries(r.stats).map(([k, v]) => `${k.toUpperCase()} ${v}+`),
            ...(r.minLevel ? [`level ${r.minLevel}+`] : []),
            ...(r.manaCost ? [`${r.manaCost} mana to learn`] : [])].join(' · ')}
        </div>
      )}
      {r.status === 'locked' && (r.missing ?? []).length > 0 && (
        <ul className="spl-miss" aria-label={`Still needed for ${r.result.name}`}>{r.missing!.map((m, i) => <li key={i}>{missingText(m)}</li>)}</ul>
      )}
      {r.dmNotes ? <div className="tiny note"><strong>DM notes.</strong> {r.dmNotes}</div> : null}
      {children}
    </div>
  );
}

export default function PlayerCodex() {
  const { w, info } = useWorld();
  const [tab, setTab] = useState<Tab>('mine');
  const [open, setOpen] = useState<string | null>(null);
  const [castAt, setCastAt] = useState<number | null>(null);
  const codex = useLoad<any>(() => w.call('GET', '/spells/codex'), [w], ['spells', 'spells-char', 'spells-recipes', 'spells-learn', 'settings', 'item', 'item-removed']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const spell = useSpell(open);
  const c: Character | null = codex.data?.character ?? null;
  const crafting = codex.data?.crafting ?? { on: false };
  const mana = c?.mana ?? { on: false };
  const ready: RecipeView[] = codex.data?.ready ?? [];
  const next: RecipeView[] = codex.data?.next ?? [];
  const learned: Spell[] = codex.data?.learned ?? [];

  const learn = (r: RecipeView) => act.run(async () => {
    const out: any = await w.call('POST', '/spells/learn', { recipeId: r.id });
    toast(out.status === 'approved' ? `You learned ${r.result.name}` : `Asked the DM to learn ${r.result.name}`);
    await codex.reload();
  });
  const cancel = (lid: string) => act.run(async () => { await w.call('POST', `/spells/learn/${lid}/cancel`); await codex.reload(); });
  const cast = (s: Spell, level?: number) => act.run(async () => {
    const out: any = await w.call('POST', '/spells/cast', { spellId: s.id, level: level ?? s.level });
    toast(mana.on ? `Cast ${s.name}: ${out.cost} mana spent, ${out.mana} left` : `Cast ${s.name}`);
    await codex.reload();
  });

  const tabs: [Tab, string][] = [['mine', `My spells (${learned.length})`], ...(crafting.on ? [['learn', `Learn${ready.length ? ` (${ready.length} ready)` : ''}`] as [Tab, string]] : []), ['all', 'All spells']];
  return (
    <div className="page wide">
      <PageHead title="Codex" lead={`Spells in ${info.name}: the ones you know, ${crafting.on ? 'what you can learn by combining them, ' : ''}and the ones the DM has opened to the table.`} />
      <ErrorBox error={codex.error ?? act.error} />
      {codex.loading && !codex.data ? <Loading /> : (
        <>
          {c && (
            <section className="card row between" style={{ gap: 14 }}>
              <div className="stack tight">
                <strong>{c.name || 'My character'}</strong>
                <span className="tiny muted">{[c.class, c.level ? `level ${c.level}` : 'level not set', ABILITIES.filter(([k]) => c.abilities[k]).map(([k, l]) => `${l} ${c.abilities[k]}`).join(' ')].filter(Boolean).join(' · ')}</span>
              </div>
              <ManaBar mana={mana} />
              {crafting.playerStats !== false && <SheetButton c={c} onSaved={() => void codex.reload()} />}
            </section>
          )}
          <Tabs label="Codex" value={tab} onChange={setTab} items={tabs} />
          {tab === 'mine' && (
            <section className="stack">
              {learned.length === 0 ? <Empty>You know no spells yet. The DM adds the ones your character starts with.</Empty> : (
                <div className="grid">
                  {learned.map((s) => (
                    <div key={s.id} className="card stack tight">
                      <button type="button" className="spl-name" onClick={() => setOpen(s.id)} aria-label={`Read ${s.name}`}><strong>{s.name}</strong></button>
                      <span className="tiny muted">{s.line}</span>
                      <div className="row between">
                        {mana.on ? <span className="chip gold">{s.manaCost} mana</span> : <span />}
                        <button type="button" className="btn small" disabled={act.busy} onClick={() => void cast(s)} aria-label={`Cast ${s.name}`}>Cast</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === 'learn' && crafting.on && (
            <section className="stack">
              <h3>Ready to learn</h3>
              {ready.length === 0 ? <p className="muted">Nothing yet: see what each spell below still needs.</p> : ready.map((r) => (
                <RecipeCard key={r.id} r={r}>
                  {r.pending ? (
                    <div className="row between"><span className="tiny">Waiting for the DM.</span><button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void cancel(r.pending!)}>Take back</button></div>
                  ) : <button type="button" className="btn primary" disabled={act.busy} onClick={() => void learn(r)}>{crafting.approval === 'auto' ? 'Learn' : 'Ask to learn'} {r.result.name}</button>}
                </RecipeCard>
              ))}
              <h3>Next</h3>
              {next.length === 0 && (codex.data?.mystery ?? []).length === 0 ? <p className="muted">No other spells to work towards.</p> : null}
              {next.map((r) => <RecipeCard key={r.id} r={r} />)}
              {(codex.data?.mystery ?? []).map((m: any, i: number) => (
                <div key={`m${i}`} className="spl-recipe mystery" aria-label="An unknown spell"><strong>???</strong><span className="tiny">{m.buildsOnKnown ? 'Something builds on a spell you know.' : 'A spell not yet discovered.'}</span></div>
              ))}
              {(codex.data?.requests ?? []).length > 0 && (
                <details>
                  <summary>My requests</summary>
                  <ul>{codex.data.requests.map((x: any) => <li key={x.id}>{x.spell}: {x.status}{x.reason ? ` (${x.reason})` : ''}</li>)}</ul>
                </details>
              )}
            </section>
          )}
          {tab === 'all' && (
            <section className="card">
              <SpellSearch onPick={(s) => setOpen(s.id)} picked={open} badge={(s) => (s.known ? <span className="chip green">Known</span> : null)} />
            </section>
          )}
        </>
      )}
      {open && (
        <Modal title={spell.data?.name ?? 'Spell'} onClose={() => { setOpen(null); setCastAt(null); }}>
          {spell.data ? (
            <SpellCard s={spell.data} mana={mana} actions={spell.data.known ? (
              <div className="row">
                {mana.on && spell.data.level > 0 && (
                  <label className="field" style={{ maxWidth: 160 }}><span className="tiny">Cast at level</span>
                    <select value={castAt ?? spell.data.level} onChange={(e) => setCastAt(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => n >= spell.data!.level).map((n) => <option key={n} value={n}>{levelText(n)}</option>)}</select>
                  </label>
                )}
                <button type="button" className="btn primary" disabled={act.busy} onClick={() => void cast(spell.data!, castAt ?? spell.data!.level)}>Cast {spell.data.name}</button>
              </div>
            ) : null} />
          ) : spell.error ? <ErrorBox error={spell.error} /> : <Loading />}
        </Modal>
      )}
      {toastNode}
    </div>
  );
}

/** The player's spell sheet: class, level, ability scores and spellcasting ability. */
export function SheetButton({ c, onSaved, accountId = 'me', dm = false }: { c: Character; onSaved: () => void; accountId?: string; dm?: boolean }) {
  const { w } = useWorld();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>(null);
  const act = useAction();
  const start = () => { setF({ class: c.class, level: c.level ?? '', castingAbility: c.castingAbility, manaMax: c.manaMax ?? '', ...Object.fromEntries(ABILITIES.map(([k]) => [k, c.abilities[k] ?? ''])) }); setOpen(true); };
  const save = () => act.run(async () => {
    const abilities = Object.fromEntries(ABILITIES.map(([k]) => [k, f[k] === '' ? null : Number(f[k])]));
    await w.call('PUT', `/spells/characters/${accountId}`, { class: f.class, level: f.level === '' ? null : Number(f.level), castingAbility: f.castingAbility, abilities, ...(dm ? { manaMax: f.manaMax === '' ? null : Number(f.manaMax) } : {}) });
    setOpen(false);
    onSaved();
  });
  return (
    <>
      <button type="button" className="btn small" onClick={start}>{dm ? 'Edit sheet' : 'My spell sheet'}</button>
      {open && f && (
        <Modal title={dm ? `${c.name}: spell sheet` : 'My spell sheet'} onClose={() => setOpen(false)}>
          <div className="stack">
            <ErrorBox error={act.error} />
            <div className="row" style={{ gap: 10 }}>
              <Field label="Class"><input value={f.class} onChange={(e) => setF({ ...f, class: e.target.value })} placeholder="Wizard" /></Field>
              <Field label="Level"><input type="number" min={1} max={20} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} style={{ width: 80 }} /></Field>
              <Field label="Spellcasting ability">
                <select value={f.castingAbility} onChange={(e) => setF({ ...f, castingAbility: e.target.value })}><option value="">Best of INT, WIS, CHA</option><option value="int">Intelligence</option><option value="wis">Wisdom</option><option value="cha">Charisma</option></select>
              </Field>
            </div>
            <div className="spl-abil">
              {ABILITIES.map(([k, l]) => <label key={k} className="field"><span className="tiny">{l}</span><input type="number" min={1} max={30} aria-label={l} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
            </div>
            {c.from.abilities?.length ? <p className="tiny muted">From the Me page: {c.from.abilities.map((x) => x.toUpperCase()).join(', ')}. A number here replaces it.</p> : null}
            {dm && <Field label="Mana maximum by hand" help="Empty: the world's formula or table by level."><input type="number" min={0} value={f.manaMax} onChange={(e) => setF({ ...f, manaMax: e.target.value })} style={{ width: 120 }} /></Field>}
            <div className="row end"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save sheet</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}
