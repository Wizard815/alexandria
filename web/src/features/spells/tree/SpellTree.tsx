// Copied from Wizard815/DND-Spell-Tree src/tree/SpellTree.tsx by scripts/sync-alexandria.sh: change it there.
// The spell tree: every spell, darkened until it opens up, grouped by school
// of magic. Spells that mix two lines (elements) sit after the schools, and
// spells without a school go under Others. A spell the character can study
// shows grey; picking it opens a panel with its requirements, the study
// table (days and gold alone, with a text or with a mentor), Start learning,
// days of study, the final check and the scroll.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ELEMENT_COLOR, SCHOOL_COLOR, TREE_CSS } from './treeCss.ts';
import TreeGraph, { GRAPH_CSS, STATUS_LABEL } from './TreeGraph.tsx';
import { SOURCES, SOURCE_LABEL, type CheckOut, type SpellDetail, type Study, type StudyPlan, type StudySource, type TreeBackend, type TreeData, type TreeSpell, type TreeStatus } from './types.ts';

const FILTERS: { key: string; label: string; has: (s: TreeSpell) => boolean }[] = [
  { key: 'all', label: 'All', has: () => true },
  { key: 'learn', label: 'Can learn', has: (s) => s.status === 'learn' },
  { key: 'studying', label: 'Studying', has: (s) => s.status === 'studying' || s.status === 'stopped' },
  { key: 'known', label: 'Known', has: (s) => s.status === 'known' || s.status === 'gift' },
  { key: 'locked', label: 'Locked', has: (s) => s.status === 'locked' },
];
const levelName = (n: number) => (n === 0 ? 'Cantrip' : `Level ${n}`);
const tierName = (n: number) => (n === 0 ? 'Cantrip' : `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`);

export interface SpellTreeProps {
  backend: TreeBackend;
  /** Changes when something outside the tree changed (another character, a live event): the tree reloads. */
  reloadKey?: unknown;
  /** Told after every change the tree makes (a study started, a spell learned). */
  onChanged?: () => void;
}

export default function SpellTree({ backend, reloadKey, onChanged }: SpellTreeProps) {
  const [data, setData] = useState<TreeData | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<'tree' | 'list'>('tree');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([backend.tree(), backend.studies().catch(() => [] as Study[])])
      .then(([t, s]) => { if (live) { setData(t); setStudies(s); setErr(''); } })
      .catch((e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [backend, reloadKey, tick]);

  const changed = useCallback(() => { setTick((n) => n + 1); onChanged?.(); }, [onChanged]);

  const all = useMemo(() => (data ? [...data.schools.flatMap((g) => g.spells), ...data.hybrids] : []), [data]);
  const picked = all.find((s) => s.id === sel) ?? null;
  const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0];
  const ql = q.trim().toLowerCase();
  const show = (s: TreeSpell) => f.has(s) && (!ql || s.name.toLowerCase().includes(ql) || s.lines.some((l) => l.toLowerCase().includes(ql)));

  if (err && !data) return <div className="st"><style>{TREE_CSS}</style><p className="st-err" role="alert">{err}</p></div>;
  if (!data) return <div className="st"><style>{TREE_CSS}</style><p className="st-empty">Loading the spell tree…</p></div>;

  const schools = data.schools.filter((g) => g.name !== 'Others');
  const others = data.schools.find((g) => g.name === 'Others');
  // Hybrids, grouped by the pair of lines they mix.
  const pairs = new Map<string, TreeSpell[]>();
  for (const s of data.hybrids) { const k = [...new Set(s.lines)].sort().slice(0, 3).join(' + '); pairs.set(k, [...(pairs.get(k) ?? []), s]); }
  const total = all.length;
  const c = data.counts;

  return (
    <div className="st">
      <style>{TREE_CSS + GRAPH_CSS}</style>
      <div className="st-bar">
        <div className="st-chips" role="group" aria-label="View">
          <button type="button" className="st-chip" aria-pressed={view === 'tree'} onClick={() => setView('tree')}>Tree</button>
          <button type="button" className="st-chip" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        </div>
        <input className="st-search" type="search" placeholder={`Search ${total} spells (Enter opens it)`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search spells"
          onKeyDown={(e) => { if (e.key === 'Enter' && ql) { const hit = all.find((x) => x.name.toLowerCase() === ql) ?? all.find(show); if (hit) setSel(hit.id); } }} />
        <div className="st-chips" role="group" aria-label="Show">
          {FILTERS.map((x) => (
            <button key={x.key} type="button" className="st-chip" aria-pressed={filter === x.key} onClick={() => setFilter(x.key)}>
              {x.label}{x.key !== 'all' ? ` ${all.filter(x.has).length}` : ''}
            </button>
          ))}
        </div>
      </div>
      <div className="st-legend" aria-label="Legend">
        <span><i style={{ background: '#f0c040' }} /> Known {(c.known ?? 0) + (c.gift ?? 0)}</span>
        <span><i style={{ background: '#e4e7ee', border: '1px solid #fff' }} /> Can learn {c.learn ?? 0}</span>
        <span><i style={{ border: '2px solid #f0c040' }} /> Studying {(c.studying ?? 0) + (c.stopped ?? 0)}</span>
        <span><i style={{ background: '#2c2a35' }} /> Locked {c.locked ?? 0}</span>
        <span><i style={{ background: '#17161d', border: '1px solid #3b3846' }} /> Unknown {(c.dark ?? 0) + (c.hidden ?? 0)}</span>
      </div>
      {!data.engine && <p className="st-note">The spell rules are off, so studying is not available. The tree still shows what is known.</p>}
      <div className={`st-layout${picked ? ' open' : ''}`}>
        {view === 'tree' ? <TreeGraph data={data} sel={sel} onPick={setSel} dim={(s) => !show(s)} /> : <div className="st" style={{ gap: 10 }}>
          {schools.map((g) => <Group key={g.name} title={g.name} color={SCHOOL_COLOR[g.name] ?? SCHOOL_COLOR.Others} spells={g.spells.filter(show)} all={g.spells} sel={sel} onPick={setSel} />)}
          {[...pairs].sort((a, b) => b[1].length - a[1].length).map(([k, list]) => {
            const [a, b] = k.split(' + ');
            return <Group key={k} title={k} hint="spells where these lines meet" hybrid colorA={ELEMENT_COLOR[a]} colorB={ELEMENT_COLOR[b]} spells={list.filter(show)} all={list} sel={sel} onPick={setSel} />;
          })}
          {others && <Group title="Others" color={SCHOOL_COLOR.Others} spells={others.spells.filter(show)} all={others.spells} sel={sel} onPick={setSel} />}
        </div>}
        {picked && <Panel key={picked.id} backend={backend} spell={picked} engine={data.engine} study={studies.find((x) => x.spellId === picked.id && x.status !== 'learned') ?? null} onClose={() => setSel(null)} onChanged={changed} />}
      </div>
    </div>
  );
}

function Group({ title, hint, color, hybrid, colorA, colorB, spells, all, sel, onPick }: {
  title: string; hint?: string; color?: string; hybrid?: boolean; colorA?: string; colorB?: string; spells: TreeSpell[]; all: TreeSpell[]; sel: string | null; onPick: (id: string) => void;
}) {
  if (!spells.length) return null;
  const known = all.filter((s) => s.status === 'known' || s.status === 'gift').length;
  const tiers = [...new Set(spells.map((s) => s.level))].sort((a, b) => a - b);
  const style = (hybrid ? { '--a': colorA, '--b': colorB, '--sc': colorA, borderLeftColor: colorA } : { '--sc': color }) as unknown as CSSProperties;
  return (
    <section className={`st-group${hybrid ? ' st-hybrids' : ''}`} style={style} aria-label={title}>
      <h3>{title} <small>{known} of {all.length} known{hint ? ` · ${hint}` : ''}</small></h3>
      {tiers.map((t) => (
        <div className="st-tier" key={t}>
          <b>{tierName(t)}</b>
          <div className="st-nodes">
            {spells.filter((s) => s.level === t).sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
              <button key={s.id} type="button" className="st-node" data-s={s.status} aria-current={sel === s.id} onClick={() => onPick(s.id)}
                title={`${s.name}: ${STATUS_LABEL[s.status]}`} aria-label={`${s.name}, ${levelName(s.level)}, ${STATUS_LABEL[s.status]}`}
                style={hybrid && s.lines[1] ? ({ '--sc': ELEMENT_COLOR[s.lines[0]] ?? colorA } as unknown as CSSProperties) : undefined}>
                {s.status === 'dark' || s.status === 'hidden' ? <span aria-hidden="true">{s.name}</span> : s.name}
                {s.study && <span className="st-prog" style={{ width: `${Math.round((s.study.banked / Math.max(1, s.study.needed)) * 100)}%` }} />}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function Panel({ backend, spell, engine, study, onClose, onChanged }: { backend: TreeBackend; spell: TreeSpell; engine: boolean; study: Study | null; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<SpellDetail | null>(null);
  const [source, setSource] = useState<StudySource>(study?.source ?? 'text');
  const [lab, setLab] = useState(study?.lab ?? false);
  const [scroll, setScroll] = useState(false);
  const [arcana, setArcana] = useState('');
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState('1');
  const [d20, setD20] = useState('');
  const [last, setLast] = useState<CheckOut | null>(null);
  const canPlan = engine && spell.status !== 'known' && spell.status !== 'gift' && spell.status !== 'dark' && spell.status !== 'hidden';

  useEffect(() => { backend.spell(spell.id).then(setDetail).catch(() => setDetail(null)); }, [backend, spell.id]);
  useEffect(() => {
    if (!canPlan) { setPlan(null); return; }
    backend.plan(spell.id, source, lab).then((p) => { setPlan(p); setErr(''); }).catch((e) => setErr(String(e?.message ?? e)));
  }, [backend, spell.id, source, lab, canPlan, study?.banked, study?.status]);

  const act = async (what: () => Promise<unknown>, done?: string) => {
    setBusy(true); setErr(''); setNote('');
    try { await what(); if (done) setNote(done); onChanged(); } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  const d = detail;
  const pct = study ? Math.round((study.banked / Math.max(1, study.needed)) * 100) : 0;

  return (
    <aside className="st-panel" aria-label={`${spell.name} details`}>
      <div className="st-head">
        <div>
          <h2>{spell.name}</h2>
          <div className="st-sub">{levelName(spell.level)} · {spell.school}{spell.lines.length ? ` · ${spell.lines.join(' + ')}` : ''}</div>
          <div style={{ marginTop: 6 }}><span className="st-pill">{STATUS_LABEL[spell.status]}</span>{spell.hybrid && <span className="st-pill">Hybrid</span>}</div>
        </div>
        <button type="button" className="st-btn small" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {d && (d.castingTime || d.range) && (
        <dl className="st-facts">
          {d.castingTime && <><div><dt>Casting time</dt><dd>{d.castingTime}{d.ritual ? ' (ritual)' : ''}</dd></div></>}
          {d.range && <div><dt>Range</dt><dd>{d.range}</dd></div>}
          {d.componentsText && <div><dt>Components</dt><dd>{d.componentsText}</dd></div>}
          {d.duration && <div><dt>Duration</dt><dd>{d.concentration ? 'Concentration, ' : ''}{d.duration}</dd></div>}
        </dl>
      )}
      {d?.text && <details><summary className="st-sub">Spell text</summary><div className="st-text">{d.text}</div></details>}

      {spell.status === 'dark' && <p className="st-note">No recipe teaches this spell yet. Ask the DM, or find a text, a mentor or a scroll of it.</p>}
      {spell.status === 'hidden' && <p className="st-note">A hidden recipe teaches this spell. Players see it as unknown.</p>}
      {(spell.status === 'known' || spell.status === 'gift') && <p className="st-note">{spell.status === 'gift' ? 'Given by the DM.' : 'Learned.'} It's in the spell list.</p>}
      {spell.from.length > 0 && spell.status !== 'known' && <div><h4>Taught by</h4><div className="st-sub">{spell.from.join(' + ')}</div></div>}

      {canPlan && plan && (
        <>
          {!study && plan.missing.length > 0 && (
            <div><h4>Still needed</h4><ul className="st-miss">{plan.missing.map((m) => <li key={m}>{m}</li>)}</ul></div>
          )}
          <div>
            <h4>How to study</h4>
            <table className="st-table">
              <thead><tr><th>How</th><th>Days left</th><th>Gold</th></tr></thead>
              <tbody>
                {SOURCES.map((s) => {
                  const left = study && study.source === s ? study.daysLeft : plan.days[s];
                  const gold = plan.gold?.[s] ?? (s === source ? plan.materials + plan.mentorFee : plan.materials);
                  return (
                    <tr key={s} aria-selected={s === source} onClick={() => setSource(s)} style={{ cursor: 'pointer' }}>
                      <td><label><input type="radio" name="st-source" checked={s === source} onChange={() => setSource(s)} /> {SOURCE_LABEL[s]}</label></td>
                      <td>{left === null || left === undefined || !Number.isFinite(left) ? '—' : left}</td>
                      <td>{gold}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="st-sub" style={{ margin: '6px 0 0' }}>
              Each 8-hour downtime day earns 1 to 3 study points: 1 alone, 2 with a text, 3 with a mentor{lab ? ', +1 in a lab' : ''}. This spell needs {plan.needed} points. Final check: d20 + {plan.checkBonus} against DC {plan.finalDC}.
            </p>
            <label className="st-row" style={{ marginTop: 6, fontSize: 13 }}><input type="checkbox" checked={lab} onChange={(e) => setLab(e.target.checked)} /> Studying in a lab</label>
          </div>

          {(!study || study.status === 'stopped') && (
            <div className="st" style={{ gap: 8 }}>
              {!study && <label className="st-row" style={{ fontSize: 13 }}><input type="checkbox" checked={scroll} onChange={(e) => setScroll(e.target.checked)} /> I have a scroll of this spell (+{plan.scrollPoints} points; the scroll is kept)</label>}
              {plan.arcanaDC !== null && !study && (
                <label className="st-field">Arcana check to start (DC {plan.arcanaDC})<input type="number" inputMode="numeric" value={arcana} onChange={(e) => setArcana(e.target.value)} placeholder="Total" /></label>
              )}
              <button type="button" className="st-btn primary" disabled={busy || (!study && (!plan.canStart || (plan.arcanaDC !== null && arcana === '')))}
                onClick={() => act(() => backend.start(spell.id, { source, lab, scroll, ...(arcana !== '' ? { arcana: Number(arcana) } : {}) }), 'Studying started.')}>
                {spell.status === 'stopped' ? 'Pick up studying' : 'Start learning'}
              </button>
            </div>
          )}
        </>
      )}

      {study && (
        <div className="st" style={{ gap: 8 }}>
          <h4>Progress</h4>
          <div className="st-progress" role="meter" aria-valuemin={0} aria-valuemax={study.needed} aria-valuenow={study.banked} aria-label="Study points"><span style={{ width: `${pct}%` }} /></div>
          <div className="st-sub">{study.banked} of {study.needed} points · {study.days} day{study.days === 1 ? '' : 's'} studied · {SOURCE_LABEL[study.source]}{study.lab ? ', lab' : ''}{study.scrollHelp ? ', with a scroll' : ''}</div>
          {study.pendingDays > 0 && <p className="st-note">{study.pendingDays} day{study.pendingDays === 1 ? '' : 's'} waiting for the DM to approve.</p>}
          {study.status === 'stopped' && <p className="st-note">Paused. The points are kept: pick it up again above.</p>}
          {study.status === 'studying' && (
            <div className="st-row">
              <label className="st-field">Downtime days<input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></label>
              <button type="button" className="st-btn primary" disabled={busy} onClick={() => act(() => backend.days(study.id, Number(days)), `${days} day${days === '1' ? '' : 's'} logged.`)}>Log study days</button>
            </div>
          )}
          {study.status === 'ready' && (
            study.waitLongRest
              ? <p className="st-note">The last final check failed. Try again after a long rest.</p>
              : (
                <div className="st-row">
                  <label className="st-field">d20 (empty: roll)<input type="number" min={1} max={20} value={d20} onChange={(e) => setD20(e.target.value)} /></label>
                  <button type="button" className="st-btn primary" disabled={busy} onClick={() => act(async () => { const r = await backend.check(study.id, d20 === '' ? undefined : Number(d20)); setLast(r); })}>Roll the final check</button>
                </div>
              )
          )}
          <div className="st-row">
            {study.scrollHelp && <button type="button" className="st-btn small" disabled={busy} onClick={() => act(() => backend.scrollCast(study.id), 'The scroll is spent and its help is gone.')}>I cast the scroll</button>}
            {study.status !== 'stopped' && <button type="button" className="st-btn small" disabled={busy} onClick={() => act(() => backend.stop(study.id), 'Paused. The points are kept.')}>Pause studying</button>}
          </div>
        </div>
      )}
      {last && (
            <p className={last.learned ? 'st-note' : 'st-err'} role="status">
              d20 {last.d20} + {last.bonus} = {last.total} against DC {last.dc}: {last.outcome === 'great' ? 'a great success' : last.outcome === 'success' ? 'learned' : last.outcome === 'setback' ? 'a setback' : 'not yet'}.
              {last.learned ? ` ${spell.name} is learned!` : ' Try again after a long rest.'}
              {last.refund ? ` ${last.refund} gp of materials back.` : ''}{last.fatigue ? ` ${last.fatigue} fatigue.` : ''}
            </p>
          )}
      {note && <p className="st-note" role="status">{note}</p>}
      {err && <p className="st-err" role="alert">{err}</p>}
    </aside>
  );
}
