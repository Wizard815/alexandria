// Giving between players and the party (no DM approval), asking each other
// for coin, and item pictures. Used by the player Inventory, the DM's Party
// page and the broker.
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { ErrorBox, Field, Modal, useAction } from '../../ui/index.tsx';

export interface Item {
  id: string; owner: string; name: string; qty: number; note: string; link: string | null; image?: string | null; weight?: number | null;
  updated_at: string; updated_by: string; status?: 'approved' | 'pending'; dm_note?: string;
  pendingChange?: { id: string; kind: 'add' | 'edit' | 'remove'; by: string; to?: Partial<Item> };
}
export interface CoinRequest { id: string; from: string; to: string; amount_cp: number; given_cp: number; note: string; offer_id: string | null; status: 'open' | 'done' | 'declined' | 'cancelled'; at: string }
export interface Transfer { id: string; kind: 'coin' | 'item'; from_owner: string; to_owner: string; amount_cp: number | null; item_name: string | null; qty: number | null; note: string; by_id: string; at: string; seen: boolean }

/** Whether players may give freely (world setting; on unless the DM turned it off). */
export const givingOn = (s: unknown) => (s as { playerTransfers?: boolean }).playerTransfers !== false;

// ---- Pictures ----

const blobs = new Map<string, string>();

/** An item's picture: uploads are fetched with the session; links load directly. */
export function ItemImage({ image, name, size = 40, onClick }: { image: string | null | undefined; name: string; size?: number; onClick?: () => void }) {
  const { client } = useAuth();
  const { w } = useWorld();
  const [src, setSrc] = useState<string | null>(() => (image && /^https?:/.test(image) ? image : image ? blobs.get(image) ?? null : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!image) { setSrc(null); return; }
    if (/^https?:/.test(image)) { setSrc(image); return; }
    if (blobs.has(image)) { setSrc(blobs.get(image)!); return; }
    let live = true;
    fetch(w.path(`/inventory/images/${encodeURIComponent(image)}`), { headers: client.token ? { Authorization: `Bearer ${client.token}` } : {} })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); const u = URL.createObjectURL(await r.blob()); blobs.set(image, u); if (live) setSrc(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [image, w, client]);
  const box = { width: size, height: size, borderRadius: Math.max(6, size / 6), flex: 'none' as const, objectFit: 'cover' as const, background: 'var(--panel-2)', border: '1px solid var(--line)' };
  if (!image || failed || !src) {
    // A tidy initial when there is no picture (or it couldn't load offline).
    return <span aria-hidden="true" style={{ ...box, display: 'inline-grid', placeItems: 'center', fontFamily: 'var(--font-head)', fontSize: Math.round(size * 0.42), color: 'var(--faint)' }}>{(name.trim()[0] ?? '?').toUpperCase()}</span>;
  }
  const img = <img src={src} alt="" width={size} height={size} style={box} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return onClick ? <button type="button" className="btn ghost" style={{ padding: 0, border: 0, lineHeight: 0 }} onClick={onClick} aria-label={`Show the picture of ${name}`}>{img}</button> : img;
}

/** Bigger view of an item's picture. */
export function ImageViewer({ item, onClose }: { item: Item; onClose: () => void }) {
  return (
    <Modal title={item.name} onClose={onClose}>
      <div style={{ display: 'grid', placeItems: 'center' }}><ItemImage image={item.image} name={item.name} size={Math.min(360, typeof window !== 'undefined' ? window.innerWidth - 80 : 360)} /></div>
      {item.note && <p className="small muted">{item.note}</p>}
    </Modal>
  );
}

const MAX = 2 * 1024 * 1024;
/** Choose a picture: upload one (PNG, JPEG, GIF, WebP up to 2 MB) or paste a link. Optional. */
export function ImageField({ value, name, onChange }: { value: string | null | undefined; name: string; onChange: (v: string | null) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [url, setUrl] = useState(value && /^https?:/.test(value) ? value : '');
  const upload = (f: File) => act.run(async () => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) throw new Error('Pick a PNG, JPEG, GIF or WebP picture');
    if (f.size > MAX) throw new Error('Pictures can be at most 2 MB');
    const b64 = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(new Error('Could not read the file')); r.readAsDataURL(f); });
    const res = await w.call<{ id: string }>('POST', '/inventory/images', { dataBase64: b64 });
    onChange(res.id);
    setUrl('');
  });
  return (
    <fieldset className="stack tight" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, margin: 0, minWidth: 0 }}>
      <legend className="small muted">Picture (optional)</legend>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <ItemImage image={value} name={name || '?'} size={56} />
        <label className="btn small">
          {act.busy ? 'Uploading…' : value && !/^https?:/.test(value) ? 'Change picture' : 'Upload picture'}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" disabled={act.busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        </label>
        {value && <button type="button" className="btn small ghost" onClick={() => { onChange(null); setUrl(''); }}>Remove</button>}
      </div>
      <Field label="…or a link to a picture"><input value={url} maxLength={500} placeholder="https://…" onChange={(e) => { const v = e.target.value; setUrl(v); if (/^https?:\/\/\S+$/.test(v.trim())) onChange(v.trim()); else if (!v.trim() && value && /^https?:/.test(value)) onChange(null); }} /></Field>
      {url.trim() && !/^https?:\/\/\S+$/.test(url.trim()) && <span className="tiny" style={{ color: 'var(--danger-text)' }}>Links must start with https://</span>}
      <ErrorBox error={act.error} />
    </fieldset>
  );
}

// ---- Who can receive ----

function usePeople() {
  const { members, me, nameOf } = useWorld();
  const players = members.filter((m) => m.role === 'player');
  const label = (owner: string) => (owner === 'party' ? 'Party stash' : owner === me ? 'You' : nameOf(owner));
  return { players, others: players.filter((m) => m.id !== me), label };
}

// ---- Give coin ----

export function GiveCoinModal({ from = 'me', to: initialTo, onClose, onDone }: { from?: string; to?: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { w, info, me, isDM } = useWorld();
  const { players, others, label } = usePeople();
  const act = useAction();
  const fromOptions = isDM ? ['party', ...players.map((p) => p.id)] : ['me', ...(info.settings.partyPurse ? ['party'] : [])];
  const [src, setSrc] = useState(from);
  const toOptions = [...(info.settings.partyPurse ? ['party'] : []), ...(isDM ? players.map((p) => p.id) : ['me', ...others.map((p) => p.id)])].filter((t) => t !== src && !(t === 'me' && src === 'me'));
  const [to, setTo] = useState(initialTo ?? toOptions.find((t) => t !== 'party' && t !== 'me') ?? toOptions[0] ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const cp = parseCoins(amount);
  const bal = useLoad(() => w.coin(src === 'me' ? 'me' : src) as Promise<{ cp: number }>, [w, src], ['coin']);
  const nm = (x: string) => (x === 'me' ? 'You' : label(x === me ? me : x));
  const go = () => act.run(async () => {
    await w.call('POST', '/inventory/coin/transfer', { from: src, to, amountCp: cp, note: note.trim() || undefined });
    onDone(`Gave ${coins(cp ?? 0, info.settings.coins)} to ${to === 'party' ? 'the party purse' : nm(to)}`);
  });
  return (
    <Modal title="Give coin" onClose={onClose}>
      <p className="small muted">Coin moves at once. The DM sees it in their log; nothing waits for approval.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Field label="From"><select value={src} onChange={(e) => setSrc(e.target.value)}>{fromOptions.map((f) => <option key={f} value={f}>{f === 'party' ? 'Party purse' : nm(f)}</option>)}</select></Field>
        <Field label="To"><select value={to} onChange={(e) => setTo(e.target.value)}>{toOptions.map((t) => <option key={t} value={t}>{t === 'party' ? 'Party purse' : nm(t)}</option>)}</select></Field>
      </div>
      <Field label="Amount" help={bal.data ? `Available: ${coins(bal.data.cp, info.settings.coins)}` : 'e.g. 5 gp 2 sp'}><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5 gp" inputMode="text" /></Field>
      <Field label="What for (optional)"><input value={note} maxLength={160} onChange={(e) => setNote(e.target.value)} placeholder="My share of the room" /></Field>
      {cp !== null && bal.data && cp > bal.data.cp && <p className="small" style={{ color: 'var(--danger-text)' }}>That's more than {src === 'party' ? 'the purse holds' : 'there is'}.</p>}
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={act.busy || !cp || cp <= 0 || !to || (!!bal.data && cp > bal.data.cp)} onClick={() => void go()}>Give</button>
      </div>
    </Modal>
  );
}

// ---- Move or split an item ----

export function MoveItemModal({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: (msg: string) => void }) {
  const { w, me, isDM, info } = useWorld();
  const { players, others, label } = usePeople();
  const act = useAction();
  const targets = ['party', ...(isDM ? players.map((p) => p.id) : [me, ...others.map((p) => p.id)])].filter((t) => t !== item.owner);
  const [to, setTo] = useState(targets[0] ?? '');
  const [qty, setQty] = useState(item.qty);
  const [reason, setReason] = useState('');
  const needReason = isDM && item.owner !== 'party' && (info.settings as { dmChangeReason?: boolean }).dmChangeReason !== false;
  const go = () => act.run(async () => {
    await w.call('POST', `/inventory/${item.id}/move`, { to, qty, reason: reason.trim() || undefined });
    onDone(`${qty} × ${item.name} → ${to === 'party' ? 'the party stash' : label(to)}`);
  });
  return (
    <Modal title={`Give or move ${item.name}`} onClose={onClose}>
      <p className="small muted">Moves at once, no DM approval. Move part of a stack to split it; matching items stack up.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Field label="To"><select value={to} onChange={(e) => setTo(e.target.value)}>{targets.map((t) => <option key={t} value={t}>{t === 'party' ? 'Party stash' : t === me ? 'My pack' : label(t)}</option>)}</select></Field>
        <Field label={`How many (of ${item.qty})`}><input type="number" min={1} max={item.qty} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(item.qty, Number(e.target.value) || 1)))} /></Field>
      </div>
      {item.qty > 1 && <input type="range" min={1} max={item.qty} value={qty} onChange={(e) => setQty(Number(e.target.value))} aria-label="How many" style={{ width: '100%' }} />}
      {needReason && <Field label="Why (the player sees this)"><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></Field>}
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={act.busy || !to || (needReason && !reason.trim())} onClick={() => void go()}>Move {qty}</button>
      </div>
    </Modal>
  );
}

// ---- Asking for coin ----

export function AskCoinModal({ amountCp, offerId, note: initialNote, onClose, onDone }: { amountCp?: number; offerId?: string; note?: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { w, info } = useWorld();
  const { others, label } = usePeople();
  const act = useAction();
  const [to, setTo] = useState('party');
  const [amount, setAmount] = useState(amountCp ? coins(amountCp, 'gsc') : '');
  const [note, setNote] = useState(initialNote ?? '');
  const cp = parseCoins(amount);
  const go = () => act.run(async () => {
    await w.call('POST', '/inventory/coin-requests', { to, amountCp: cp, note: note.trim() || undefined, offerId });
    onDone(`Asked ${to === 'party' ? 'the party' : label(to)} for ${coins(cp ?? 0, info.settings.coins)}`);
  });
  return (
    <Modal title="Ask for coin" onClose={onClose}>
      <p className="small muted">The others see your request and can chip in. Whatever they give lands in your purse.</p>
      <Field label="Ask"><select value={to} onChange={(e) => setTo(e.target.value)}><option value="party">Everyone in the party</option>{others.map((p) => <option key={p.id} value={p.id}>{label(p.id)}</option>)}</select></Field>
      <Field label="How much"><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2 gp" /></Field>
      <Field label="What for"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={act.busy || !cp || cp <= 0} onClick={() => void go()}>Send request</button>
      </div>
    </Modal>
  );
}

/** Requests for coin: ones to me (give / not now) and mine (cancel). Hidden when there are none. */
export function CoinRequestsCard({ onChanged }: { onChanged?: () => void }) {
  const { w, info, nameOf } = useWorld();
  const list = useLoad(() => w.call<{ incoming: CoinRequest[]; outgoing: CoinRequest[] }>('GET', '/inventory/coin-requests'), [w], ['coin-request', 'coin']);
  const act = useAction();
  const incoming = (list.data?.incoming ?? []).filter((r) => r.status === 'open');
  const outgoing = (list.data?.outgoing ?? []).filter((r) => r.status === 'open' || Date.now() - Date.parse(r.at) < 86400_000);
  if (!incoming.length && !outgoing.length) return null;
  const post = (path: string, body?: unknown) => act.run(async () => { await w.call('POST', path, body); await list.reload(); onChanged?.(); });
  const money = (cp: number) => coins(cp, info.settings.coins);
  return (
    <section className="card" aria-labelledby="creq-h" style={{ borderColor: incoming.length ? 'var(--accent)' : undefined }}>
      <h2 id="creq-h">Coin requests</h2>
      <ErrorBox error={act.error} />
      {incoming.map((r) => (
        <div key={r.id} className="list-item" style={{ display: 'block' }}>
          <div className="small"><strong>{nameOf(r.from)}</strong> asks {r.to === 'party' ? 'the party' : 'you'} for {money(r.amount_cp - r.given_cp)}{r.given_cp ? ` more (${money(r.given_cp)} given so far)` : ''}{r.note ? <> · “{r.note}”</> : null}</div>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void post(`/inventory/coin-requests/${r.id}/give`, {})}>Give {money(r.amount_cp - r.given_cp)}</button>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => { const v = window.prompt('How much will you give? (e.g. 1 gp)'); const cp = v ? parseCoins(v) : null; if (cp) void post(`/inventory/coin-requests/${r.id}/give`, { amountCp: Math.min(cp, r.amount_cp - r.given_cp) }); }}>Give some</button>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void post(`/inventory/coin-requests/${r.id}/decline`)}>Not now</button>
          </div>
        </div>
      ))}
      {outgoing.map((r) => (
        <div key={r.id} className="list-item row between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="small">You asked {r.to === 'party' ? 'the party' : nameOf(r.to)} for {money(r.amount_cp)} · {r.status === 'done' ? 'covered' : r.given_cp ? `${money(r.given_cp)} given so far` : 'nothing given yet'}{r.status === 'declined' ? ' · declined' : ''}</span>
          {r.status === 'open' && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void post(`/inventory/coin-requests/${r.id}/cancel`)}>Cancel</button>}
        </div>
      ))}
    </section>
  );
}

/** Recent gives: for the DM, everyone's; for players, theirs and the party's. */
export function TransfersList({ limit = 20, title = 'Given and moved' }: { limit?: number; title?: string }) {
  const { w, info, nameOf, isDM } = useWorld();
  const list = useLoad(() => w.call<{ transfers: Transfer[]; unseen?: number }>('GET', '/inventory/transfers', undefined, { limit }), [w, limit], ['transfer']);
  const act = useAction();
  const rows = list.data?.transfers ?? [];
  const who = (o: string) => (o === 'party' ? 'party' : nameOf(o));
  return (
    <section className="card" aria-labelledby="trf-h">
      <div className="card-head">
        <h2 id="trf-h">{title}{isDM && !!list.data?.unseen && <span className="chip gold" style={{ marginLeft: 8 }}>{list.data.unseen} new</span>}</h2>
        {isDM && !!list.data?.unseen && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', '/inventory/transfers/seen'); await list.reload(); })}>Mark seen</button>}
      </div>
      <ErrorBox error={list.error ?? act.error} />
      {!rows.length ? <p className="small muted">Nothing given or moved yet.</p> : (
        <ul className="stack tight small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((t) => (
            <li key={t.id} className="row between" style={{ gap: 6, opacity: isDM && t.seen ? 0.75 : 1 }}>
              <span className="grow">{who(t.from_owner)} → {who(t.to_owner)}: {t.kind === 'coin' ? coins(t.amount_cp ?? 0, info.settings.coins) : `${t.qty} × ${t.item_name}`}{t.note ? <span className="faint"> · {t.note}</span> : null}</span>
              <span className="tiny faint">{t.by_id !== t.from_owner && t.by_id !== t.to_owner ? `by ${nameOf(t.by_id)} · ` : ''}{when(t.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
