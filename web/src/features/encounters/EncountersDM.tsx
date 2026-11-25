// DM page: Encounters. Send an NPC to one player, several or the party (a
// quick line with answers, a saved encounter or a built-in starter), watch
// each talk live, speak as the NPC, end a talk; build and save encounters
// with branching answers, gifts, a shop and small games; and the settings
// (wandering, its wait, the coin cap per encounter).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, PageHead, Switch, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { GAME_HELP, type Effect, type Encounter, type EncounterConfig, type GameKind, type Node, type Script, type Template } from './types.ts';
import './encounters.css';

type Tab = 'live' | 'library' | 'settings';
interface ShopLite { id: string; name: string; status: string }

export default function EncountersDM() {
  const { w } = useWorld();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'live';
  const cfg = useLoad<EncounterConfig>(() => w.call('GET', '/encounters/config'), [w], ['settings']);
  const tpl = useLoad<{ templates: Template[]; starters: Template[] }>(() => w.call('GET', '/encounters/templates/all'), [w]);
  const shops = useLoad<{ shops: ShopLite[] }>(() => w.call('GET', '/shop/shops'), [w], ['shop']);
  return (
    <div className="page enc-page">
      <PageHead title="Encounters" lead="An NPC walks up to a player and the talk plays out in their app: answers, small gifts, a shop, a game of chance. Good for players you are not busy with." />
      <Tabs label="Encounters" value={tab} onChange={(t) => setSp(t === 'live' ? {} : { tab: t })} items={[['live', 'Send & watch'], ['library', 'Saved encounters'], ['settings', 'Settings']]} />
      {!cfg.data || !tpl.data ? <><ErrorBox error={cfg.error ?? tpl.error} /><Loading /></>
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
  const t = templates.find((x) => x.id === tid);
  const needsShop = mode === 'saved' && !!t?.script.nodes.some((n) => n.options.some((o) => o.effects.some((e) => e.kind === 'shop' && !e.shopId)));
  const toggle = (id: string) => setTo((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const send = () => act.run(async () => {
    const body: Record<string, unknown> = { accountIds: to, shopId: shopId || undefined, npcName: npcName.trim() || undefined };
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
      {mode === 'saved' ? (
        <>
          <Field label="Encounter">
            <select value={tid} onChange={(e) => setTid(e.target.value)}>
              {templates.map((x) => <option key={x.id} value={x.id}>{x.builtin ? '★ ' : ''}{x.name}</option>)}
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
          {e.source === 'wander' && <span className="chip teal">Wandered</span>}
          <span className={`chip${open ? ' gold' : ''}`}>{open ? 'Talking' : e.status === 'done' ? 'Finished' : 'Ended'}</span>
          <span className="tiny faint">{when(e.updatedAt)}</span>
        </span>
      </div>
      {e.templateName && <span className="tiny faint">{e.templateName}{e.paidCp ? ` · paid out ${coins(e.paidCp, cfg.coins)}` : ''}</span>}
      <div className="enc-log">
        {e.log.map((l, i) => <div key={i} className={`enc-line ${l.who}`}>{(l.who === 'npc' || l.who === 'dm') && <span className="enc-who">{l.who === 'dm' ? `${e.npc.name} (you)` : e.npc.name}</span>}{l.who === 'you' && <span className="enc-who">{e.player}</span>}<span>{l.text}</span></div>)}
      </div>
      {open && (
        <>
          <span className="small muted">
            Waiting on: {e.game ? `${e.game.label}${e.dc ? ` (DC ${e.dc})` : ''}` : ''}{e.game && e.options.length ? ' or ' : ''}{e.options.map((o) => `“${o.label}”`).join(', ')}
          </span>
          <details>
            <summary className="small">Speak as {e.npc.name}</summary>
            <div className="stack tight" style={{ marginTop: 8 }}>
              <textarea rows={2} value={say} onChange={(ev) => setSay(ev.target.value)} placeholder="What they say now" maxLength={1000} />
              <textarea rows={2} value={answers} onChange={(ev) => setAnswers(ev.target.value)} placeholder={'Answers, one per line (empty: just “Farewell”)'} />
              <button type="button" className="btn small primary" disabled={act.busy || !say.trim()} onClick={() => void speak()}>Say it</button>
            </div>
          </details>
          <div className="row"><button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(() => w.call('POST', `${path}/end`))}>End the talk</button></div>
        </>
      )}
      <ErrorBox error={act.error} />
    </section>
  );
}

// ---------------- saved encounters ----------------

const blank = (): Template => ({ id: '', name: 'New encounter', npcName: 'A stranger', npcBlurb: '', wander: false, builtin: false, script: { start: 'start', nodes: [{ id: 'start', text: 'Hello there.', options: [{ label: 'Hello', next: null, effects: [] }], game: null }] } });

function Library({ data, shops, reload }: { data: { templates: Template[]; starters: Template[] }; shops: ShopLite[]; reload: () => Promise<void> }) {
  const [sel, setSel] = useState<Template | null>(null);
  const copy = (t: Template): Template => ({ ...structuredClone(t), id: '', builtin: false, name: t.builtin ? t.name : `${t.name} (copy)`, wander: false });
  return (
    <div className="cols">
      <nav className="col-1 stack" aria-label="Saved encounters">
        <button type="button" className="btn" onClick={() => setSel(blank())}>New encounter</button>
        {data.templates.map((t) => (
          <button key={t.id} type="button" className={`card enc-pick${sel?.id === t.id ? ' on' : ''}`} onClick={() => setSel(structuredClone(t))}>
            <div className="row between"><strong>{t.name}</strong>{t.wander && <span className="chip teal">Wander</span>}</div>
            <span className="small muted">{t.npcName}</span>
          </button>
        ))}
        <h3 className="enc-h">Starters</h3>
        <span className="tiny faint">Ready to send. Copy one to change it.{!data.templates.some((t) => t.wander) ? ' While none of yours is marked Wander, wandering players meet these.' : ''}</span>
        {data.starters.map((t) => (
          <div key={t.id} className="card enc-pick">
            <strong>{t.name}</strong>
            <span className="small muted">{t.npcName}</span>
            <button type="button" className="btn small ghost" onClick={() => setSel(copy(t))}>Copy and edit</button>
          </div>
        ))}
      </nav>
      <div className="col-2 stack loose">
        {sel ? <Editor key={sel.id || sel.name} start={sel} shops={shops} onSaved={async (t) => { await reload(); setSel(t); }} onGone={async () => { await reload(); setSel(null); }} /> : <Empty>Pick an encounter to edit, or start a new one.</Empty>}
      </div>
    </div>
  );
}

const slug = (s: string, taken: string[]) => {
  const b = s.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'step';
  let id = b, n = 2;
  while (taken.includes(id)) id = `${b}-${n++}`;
  return id;
};

function Editor({ start, shops, onSaved, onGone }: { start: Template; shops: ShopLite[]; onSaved: (t: Template) => void; onGone: () => void }) {
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
    const body = { name: t.name, npcName: t.npcName, npcBlurb: t.npcBlurb, wander: t.wander, script: t.script };
    const saved = t.id ? await w.call<Template>('PUT', `/encounters/templates/all/${encodeURIComponent(t.id)}`, body) : await w.call<Template>('POST', '/encounters/templates/all', body);
    toast('Saved');
    onSaved(saved);
  });
  const del = () => act.run(async () => { await w.call('DELETE', `/encounters/templates/all/${encodeURIComponent(t.id)}`); onGone(); });
  const money = (cp: number) => coins(cp, info.settings.coins);
  return (
    <section className="card stack loose" aria-label="Edit encounter">
      <div className="row wrap">
        <Field label="Name"><input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} maxLength={120} /></Field>
        <Field label="NPC"><input value={t.npcName} onChange={(e) => setT({ ...t, npcName: e.target.value })} maxLength={80} /></Field>
      </div>
      <Field label="Looks like"><input value={t.npcBlurb} onChange={(e) => setT({ ...t, npcBlurb: e.target.value })} maxLength={300} /></Field>
      <div className="row between">
        <div className="stack tight"><strong style={{ fontWeight: 500 }}>Wandering players can meet this NPC</strong><span className="small muted">Only when wandering is on in Settings.</span></div>
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
          <Field label="NPC says"><textarea rows={2} value={n.text} onChange={(e) => setNode(i, { ...n, text: e.target.value })} maxLength={1000} /></Field>

          <div className="row between">
            <span className="small">Game here</span>
            <select value={n.game?.kind ?? ''} onChange={(e) => setNode(i, { ...n, game: e.target.value ? { kind: e.target.value as GameKind, stakeCp: n.game?.stakeCp ?? 0, winCp: n.game?.winCp ?? 10, dc: e.target.value === 'check' ? n.game?.dc ?? 12 : null, skill: n.game?.skill ?? null, win: n.game?.win ?? n.id, lose: n.game?.lose ?? n.id } : null })} style={{ width: 'auto' }}>
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
                  <label className="field" style={{ width: 80 }}><span className="label">DC</span><input inputMode="numeric" value={n.game.dc ?? ''} onChange={(e) => setNode(i, { ...n, game: { ...n.game!, dc: Number(e.target.value.replace(/\D/g, '')) || null } })} /></label>
                  <label className="field" style={{ width: 140 }}><span className="label">Skill</span><input value={n.game.skill ?? ''} onChange={(e) => setNode(i, { ...n, game: { ...n.game!, skill: e.target.value || null } })} maxLength={40} /></label>
                </>}
              </div>
              <div className="row wrap">
                <label className="field" style={{ width: 160 }}><span className="label">On a win go to</span><NextPicker ids={ids} value={n.game.win} required onChange={(v) => setNode(i, { ...n, game: { ...n.game!, win: v ?? n.id } })} /></label>
                <label className="field" style={{ width: 160 }}><span className="label">On a loss go to</span><NextPicker ids={ids} value={n.game.lose} required onChange={(v) => setNode(i, { ...n, game: { ...n.game!, lose: v ?? n.id } })} /></label>
              </div>
            </div>
          )}

          <span className="small">{n.game ? 'Other answers (e.g. walk away)' : 'Answers'}</span>
          {n.options.map((o, j) => {
            const setOpt = (patch: Partial<typeof o>) => setNode(i, { ...n, options: n.options.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
            const setFx = (fx: Effect[]) => setOpt({ effects: fx });
            return (
              <div key={j} className="enc-opt-edit stack tight">
                <div className="row wrap">
                  <input style={{ flex: '2 1 200px' }} value={o.label} placeholder="What the player says" onChange={(e) => setOpt({ label: e.target.value })} maxLength={120} />
                  <NextPicker ids={ids} value={o.next} onChange={(v) => setOpt({ next: v })} />
                  <button type="button" className="btn ghost small" aria-label="Remove answer" onClick={() => setNode(i, { ...n, options: n.options.filter((_, k) => k !== j) })}>✕</button>
                </div>
                {o.effects.map((fx, k) => (
                  <div key={k} className="row wrap enc-fx">
                    {fx.kind === 'gold' && <CoinInput label="Gives coin" cp={fx.cp} money={money} onChange={(cp) => setFx(o.effects.map((x, m) => (m === k ? { kind: 'gold', cp } : x)))} />}
                    {fx.kind === 'item' && <>
                      <label className="field" style={{ flex: '1 1 160px' }}><span className="label">Gives item</span><input value={fx.name} maxLength={120} onChange={(e) => setFx(o.effects.map((x, m) => (m === k ? { ...fx, name: e.target.value } : x)))} /></label>
                      <label className="field" style={{ width: 70 }}><span className="label">Qty</span><input inputMode="numeric" value={fx.qty} onChange={(e) => setFx(o.effects.map((x, m) => (m === k ? { ...fx, qty: Math.max(1, Math.min(20, Number(e.target.value.replace(/\D/g, '')) || 1)) } : x)))} /></label>
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
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Goes to" style={{ flex: '1 1 140px', width: 'auto' }}>
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
