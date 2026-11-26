// The chat list as folders. Outside a session the DM (or player) sees their chats as a file tree: folders they made,
// chats at the top level, and template chats in one dropdown of their own so they never mix with the main chats.
// During a session the compact dropdown of recent chats is shown instead (ChatSwitcher), and either view can be picked
// by hand; the choice is remembered on this device. Folders are only paths that chats carry ("Bloodearth/Session 3"),
// so an empty folder made here lives on this device until a chat is put in it. A chat can be tossed: it goes, and a
// short note of what it made is kept for the assistant (listed at the bottom, each can be forgotten).
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import type { ChatRow, Switcher } from './ChatParts.tsx';

export type ChatView = 'auto' | 'tree' | 'recent';
const VIEW_KEY = 'alx-chat-view';
const OPEN_KEY = 'alx-chat-tree-open';
const MADE_KEY = 'alx-chat-tree-made';
const FOLD_KEY = 'alx-chat-tree-folded';

const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };

export const rememberedView = (): ChatView => { const v = read<string>(VIEW_KEY, 'auto'); return v === 'tree' || v === 'recent' ? v : 'auto'; };
export const rememberView = (v: ChatView) => write(VIEW_KEY, v);

/** Which view to show: the one picked by hand, else the recent dropdown in a session and the tree outside one. */
export const effectiveView = (v: ChatView, inSession: boolean): 'tree' | 'recent' => (v === 'auto' ? (inSession ? 'recent' : 'tree') : v);

/** Folder names in a stored path, cleaned the way the server stores them. */
export const cleanFolder = (p: string) => p.split('/').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('/');

export interface Node { name: string; path: string; folders: Node[]; chats: ChatRow[]; count: number }

/** Build the folder tree from the chats' paths (plus folders made on this device). Folders by name, chats newest first. */
export function buildTree(chats: ChatRow[], extra: string[] = []): Node {
  const root: Node = { name: '', path: '', folders: [], chats: [], count: 0 };
  const at = (path: string): Node => {
    let n = root;
    if (!path) return n;
    let acc = '';
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      let next = n.folders.find((f) => f.name === part);
      if (!next) { next = { name: part, path: acc, folders: [], chats: [], count: 0 }; n.folders.push(next); }
      n = next;
    }
    return n;
  };
  for (const p of extra) at(cleanFolder(p));
  for (const c of chats) at(cleanFolder(c.folder ?? '')).chats.push(c);
  const sort = (n: Node): number => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    n.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    n.count = n.chats.length + n.folders.reduce((s, f) => s + sort(f), 0);
    return n.count;
  };
  sort(root);
  return root;
}

/** A template id as a name: the DM's template's name when known, else a built-in starter's id made readable. */
export const templateName = (id: string, names: Record<string, string>) => names[id] || (id.startsWith('starter:') ? id.slice(8).replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : id);

export interface TreeTools {
  view: ChatView; setView: (v: ChatView) => void; inSession: boolean;
  templates: ChatRow[]; templateNames: Record<string, string>;
  /** A new chat, in a folder ('' = top level). */
  freshIn: (folder: string) => void;
  move: (id: string, folder: string) => void;
  renameFolder: (from: string, to: string) => void;
  /** Notes kept from tossed chats, and forgetting one. */
  notes: ChatNote[]; forget: (id: string) => void;
}

/** What is left of a tossed chat: its title, the changes it made and its gist. */
export interface ChatNote { id: string; title: string; gist: string; made: string[]; chatAt: string; createdAt: string }

const date = (iso: string) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString(); };

/** The tree, or (in a session) the dropdown, with a switch between them. */
export function ChatNav({ s, t, phone, recent }: { s: Switcher; t: TreeTools; phone?: boolean; recent: ReactNode }) {
  const shown = effectiveView(t.view, t.inSession);
  const btn = phone ? 'b' : 'btn small';
  const pick = (v: 'tree' | 'recent') => t.setView(v === (t.inSession ? 'recent' : 'tree') ? 'auto' : v);
  // One button that switches to the other view (the tree in a session, the dropdown outside one).
  const toggle = shown === 'recent'
    ? <button type="button" className={`${btn} ghost`} aria-label="Show chats in folders" title="Chats in folders" onClick={() => pick('tree')} data-testid="ag-view-tree"><i className="fa-solid fa-folder-tree" aria-hidden="true" /></button>
    : <button type="button" className={`${btn} ghost`} aria-label="Show recent chats" title="Recent chats (a dropdown)" onClick={() => pick('recent')} data-testid="ag-view-recent"><i className="fa-solid fa-clock-rotate-left" aria-hidden="true" /></button>;
  if (shown === 'recent') return <div className="row ag-nav"><div style={{ flex: '1 1 220px', minWidth: 0 }}>{recent}</div>{toggle}</div>;
  return <ChatTree s={s} t={t} phone={phone} toggle={toggle} />;
}

function ChatTree({ s, t, phone, toggle }: { s: Switcher; t: TreeTools; phone?: boolean; toggle: ReactNode }) {
  const [open, setOpen] = useState<string[]>(() => read<string[]>(OPEN_KEY, []));
  const [made, setMade] = useState<string[]>(() => read<string[]>(MADE_KEY, []));
  // A phone starts with the tree folded (the chat needs the room) and folds it again after a chat is picked.
  const [folded, setFoldedState] = useState<boolean>(() => read<boolean>(FOLD_KEY + (phone ? '-phone' : ''), !!phone));
  const setFolded = (f: boolean | ((x: boolean) => boolean)) => setFoldedState((cur) => { const v = typeof f === 'function' ? f(cur) : f; write(FOLD_KEY + (phone ? '-phone' : ''), v); return v; });
  const [moving, setMoving] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ path: string; value: string; mode: 'new' | 'rename' } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [acts, setActs] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(s.list, made), [s.list, made]);
  const folders = useMemo(() => { const out: string[] = []; const walk = (n: Node) => { for (const f of n.folders) { out.push(f.path); walk(f); } }; walk(tree); return out; }, [tree]);
  const tplGroups = useMemo(() => {
    const m = new Map<string, ChatRow[]>();
    for (const c of t.templates) { const k = c.template ?? ''; if (!k) continue; m.set(k, [...(m.get(k) ?? []), c]); }
    return [...m.entries()].map(([id, chats]) => ({ id, name: templateName(id, t.templateNames), chats })).sort((a, b) => a.name.localeCompare(b.name));
  }, [t.templates, t.templateNames]);
  const btn = (extra = '') => (phone ? `b ${extra}` : `btn small ${extra}`).trim();
  const isOpen = (p: string) => open.includes(p);
  const flip = (p: string) => { const next = isOpen(p) ? open.filter((x) => x !== p) : [...open, p]; setOpen(next); write(OPEN_KEY, next); };
  const expand = (p: string) => { const parts = p.split('/'); const add = parts.map((_, i) => parts.slice(0, i + 1).join('/')).filter((x) => !open.includes(x)); if (add.length) { const next = [...open, ...add]; setOpen(next); write(OPEN_KEY, next); } };
  const addMade = (p: string) => { const next = [...new Set([...made, p])]; setMade(next); write(MADE_KEY, next); };
  const dropMade = (under: string) => { const next = made.filter((m) => m !== under && !m.startsWith(`${under}/`)); setMade(next); write(MADE_KEY, next); };

  const saveName = () => {
    if (!naming) return;
    const name = cleanFolder(naming.value);
    if (!name) { setNaming(null); return; }
    if (naming.mode === 'new') { const p = cleanFolder(naming.path ? `${naming.path}/${name}` : name); addMade(p); expand(p); }
    else {
      const parent = naming.path.includes('/') ? naming.path.slice(0, naming.path.lastIndexOf('/')) : '';
      const to = cleanFolder(parent ? `${parent}/${name}` : name);
      if (to !== naming.path) {
        const kept = made.filter((m) => m === naming.path || m.startsWith(`${naming.path}/`)).map((m) => to + m.slice(naming.path.length));
        dropMade(naming.path); kept.forEach(addMade);
        t.renameFolder(naming.path, to); expand(to);
      }
    }
    setNaming(null);
  };
  const dropOn = (folder: string) => (e: DragEvent) => {
    e.preventDefault(); setOver(null);
    const id = e.dataTransfer.getData('text/x-alx-chat');
    if (id) { t.move(id, folder); expand(folder); }
  };
  const dropZone = (folder: string) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('text/x-alx-chat')) { e.preventDefault(); setOver(folder); } },
    onDragLeave: () => setOver((o) => (o === folder ? null : o)),
    onDrop: dropOn(folder),
  });

  const nameForm = (depth: number) => naming && (
    <li style={{ paddingLeft: depth * 14 }}>
      <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); saveName(); }}>
        <label style={{ flex: 1 }}><span className="sr-only">Folder name</span><input style={{ width: '100%' }} value={naming.value} maxLength={60} autoFocus placeholder="Folder name" onChange={(e) => setNaming({ ...naming, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null); }} data-testid="ag-folder-name" /></label>
        <button type="submit" className={btn('primary')}>Save</button>
        <button type="button" className={btn()} onClick={() => setNaming(null)}>Cancel</button>
      </form>
    </li>
  );

  const chatRow = (c: ChatRow, depth: number, inTemplates = false) => {
    const active = s.chat?.id === c.id;
    return (
      <li key={c.id} style={{ paddingLeft: depth * 14 }}>
        <div className={`ag-tree-chat${active ? ' on' : ''}`} draggable={!inTemplates && !phone} onDragStart={(e) => { e.dataTransfer.setData('text/x-alx-chat', c.id); e.dataTransfer.effectAllowed = 'move'; }}>
          <button type="button" className="ag-tree-open" aria-current={active ? 'true' : undefined} onClick={() => { setMoving(null); s.open(c.id); if (phone) setFoldedState(true); }} data-testid="ag-tree-chat">
            <i className="fa-regular fa-message" aria-hidden="true" /> <span className="ag-tree-title">{c.title || 'New chat'}</span> <span className="tiny muted">{date(c.updatedAt)}</span>
          </button>
          {active && !inTemplates && <button type="button" className={btn('ghost')} aria-label="Move this chat to a folder" title="Move to a folder" onClick={() => setMoving(moving === c.id ? null : c.id)} data-testid="ag-move"><i className="fa-solid fa-folder-open" aria-hidden="true" /></button>}
        </div>
        {moving === c.id && <MoveForm phone={phone} folders={folders} current={cleanFolder(c.folder ?? '')} onCancel={() => setMoving(null)} onMove={(f) => { setMoving(null); if (f) addMade(f); t.move(c.id, f); if (f) expand(f); }} />}
      </li>
    );
  };

  // A folder's actions: inline on a desktop (shown on hover), behind one button on a phone so the name keeps its room.
  const folderActs = (f: Node) => <>
    <button type="button" className={btn('ghost')} aria-label={`New chat in ${f.name}`} title="New chat here" onClick={() => { setActs(null); expand(f.path); t.freshIn(f.path); }}><i className="fa-solid fa-plus" aria-hidden="true" />{phone && ' New chat'}</button>
    <button type="button" className={btn('ghost')} aria-label={`New folder in ${f.name}`} title="New folder inside" onClick={() => { setActs(null); expand(f.path); setNaming({ path: f.path, value: '', mode: 'new' }); }}><i className="fa-solid fa-folder-plus" aria-hidden="true" />{phone && ' Folder'}</button>
    <button type="button" className={btn('ghost')} aria-label={`Rename ${f.name}`} title="Rename folder" onClick={() => { setActs(null); setNaming({ path: f.path, value: f.name, mode: 'rename' }); }}><i className="fa-solid fa-pen" aria-hidden="true" />{phone && ' Rename'}</button>
  </>;

  const folderRows = (n: Node, depth: number): ReactNode[] => n.folders.flatMap((f) => {
    const o = isOpen(f.path);
    const row = (
      <li key={`f:${f.path}`} style={{ paddingLeft: depth * 14 }} {...dropZone(f.path)}>
        {naming?.mode === 'rename' && naming.path === f.path ? null : (
          <div className={`ag-tree-folder${over === f.path ? ' over' : ''}`}>
            <button type="button" className="ag-tree-open" aria-expanded={o} onClick={() => flip(f.path)} data-testid="ag-tree-folder">
              <i className={`fa-solid ${o ? 'fa-folder-open' : 'fa-folder'}`} aria-hidden="true" /> <span className="ag-tree-title">{f.name}</span> <span className="tiny muted">{f.count}</span>
            </button>
            {phone
              ? <button type="button" className={btn(`ghost${acts === f.path ? ' on' : ''}`)} aria-label={`Folder actions for ${f.name}`} aria-expanded={acts === f.path} onClick={() => setActs(acts === f.path ? null : f.path)}><i className="fa-solid fa-ellipsis" aria-hidden="true" /></button>
              : folderActs(f)}
          </div>
        )}
        {phone && acts === f.path && <div className="row ag-tree-acts">{folderActs(f)}</div>}
      </li>
    );
    const renameRow = naming?.mode === 'rename' && naming.path === f.path ? [<NameSlot key={`r:${f.path}`}>{nameForm(depth)}</NameSlot>] : [];
    const inside = o ? [
      ...(naming?.mode === 'new' && naming.path === f.path ? [<NameSlot key={`n:${f.path}`}>{nameForm(depth + 1)}</NameSlot>] : []),
      ...folderRows(f, depth + 1),
      ...f.chats.map((c) => chatRow(c, depth + 1)),
      ...(f.count === 0 ? [<li key={`e:${f.path}`} className="tiny muted" style={{ paddingLeft: (depth + 1) * 14 + 6 }}>Empty. Drag a chat here or press + to start one.</li>] : []),
    ] : [];
    return [...renameRow, row, ...inside];
  });

  return (
    <div className="stack tight ag-tree-wrap" aria-label="Your chats" data-testid="ag-chats">
      <div className="row ag-chats" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
        <button type="button" className="ag-tree-open" style={{ flex: 1, minWidth: 0 }} aria-expanded={!folded} onClick={() => setFolded((f) => !f)} data-testid="ag-tree-fold">
          <i className={`fa-solid ${folded ? 'fa-chevron-right' : 'fa-chevron-down'}`} aria-hidden="true" /> <strong>Chats</strong>{folded && s.chat ? <span className="tiny muted ag-tree-title"> · {s.list.find((c) => c.id === s.chat?.id)?.title || t.templates.find((c) => c.id === s.chat?.id)?.title || 'New chat'}</span> : null}
        </button>
        <button type="button" className={btn('ghost')} aria-label="New chat" title="New chat" disabled={s.busy} onClick={() => t.freshIn('')} data-testid="ag-tree-new"><i className="fa-solid fa-plus" aria-hidden="true" /></button>
        <button type="button" className={btn('ghost')} aria-label="New folder" title="New folder" onClick={() => { setFolded(false); setNaming({ path: '', value: '', mode: 'new' }); }} data-testid="ag-tree-newfolder"><i className="fa-solid fa-folder-plus" aria-hidden="true" /></button>
        {toggle}
      </div>
      {!folded && (
        <ul className={`ag-tree${phone ? ' phone' : ''}`} data-testid="ag-tree">
          {naming?.mode === 'new' && naming.path === '' && nameForm(0)}
          {folderRows(tree, 0)}
          <li {...dropZone('')} className={over === '' && tree.chats.length === 0 ? 'ag-tree-over' : undefined}>
            <ul className="ag-tree-flat">{tree.chats.map((c) => chatRow(c, 0))}</ul>
          </li>
          {!s.list.length && !t.templates.length && <li className="tiny muted">No chats yet. Ask something below to start one.</li>}
          {tplGroups.length > 0 && <>
            <li className="ag-tree-sep" aria-hidden="true" />
            {/* Template chats: one dropdown, out of the way of the main chats. */}
            <li className="ag-tree-tpl">
              <label className="row" style={{ flexWrap: 'nowrap', alignItems: 'center', gap: 6 }}>
                <i className="fa-solid fa-scroll" aria-hidden="true" /><span className="sr-only">Template chats</span>
                <select style={{ flex: 1, minWidth: 0 }} value={t.templates.some((c) => c.id === s.chat?.id) ? s.chat!.id : ''} onChange={(e) => { if (e.target.value) { s.open(e.target.value); if (phone) setFoldedState(true); } }} data-testid="ag-tree-templates">
                  <option value="">Template chats ({t.templates.length})</option>
                  {tplGroups.map((g) => <optgroup key={g.id} label={g.name}>{g.chats.map((c) => <option key={c.id} value={c.id}>{c.title || 'New chat'} · {date(c.updatedAt)}</option>)}</optgroup>)}
                </select>
              </label>
            </li>
          </>}
          {t.notes.length > 0 && <>
            <li className="ag-tree-sep" aria-hidden="true" />
            <li>
              <div className="ag-tree-folder">
                <button type="button" className="ag-tree-open" aria-expanded={isOpen('\u0000notes')} onClick={() => flip('\u0000notes')} data-testid="ag-tree-notes" title="Notes kept from tossed chats. The assistant reads the newest few.">
                  <i className="fa-solid fa-box-archive" aria-hidden="true" /> <span className="ag-tree-title">Remembered from tossed chats</span> <span className="tiny muted">{t.notes.length}</span>
                </button>
              </div>
            </li>
            {isOpen('\u0000notes') && t.notes.map((n) => (
              <li key={n.id} style={{ paddingLeft: 14 }} data-testid="ag-note">
                <div className="ag-tree-chat">
                  <div className="ag-tree-open" style={{ cursor: 'default' }} title={[n.made.length ? `Made: ${n.made.join('; ')}` : 'Made nothing', n.gist].filter(Boolean).join('\n')}>
                    <i className="fa-regular fa-note-sticky" aria-hidden="true" /> <span className="ag-tree-title">{n.title}</span> <span className="tiny muted">{n.made.length ? `${n.made.length} made` : date(n.chatAt)}</span>
                  </div>
                  <button type="button" className={btn('ghost')} aria-label={`Forget the note of ${n.title}`} title="Forget this note" onClick={() => t.forget(n.id)}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
                </div>
              </li>
            ))}
          </>}
        </ul>
      )}
      {s.chat && <OpenChatTools s={s} phone={phone} />}
    </div>
  );
}

/** Gives the inline name form a key in a list of rows. */
const NameSlot = ({ children }: { children: ReactNode }) => <>{children}</>;

/** Pick a folder for a chat: an existing one, the top level, or a new name (a path with "/" makes nested folders). */
function MoveForm({ folders, current, onMove, onCancel, phone }: { folders: string[]; current: string; onMove: (f: string) => void; onCancel: () => void; phone?: boolean }) {
  const [v, setV] = useState(current);
  const btn = phone ? 'b' : 'btn small';
  return (
    <form className="row ag-tree-move" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); onMove(cleanFolder(v)); }} data-testid="ag-move-form">
      <label style={{ flex: 1 }}><span className="sr-only">Folder</span>
        <input style={{ width: '100%' }} list="ag-folders" value={v} maxLength={200} autoFocus placeholder="Folder (empty for top level)" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }} />
        <datalist id="ag-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      </label>
      <button type="submit" className={`${btn} primary`}>Move</button>
      <button type="button" className={btn} onClick={onCancel}>Cancel</button>
    </form>
  );
}

/** Rename, toss or delete the open chat, under the tree. */
function OpenChatTools({ s, phone }: { s: Switcher; phone?: boolean }) {
  const { chat, renaming, setRenaming, confirmDel, setConfirmDel, busy } = s;
  if (!chat) return null;
  const btn = (extra: string) => (phone ? `b ${extra}` : `btn small ${extra}`).trim();
  if (renaming !== null) return (
    <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (renaming.trim()) s.rename(chat.id, renaming.trim()); }}>
      <label style={{ flex: 1 }}><span className="sr-only">Chat name</span><input style={{ width: '100%' }} value={renaming} maxLength={120} autoFocus onChange={(e) => setRenaming(e.target.value)} /></label>
      <button type="submit" className={btn('primary')} disabled={busy || !renaming.trim()}>Save</button>
      <button type="button" className={btn('')} onClick={() => setRenaming(null)}>Cancel</button>
    </form>
  );
  if (confirmDel) return (
    <div className="stack tight">
      <span className="tiny">Toss keeps a short note of what this chat made, for the assistant. Delete keeps nothing. What it made in the world stays either way.</span>
      <div className="row">
        {s.toss && <button type="button" className={btn('primary')} disabled={busy} onClick={() => s.toss?.()} data-testid="ag-toss">Toss</button>}
        <button type="button" className={btn('danger')} disabled={busy} onClick={() => s.remove()}>Delete</button>
        <button type="button" className={btn('')} onClick={() => setConfirmDel(false)}>Keep</button>
      </div>
    </div>
  );
  return (
    <div className="row ag-tree-tools">
      <button type="button" className={btn('ghost')} aria-label="Rename this chat" onClick={() => setRenaming(s.titleOf?.(chat.id) ?? '')}><i className="fa-solid fa-pen" aria-hidden="true" /> Rename</button>
      <button type="button" className={btn('ghost')} aria-label="Delete this chat" onClick={() => setConfirmDel(true)}><i className="fa-solid fa-trash" aria-hidden="true" /> Toss or delete</button>
    </div>
  );
}
