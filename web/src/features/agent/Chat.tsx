// One conversation with the assistant. The reply streams in as it is written
// (live 'agent' events, with the chat polled as a fallback), can be stopped,
// quotes its sources as links to library pages, and (for the GM) shows
// actions waiting for approval right under the message that proposed them.
// The same component runs the desktop panel, the pop-out window and, with
// `phone`, the GM phone's Ask tab (big targets, quick prompts, hold-to-talk),
// so every feature lands in both.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { useAuth } from '../../lib/auth.tsx';
import { buzz } from '../gmphone/hooks.ts';
import { AloudToggle, OPEN_CHAT, chatKey, claimSpoken, rememberChat, rememberedChat, speakAloud, stopSpeaking, useReadAloud } from './aloud.tsx';
import { AutoSwitch, ChatMessages, ChatSwitcher, MicButton, type Act, type ChatRow, type ChatState, type Item, type Live } from './ChatParts.tsx';
import { PREFILL_EVENT, takePrefill } from './prefill.ts';
import { ChatNav, rememberView, rememberedView, type ChatView, type TreeTools } from './ChatTree.tsx';
import './agent.css';

export { linkCitations } from './ChatParts.tsx';

/** Told to every chat and to the phone's Queue when an agent action is decided, so none waits for the server's event. */
export const ACTIONS_CHANGED = 'alx-agent-actions-changed';
export const announceActions = () => { try { window.dispatchEvent(new Event(ACTIONS_CHANGED)); } catch { /* no window */ } };

/** Put an action in the chat's list (a new card, or a newer state of one it has). */
const upsert = (list: Act[], a: Act): Act[] => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? { ...x, ...a } : x)) : [...list, a]);

const KEY = chatKey;
const remembered = rememberedChat;
const remember = rememberChat;

type Quick = { label: string; send?: string; fill?: string; needs?: 'page' };
const QUICK: Record<'gm' | 'player', Quick[]> = {
  gm: [
    { label: 'Summarise this page', send: 'Summarise this page: the key facts and what the party could do with it, in a few bullets.', needs: 'page' },
    { label: 'Make a statblock', fill: 'Make a statblock for ' },
    { label: 'What happened last session?', send: 'What happened last session? Give me the key events and open threads.' },
    { label: 'Next turn', send: 'next turn' },
  ],
  player: [
    { label: 'What happened last session?', send: 'What happened last session?' },
    { label: 'Who have we met?', send: 'Who have we met so far?' },
    { label: 'What do I have?', send: 'What items do I have?' },
  ],
};

/** Something the GM's phone adds to every message (the combatant picked on the Now tab). `get` reads it fresh at send time. */
export interface ChatContext { label: string; get: () => Promise<string | undefined>; drop: () => void }

export interface ChatProps {
  harness: 'gm' | 'player'; page?: string; placeholder?: string;
  /** A player's table helper instead of the broker. */
  mode?: 'helper';
  /** Chats about one template (its id): created with it and listed apart from the main chats. */
  template?: string;
  /** The GM phone's layout: big targets, a pinned input, quick prompts and hold-to-talk. */
  phone?: boolean;
  /** Phone: shown at the top of the chat (the session summary). */
  header?: ReactNode;
  context?: ChatContext | null;
  /** Phone: offered when nothing is attached (the combatant whose turn it is). */
  attachable?: { label: string; attach: () => void } | null;
  /** Phone: one-tap prompts, and the button that edits them. */
  quickPrompts?: { label: string; text: string }[];
  onEditQuick?: () => void;
  /** Text put in the box for the user to check and send (the quick helper's handoff). A new `n` fills it again. */
  prefill?: { text: string; n: number } | null;
}

export default function Chat({ harness, page, placeholder, mode, template, phone, header, context, attachable, quickPrompts, onEditQuick, prefill }: ChatProps) {
  const { w, info, on, isGM } = useWorld();
  const { world = '' } = useParams();
  const navigate = useNavigate();
  const [chat, setChat] = useState<ChatState | null>(null);
  const [text, setText] = useState('');
  const [selection, setSelection] = useState('');
  const [dropPage, setDropPage] = useState(false);
  const [pageTitle, setPageTitle] = useState('');
  const [combat, setCombat] = useState<{ active: boolean; round?: number } | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [model, setModel] = useState<boolean | null>(null);
  const [alwaysAsk, setAlwaysAsk] = useState<string[]>([]);
  // The tools the GM let run without a card (agentAutoApprove), kept live by the settings event.
  const trusted: string[] = Array.isArray((info.settings as any)?.agentAutoApprove) ? (info.settings as any).agentAutoApprove : [];
  // Auto mode: the world's setting (kept live by the settings event). `autoNow` shows a tap at once, until the server's answer arrives.
  const [autoNow, setAutoNow] = useState<boolean | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);
  const autoServer = (info.settings as any)?.agentAuto === true;
  const autoOn = autoNow ?? autoServer;
  const sticky = useRef(true);
  const [away, setAway] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  const lastSent = useRef('');
  const { busy, error, setError, run } = useAction();
  const { client } = useAuth();
  const [aloud] = useReadAloud();
  const [aloudNote, setAloudNote] = useState('');
  const [list, setList] = useState<ChatRow[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  // Assistant messages already seen in the open chat: only one that arrives after this is read aloud.
  const seen = useRef<{ chat: string; ids: Set<string> }>({ chat: '', ids: new Set() });
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<ChatState | null>(null);
  chatRef.current = chat;
  // Incognito: a chat that is not saved. It works like any other, is never listed, and is deleted when it is left
  // (another chat opened, a new one started, the screen closed). What it did in the world stays.
  const wRef = useRef(w); wRef.current = w;
  const leaveIncognito = useCallback((next?: string) => {
    const cur = chatRef.current;
    if (cur?.incognito && cur.id !== next) void wRef.current.call('DELETE', `/agent/chats/${cur.id}`).catch(() => {});
  }, []);
  useEffect(() => () => leaveIncognito(), [leaveIncognito]);
  const key = KEY(info.id, [harness, mode, template && `tpl-${template}`].filter(Boolean).join('-'));
  // The list asked for (the broker's or the helper's; main chats or one template's) and what a new chat is made with.
  const listPath = (tpl?: string) => { const q = new URLSearchParams(); if (mode) q.set('mode', mode); if (tpl) q.set('template', tpl); const t = q.toString(); return `/agent/chats${t ? `?${t}` : ''}`; };
  const newBody = (folder?: string) => ({ ...(mode ? { mode } : {}), ...(template ? { template } : {}), ...(folder ? { folder } : {}) });
  // Folders outside a session, recent chats during one (or whichever the GM picked).
  const [view, setViewState] = useState<ChatView>(rememberedView);
  const setView = (v: ChatView) => { setViewState(v); rememberView(v); };
  const sess = useLoad<any>(() => w.call('GET', '/sessionchat/current'), [w], ['chat-session']);
  const inSession = !!sess.data?.session;
  const [tplList, setTplList] = useState<ChatRow[]>([]);
  const [tplNames, setTplNames] = useState<Record<string, string>>({});
  const attachedPage = page && !dropPage ? page : undefined;

  // An older answer never replaces a newer one (the chat is re-read from several places at once).
  const load = useCallback(async (id: string) => {
    const n = ++loadSeq.current;
    try {
      const c = await w.call<ChatState>('GET', `/agent/chats/${id}`);
      if (n === loadSeq.current) setChat(c);
    } catch (e: any) { if (n === loadSeq.current) setError(e.message); }
  }, [w, setError]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await w.call<any>('GET', '/agent/status');
        if (alive) { setModel(!!st.model); setAlwaysAsk(Array.isArray(st.alwaysAsk) ? st.alwaysAsk : []); }
        const id = remembered(key);
        if (id) { try { const c = await w.call<ChatState>('GET', `/agent/chats/${id}`); if (alive) setChat(c); return; } catch { /* a deleted chat: start fresh */ } }
        const list = await w.call<{ chats: { id: string }[] }>('GET', listPath(template));
        if (list.chats[0]) { remember(key, list.chats[0].id); const c = await w.call<ChatState>('GET', `/agent/chats/${list.chats[0].id}`); if (alive) setChat(c); }
      } catch (e: any) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, [w, key, setError]);

  const refreshList = useCallback(() => {
    w.call<{ chats: ChatRow[] }>('GET', listPath(template)).then((r) => setList(r.chats ?? [])).catch(() => {});
    // The main chat also lists every template chat, in the tree's own Templates branch (never mixed in with the rest).
    if (!template) w.call<{ chats: ChatRow[] }>('GET', listPath('only')).then((r) => setTplList((r.chats ?? []).filter((c) => !!c.template))).catch(() => {});
  }, [w, mode, template]);
  // Template names for that branch (the GM's templates; built-in starters are named from their id).
  useEffect(() => {
    if (template || !isGM || harness !== 'gm' || !tplList.length) return;
    let alive = true;
    // Built-in starters come as `starters` where the server lists them; else their names are made from the id.
    w.call<{ templates: { id: string; name: string }[]; starters?: { id: string; name: string }[] }>('GET', '/templates').then((r) => { if (alive) setTplNames(Object.fromEntries([...(r.starters ?? []), ...(r.templates ?? [])].map((x) => [x.id, x.name]))); }).catch(() => {});
    return () => { alive = false; };
  }, [w, template, isGM, harness, tplList.length]);
  useEffect(() => { refreshList(); }, [refreshList, chat?.id, chat?.busy]);

  const open = useCallback(async (id: string) => {
    leaveIncognito(id);
    setConfirmDel(false); setRenaming(null); setLive(null); stopSpeaking();
    try { const c = await w.call<ChatState>('GET', `/agent/chats/${id}`); remember(key, id); setChat(c); } catch (e: any) { setError(e.message); }
  }, [w, key, setError, leaveIncognito]);
  // The notice for a spoken request asks for its chat to be shown.
  useEffect(() => {
    const h = (e: Event) => { const id = (e as CustomEvent).detail?.chatId; if (id && harness === 'gm') void open(id); };
    window.addEventListener(OPEN_CHAT, h);
    return () => window.removeEventListener(OPEN_CHAT, h);
  }, [open, harness]);

  // Read a finished reply aloud (GM only, if switched on). What was already in the chat when it opened is never read.
  useEffect(() => {
    if (!chat) return;
    const done = chat.messages.filter((m) => m.role === 'assistant' && m.status === 'done' && m.text.trim());
    if (seen.current.chat !== chat.id) { seen.current = { chat: chat.id, ids: new Set(done.map((m) => m.id)) }; return; }
    const fresh = done.filter((m) => !seen.current.ids.has(m.id));
    for (const m of fresh) seen.current.ids.add(m.id);
    const last = fresh.at(-1);
    if (last && phone) buzz([10, 40, 10]);
    if (last && aloud && isGM && harness === 'gm' && claimSpoken(last.id)) void speakAloud(info.id, client.token, last.text).then((n) => setAloudNote(n ?? ''));
  }, [chat, aloud, isGM, harness, phone, info.id, client]);
  useEffect(() => { if (!aloud) setAloudNote(''); }, [aloud]);

  // The title of the page that is attached, and whether a fight is running (GM only: only the GM's assistant is given it).
  useEffect(() => {
    setDropPage(false);
    setPageTitle('');
    if (!page) return;
    let alive = true;
    w.call<any>('GET', `/library/pages/${encodeURIComponent(page)}`).then((p) => { if (alive) setPageTitle(p?.title ?? ''); }).catch(() => {});
    return () => { alive = false; };
  }, [w, page]);
  // A request put in the box from elsewhere (a template's "Ask the assistant"): shown, not sent.
  useEffect(() => {
    if (harness !== 'gm') return;
    const fill = (t: string) => { if (!t) return; setText(t); setTimeout(() => { box.current?.focus(); box.current?.setSelectionRange(t.length, t.length); }, 30); };
    fill(takePrefill());
    const onFill = (e: Event) => { takePrefill(); fill(String((e as CustomEvent).detail ?? '')); };
    window.addEventListener(PREFILL_EVENT, onFill);
    return () => window.removeEventListener(PREFILL_EVENT, onFill);
  }, [harness]);
  useEffect(() => {
    const t = prefill?.text ?? '';
    if (!t) return;
    setText(t);
    setTimeout(() => { box.current?.focus(); box.current?.setSelectionRange(t.length, t.length); }, 30);
  }, [prefill?.text, prefill?.n]);
  const loadCombat = useCallback(() => { if (isGM) w.call<any>('GET', '/live/combat').then((c) => setCombat({ active: !!c.active, round: c.round })).catch(() => {}); }, [w, isGM]);
  useEffect(() => { loadCombat(); return on(['combat'], loadCombat); }, [on, loadCombat]);

  // Text selected on the page (outside this panel) is offered as context. A phone has no page behind the chat.
  useEffect(() => {
    if (harness !== 'gm' || phone) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sel = window.getSelection();
        const s = (sel?.toString() ?? '').trim();
        const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
        if (s && s.length > 2 && !node?.closest('.ag-panel')) setSelection(s.slice(0, 3000));
      }, 250);
    };
    document.addEventListener('selectionchange', check);
    return () => { clearTimeout(t); document.removeEventListener('selectionchange', check); };
  }, [harness, phone]);

  // The reply arriving: pieces of text, a reset when the model turns to tools, a replacement, a status line.
  useEffect(() => on(['agent'], (e) => {
    const d: any = e.data;
    const cur = chatRef.current;
    if (!cur || d?.chatId !== cur.id) return;
    if (d.kind === 'delta') setLive((l) => ({ text: (l?.text ?? '') + d.text, status: '' }));
    else if (d.kind === 'reset') setLive({ text: '', status: '' });
    else if (d.kind === 'replace') setLive({ text: d.text, status: '' });
    else if (d.kind === 'status') setLive((l) => ({ text: l?.text ?? '', status: String(d.status ?? d.text ?? '') }));
    else if (d.kind === 'queue') setLive((l) => ({ text: l?.text ?? '', status: '', queue: String(d.text ?? '') }));
    // A card arrives (or changes) with the event itself: no re-read, so it shows the moment it is proposed or decided anywhere.
    else if (d.kind === 'action' && d.action) setChat((c) => (c && c.id === d.chatId ? { ...c, actions: upsert(c.actions, d.action as Act) } : c));
    // The streaming text stays on screen: only the end of the turn (busy false) clears it.
    else if (d.kind === 'message' || d.kind === 'action') void load(cur.id);
  }), [on, load]);
  // An action decided elsewhere on this device (the phone's Queue) leaves this chat at once.
  useEffect(() => {
    const h = () => { const cur = chatRef.current; if (cur) void load(cur.id); };
    window.addEventListener(ACTIONS_CHANGED, h);
    return () => window.removeEventListener(ACTIONS_CHANGED, h);
  }, [load]);

  // Fallback while it is working: poll (this also carries the text so far, if the live stream was missed).
  useEffect(() => {
    if (!chat?.busy) return;
    const t = setInterval(() => void load(chat.id), 1500);
    return () => clearInterval(t);
  }, [chat?.busy, chat?.id, load]);
  useEffect(() => { if (!chat?.busy) setLive(null); }, [chat?.busy]);
  // Follow the reply while the GM is at the bottom; scrolled up to read, leave them there and offer a way back.
  const onScroll = () => { const el = log.current; if (!el) return; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; sticky.current = near; setAway(!near); };
  const toEnd = () => { sticky.current = true; setAway(false); end.current?.scrollIntoView?.({ block: 'end' }); };
  useEffect(() => { if (sticky.current) end.current?.scrollIntoView?.({ block: 'end' }); }, [chat?.messages.length, chat?.actions.length, chat?.actions.map((a) => a.status).join(), live?.text.length]);

  // A new proposal buzzes the phone: it is waiting for a thumb.
  const pending = (chat?.actions ?? []).filter((a) => a.status === 'pending').length;
  const lastPending = useRef(0);
  useEffect(() => { if (phone && pending > lastPending.current) buzz([30, 50, 30]); lastPending.current = pending; }, [pending, phone]);

  // The phone's box grows with what is typed (up to a few lines) and shrinks back after a send.
  useEffect(() => {
    const el = box.current;
    if (!phone || !el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [text, phone]);

  const send = (override?: string) => run(async () => {
    const body = (override ?? text).trim();
    if (!body) return;
    lastSent.current = body;
    if (phone) buzz(10);
    // What the phone attaches is read now, so a fight that moved on since it was picked is not described by old numbers.
    const extra = context ? await context.get().catch(() => undefined) : undefined;
    let id = chat?.id;
    if (!id) { const c = await w.call<ChatState>('POST', '/agent/chats', newBody()); id = c.id; remember(key, id); seen.current = { chat: id, ids: new Set() }; }
    setText('');
    stopSpeaking();
    toEnd();
    setLive({ text: '', status: '' });
    const sel = [selection, extra].filter(Boolean).join('\n\n').slice(0, 3000);
    setSelection('');
    try {
      setChat(await w.call<ChatState>('POST', `/agent/chats/${id}/messages`, { text: body, page: attachedPage, selection: sel || undefined }));
    } catch (e) {
      // Nothing was sent: the words come back to the box, the input stays usable, and the error shows above it.
      setLive(null);
      setText((cur) => cur || body);
      if (selection) setSelection(selection);
      throw e;
    }
  });
  const retry = () => { if (lastSent.current) void send(lastSent.current); };
  const stop = () => { if (chat) void w.call('POST', `/agent/chats/${chat.id}/stop`, {}).catch((e: any) => setError(e.message)); };
  const fresh = (folder?: string) => run(async () => { leaveIncognito(); const c = await w.call<ChatState>('POST', '/agent/chats', newBody(folder)); remember(key, c.id); setChat(c); setLive(null); stopSpeaking(); refreshList(); });
  const move = (id: string, folder: string) => run(async () => { await w.call('PATCH', `/agent/chats/${id}`, { folder }); refreshList(); });
  const renameFolder = (from: string, to: string) => run(async () => { await w.call('POST', '/agent/chats/folders/rename', { from, to, ...(mode ? { mode } : {}) }); refreshList(); });
  const rename = (id: string, title: string) => run(async () => { await w.call('PATCH', `/agent/chats/${id}`, { title }); setRenaming(null); refreshList(); });
  const incognito = () => run(async () => {
    leaveIncognito();
    const c = await w.call<ChatState>('POST', '/agent/chats', { ...newBody(), incognito: true });
    setChat(c); setLive(null); stopSpeaking(); setConfirmDel(false); setRenaming(null);
  });
  const endIncognito = () => run(async () => {
    leaveIncognito(); setLive(null); stopSpeaking();
    const back = remembered(key) || list[0]?.id;
    if (back) await open(back); else setChat(null);
  });
  const remove = () => run(async () => {
    if (!chat) return;
    await w.call('DELETE', `/agent/chats/${chat.id}`);
    setConfirmDel(false);
    const rest = [...list, ...tplList].filter((c) => c.id !== chat.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (rest[0]) await open(rest[0].id); else { remember(key, ''); setChat(null); setLive(null); }
    refreshList();
  });
  // Deciding is instant on screen: the card flips to its outcome at once and the server's answer (or its event) settles it. Each card
  // is independent, so several can be approved back to back without waiting for one another.
  const decide = (a: Act, decision: 'approve' | 'reject') => {
    if (phone) buzz(decision === 'approve' ? 15 : [20, 40, 20]);
    const prev = a.status;
    setChat((c) => (c ? { ...c, actions: upsert(c.actions, { ...a, status: decision === 'approve' ? 'done' : 'rejected' }) } : c));
    w.call<Act>('POST', `/agent/actions/${a.id}`, { decision })
      .then((got) => setChat((c) => (c ? { ...c, actions: upsert(c.actions, got) } : c)))
      .catch((e: any) => {
        // A 502 still carries the card (the change did not work); a 409 means someone decided it first: read the truth from the server.
        setError(e.message);
        setChat((c) => (c ? { ...c, actions: upsert(c.actions, { ...a, status: e?.status ? 'running' : prev }) } : c));
        if (chatRef.current) void load(chatRef.current.id);
      })
      .finally(() => announceActions());
  };

  // Every waiting card at once, oldest first and one after another (adding a creature before damaging it keeps its order).
  const decideAll = (decision: 'approve' | 'reject') => run(async () => {
    const list = (chatRef.current?.actions ?? []).filter((a) => a.status === 'pending').sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    if (phone) buzz(decision === 'approve' ? 15 : [20, 40, 20]);
    for (const a of list) {
      setChat((c) => (c ? { ...c, actions: upsert(c.actions, { ...a, status: decision === 'approve' ? 'running' : 'rejected' }) } : c));
      try { const got = await w.call<Act>('POST', `/agent/actions/${a.id}`, { decision }); setChat((c) => (c ? { ...c, actions: upsert(c.actions, got) } : c)); }
      catch (e: any) { setError(e.message); if (chatRef.current) await load(chatRef.current.id); break; }
    }
    announceActions();
  });
  const editAction = async (a: Act, args: Record<string, unknown>) => {
    const got = await w.call<Act>('PATCH', `/agent/actions/${a.id}`, { args });
    setChat((c) => (c ? { ...c, actions: upsert(c.actions, got) } : c));
  };
  const setTrusted = (next: string[]) => w.call('PATCH', '/settings', { agentAutoApprove: [...new Set(next)].slice(0, 60) });
  const trustAction = (a: Act) => { void setTrusted([...trusted, a.tool]).then(() => decide(a, 'approve')).catch((e: any) => setError(`Could not allow ${a.tool}: ${e.message}`)); };
  const untrust = (tool: string) => { void setTrusted(trusted.filter((t) => t !== tool)).catch((e: any) => setError(e.message)); };

  const toggleAuto = async () => {
    const next = !autoOn;
    setAutoNow(next); setSavingAuto(true); setError(null);
    try { await w.call('PATCH', '/settings', { agentAuto: next }); }
    catch (e: any) { setError(`Could not switch Auto mode: ${e.message}`); }
    finally { setSavingAuto(false); setAutoNow(null); }
  };

  const libraryHref = useCallback((id: string) => `/w/${world}/${isGM ? 'gm/' : ''}library?page=${encodeURIComponent(id)}`, [world, isGM]);
  const goLink = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest?.('a.wikilink') as HTMLAnchorElement | null;
    const href = a?.getAttribute('href');
    if (href?.startsWith('/')) { e.preventDefault(); navigate(href); }
  };

  const items = useMemo(() => {
    // The reply "Done: ..." the server files after a decision repeats what the card now says: the card is shown, not the line.
    const said = new Set((chat?.actions ?? []).flatMap((a) => [`Done: ${a.summary}.`, `Rejected: ${a.summary}.`]));
    const out: Item[] = (chat?.messages ?? []).filter((m) => !(m.role === 'assistant' && (said.has(m.text) || (m.text.startsWith('That did not work: ') && (chat?.actions ?? []).some((a) => m.text.startsWith(`That did not work: ${a.summary}.`)))))).map((m) => ({ t: 'msg' as const, m }));
    for (const a of chat?.actions ?? []) out.push({ t: 'act' as const, a });
    return out.sort((x, y) => (x.t === 'msg' ? x.m.at : x.a.createdAt).localeCompare(y.t === 'msg' ? y.m.at : y.a.createdAt));
  }, [chat?.messages, chat?.actions]);

  const working = !!chat?.busy;
  const focusInput = () => (box.current ?? document.querySelector<HTMLTextAreaElement>('[data-ag-input]'))?.focus();
  const addText = (t: string) => { setText((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t)); focusInput(); };
  const switcher = { chat, list, busy, renaming, setRenaming, confirmDel, setConfirmDel, open: (id: string) => void open(id), rename: (id: string, t: string) => void rename(id, t), remove: () => void remove(), fresh: () => void fresh(), titleOf: (id: string) => [...list, ...tplList].find((c) => c.id === id)?.title ?? '' };
  const tree: TreeTools = { view, setView, inSession, templates: tplList, templateNames: tplNames, freshIn: (f) => void fresh(f), move: (id, f) => void move(id, f), renameFolder: (a, b) => void renameFolder(a, b), incognito: () => void incognito() };
  // One template's chats are few and short-lived: the plain dropdown is enough there.
  const incogBar = (ph?: boolean) => chat?.incognito && (
    <div className="row ag-incognito" role="status" data-testid="ag-incognito-bar">
      <i className="fa-solid fa-user-secret" aria-hidden="true" />
      <span className={ph ? 'sub' : 'tiny'} style={{ flex: 1, minWidth: 0 }}>Incognito: this chat is not saved and is deleted when you leave it. What it does in the world stays.</span>
      <button type="button" className={ph ? 'b' : 'btn small'} disabled={busy} onClick={() => void endIncognito()}>End</button>
    </div>
  );
  const nav = (ph?: boolean) => (template ? <ChatSwitcher phone={ph} s={switcher} /> : <ChatNav s={switcher} t={tree} phone={ph} recent={<ChatSwitcher phone={ph} s={switcher} />} />);
  const gmCards = harness === 'gm' && isGM;
  const messages = <ChatMessages phone={phone} items={items} live={live} isGM={isGM} auto={autoOn} retry={retry} libraryHref={libraryHref} onLink={goLink} onNavigate={navigate} decide={decide} cardTools={gmCards ? { edit: editAction, trust: trustAction } : undefined} />;
  const modeSwitch = gmCards && <AutoSwitch phone={phone} on={autoOn} saving={savingAuto} onToggle={() => void toggleAuto()} alwaysAsk={alwaysAsk} trusted={trusted} untrust={untrust} />;
  const bulk = gmCards && pending >= 2 && (
    <div className={phone ? 'row ag-bulk' : 'row ag-bulk'} role="group" aria-label="All waiting changes" data-testid="ag-bulk">
      <span className={phone ? 'sub' : 'tiny muted'}>{pending} changes waiting</span>
      <button type="button" className={phone ? 'b ok' : 'btn small primary'} disabled={busy} onClick={() => void decideAll('approve')} data-testid="ag-approve-all">Approve all</button>
      <button type="button" className={phone ? 'b' : 'btn small'} disabled={busy} onClick={() => void decideAll('reject')}>Reject all</button>
    </div>
  );
  const jump = away && <button type="button" className={phone ? 'b chip ag-jump' : 'btn small ag-jump'} onClick={toEnd} data-testid="ag-jump"><i className="fa-solid fa-arrow-down" aria-hidden="true" /> Latest</button>;
  const noModel = model === false && <p className="tiny muted">No chat model is set yet (Admin → Models). Dice, the date and simple combat commands still work.</p>;
  const hello = harness === 'gm' ? 'Ask about your world, the last session, the rules or the fight. It can propose changes; nothing happens until you approve it.' : 'Ask about what your character knows: places, people, what happened, your items.';

  if (phone) {
    return (
      <div className="ask">
        {header}
        <div className="ask-top">
          {model === false && <div className="sub">No chat model is set (Admin, Models). Dice, the date and simple combat commands still work.</div>}
          {modeSwitch}
          {nav(true)}
          {incogBar(true)}
        </div>
        <div className="ask-log" aria-live="polite" data-testid="ask-log" ref={log} onScroll={onScroll}>
          {!chat?.messages.length && <div className="empty">{hello}</div>}
          {messages}
          <div ref={end} />
        </div>
        {jump}
        {bulk}
        <div className="ask-bar">
          {error && <div className="err" role="alert">{error}</div>}
          {aloud && aloudNote && <div className="sub" role="status">{aloudNote}</div>}
          <div className="flow ask-chips" aria-label="Quick asks">
            {context && <button type="button" className="b chip on" aria-label={`Do not send ${context.label}`} title="Sent with your message. Tap to drop it." onClick={context.drop}><i className="fa-solid fa-khanda" aria-hidden="true" /> {context.label} <i className="fa-solid fa-xmark" aria-hidden="true" /></button>}
            {attachable && <button type="button" className="b chip" aria-label={`Attach ${attachable.label}`} title="Send this combatant with your message" onClick={attachable.attach}><i className="fa-solid fa-plus" aria-hidden="true" /> {attachable.label}</button>}
            {isGM && combat?.active && <span className="pill gold" title="The fight now is sent with your message"><i className="fa-solid fa-khanda" aria-hidden="true" /> Round {combat.round}</span>}
            {(quickPrompts ?? []).map((q) => <button key={q.label} type="button" className="b chip" disabled={busy || working} onClick={() => void send(q.text)}>{q.label}</button>)}
            {onEditQuick && <button type="button" className="b chip" aria-label="Edit quick prompts" title="Edit quick prompts" onClick={onEditQuick} data-testid="quick-edit"><i className="fa-solid fa-pen" aria-hidden="true" /></button>}
            {isGM && harness === 'gm' && <AloudToggle phone note={aloudNote} />}
          </div>
          <form className="row ask-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <label className="grow"><span className="sr-only">Message</span>
              <textarea ref={box} data-ag-input rows={1} value={text} placeholder={placeholder ?? 'Ask…'} enterKeyHint="send" onChange={(e) => setText(e.target.value)} /></label>
            {isGM && <MicButton hold disabled={busy || working} onText={addText} onError={setError} />}
            {working
              ? <button type="button" className="b danger" onClick={stop} aria-label="Stop the answer"><i className="fa-solid fa-stop" aria-hidden="true" /></button>
              : <button type="submit" className="b primary" disabled={busy || !text.trim()} aria-label="Send"><i className="fa-solid fa-paper-plane" aria-hidden="true" /></button>}
          </form>
        </div>
      </div>
    );
  }

  const quick = QUICK[harness].filter((q) => q.needs !== 'page' || attachedPage);
  return (
    <div className="stack" style={{ minHeight: 0, flex: 1 }}>
      {noModel}
      {modeSwitch}
      {nav()}
      {incogBar()}
      <div className="stack" style={{ overflowY: 'auto', flex: 1, minHeight: 120, position: 'relative' }} aria-live="polite" ref={log} onScroll={onScroll} data-testid="ag-log">
        {!chat?.messages.length && <p className="tiny muted">{hello}</p>}
        {messages}
        <div ref={end} />
      </div>
      {jump}
      {bulk}
      <ErrorBox error={error} />
      {aloud && aloudNote && <p className="tiny muted" role="status">{aloudNote}</p>}
      <div className="row ag-chips" aria-label="Attached to your message">
        {attachedPage && <span className="chip gold" title="The page you are looking at is sent with your message"><i className="fa-solid fa-file-lines" aria-hidden="true" /> {pageTitle || 'This page'} <button type="button" className="ag-x" aria-label="Do not send this page" onClick={() => setDropPage(true)}>×</button></span>}
        {page && dropPage && <button type="button" className="chip" onClick={() => setDropPage(false)}>Attach this page</button>}
        {selection && <span className="chip gold" title={selection}><i className="fa-solid fa-i-cursor" aria-hidden="true" /> “{selection.slice(0, 40)}{selection.length > 40 ? '…' : ''}” <button type="button" className="ag-x" aria-label="Do not send the selection" onClick={() => setSelection('')}>×</button></span>}
        {isGM && combat?.active && <span className="chip teal" title="The fight now is sent with your message"><i className="fa-solid fa-khanda" aria-hidden="true" /> Combat, round {combat.round}</span>}
      </div>
      <div className="row ag-quick" aria-label="Quick actions">
        {quick.map((q) => <button key={q.label} type="button" className="chip ag-quick-btn" disabled={busy || working} onClick={() => { if (q.send) void send(q.send); else { setText(q.fill ?? ''); focusInput(); } }}>{q.label}</button>)}
        <button type="button" className="chip ag-quick-btn" onClick={() => void fresh()}>New chat</button>
        {!template && <button type="button" className="chip ag-quick-btn" title="Not saved, deleted when you leave it" onClick={() => void incognito()}><i className="fa-solid fa-user-secret" aria-hidden="true" /> Incognito</button>}
        {isGM && harness === 'gm' && <AloudToggle note={aloudNote} />}
      </div>
      <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="grow" style={{ flex: 1 }}><span className="sr-only">Message</span>
          <textarea ref={box} data-ag-input rows={2} style={{ width: '100%' }} value={text} placeholder={placeholder ?? 'Ask…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!working) void send(); } }} />
        </label>
        {isGM && <MicButton disabled={busy || working} onText={addText} />}
        {working
          ? <button type="button" className="btn small danger" onClick={stop} aria-label="Stop the answer"><i className="fa-solid fa-stop" aria-hidden="true" /> Stop</button>
          : <button type="submit" className="btn primary small" disabled={busy || !text.trim()}>Send</button>}
      </form>
    </div>
  );
}
