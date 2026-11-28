// The Worlds page's cards for one world: player source keys, shared pages, pages that are the same thing in two
// sources, and which source wins when they disagree. All from /api/admin/gateway/worlds; an admin sees page titles
// only where they may read the page (party pages, or any page of a world they are the GM of).
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { Pill, Section } from './kit.tsx';

export interface PairSide { id: string; title: string; source: string }
export interface Pair { a: PairSide; b: PairSide; status: 'suggested' | 'linked' | 'different' }
export interface WorldCard {
  id: string;
  keys: { total: number; perUser: number; blanket: number; unsure: number; playersMayAdd: boolean };
  shares: { total: number; withParty: number; withChosen: number; recent: { from: string; to: string; page: string | null }[] };
  sameThing: { pairs: Pair[]; total: number; hidden: number; open: number };
  disagree: { first: string; showBoth: boolean; sources: { id: string; name: string }[]; stored: boolean };
}

export function WorldCards({ world, card, onChange }: { world: { id: string; name: string }; card: WorldCard; onChange: () => void }) {
  const { client } = useAuth();
  const a = useAction();
  const link = (p: Pair, status: 'linked' | 'different' | 'clear') => void a.run(async () => { await client.request('POST', `/api/admin/gateway/worlds/${world.id}/links`, { a: p.a.id, b: p.b.id, status }); onChange(); });
  const prefs = (body: { first?: string; showBoth?: boolean }) => void a.run(async () => { await client.request('PUT', `/api/admin/gateway/worlds/${world.id}/prefs`, body); onChange(); });
  const { keys, shares, sameThing, disagree } = card;
  return (
    <div className="stack">
      <ErrorBox error={a.error} />
      <div className="adm-two">
        <Section title="Player keys" lead="What a player's own key sees is theirs alone, unless they share a page.">
          {keys.total ? (
            <div className="row wrap">
              <span className="chip">{keys.total} key{keys.total === 1 ? '' : 's'}</span>
              <span className="chip teal">{keys.perUser} per-user</span>
              <span className="chip gold">{keys.blanket} blanket</span>
              <span className="chip">{keys.unsure} unsure</span>
            </div>
          ) : <p className="muted small">No player keys yet.</p>}
          <p className="small muted">Players {keys.playersMayAdd ? 'may' : 'may not'} add their own keys. The GM changes this in the world's settings.</p>
        </Section>
        <Section title="Shared pages" lead="A share carries only the player view; secret, broker and classified parts never travel.">
          {shares.total ? (
            <>
              <p className="small"><strong>{shares.total}</strong> share{shares.total === 1 ? '' : 's'} · {shares.withParty} with the whole party · {shares.withChosen} with chosen players</p>
              <ul className="adm-feed">{shares.recent.map((s, i) => <li key={i}><span>{s.from} → {s.to}{s.page ? <span className="muted"> · {s.page}</span> : null}</span></li>)}</ul>
            </>
          ) : <p className="muted small">Nothing has been shared.</p>}
        </Section>
      </div>
      <Section title="Same thing in two sources" lead="Pages from different sources with the same name. Say which are the same, so they can be told apart from look-alikes.">
        {sameThing.pairs.length ? (
          <ul className="adm-feed adm-pairs">{sameThing.pairs.map((p) => (
            <li key={`${p.a.id}|${p.b.id}`}>
              <span className="adm-pair"><strong>{p.a.title}</strong> <span className="tiny muted">{p.a.source}</span> ↔ <strong>{p.b.title}</strong> <span className="tiny muted">{p.b.source}</span></span>
              <span className="row">
                {p.status === 'linked' ? <><Pill tone="ok">Linked</Pill><button type="button" className="btn small" disabled={a.busy} onClick={() => link(p, 'clear')}>Undo</button></>
                  : p.status === 'different' ? <><Pill>Not the same</Pill><button type="button" className="btn small" disabled={a.busy} onClick={() => link(p, 'clear')}>Undo</button></>
                    : <><button type="button" className="btn small primary" disabled={a.busy} onClick={() => link(p, 'linked')}>Link</button><button type="button" className="btn small" disabled={a.busy} onClick={() => link(p, 'different')}>Not the same</button></>}
              </span>
            </li>
          ))}</ul>
        ) : <p className="muted small">No two sources hold a page with the same name.</p>}
        {sameThing.hidden > 0 && <p className="tiny faint">{sameThing.hidden} more pair{sameThing.hidden === 1 ? '' : 's'} involve pages only this world's GM may read, so they are not listed here.</p>}
        <p className="tiny faint">The decision is stored for this world. Search does not yet treat linked pages as one.</p>
      </Section>
      <Section title="When sources disagree" lead="Which source to trust first for this world.">
        {disagree.sources.length > 1 ? (
          <div className="stack">
            <label className="field"><span>Trust first</span>
              <select className="input" value={disagree.first} disabled={a.busy} onChange={(e) => prefs({ first: e.target.value })}>
                {disagree.sources.map((s) => <option key={s.id} value={s.id}>{s.name}, then the others</option>)}
                <option value="newest">The most recently edited page</option>
              </select>
            </label>
            <label className="row"><input type="checkbox" checked={disagree.showBoth} disabled={a.busy} onChange={(e) => prefs({ showBoth: e.target.checked })} /> Show the GM both versions when they differ, instead of picking one</label>
            <p className="tiny faint">Stored for this world. Today a sync keeps one page per path and does not compare sources, so nothing reads this yet.</p>
          </div>
        ) : <p className="muted small">This world has {disagree.sources.length ? 'one source' : 'no sources'}, so there is nothing to settle.</p>}
      </Section>
    </div>
  );
}

/** A one-line summary for the world list. */
export const cardLine = (c?: WorldCard) => (c ? `${c.keys.total} player key${c.keys.total === 1 ? '' : 's'} · ${c.shares.total} share${c.shares.total === 1 ? '' : 's'}` : '');
