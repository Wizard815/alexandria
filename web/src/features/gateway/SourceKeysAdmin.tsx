// Gateway admin → Source keys: every world's keys (who owns each, which source, how far it is trusted, what it
// is used for, whether it was checked against the world) and the questions that needed more than a player's own
// view. Read-only: a key's secret, the hidden context of a question and its answer are GM-only and never sent here.
// The GM changes trust, users and revokes in the world's own settings.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import { coins, when } from '../../lib/format.ts';
import { Callout, Pill, Section, Tile, type Tone } from '../../pages/admin/kit.tsx';

interface Key {
  id: string; label: string; sourceName: string | null; sourceKind: string | null; ownerName: string; userNames: string[]; trust: string; treatedAs: string;
  uses: string[]; verified: { matchedWorld: boolean; checkedAt: string | null }; refreshedAt: string | null; createdAt: string; pagesSeen: number;
}
interface Esc { id: string; asker: string; question: string; origin: string; mode: string; status: string; costCp: number | null; sessions: number | null; createdAt: string; resolvedAt: string | null }
interface WorldKeys { id: string; name: string; slug: string; keys: Key[]; escalations: Esc[] }

const TRUST: Record<string, [string, Tone]> = { 'per-user': ['Per-user', 'ok'], blanket: ['Blanket', 'warn'], unsure: ['Unsure (treated as blanket)', 'warn'] };
const USE: Record<string, string> = { library: 'Library', agent: 'Agent', broker: 'Broker' };
const STATUS: Record<string, [string, Tone]> = { open: ['Waiting on the GM', 'warn'], offered: ['Priced, waiting on the player', 'teal'], waiting: ['Paid, being worked on', 'teal'], answered: ['Answered', 'ok'], refused: ['Refused', ''], declined: ['Declined by the player', ''] };

export default function SourceKeysAdmin() {
  const { client } = useAuth();
  const data = useLoad(() => client.request<{ worlds: WorldKeys[] }>('GET', '/api/admin/gateway/source-keys'), []);
  const [pick, setPick] = useState('');
  const worlds = data.data?.worlds ?? [];
  const cur = worlds.find((w) => w.id === pick) ?? worlds[0];
  const all = worlds.flatMap((w) => w.keys);
  const blanket = all.filter((k) => k.treatedAs !== 'per-user').length;
  const open = worlds.flatMap((w) => w.escalations).filter((e) => e.status === 'open').length;

  return (
    <div className="page">
      <PageHead title="Source keys" lead="Keys from the GM and players for a world's sources. Each key only ever answers for the people it is assigned to. Secrets are never shown here." />
      <ErrorBox error={data.error} />
      {data.loading && !data.data ? <Loading /> : (
        <>
          <div className="tiles">
            <Tile label="Keys" value={all.length} sub={`${worlds.filter((w) => w.keys.length).length} of ${worlds.length} worlds`} />
            <Tile label="Per-user" value={all.length - blanket} tone="ok" sub="each person sees their own view" />
            <Tile label="Blanket or unsure" value={blanket} tone={blanket ? 'warn' : ''} sub="can only feed a GM question" />
            <Tile label="Waiting on a GM" value={open} tone={open ? 'warn' : ''} sub="questions needing hidden info" />
          </div>
          {!worlds.length && <div className="card"><Empty>No worlds yet.</Empty></div>}
          {worlds.length > 1 && (
            <div className="row" role="tablist" aria-label="World">
              {worlds.map((w) => <button key={w.id} type="button" role="tab" aria-selected={w.id === cur?.id} className={`btn small${w.id === cur?.id ? ' on' : ''}`} onClick={() => setPick(w.id)}>{w.name} <span className="faint">({w.keys.length})</span></button>)}
            </div>
          )}
          {cur && (
            <>
              <Section title={`${cur.name} · keys`} lead="Checked against the world before saving. Secrets are wiped when a key is revoked.">
                {cur.keys.length ? (
                  <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
                    <thead><tr><th>Key</th><th>Owner</th><th>Source</th><th>Trust</th><th>Used for</th><th>Checked</th></tr></thead>
                    <tbody>{cur.keys.map((k) => {
                      const [tl, tt] = TRUST[k.trust] ?? [k.trust, ''];
                      return (
                        <tr key={k.id}>
                          <td><strong>{k.label}</strong>{k.treatedAs === 'per-user' && <span className="tiny muted">sees {k.pagesSeen.toLocaleString()} page{k.pagesSeen === 1 ? '' : 's'}</span>}{k.userNames.length > 0 && <span className="tiny muted">for: {k.userNames.join(', ')}</span>}</td>
                          <td>{k.ownerName}</td>
                          <td>{k.sourceName ?? <span className="faint">gone</span>}</td>
                          <td><Pill tone={tt}>{tl}</Pill></td>
                          <td className="small">{k.uses.map((u) => USE[u] ?? u).join(', ')}</td>
                          <td>{k.verified.matchedWorld ? <Pill tone="ok">Same world</Pill> : <Pill tone="bad">Not verified</Pill>}<span className="tiny muted">{k.refreshedAt ? `refreshed ${when(k.refreshedAt)}` : 'not yet read'}</span></td>
                        </tr>
                      );
                    })}</tbody>
                  </table></div></div>
                ) : <p className="muted">No keys in this world yet. The GM and players add them from inside the world.</p>}
              </Section>
              <Section title="Waiting on the GM" lead="Questions that needed hidden info. The hidden context and the answer are for the GM only and are not shown here.">
                {cur.escalations.length ? (
                  <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
                    <thead><tr><th>Asked by</th><th>Question</th><th>Kind</th><th>Status</th><th>Asked</th></tr></thead>
                    <tbody>{cur.escalations.map((e) => {
                      const [sl, st] = STATUS[e.status] ?? [e.status, ''];
                      return (
                        <tr key={e.id}>
                          <td>{e.asker}</td><td>“{e.question}”</td>
                          <td>{e.mode === 'broker-deal' ? 'Broker deal' : 'GM question'}</td>
                          <td><Pill tone={st}>{sl}</Pill>{e.costCp ? <span className="tiny muted">{coins(e.costCp)}{e.sessions ? ` · after ${e.sessions} session${e.sessions === 1 ? '' : 's'}` : ''}</span> : null}</td>
                          <td className="small">{when(e.createdAt)}</td>
                        </tr>
                      );
                    })}</tbody>
                  </table></div></div>
                ) : <p className="muted">No questions have needed hidden info.</p>}
              </Section>
            </>
          )}
          <Section title="Does a key give each person their own view?">
            <dl className="adm-kv">
              <dt>Per-user</dt><dd>The service hides what this person may not see. Pages only their key reaches show up in their own library and agent, for them alone.</dd>
              <dt>Blanket</dt><dd>One key sees everything. Nothing it returns goes straight to a player; it can only feed a question to the GM.</dd>
              <dt>Unsure</dt><dd>Treated as blanket until the GM decides. Only the GM can mark a key per-user.</dd>
            </dl>
            <Callout tone="ok">To change a key's trust or users, or to revoke it, the GM opens the world's settings, Source keys tab. An admin who is not the world's GM only sees this summary.</Callout>
          </Section>
        </>
      )}
    </div>
  );
}
