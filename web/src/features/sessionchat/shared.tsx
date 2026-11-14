// Types and small helpers for session chat.
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';

export type Channel = 'table' | 'party';
export interface ChatSession { id: string; title: string; startedAt: string; endedAt: string | null; open: boolean; source: string }
export interface CurrentChat { session: ChatSession | null; channels: { channel: Channel; canWrite: boolean; unread: number }[] }
export interface RollTerm { term: string; dice: number[]; kept?: number[]; sum: number }
export interface ChatMessage {
  id: string; sessionId: string; channel: Channel; authorId: string; at: string; kind: 'text' | 'roll'; body: string;
  roll: { expr: string; terms: RollTerm[]; total: number; note: string } | null;
  replyTo: { id: string; authorId: string; snippet: string } | null;
  mentions: string[]; mentionsMe: boolean; editedAt: string | null; deleted: boolean; hidden: boolean;
  reactions: { emoji: string; count: number; mine: boolean }[];
}
export interface Trade {
  id: string; from: string; to: string; status: 'open' | 'accepted' | 'declined' | 'cancelled'; note: string;
  offer: { itemId: string | null; item: string | null; qty: number; cp: number };
  want: { item: string | null; qty: number; cp: number };
}

/** The current session and my unread counts, live. */
export function useCurrent() {
  const { w } = useWorld();
  return useLoad(() => w.call<CurrentChat>('GET', '/sessionchat/current'), [w], ['chat', 'chat-session', 'settings']);
}
export const totalUnread = (c: CurrentChat | null | undefined) => (c ? c.channels.reduce((n, x) => n + x.unread, 0) : 0);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Message text: page links become links, @names are highlighted. */
export function Body({ text, slug }: { text: string; slug: string }): ReactNode {
  const { members } = useWorld();
  const names = members.flatMap((m) => [m.character_name, m.display_name]).filter((n): n is string => !!n).sort((a, b) => b.length - a.length);
  const mention = names.length ? new RegExp(`@(?:${names.map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null;
  const parts = text.split(/(\[\[page:[^|\]]+\|[^\]]*\]\])/g);
  return parts.map((p, i) => {
    const m = /^\[\[page:([^|\]]+)\|([^\]]*)\]\]$/.exec(p);
    if (m) return <Link key={i} to={`/w/${slug}/library?page=${encodeURIComponent(m[1])}`}>{m[2]}</Link>;
    if (!mention) return <Fragment key={i}>{p}</Fragment>;
    const bits = p.split(mention);
    const hits = p.match(mention) ?? [];
    return <Fragment key={i}>{bits.map((b, j) => <Fragment key={j}>{b}{hits[j] && <span className="sc-mention">{hits[j]}</span>}</Fragment>)}</Fragment>;
  });
}
