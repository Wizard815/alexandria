// GM page: Encounters. Send an NPC to one player, several or the party (a
// quick line with answers, a saved encounter or a built-in starter), watch
// each talk live, speak as the NPC, end a talk; build and save encounters
// with branching answers, gifts, a shop and small games; and the settings
// (wandering, its wait, the coin cap per encounter). Story events (quick
// events that happen to a player: a thief, a find, a hazard) run on the same
// engine, tagged by place; the Story events tab sends one for a place.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Switch, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { GAME_HELP, type Effect, type Encounter, type EncounterConfig, type EncounterKind, type GameKind, type Node, type PlaceOpt, type Script, type Template } from './types.ts';
import { Countdown } from './Countdown.tsx';
import './encounters.css';

type Tab = 'live' | 'events' | 'library' | 'settings';
interface ShopLite { id: string; name: string; status: string }
interface PersonLite { id: string; name: string; role: string; attitude: string }

export default function EncountersGM() {
  const { w } = useWorld();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'live';
  const cfg = useLoad<EncounterConfig>(() => w.call('GET', '/encounters/config'), [w], ['settings']);
  const tpl = useLoad<{ templates: Template[]; starters: Template[]; places: PlaceOpt[] }>(() => w.call('GET', '/encounters/templates/all'), [w]);
  const shops = useLoad<{ shops: ShopLite[] }>(() => w.call('GET', '/shop/shops'), [w], ['shop']);
  return (
    <div className="page enc-page">
      <PageHead title="Encounters" lead="An NPC walks up to a player, or something happens to them, and it plays out in their app: answers, small gifts, a shop, a game of chance, a choice with a consequence. Good for players you are not busy with." />
      <Tabs label="Encounters" value={tab} onChange={(t) => setSp(t === 'live' ? {} : { tab: t })} items={[['live', 'Send & watch'], ['events', 'Story events'], ['library', 'Saved'], ['settings', 'Settings']]} />
      {!cfg.data || !tpl.data ? <><ErrorBox error={cfg.error ?? tpl.error} /><Loading /></>
        : tab === 'events' ? <StoryEvents data={tpl.data} cfg={cfg.data} shops={shops.data?.shops ?? []} reload={tpl.reload} />
        : tab === 'library' ? <Library data={tpl.data} shops={shops.data?.shops ?? []} reload={tpl.reload} />
        : tab === 'settings' ? <Settings cfg={cfg.data} reload={cfg.reload} />
        : <Live templates={[...tpl.data.templates, ...tpl.data.starters]} shops={shops.data?.shops ?? []} cfg={cfg.data} />}
    </div>
  );
}

// ---------------- send & watch ----------------

function Live({ templates, shops, cfg }: { templates: Template[]; shops: ShopLite[]; cfg: EncounterConfig }) {
  const { w } = useWorld();
  const list = useLoad<Encounter[]>(() => w.call('GET', '/encounters'), [w], ['encounter']);
  const open = (list.data ?? []).filter((e) => e.status === 'open');
  const past = (list.data ?? []).filter((e) => e.status !== 'open').slice(0, 20);
  return (
    <div className="cols">
      <div className="col-1 stack"><Send templates={templates} shops={shops} onSent={() => void list.reload()} /></div>
      <div className="col-2 stack loose">
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : (
          <>
            <h2 className="enc-h">Talking now</h2>
            {!open.length ? <Empty>No one is mid-conversation. Send an NPC from the left.</Empty> : open.map((e) => <Watch key={e.id} e={e} cfg={cfg} />)}
            {past.length > 0 && <><h2 className="enc-h">Earlier</h2>{past.map((e) => <Watch key={e.id} e={e} cfg={cfg} />)}</>}
          </>
        )}
      </div>
    </div>
  );
}

function Send({ templates, shops, onSent }: { templates: Template[]; shops: ShopLite[]; onSent: () => void }) {
  const { w, members } = useWorld();
  const players = members.filter((m) => m.role === 'player');
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [to, setTo] = useState<string[]>([]);
  const [mode, setMode] = useState<'quick' | 'saved'>('quick');
  const [tid, setTid] = useState(templates[0]?.id ?? '');
  const [npcName, setNpcName] = useState('');
  const [npcBlurb, setNpcBlurb] = useState('');
  const [line, setLine] = useState('');
  const [answers, setAnswers] = useState<string[]>(['', '']);
  const [shopId, setShopId] = useState('');
  const [addPeople, setAddPeople] = useState(false);
  const people = useLoad<PersonLite[]>(() => w.call('GET', '/people'), [w], ['person']);
  const t = templates.find((x) => x.id === tid);
  const fromPerson = (pid: string) => {
    const p = (people.data ?? []).find((x) => x.id === pid);
    if (!p) return;
    setNpcName(p.name);
    setNpcBlurb([p.role, p.attitude].filter(Boolean).join(', '));
  };
  const needsShop = mode === 'saved' && !!t?.script.nodes.some((n) => n.options.some((o) => o.effects.some((e) => e.kind === 'shop' && !e.shopId)));
  const toggle = (id: string) => setTo((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const send = () => act.run(async () => {
    const body: Record<string, unknown> = { accountIds: to, shopId: shopId || undefined, npcName: npcName.trim() || undefined, addToPeople: addPeople || undefined };
    if (mode === 'saved') body.templateId = tid;
    else Object.assign(body, { npcBlurb: npcBlurb.trim() || undefined, line, answers: answers.filter((a) => a.trim()) });
    await w.call('POST', '/encounters', body);
    toast(`Sent to ${to.length} player${to.length === 1 ? '' : 's'}`);
    if (mode === 'quick') { setLine(''); setAnswers(['', '']); }
    onSent();
  });
  return (
    <section className="card" aria-labelledby="send-h">
      <h2 id="send-h">Send an NPC</h2>
      <Field label="To">
        <div className="row wrap" role="group" aria-label="Players">
          {players.length ? players.map((p) => (
            <button key={p.id} type="button" className={`btn small${to.includes(p.id) ? ' on' : ''}`} aria-pressed={to.includes(p.id)} onClick={() => toggle(p.id)}>{p.character_name || p.display_name}</button>
          )) : <span className="small muted">No players in this world yet.</span>}
          {players.length > 1 && <button type="button" className="btn ghost small" onClick={() => setTo(to.length === players.length ? [] : players.map((p) => p.id))}>{to.length === players.length ? 'None' : 'Everyone'}</button>}
        </div>
      </Field>
      <Tabs label="What to send" value={mode} onChange={setMode} items={[['quick', 'Quick line'], ['saved', 'Saved or starter']]} />
      {(people.data?.length ?? 0) > 0 && (
        <Field label="Someone from People (optional)" help="Fills in the NPC's name and look.">
          <select value="" onChange={(e) => fromPerson(e.target.value)} data-testid="enc-person">
            <option value="">Pick an NPC…</option>
            {people.data!.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? ` · ${p.role}` : ''}</option>)}
          </select>
        </Field>
      )}
      {mode === 'saved' ? (
        <>
          <Field label="Encounter">
            <select value={tid} onChange={(e) => setTid(e.target.value)}>
              {templates.map((x) => <option key={x.id} value={x.id}>{x.builtin ? '★ ' : ''}{x.kind === 'event' ? '⚡ ' : ''}{x.name}</option>)}
            </select>
          </Field>
          {t && <span className="small muted">{t.npcName}: {t.npcBlurb || 'no description'} · {t.script.nodes.length} step{t.script.nodes.length === 1 ? '' : 's'}</span>}
          <Field label="NPC name (optional)" help="Leave empty to keep the encounter's own."><input value={npcName} onChange={(e) => setNpcName(e.target.value)} maxLength={80} /></Field>
        </>
      ) : (
        <>
          <Field label="NPC name"><input value={npcName} onChange={(e) => setNpcName(e.target.value)} placeholder="A stranger" maxLength={80} /></Field>
          <Field label="Looks like (optional)"><input value={npcBlurb} onChange={(e) => setNpcBlurb(e.target.value)} maxLength={300} /></Field>
          <Field label="They say"><textarea rows={3} value={line} onChange={(e) => setLine(e.target.value)} maxLength={1000} /></Field>
          <Field label="Answers the player can pick" help="Leave them empty for just “Farewell”. You can speak again once they answer.">
            <div className="stack tight">
              {answers.map((a, i) => <input key={i} value={a} placeholder={`Answer ${i + 1}`} maxLength={120} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? e.target.value : x)))} />)}
              {answers.length < 6 && <button type="button" className="btn ghost small" onClick={() => setAnswers([...answers, ''])}>+ Answer</button>}
            </div>
          </Field>
        </>
      )}
      {(needsShop || shops.length > 0) && (
        <Field label="Shop they can show" help={needsShop ? 'This encounter has a “show me your wares” option. Pick the shop, or leave it to any open one.' : 'Only used by options that open a shop.'}>
          <select value={shopId} onChange={(e) => setShopId(e.target.value)}>
            <option value="">Any open shop</option>
            {shops.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status !== 'open' ? ` (${s.status})` : ''}</option>)}
          </select>
        </Field>
      )}
      <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={addPeople} onChange={(e) => setAddPeople(e.target.checked)} /><span className="small">Add this NPC to the party’s People list</span></label>
      <ErrorBox error={act.error} />
      <button type="button" className="btn primary" disabled={act.busy || !to.length || (mode === 'quick' ? !line.trim() : !tid)} onClick={() => void send()} data-testid="enc-send">Send</button>
      {toastNode}
    </section>
  );
}

function Watch({ e, cfg }: { e: Encounter; cfg: EncounterConfig }) {
  const { w } = useWorld();
  const act = useAction();
  const [say, setSay] = useState('');
  const [answers, setAnswers] = useState('');
  const open = e.status === 'open';
  const path = `/encounters/${encodeURIComponent(e.id)}`;
  const speak = () => act.run(async () => {
    await w.call('POST', `${path}/say`, { text: say, answers: answers.split('\n').map((a) => a.trim()).filter(Boolean) });
    setSay(''); setAnswers('');
  });
  return (
    <section className={`card enc-watch${open ? ' gold' : ''}`} data-testid="enc-watch">
      <div className="row between">
        <strong>{e.npc.name} <span className="muted">→ {e.player}</span></strong>
        <span className="row" style={{ gap: 6 }}>
          {e.kind === 'event' && <span className="chip">Story event</span>}
          {e.source === 'wander' && <span className="chip teal">Wandered</span>}
          <span className={`chip${open ? ' gold' : ''}`}>{open ? (e.kind === 'event' ? 'Happening' : 'Talking') : e.status === 'done' ? 'Finished' : 'Ended'}</span>
          <span className="tiny faint">{when(e.updatedAt)}</span>
        </span>
      </div>
      {e.templateName && <span className="tiny faint">{e.templateName}{e.paidCp ? ` · paid out ${coins(e.paidCp, cfg.coins)}` : ''}</span>}
      <div className="enc-log">
        {e.log.map((l, i) => <div key={i} className={`enc-line ${l.who}`}>{(l.who === 'npc' || l.who === 'gm') && <span className="enc-who">{l.who === 'gm' ? `${e.npc.name} (you)` : e.npc.name}</span>}{l.who === 'you' && <span className="enc-who">{e.player}</span>}{l.who === 'secret' && <span className="enc-who">GM note</span>}<span>{l.text}</span></div>)}
      </div>
      {open && (
        <>
          <span className="small muted">
            {e.timer && <><i className="fa-solid fa-stopwatch" aria-hidden="true" /> {e.timer.endsAt ? <Countdown endsAt={e.timer.endsAt} /> : `${e.timer.secs}s once they open it`} · </>}Waiting on: {e.game ? `${e.game.label}${e.dc ? ` (DC ${e.dc}${e.dcMax ? `–${e.dcMax}` : ''})` : ''}` : ''}{e.game && e.options.length ? ' or ' : ''}{e.options.map((o) => `“${o.label}”`).join(', ')}
          </span>
          <details>
            <summary className="small">{e.kind === 'event' ? 'Narrate what happens next' : `Speak as ${e.npc.name}`}</summary>
            <div className="stack tight" style={{ marginTop: 8 }}>
              <textarea rows={2} value={say} onChange={(ev) => setSay(ev.target.value)} placeholder="What they say now" maxLength={1000} />
              <textarea rows={2} value={answers} onChange={(ev) => setAnswers(ev.target.value)} placeholder={'Answers, one per line (empty: just “Farewell”)'} />
              <button type="button" className="btn small primary" disabled={act.busy || !say.trim()} onClick={() => void speak()}>Say it</button>
            </div>
          </details>
          <div className="row"><button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(() => w.call('POST', `${path}/end`))}>{e.kind === 'event' ? 'End the event' : 'End the talk'}</button></div>
        </>
      )}
      <ErrorBox error={act.error} />
    </section>
  );
}

// ---------------- story events ----------------

type Source = 'any' | 'fav' | 'mine' | 'builtin';
const SOURCES: [Source, string][] = [['any', 'Any'], ['fav', '★ Favourites'], ['mine', 'My events'], ['builtin', 'Built-in']];
/** What the preview shows: a saved or built-in event, or a fresh draft (not saved yet). */
type Pick = { t: Template; random?: boolean; draft?: boolean };

/**
 * Pick where the party is and who it happens to, then pick an event: from the list, a random one (favourites, your
 * own, the built-ins, or any), or a new one the assistant drafts. Every event opens in a preview first, where the GM
 * sends it, tweaks it, or tries another. Stars keep favourites at the top.
 */
function StoryEvents({ data, cfg, shops, reload }: { data: { templates: Template[]; starters: Template[]; places: PlaceOpt[] }; cfg: EncounterConfig; shops: ShopLite[]; reload: () => Promise<void> }) {
  const { w, members, info } = useWorld();
  const players = members.filter((m) => m.role === 'player');
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [to, setTo] = useState<string[]>([]);
  const remembered = (k: string, d: string) => { try { return localStorage.getItem(`alx-story-${k}-${info.slug}`) ?? d; } catch { return d; } };
  const remember = (k: string, v: string) => { try { localStorage.setItem(`alx-story-${k}-${info.slug}`, v); } catch { /* private mode */ } };
  const [place, setPlace] = useState<string>(() => remembered('place', ''));
  const [from, setFrom] = useState<Source>(() => remembered('from', 'any') as Source);
  const [favs, setFavs] = useState<Record<string, boolean>>({});
  const [pick, setPick] = useState<Pick | null>(null);
  const [gen, setGen] = useState(false);
  const list = useLoad<Encounter[]>(() => w.call('GET', '/encounters'), [w], ['encounter']);
  const choosePlace = (p: string) => { setPlace(p); remember('place', p); };
  const chooseFrom = (f: Source) => { setFrom(f); remember('from', f); };
  const label = (p: string) => data.places.find((x) => x.id === p)?.label ?? p;
  const isFav = (t: Template) => favs[t.id] ?? !!t.fav;
  const all = [...data.templates, ...data.starters].filter((t) => t.kind === 'event');
  const here = all
    .filter((t) => !place || t.places?.includes(place))
    .filter((t) => from === 'any' || (from === 'fav' ? isFav(t) : from === 'mine' ? !t.builtin : t.builtin))
    .sort((a, b) => Number(isFav(b)) - Number(isFav(a)) || Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  const toggle = (id: string) => setTo((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const star = (t: Template) => act.run(async () => {
    const fav = !isFav(t);
    setFavs((f) => ({ ...f, [t.id]: fav }));
    await w.call('PUT', `/encounters/templates/fav/${encodeURIComponent(t.id)}`, { fav });
  });
  const random = (not?: string) => {
    const pool = here.length > 1 && not ? here.filter((t) => t.id !== not) : here;
    if (pool.length) setPick({ t: pool[Math.floor(Math.random() * pool.length)], random: true });
  };
  const whoText = to.length === players.length && players.length > 1 ? 'everyone' : to.length === 1 ? (players.find((p) => p.id === to[0])?.character_name || 'one player') : `${to.length} players`;
  const send = (p: Pick) => act.run(async () => {
    const t = p.t;
    const body = t.id ? { accountIds: to, templateId: t.id } : { accountIds: to, kind: 'event', name: t.name, npcName: t.npcName, npcBlurb: t.npcBlurb, script: t.script };
    const made = await w.call<Encounter[]>('POST', '/encounters', body);
    toast(`${made[0]?.templateName || t.name} sent to ${whoText}`);
    setPick(null);
    void list.reload();
  });
  const live = (list.data ?? []).filter((e) => e.kind === 'event');
  const open = live.filter((e) => e.status === 'open');
  const fromText = from === 'fav' ? 'favourite ' : from === 'mine' ? 'saved ' : from === 'builtin' ? 'built-in ' : '';
  return (
    <div className="cols">
      <div className="col-1 stack">
        <section className="card stack" aria-labelledby="story-h">
          <h2 id="story-h">Make something happen</h2>
          <span className="small muted">A quick moment for one player, a few, or everyone: a pickpocket, an undervalued gem, a rotten bridge. You see each event before it goes out; they choose; you see every choice and its consequence.</span>
          <Field label="Where they are">
            <div className="row wrap" role="group" aria-label="Place">
              <button type="button" className={`btn small${!place ? ' on' : ''}`} aria-pressed={!place} onClick={() => choosePlace('')}>Anywhere</button>
              {data.places.map((p) => <button key={p.id} type="button" className={`btn small${place === p.id ? ' on' : ''}`} aria-pressed={place === p.id} onClick={() => choosePlace(p.id)} data-testid={`story-place-${p.id}`}>{p.label}</button>)}
            </div>
          </Field>
          <Field label="Happens to">
            <div className="row wrap" role="group" aria-label="Players">
              {players.length ? players.map((p) => (
                <button key={p.id} type="button" className={`btn small${to.includes(p.id) ? ' on' : ''}`} aria-pressed={to.includes(p.id)} onClick={() => toggle(p.id)}>{p.character_name || p.display_name}</button>
              )) : <span className="small muted">No players in this world yet.</span>}
              {players.length > 1 && <button type="button" className="btn ghost small" onClick={() => setTo(to.length === players.length ? [] : players.map((p) => p.id))}>{to.length === players.length ? 'None' : 'Everyone'}</button>}
            </div>
          </Field>
          <Field label="Pick from">
            <div className="row wrap" role="group" aria-label="Pick from">
              {SOURCES.map(([k, l]) => <button key={k} type="button" className={`btn small${from === k ? ' on' : ''}`} aria-pressed={from === k} onClick={() => chooseFrom(k)} data-testid={`story-from-${k}`}>{l}</button>)}
            </div>
          </Field>
          <ErrorBox error={act.error} />
          <div className="row wrap">
            <button type="button" className="btn primary" disabled={!here.length} onClick={() => random()} data-testid="story-random">
              <i className="fa-solid fa-dice" aria-hidden="true" /> Random {fromText}{place ? `${label(place).toLowerCase()} ` : ''}event
            </button>
            <button type="button" className="btn" onClick={() => setGen(true)} data-testid="story-generate"><i className="fa-solid fa-wand-magic-sparkles" aria-hidden="true" /> Generate new</button>
          </div>
          <span className="tiny faint">Nothing goes out until you press Send in the preview.</span>
          {toastNode}
        </section>
        <section className="card stack" aria-label="Events for this place">
          <h3 className="enc-h">{place ? `${label(place)} events` : 'All story events'}</h3>
          {!here.length && <Empty>{from === 'fav' ? 'No favourites here yet. Star an event to keep it at the top.' : `None here yet. Generate one, or make one under Saved and tag it ${place ? label(place) : 'with a place'}.`}</Empty>}
          {here.map((t) => (
            <div key={t.id} className="row between enc-pick" style={{ gap: 8 }} data-testid="story-event" data-name={t.name}>
              <button type="button" className={`btn ghost small enc-star${isFav(t) ? ' on' : ''}`} aria-pressed={isFav(t)} aria-label={isFav(t) ? `Unstar ${t.name}` : `Star ${t.name}`} onClick={() => void star(t)} data-testid="story-star">
                <i className={`fa-${isFav(t) ? 'solid' : 'regular'} fa-star`} aria-hidden="true" />
              </button>
              <span className="stack tight" style={{ minWidth: 0, flex: 1 }}>
                <strong>{t.name}{t.builtin && <span className="tiny faint enc-builtin"> · built-in</span>}</strong>
                <span className="tiny faint">{(t.places ?? []).map(label).join(' · ') || 'Anywhere'}</span>
              </span>
              <button type="button" className="btn small" onClick={() => setPick({ t })} data-testid="story-open">Preview</button>
            </div>
          ))}
        </section>
      </div>
      <div className="col-2 stack loose">
        <ErrorBox error={list.error} />
        <h2 className="enc-h">Happening now</h2>
        {!list.data ? <Loading /> : !open.length ? <Empty>Nothing is happening to anyone. Send an event from the left.</Empty> : open.map((e) => <Watch key={e.id} e={e} cfg={cfg} />)}
        {live.length > open.length && <><h2 className="enc-h">Earlier</h2>{live.filter((e) => e.status !== 'open').slice(0, 15).map((e) => <Watch key={e.id} e={e} cfg={cfg} />)}</>}
      </div>
      {gen && <Generate place={place} placeLabel={place ? label(place) : ''} onClose={() => setGen(false)} onDraft={(t) => { setGen(false); setPick({ t, draft: true }); }} />}
      {pick && (
        <StoryPreview key={pick.t.id || pick.t.name} pick={pick} shops={shops} places={data.places} label={label} who={to.length ? whoText : ''} busy={act.busy} error={act.error}
          fav={pick.t.id ? isFav(pick.t) : null} onStar={() => void star(pick.t)}
          onSend={() => void send(pick)} onClose={() => setPick(null)}
          onAnother={pick.random ? () => random(pick.t.id) : pick.draft ? () => { setPick(null); setGen(true); } : undefined}
          onSaved={(t) => { setPick({ t }); void reload(); }} />
      )}
    </div>
  );
}

/** "Generate new": the assistant drafts a story event for the place; it opens in the preview, not saved or sent. */
function Generate({ place, placeLabel, onClose, onDraft }: { place: string; placeLabel: string; onClose: () => void; onDraft: (t: Template) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [prompt, setPrompt] = useState('');
  const [guide, setGuide] = useState('');
  const guides = useLoad<{ templates: { id: string; name: string; kind: string; enabled: boolean }[] }>(() => w.call('GET', '/templates', undefined, { kind: 'event' }), [w]);
  const usable = (guides.data?.templates ?? []).filter((g) => g.enabled && g.kind === 'event');
  const go = () => act.run(async () => {
    const ask = prompt.trim() || `Something small and surprising that happens to one character ${placeLabel ? `in a ${placeLabel.toLowerCase()}` : 'on their travels'}, with a real choice.`;
    const r = await w.call<{ name: string; npcName: string; npcBlurb: string; script: Script; kind?: EncounterKind; places?: string[] }>('POST', '/encounters/templates/draft', { prompt: ask, kind: 'event', places: place ? [place] : [], guide: guide || undefined });
    onDraft({ id: '', kind: 'event', places: r.places?.length ? r.places : place ? [place] : [], name: r.name, npcName: r.npcName, npcBlurb: r.npcBlurb, script: r.script, wander: false, builtin: false });
  });
  return (
    <Modal title="Generate a story event" onClose={onClose}>
      <div className="stack" data-testid="story-gen">
        <span className="small muted">The assistant writes a new event{placeLabel ? ` for a ${placeLabel.toLowerCase()}` : ''}. You see it before anything is sent or saved.</span>
        <Field label="What kind of thing? (optional)"><textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={3000} placeholder="A street kid steals a purse; a merchant short-changes them; a dog follows them home…" data-testid="story-gen-prompt" /></Field>
        {usable.length > 0 && (
          <label className="field"><span className="label">Follow a quick event template</span>
            <select value={guide} onChange={(e) => setGuide(e.target.value)}><option value="">None</option>{usable.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          </label>
        )}
        <ErrorBox error={act.error} />
        <div className="row"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void go()} data-testid="story-gen-go">{act.busy ? 'Writing…' : 'Generate'}</button><button type="button" className="btn ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}

const fxText = (fx: Effect, money: (cp: number) => string): string => fx.kind === 'gold' ? `gets ${money(fx.cp)}` : fx.kind === 'pay' ? `pays ${money(fx.cp)}` : fx.kind === 'lose' ? `loses ${money(fx.cp)}` : fx.kind === 'item' ? `gets ${fx.qty > 1 ? `${fx.qty} × ` : ''}${fx.name}` : fx.kind === 'gmnote' ? `GM note: ${fx.text}` : 'opens a shop';

/** The event before it goes out: every step, answer, check and timer. Send, tweak (edit and save), or try another. */
function StoryPreview({ pick, shops, places, label, who, busy, error, fav, onStar, onSend, onClose, onAnother, onSaved }: {
  pick: Pick; shops: ShopLite[]; places: PlaceOpt[]; label: (p: string) => string; who: string; busy: boolean; error: string | null; fav: boolean | null;
  onStar: () => void; onSend: () => void; onClose: () => void; onAnother?: () => void; onSaved: (t: Template) => void;
}) {
  const { info } = useWorld();
  const [tweak, setTweak] = useState(false);
  const t = pick.t;
  const money = (cp: number) => coins(cp, info.settings.coins);
  const order = [t.script.nodes.find((n) => n.id === t.script.start), ...t.script.nodes.filter((n) => n.id !== t.script.start)].filter(Boolean) as Node[];
  if (tweak) {
    // A built-in or a fresh draft becomes your own saved copy; your own event is edited in place.
    const start = t.builtin ? { ...structuredClone(t), id: '', builtin: false, wander: false } : t;
    return (
      <Modal title={`Tweak: ${t.name}`} onClose={onClose}>
        <div className="stack" data-testid="story-tweak">
          {t.builtin && <span className="small muted">Saving makes your own copy; the built-in one stays as it is.</span>}
          <Editor start={start} shops={shops} places={places} onSaved={(s) => { setTweak(false); onSaved(s); }} onGone={onClose} />
          <button type="button" className="btn ghost" onClick={() => setTweak(false)}>Back to the preview</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t.name} onClose={onClose}>
      <div className="stack" data-testid="story-preview">
        <div className="row between">
          <span className="small muted">{t.npcName}{t.npcBlurb ? ` · ${t.npcBlurb}` : ''}</span>
          {fav !== null && <button type="button" className={`btn ghost small enc-star${fav ? ' on' : ''}`} aria-pressed={fav} onClick={onStar} aria-label={fav ? 'Unstar' : 'Star'}><i className={`fa-${fav ? 'solid' : 'regular'} fa-star`} aria-hidden="true" /> {fav ? 'Favourite' : 'Star'}</button>}
        </div>
        <span className="tiny faint">{pick.draft ? 'New draft, not saved' : t.builtin ? 'Built-in' : 'Saved'} · {(t.places ?? []).map(label).join(' · ') || 'Anywhere'}</span>
        <ol className="enc-preview">
          {order.map((n) => (
            <li key={n.id} className="stack tight">
              <span className="tiny faint">{n.id}{n.timer ? ` · ⏱ ${n.timer.secs}s` : ''}</span>
              <span>{n.text}</span>
              {n.game && <span className="small"><i className="fa-solid fa-dice-d20" aria-hidden="true" /> {n.game.kind === 'check' ? `${n.game.skill || 'Skill'} check, ${dcLabel(n.game)}` : GAME_LABEL_GM[n.game.kind]}: pass → {n.game.win}, fail → {n.game.lose}</span>}
              {n.options.map((o, j) => <span key={j} className="small">• {o.label}{o.effects.length ? ` (${o.effects.map((fx) => fxText(fx, money)).join('; ')})` : ''} → {o.next ?? 'ends'}</span>)}
              {n.timer && <span className="tiny faint">If time runs out: {n.timer.fallback === -1 ? 'the check fails' : `“${n.options[n.timer.fallback]?.label ?? 'the last answer'}”`}</span>}
            </li>
          ))}
        </ol>
        <ErrorBox error={error} />
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={busy || !who} onClick={onSend} data-testid="story-send">{who ? `Send to ${who}` : 'Pick who it happens to first'}</button>
          <button type="button" className="btn" onClick={() => setTweak(true)} data-testid="story-tweak-btn">{pick.draft ? 'Tweak or save' : 'Tweak'}</button>
          {onAnother && <button type="button" className="btn" onClick={onAnother} data-testid="story-another"><i className="fa-solid fa-rotate" aria-hidden="true" /> {pick.draft ? 'Generate another' : 'Try another'}</button>}
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}

const GAME_LABEL_GM: Record<GameKind, string> = { coin: 'Coin toss', shells: 'Shell game', dice: 'Dice duel', check: 'Skill check' };
const dcLabel = (g: { dc: number | null; dcMax?: number | null }) => (g.dc === null ? 'DC ?' : `DC ${g.dc}${g.dcMax ? `–${g.dcMax}` : ''}`);

// ---------------- saved encounters ----------------

const blank = (kind: EncounterKind = 'npc'): Template => kind === 'event'
  ? { id: '', kind, places: [], name: 'New story event', npcName: 'Something happens', npcBlurb: '', wander: false, builtin: false, script: { start: 'start', nodes: [{ id: 'start', text: 'Something happens.', options: [{ label: 'Deal with it', next: null, effects: [] }, { label: 'Ignore it', next: null, effects: [] }], game: null }] } }
  : { id: '', kind, places: [], name: 'New encounter', npcName: 'A stranger', npcBlurb: '', wander: false, builtin: false, script: { start: 'start', nodes: [{ id: 'start', text: 'Hello there.', options: [{ label: 'Hello', next: null, effects: [] }], game: null }] } };

function Library({ data, shops, reload }: { data: { templates: Template[]; starters: Template[]; places: PlaceOpt[] }; shops: ShopLite[]; reload: () => Promise<void> }) {
  const [sel, setSel] = useState<Template | null>(null);
  const [kind, setKind] = useState<EncounterKind>('npc');
  const copy = (t: Template): Template => ({ ...structuredClone(t), id: '', builtin: false, name: t.builtin ? t.name : `${t.name} (copy)`, wander: false });
  const mine = data.templates.filter((t) => (t.kind ?? 'npc') === kind);
  const starters = data.starters.filter((t) => (t.kind ?? 'npc') === kind);
  return (
    <div className="cols">
      <nav className="col-1 stack" aria-label="Saved encounters and story events">
        <Tabs label="Kind" value={kind} onChange={(k) => setKind(k)} items={[['npc', 'NPC encounters'], ['event', 'Story events']]} />
        <button type="button" className="btn" onClick={() => setSel(blank(kind))}>{kind === 'event' ? 'New story event' : 'New encounter'}</button>
        <DraftBox kind={kind} places={data.places} onDraft={(t) => setSel(t)} />
        {mine.map((t) => (
          <button key={t.id} type="button" className={`card enc-pick${sel?.id === t.id ? ' on' : ''}`} onClick={() => setSel(structuredClone(t))}>
            <div className="row between"><strong>{t.name}</strong>{t.wander && <span className="chip teal">Wander</span>}</div>
            <span className="small muted">{kind === 'event' ? (t.places ?? []).map((p) => data.places.find((x) => x.id === p)?.label ?? p).join(' · ') || 'Anywhere' : t.npcName}</span>
          </button>
        ))}
        <h3 className="enc-h">Starters</h3>
        <span className="tiny faint">Ready to send. Copy one to change it.{kind === 'npc' && !data.templates.some((t) => t.wander) ? ' While none of yours is marked Wander, wandering players meet these.' : ''}</span>
        {starters.map((t) => (
          <div key={t.id} className="card enc-pick">
            <strong>{t.name}</strong>
            <span className="small muted">{kind === 'event' ? (t.places ?? []).map((p) => data.places.find((x) => x.id === p)?.label ?? p).join(' · ') : t.npcName}</span>
            <button type="button" className="btn small ghost" onClick={() => setSel(copy(t))}>Copy and edit</button>
          </div>
        ))}
      </nav>
      <div className="col-2 stack loose">
        {sel ? <Editor key={sel.id || `${sel.name}-${sel.script.nodes.length}-${sel.npcName}`} start={sel} shops={shops} places={data.places} onSaved={async (t) => { await reload(); setSel(t); }} onGone={async () => { await reload(); setSel(null); }} /> : <Empty>Pick one to edit, or start a new one.</Empty>}
      </div>
    </div>
  );
}

/** Describe an encounter and the world's chat model drafts the steps; the GM edits and saves it. */
function DraftBox({ onDraft, kind = 'npc', places = [] }: { onDraft: (t: Template) => void; kind?: EncounterKind; places?: PlaceOpt[] }) {
  const { w } = useWorld();
  const act = useAction();
  const [prompt, setPrompt] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [where, setWhere] = useState<string[]>([]);
  const [guide, setGuide] = useState('');
  const guides = useLoad<{ templates: { id: string; name: string; kind: string; enabled: boolean }[] }>(() => (kind === 'event' ? w.call('GET', '/templates', undefined, { kind: 'event' }) : Promise.resolve({ templates: [] })), [w, kind]);
  const go = () => act.run(async () => {
    const r = await w.call<{ name: string; npcName: string; npcBlurb: string; script: Script; usedModel: boolean; note: string | null; kind?: EncounterKind; places?: string[] }>('POST', '/encounters/templates/draft', { prompt, kind, places: where, guide: guide || undefined });
    setNote(r.note);
    onDraft({ id: '', kind: r.kind ?? kind, places: r.places ?? where, name: r.name, npcName: r.npcName, npcBlurb: r.npcBlurb, script: r.script, wander: false, builtin: false });
  });
  return (
    <details className="card enc-draft">
      <summary><i className="fa-solid fa-wand-magic-sparkles" aria-hidden="true" /> {kind === 'event' ? 'Draft a story event with the assistant' : 'Draft one with the assistant'}</summary>
      <div className="stack tight" style={{ marginTop: 8 }}>
      <textarea className="input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={3000} placeholder={kind === 'event' ? 'Someone steals their coin purse in the market. If they catch the thief, do they keep the extra coin or give it back?' : 'A nervous fence behind the tannery offers a dice game; if they win, he tips them off about the guard rotation.'} style={{ padding: '8px 10px' }} />
      {kind === 'event' && <>
        <div className="row wrap" role="group" aria-label="Places it fits">
          {places.map((p) => <button key={p.id} type="button" className={`btn small${where.includes(p.id) ? ' on' : ''}`} aria-pressed={where.includes(p.id)} onClick={() => setWhere(where.includes(p.id) ? where.filter((x) => x !== p.id) : [...where, p.id])}>{p.label}</button>)}
        </div>
        {(guides.data?.templates ?? []).filter((g) => g.enabled).length > 0 && (
          <label className="field"><span className="label">Follow a quick event template</span>
            <select value={guide} onChange={(e) => setGuide(e.target.value)} data-testid="enc-draft-guide">
              <option value="">None</option>
              {guides.data!.templates.filter((g) => g.enabled).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
      </>}
      <ErrorBox error={act.error} />
      {note && <span className="tiny faint">{note}</span>}
      <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} disabled={act.busy || !prompt.trim()} onClick={() => void go()}>{act.busy ? 'Drafting…' : 'Draft'}</button>
      <span className="tiny faint">Nothing is sent or saved until you do.</span>
      </div>
    </details>
  );
}

const slug = (s: string, taken: string[]) => {
  const b = s.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'step';
  let id = b, n = 2;
  while (taken.includes(id)) id = `${b}-${n++}`;
  return id;
};

function Editor({ start, shops, places = [], onSaved, onGone }: { start: Template; shops: ShopLite[]; places?: PlaceOpt[]; onSaved: (t: Template) => void; onGone: () => void }) {
  const { w, info } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [t, setT] = useState<Template>(start);
  useEffect(() => setT(start), [start]);
  const ids = t.script.nodes.map((n) => n.id);
  const setScript = (s: Script) => setT({ ...t, script: s });
  const setNode = (i: number, n: Node) => setScript({ ...t.script, nodes: t.script.nodes.map((x, j) => (j === i ? n : x)) });
  const addNode = () => setScript({ ...t.script, nodes: [...t.script.nodes, { id: slug('step', ids), text: '', options: [], game: null }] });
  const delNode = (i: number) => {
    const gone = t.script.nodes[i].id;
    const nodes = t.script.nodes.filter((_, j) => j !== i).map((n) => ({ ...n, options: n.options.map((o) => (o.next === gone ? { ...o, next: null } : o)), game: n.game && (n.game.win === gone || n.game.lose === gone) ? null : n.game }));
    setScript({ start: t.script.start === gone ? nodes[0]?.id ?? '' : t.script.start, nodes });
  };
  const save = () => act.run(async () => {
    const body = { kind: t.kind ?? 'npc', places: t.places ?? [], name: t.name, npcName: t.npcName, npcBlurb: t.npcBlurb, wander: t.wander, script: t.script };
    const saved = t.id ? await w.call<Template>('PUT', `/encounters/templates/all/${encodeURIComponent(t.id)}`, body) : await w.call<Template>('POST', '/encounters/templates/all', body);
    toast('Saved');
    onSaved(saved);
  });
  const del = () => act.run(async () => { await w.call('DELETE', `/encounters/templates/all/${encodeURIComponent(t.id)}`); onGone(); });
  const money = (cp: number) => coins(cp, info.settings.coins);
  const ev = t.kind === 'event';
  const tagged = t.places ?? [];
  return (
    <section className="card stack loose" aria-label={ev ? 'Edit story event' : 'Edit encounter'}>
      <div className="row wrap">
        <Field label="Name"><input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} maxLength={120} /></Field>
        <Field label={ev ? 'Who or what it is about' : 'NPC'}><input value={t.npcName} onChange={(e) => setT({ ...t, npcName: e.target.value })} maxLength={80} placeholder={ev ? 'A pickpocket' : ''} /></Field>
      </div>
      <Field label={ev ? 'The scene, in a line' : 'Looks like'}><input value={t.npcBlurb} onChange={(e) => setT({ ...t, npcBlurb: e.target.value })} maxLength={300} /></Field>
      {ev && (
        <Field label="Places it fits" help="The Story events tab offers it for these places; a random event for a place picks among them.">
          <div className="row wrap" role="group" aria-label="Places it fits">
            {places.map((p) => <button key={p.id} type="button" className={`btn small${tagged.includes(p.id) ? ' on' : ''}`} aria-pressed={tagged.includes(p.id)} onClick={() => setT({ ...t, places: tagged.includes(p.id) ? tagged.filter((x) => x !== p.id) : [...tagged, p.id] })}>{p.label}</button>)}
          </div>
        </Field>
      )}
      <div className="row between">
        <div className="stack tight"><strong style={{ fontWeight: 500 }}>{ev ? 'Wandering players can run into this' : 'Wandering players can meet this NPC'}</strong><span className="small muted">Only when wandering is on in Settings.</span></div>
        <Switch checked={t.wander} onChange={(v) => setT({ ...t, wander: v })} label="Wander" />
      </div>
      <Field label="Starts at">
        <select value={t.script.start} onChange={(e) => setScript({ ...t.script, start: e.target.value })}>{ids.map((id) => <option key={id} value={id}>{id}</option>)}</select>
      </Field>

      {t.script.nodes.map((n, i) => (
        <div key={i} className="card enc-node">
          <div className="row between">
            <label className="field" style={{ width: 180 }}><span className="label">Step id</span>
              <input value={n.id} onChange={(e) => {
                const nid = e.target.value.replace(/[^\w-]/g, '').slice(0, 40);
                // Renaming a step renames every link to it.
                const nodes = t.script.nodes.map((x, j) => ({ ...(j === i ? { ...x, id: nid } : x), options: x.options.map((o) => (o.next === n.id ? { ...o, next: nid } : o)), game: x.game && { ...x.game, win: x.game.win === n.id ? nid : x.game.win, lose: x.game.lose === n.id ? nid : x.game.lose } }));
                setScript({ start: t.script.start === n.id ? nid : t.script.start, nodes });
              }} />
            </label>
            {t.script.nodes.length > 1 && <button type="button" className="btn ghost small" onClick={() => delNode(i)}>Remove step</button>}
          </div>
          <Field label={ev ? 'What happens' : 'NPC says'}><textarea rows={2} value={n.text} onChange={(e) => setNode(i, { ...n, text: e.target.value })} maxLength={1000} /></Field>

          <div className="row between">
            <span className="small">Game here</span>
            <select className="input" aria-label="Game here" value={n.game?.kind ?? ''} onChange={(e) => setNode(i, { ...n, game: e.target.value ? { kind: e.target.value as GameKind, stakeCp: n.game?.stakeCp ?? 0, winCp: n.game?.winCp ?? 10, dc: e.target.value === 'check' ? n.game?.dc ?? 12 : null, skill: n.game?.skill ?? null, win: n.game?.win ?? n.id, lose: n.game?.lose ?? n.id } : null })} style={{ width: 'auto' }}>
              <option value="">None</option>
              {(['coin', 'shells', 'dice', 'check'] as GameKind[]).map((k) => <option key={k} value={k}>{k === 'coin' ? 'Coin toss' : k === 'shells' ? 'Shell game' : k === 'dice' ? 'Dice duel' : 'Skill check'}</option>)}
            </select>
          </div>
          {n.game && (
            <div className="stack tight enc-gamebox">
              <span className="tiny faint">{GAME_HELP[n.game.kind]}</span>
              <div className="row wrap">
                <CoinInput label="Stake" cp={n.game.stakeCp} money={money} onChange={(cp) => setNode(i, { ...n, game: { ...n.game!, stakeCp: cp } })} />
                <CoinInput label="Win pays" cp={n.game.winCp} money={money} onChange={(cp) => setNode(i, { ...n, game: { ...n.game!, winCp: cp } })} />
                {n.game.kind === 'check' && <>
                  <label className="field" style={{ width: 80 }}><span className="label">DC from</span><input inputMode="numeric" aria-label="DC from" value={n.game.dc ?? ''} onChange={(e) => setNode(i, { ...n, game: { ...n.game!, dc: Number(e.target.value.replace(/\D/g, '')) || null } })} /></label>
                  <label className="field" style={{ width: 80 }}><span className="label">to</span><input inputMode="numeric" aria-label="DC to" placeholder="same" value={n.game.dcMax ?? ''} onChange={(e) => setNode(i, { ...n, game: { ...n.game!, dcMax: Number(e.target.value.replace(/\D/g, '')) || null } })} /></label>
                  <label className="field" style={{ width: 140 }}><span className="label">Skill</span><input value={n.game.skill ?? ''} onChange={(e) => setNode(i, { ...n, game: { ...n.game!, skill: e.target.value || null } })} maxLength={40} /></label>
                </>}
              </div>
              <div className="row wrap">
                <label className="field" style={{ width: 160 }}><span className="label">On a win go to</span><NextPicker ids={ids} value={n.game.win} required onChange={(v) => setNode(i, { ...n, game: { ...n.game!, win: v ?? n.id } })} /></label>
                <label className="field" style={{ width: 160 }}><span className="label">On a loss go to</span><NextPicker ids={ids} value={n.game.lose} required onChange={(v) => setNode(i, { ...n, game: { ...n.game!, lose: v ?? n.id } })} /></label>
              </div>
            </div>
          )}

          <div className="row wrap enc-timer-edit" data-testid="enc-timer-edit">
            <label className="row tight small"><input type="checkbox" checked={!!n.timer} onChange={(e) => setNode(i, { ...n, timer: e.target.checked ? { secs: 20, fallback: n.game ? -1 : Math.max(0, n.options.length - 1) } : null })} /> <i className="fa-solid fa-stopwatch" aria-hidden="true" /> Timed: they must answer quickly</label>
            {n.timer && <>
              <label className="field" style={{ width: 90 }}><span className="label">Seconds</span><input inputMode="numeric" aria-label="Seconds to answer" value={n.timer.secs} onChange={(e) => setNode(i, { ...n, timer: { ...n.timer!, secs: Math.min(600, Number(e.target.value.replace(/\D/g, '')) || 0) } })} /></label>
              <label className="field" style={{ flex: '1 1 200px' }}><span className="label">If time runs out</span>
                <select className="input" aria-label="If time runs out" value={n.timer.fallback} onChange={(e) => setNode(i, { ...n, timer: { ...n.timer!, fallback: Number(e.target.value) } })}>
                  {n.game && <option value={-1}>{n.game.kind === 'check' ? 'The check fails' : 'They lose the game'}</option>}
                  {n.options.map((o, j) => <option key={j} value={j}>{o.label || `Answer ${j + 1}`}</option>)}
                </select>
              </label>
            </>}
          </div>

          <span className="small">{n.game ? 'Other answers (e.g. walk away)' : 'Answers'}</span>
          {n.options.map((o, j) => {
            const setOpt = (patch: Partial<typeof o>) => setNode(i, { ...n, options: n.options.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
            const setFx = (fx: Effect[]) => setOpt({ effects: fx });
            return (
              <div key={j} className="enc-opt-edit stack tight">
                <div className="row wrap">
                  <input className="input" style={{ flex: '2 1 200px', width: 'auto' }} value={o.label} placeholder="What the player says" onChange={(e) => setOpt({ label: e.target.value })} maxLength={120} />
                  <NextPicker ids={ids} value={o.next} onChange={(v) => setOpt({ next: v })} />
                  <button type="button" className="btn ghost small" aria-label="Remove answer" onClick={() => setNode(i, { ...n, options: n.options.filter((_, k) => k !== j) })}>✕</button>
                </div>
                {o.effects.map((fx, k) => (
                  <div key={k} className="row wrap enc-fx">
                    {fx.kind === 'gold' && <CoinInput label="Gives coin" cp={fx.cp} money={money} onChange={(cp) => setFx(o.effects.map((x, m) => (m === k ? { kind: 'gold', cp } : x)))} />}
                    {(fx.kind === 'pay' || fx.kind === 'lose') && <CoinInput label={fx.kind === 'pay' ? 'They pay' : 'They lose'} cp={fx.cp} money={money} onChange={(cp) => setFx(o.effects.map((x, m) => (m === k ? { kind: fx.kind, cp: Math.max(1, cp) } : x)))} />}
                    {fx.kind === 'gmnote' && <label className="field" style={{ flex: '1 1 260px' }}><span className="label">Note for you (the player never sees it)</span><input value={fx.text} maxLength={300} placeholder="Kept the stolen purse; the thieves remember" onChange={(e) => setFx(o.effects.map((x, m) => (m === k ? { kind: 'gmnote', text: e.target.value } : x)))} /></label>}
                    {fx.kind === 'item' && <>
                      <label className="field" style={{ flex: '1 1 160px' }}><span className="label">Gives item</span><input value={fx.name} maxLength={120} onChange={(e) => setFx(o.effects.map((x, m) => (m === k ? { ...fx, name: e.target.value } : x)))} /></label>
                      <label className="field" style={{ width: 70 }}><span className="label">Qty</span><input inputMode="numeric" value={fx.qty} onChange={(e) => setFx(o.effects.map((x, m) => (m === k ? { ...fx, qty: Math.max(1, Math.min(20, Number(e.target.value.replace(/\D/g, '')) || 1)) } : x)))} /></label>
                      <label className="field" style={{ flex: '1 1 200px' }}><span className="label">Note on the item (optional)</span><input value={fx.note ?? ''} maxLength={200} placeholder="Worth about 10 gp to a jeweller" onChange={(e) => setFx(o.effects.map((x, m) => (m === k ? { ...fx, note: e.target.value || undefined } : x)))} /></label>
                    </>}
                    {fx.kind === 'shop' && (
                      <label className="field" style={{ flex: '1 1 200px' }}><span className="label">Opens a shop</span>
                        <select value={fx.shopId} onChange={(e) => setFx(o.effects.map((x, m) => (m === k ? { kind: 'shop', shopId: e.target.value } : x)))}>
                          <option value="">Chosen when sent (or any open shop)</option>
                          {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </label>
                    )}
                    <button type="button" className="btn ghost small" aria-label="Remove" onClick={() => setFx(o.effects.filter((_, m) => m !== k))}>✕</button>
                  </div>
                ))}
                {o.effects.length < 3 && (
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn ghost small" onClick={() => setFx([...o.effects, { kind: 'gold', cp: 10 }])}>+ Coin</button>
                    <button type="button" className="btn ghost small" onClick={() => setFx([...o.effects, { kind: 'item', name: '', qty: 1 }])}>+ Item</button>
                    <button type="button" className="btn ghost small" onClick={() => setFx([...o.effects, { kind: 'shop', shopId: '' }])}>+ Shop</button>
                    <button type="button" className="btn ghost small" onClick={() => setFx([...o.effects, { kind: 'pay', cp: 10 }])}>+ They pay</button>
                    <button type="button" className="btn ghost small" onClick={() => setFx([...o.effects, { kind: 'lose', cp: 10 }])}>+ They lose</button>
                    <button type="button" className="btn ghost small" onClick={() => setFx([...o.effects, { kind: 'gmnote', text: '' }])}>+ GM note</button>
                  </div>
                )}
              </div>
            );
          })}
          {n.options.length < 6 && <button type="button" className="btn ghost small" onClick={() => setNode(i, { ...n, options: [...n.options, { label: '', next: null, effects: [] }] })}>+ Answer</button>}
        </div>
      ))}
      {t.script.nodes.length < 40 && <button type="button" className="btn" onClick={addNode}>+ Step</button>}
      <ErrorBox error={act.error} />
      <div className="row">
        <button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save</button>
        {t.id && <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void del()}>Delete</button>}
      </div>
      {toastNode}
    </section>
  );
}

function NextPicker({ ids, value, onChange, required }: { ids: string[]; value: string | null; onChange: (v: string | null) => void; required?: boolean }) {
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Goes to" style={{ flex: '1 1 140px', width: 'auto' }}>
      {!required && <option value="">Ends the talk</option>}
      {ids.map((id) => <option key={id} value={id}>→ {id}</option>)}
    </select>
  );
}

function CoinInput({ label, cp, onChange, money }: { label: string; cp: number; onChange: (cp: number) => void; money: (cp: number) => string }) {
  const [s, setS] = useState(money(cp));
  useEffect(() => setS(money(cp)), [cp]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="field" style={{ width: 130 }}><span className="label">{label}</span>
      <input value={s} onChange={(e) => setS(e.target.value)} onBlur={() => { const v = parseCoins(s); onChange(v === null ? 0 : Math.max(0, Math.min(100_000, v))); }} />
    </label>
  );
}

// ---------------- settings ----------------

function Settings({ cfg, reload }: { cfg: EncounterConfig; reload: () => Promise<void> }) {
  const { w, reloadInfo, info } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [mins, setMins] = useState(String(cfg.wanderMinutes));
  const [cap, setCap] = useState(coins(cfg.capCp, info.settings.coins));
  const save = (patch: Record<string, unknown>) => act.run(async () => { await w.updateSettings(patch); await Promise.all([reload(), reloadInfo()]); toast('Saved'); });
  return (
    <section className="card stack loose">
      <div className="row between">
        <div className="stack tight" style={{ flex: '1 1 300px' }}><strong style={{ fontWeight: 500 }}>Players can wander</strong><span className="small muted">A “Wander about” card on their home page starts a random encounter: your saved ones marked Wander, or the starters if none are.</span></div>
        <Switch checked={cfg.wander} onChange={(v) => void save({ encounterWander: v })} label="Players can wander" />
      </div>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Minutes between wanders" help="Per player. 0 for no wait."><input inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
        <button type="button" className="btn" disabled={act.busy} onClick={() => void save({ encounterWanderMinutes: Math.min(1440, Number(mins) || 0) })}>Save</button>
      </div>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Most coin one encounter pays out" help="Gifts and game winnings stop here (losses count against it), so “Again!” loops cannot farm gold."><input value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
        <button type="button" className="btn" disabled={act.busy} onClick={() => void save({ encounterRewardCapCp: Math.max(0, Math.min(100_000, parseCoins(cap) ?? 0)) })}>Save</button>
      </div>
      <ErrorBox error={act.error} />
      {toastNode}
    </section>
  );
}
