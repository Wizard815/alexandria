// A player's front page: next game night with RSVP, who's here now, and
// what changed (replies to my requests, new messages).
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, dateLong, timeShort, when } from '../../lib/format.ts';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { CombatPanel, type LiveView } from './Live.tsx';
import { AlertsCard, BrokerTeaser, useMine } from '../broker/shared.tsx';

interface CalSession { id: string; title: string; starts_at: string; ends_at: string; location: string; status: string; rsvps: { account_id: string; answer: string }[]; chatCount: number }
const RSVP: [string, string][] = [['yes', 'Going'], ['maybe', 'Maybe'], ['no', "Can't"]];

export default function PlayerHome() {
  const { w, me, info, members } = useWorld();
  const base = `/w/${info.slug}`;
  const self = members.find((m) => m.id === me);
  const cal = useLoad(() => (info.settings.calendar === 'off' ? Promise.resolve([]) : w.calendar()) as Promise<CalSession[]>, [w, info.settings.calendar], ['calendar', 'rsvp']);
  const live = useLoad(() => w.live() as Promise<LiveView>, [w], ['presence', 'coin', 'combat']);
  const reqs = useLoad(() => w.requests(), [w], ['request']);
  const threads = useLoad(() => w.threads(), [w], ['message', 'thread']);
  const act = useAction();
  const mine = useMine();

  const next = (cal.data ?? []).find((s) => s.status === 'scheduled' && Date.parse(s.ends_at) > Date.now());
  const myAnswer = next?.rsvps.find((r) => r.account_id === me)?.answer;
  const going = next?.rsvps.filter((r) => r.answer === 'yes').length ?? 0;
  const myReqs = (reqs.data ?? []).filter((r: any) => r.author_id === me).slice(0, 4);
  const recentThreads = (threads.data ?? []).slice(0, 4);
  const d = live.data;

  return (
    <div className="page">
      <header className="stack tight">
        <h1>Welcome back{self?.character_name ? `, ${self.character_name}` : `, ${self?.display_name ?? ''}`}</h1>
        <p className="muted">{info.name}</p>
      </header>
      <ErrorBox error={act.error ?? cal.error ?? live.error} />

      <div className="cols">
        <div className="col-2 stack loose">
          {info.settings.calendar !== 'off' && (
            <section className="card gold" aria-labelledby="next-h">
              <div className="card-head"><h2 id="next-h">Next session</h2><Link to={`${base}/calendar`} className="small">Calendar →</Link></div>
              {next ? (
                <>
                  <div className="stack tight">
                    <strong style={{ fontSize: 18 }}>{next.title}</strong>
                    <span className="muted">{dateLong(next.starts_at)} · {timeShort(next.starts_at)}–{timeShort(next.ends_at)}{next.location ? ` · ${next.location}` : ''}</span>
                    <span className="tiny faint">{going} going{next.chatCount ? ` · ${next.chatCount} message${next.chatCount === 1 ? '' : 's'} about this day` : ''}</span>
                  </div>
                  <div className="tabs" role="radiogroup" aria-label="Are you coming?">
                    {RSVP.map(([k, label]) => (
                      <button key={k} type="button" role="radio" aria-checked={myAnswer === k} className={`btn small${myAnswer === k ? ' on' : ''}`} disabled={act.busy}
                        onClick={() => void act.run(async () => { await w.rsvp(next.id, k as any); await cal.reload(); })}>{label}</button>
                    ))}
                  </div>
                </>
              ) : <p className="muted">No game night is set yet.</p>}
            </section>
          )}

          {d && d.combat.active && <CombatPanel c={d.combat} compact />}
          <AlertsCard mine={mine.data} reload={mine.reload} />

          <section className="card" aria-labelledby="upd-h">
            <h2 id="upd-h">Updates</h2>
            {!myReqs.length && !recentThreads.length && <p className="muted small">Nothing new. Ask the DM something or start a chat.</p>}
            {recentThreads.length > 0 && (
              <div className="stack tight">
                <span className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>Messages</span>
                {recentThreads.map((t: any) => (
                  <Link key={t.id} to={`${base}/messages?thread=${t.id}`} className="row" style={{ gap: 8, textDecoration: 'none', color: 'inherit' }}>
                    <span className="grow small"><strong style={{ fontWeight: 500 }}>{t.title || 'Chat'}</strong> <span className="muted">{t.last ?? ''}</span></span>
                    <span className="tiny faint">{when(t.last_at)}</span>
                  </Link>
                ))}
              </div>
            )}
            {myReqs.length > 0 && (
              <div className="stack tight">
                <span className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>Your requests</span>
                {myReqs.map((r: any) => (
                  <Link key={r.id} to={`${base}/ask`} className="row" style={{ gap: 8, textDecoration: 'none', color: 'inherit' }}>
                    <span className="grow small">{r.title}{r.reply && <span className="muted"> · “{r.reply}”</span>}</span>
                    <span className={`chip ${r.status === 'accepted' ? 'green' : r.status === 'rejected' ? 'red' : 'gold'}`}>{r.status === 'open' ? 'Waiting' : r.status === 'accepted' ? 'Accepted' : 'Declined'}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="col-1 stack loose">
          <section className="card" aria-labelledby="now-h">
            <div className="card-head"><h2 id="now-h">Right now</h2><Link to={`${base}/live`} className="small">Live →</Link></div>
            {d ? (
              <>
                <span className="small">{d.here.length ? `${d.here.length} here: ${d.here.map((h) => h.character_name || h.display_name).join(', ')}` : 'Nobody has checked in.'}</span>
                {d.purse && <span className="small"><span className="muted">Party pouch:</span> {coins(d.purse.cp, info.settings.coins)}</span>}
                <span className="small"><span className="muted">Your coin:</span> {coins(d.myCoin, info.settings.coins)}</span>
              </>
            ) : <span className="muted small">Loading…</span>}
          </section>
          <BrokerTeaser />
          <nav className="card" aria-label="Quick links">
            <div className="grid small">
              {[['lore', 'Read the lore'], ['people', 'People we met'], ['me', 'My character'], ['map', 'The map'], ['ask', 'Ask the DM'], ['whiteboard', 'Whiteboard']].map(([to, label]) => (
                <Link key={to} to={`${base}/${to}`} className="btn small">{label}</Link>
              ))}
            </div>
          </nav>
        </aside>
      </div>
    </div>
  );
}
