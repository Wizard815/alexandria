// A floating chat button on every player and DM page, with an unread badge
// and a drawer holding the chat panel (a bottom sheet on phones).
import { useState } from 'react';
import { ChatPanel } from './ChatPanel.tsx';
import { totalUnread, useCurrent } from './shared.tsx';

export default function ChatOverlay() {
  const [open, setOpen] = useState(false);
  const cur = useCurrent();
  const n = totalUnread(cur.data);
  return (
    <>
      {open && (
        <div className="sc-drawer" role="dialog" aria-label="Session chat">
          <div className="row between"><strong>Chat</strong><button type="button" className="btn ghost small" onClick={() => setOpen(false)} aria-label="Close chat">✕</button></div>
          <ChatPanel onRead={() => void cur.reload()} />
        </div>
      )}
      <button type="button" className="sc-fab" aria-label={n ? `Chat, ${n} unread` : 'Chat'} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">💬</span>
        {n > 0 && <span className="sc-badge">{n > 99 ? '99+' : n}</span>}
      </button>
    </>
  );
}
