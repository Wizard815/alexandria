// The chat panel: Table and Party tabs (the DM only gets Table), messages
// with replies, reactions, @mentions, /roll and page links, a compose box,
// and for the DM Start / End session. Ended sessions are read-only history.
import { useEffect, useRef, useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Tabs, ErrorBox, useAction } from '../../ui/index.tsx';
import { timeShort } from '../../lib/format.ts';
import { Body, useCurrent, type Channel, type ChatMessage } from './shared.tsx';
import { TradeOffers } from './TradeDialog.tsx';

const EMOJI = ['👍', '😂', '🎲', '⚔️'];
const WINDOW_MS = 10 * 60_000;

export function ChatPanel({ tall = false, onRead }: { tall?: boolean; onRead?: () => void }) {
  const { w, info, isDM, me, nameOf } = useWorld();
  const cur = useCurrent();
  const act = useAction();
  const [tab, setTab] = useState<Channel>('table');
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const c = cur.data;
  const sessions = useLoad(() => w.call<any[]>('GET', '/sessionchat/sessions'), [w, c?.session?.id], ['chat-session']);
  const sid = session ?? c?.session?.id ?? null;
  const channels = c?.channels.map((x) => x.channel) ?? ['table'];
  const channel: Channel = channels.includes(tab) ? tab : 'table';
  const msgs = useLoad(() => w.call<{ session: any; messages: ChatMessage[] }>('GET', `/sessionchat/chat/${channel}`, undefined, sid ? { session: sid } : undefined), [w, channel, sid], ['chat']);
  const viewing = msgs.data?.session ?? c?.session ?? null;
  const open = !!viewing && viewing.open;

  // Mark what I am looking at as read.
  const list = msgs.data?.messages ?? [];
  const lastId = list[list.length - 1]?.id;
  useEffect(() => {
    if (!open || !lastId) return;
    void w.call('POST', '/sessionchat/read', { channel }).then(() => { onRead?.(); void cur.reload(); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, channel, open]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [lastId]);

  const send = () => void act.run(async () => {
    const body = text.trim();
    if (!body) return;
    if (editing) await w.call('PATCH', `/sessionchat/messages/${editing.id}`, { body });
    else await w.call('POST', `/sessionchat/chat/${channel}`, { body, replyTo: replyTo?.id });
    setText(''); setReplyTo(null); setEditing(null);
    await msgs.reload();
  });
  const react = (m: ChatMessage, emoji: string) => void act.run(async () => { await w.call('POST', `/sessionchat/messages/${m.id}/react`, { emoji }); await msgs.reload(); });
  const del = (m: ChatMessage) => void act.run(async () => { await w.call('DELETE', `/sessionchat/messages/${m.id}`); await msgs.reload(); });
  const hide = (m: ChatMessage) => void act.run(async () => { await w.call('POST', `/sessionchat/messages/${m.id}/hide`, { hidden: !m.hidden }); await msgs.reload(); });
  const start = () => void act.run(async () => { await w.call('POST', '/sessionchat/sessions/start', {}); await cur.reload(); });
  const end = () => void act.run(async () => { if (window.confirm('End the session? Its chats become read-only history.')) { await w.call('POST', '/sessionchat/sessions/end', {}); await cur.reload(); } });
  const past = (sessions.data ?? []).filter((s) => s.id !== c?.session?.id);

  const tabs: [Channel, string][] = channels.map((ch) => {
    const n = c?.channels.find((x) => x.channel === ch)?.unread ?? 0;
    return [ch, `${ch === 'table' ? 'Table' : 'Party'}${n ? ` (${n})` : ''}`];
  });

  return (
    <div className={`sc-panel${tall ? ' tall' : ''}`}>
      <div className="row between">
        {tabs.length > 1 ? <Tabs label="Chat channel" value={channel} onChange={setTab} items={tabs} /> : <strong>Table chat</strong>}
        {isDM && (c?.session ? <button type="button" className="btn small" disabled={act.busy} onClick={end}>End session</button> : <button type="button" className="btn small primary" disabled={act.busy} onClick={start}>Start session</button>)}
      </div>
      <div className="tiny muted">
        {channel === 'party' ? 'Party chat: only players can read this. The DM cannot.' : 'Table chat: everyone, the DM too.'}
        {viewing && <> · {viewing.title}{!open && ' (ended, read-only)'}</>}
      </div>
      {past.length > 0 && (
        <select className="input" aria-label="Session" value={session ?? ''} onChange={(e) => setSession(e.target.value || null)}>
          <option value="">{c?.session ? 'Current session' : 'Latest'}</option>
          {past.map((s) => <option key={s.id} value={s.id}>{s.title} · {String(s.startedAt).slice(0, 10)}</option>)}
        </select>
      )}
      <ErrorBox error={msgs.error ?? act.error} />
      {!isDM && <TradeOffers />}
      <div className="sc-log" ref={logRef} role="log" aria-live="polite" aria-label={`${channel} chat`}>
        {!viewing && <p className="muted small">{isDM ? 'No session running. Press Start session to open the chats.' : 'No session yet. It starts when the DM starts one or everyone checks in on Live.'}</p>}
        {viewing && !list.length && <p className="muted small">Nothing yet. Try <code>/roll 2d6+3</code> or <code>@name</code>.</p>}
        {list.map((m) => {
          const mine = m.authorId === me;
          const canEdit = mine && open && !m.deleted && Date.now() - new Date(m.at).getTime() < WINDOW_MS;
          return (
            <div key={m.id} className={`sc-msg${mine ? ' mine' : ''}${m.mentionsMe ? ' ping' : ''}${m.deleted || m.hidden ? ' gone' : ''}`}>
              <div className="sc-meta"><strong>{nameOf(m.authorId)}</strong><span>{timeShort(m.at)}</span>{m.editedAt && <span>edited</span>}{m.hidden && <span className="chip red">hidden{isDM ? ' from players' : ''}</span>}</div>
              {m.replyTo && <div className="sc-reply">↩ {nameOf(m.replyTo.authorId)}: {m.replyTo.snippet || '…'}</div>}
              {m.deleted ? <span>(deleted)</span> : m.hidden && !isDM ? <span>(hidden by the DM)</span> : m.roll ? (
                <div className="sc-roll">🎲 {nameOf(m.authorId)} rolled <strong>{m.roll.total}</strong> <span className="muted small">({m.roll.expr}{m.roll.note ? `, ${m.roll.note}` : ''}: {m.roll.terms.filter((t) => t.dice.length).map((t) => `[${t.dice.join(', ')}]`).join(' ')})</span></div>
              ) : <div><Body text={m.body} slug={info.slug} /></div>}
              {!m.deleted && (
                <div className="sc-acts">
                  {m.reactions.map((r) => <button type="button" key={r.emoji} aria-pressed={r.mine} disabled={!open} onClick={() => react(m, r.emoji)}>{r.emoji} {r.count}</button>)}
                  {open && EMOJI.filter((e) => !m.reactions.some((r) => r.emoji === e)).slice(0, 2).map((e) => <button type="button" key={e} aria-label={`React ${e}`} onClick={() => react(m, e)}>{e}</button>)}
                  {open && <button type="button" onClick={() => { setReplyTo(m); setEditing(null); }}>Reply</button>}
                  {canEdit && m.kind === 'text' && <button type="button" onClick={() => { setEditing(m); setText(m.body); setReplyTo(null); }}>Edit</button>}
                  {canEdit && <button type="button" onClick={() => del(m)}>Delete</button>}
                  {isDM && channel === 'table' && <button type="button" onClick={() => hide(m)}>{m.hidden ? 'Unhide' : 'Hide'}</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {open && c?.channels.find((x) => x.channel === channel)?.canWrite && (
        <>
          {(replyTo || editing) && <div className="tiny muted row">{editing ? 'Editing your message' : `Replying to ${nameOf(replyTo!.authorId)}`} <button type="button" className="btn ghost small" onClick={() => { setReplyTo(null); setEditing(null); setText(''); }}>Cancel</button></div>}
          <form className="sc-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label className="sr-only" htmlFor="sc-text">Message</label>
            <textarea id="sc-text" value={text} maxLength={2000} rows={1} placeholder={channel === 'party' ? 'Message the party…' : 'Message the table…  /roll 1d20+5'} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button type="submit" className="btn primary" disabled={act.busy || !text.trim()}>{editing ? 'Save' : 'Send'}</button>
          </form>
        </>
      )}
    </div>
  );
}
