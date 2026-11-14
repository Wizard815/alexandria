// A floating chat button on every player and DM page, with an unread badge
// and a drawer holding the chat panel (a bottom sheet on phones).
import { useState } from 'react';
import { DockButton, useExclusivePanel } from '../../ui/Dock.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { totalUnread, useCurrent } from './shared.tsx';

export default function ChatOverlay() {
  const [open, setOpen] = useState(false);
  const cur = useCurrent();
  useExclusivePanel('chat', open, () => setOpen(false));
  const n = totalUnread(cur.data);
  return (
    <>
      {open && (
        <div className="sc-drawer dock-panel" role="dialog" aria-label="Session chat">
          <div className="row between"><strong>Chat</strong><button type="button" className="btn ghost small" onClick={() => setOpen(false)} aria-label="Close chat">✕</button></div>
          <ChatPanel onRead={() => void cur.reload()} />
        </div>
      )}
      <DockButton order={10} icon="fa-comment-dots" label={n ? `Chat, ${n} unread` : 'Chat'} title="Chat" active={open} badge={n > 99 ? '99+' : n} onClick={() => setOpen((o) => !o)} testId="dock-chat" />
    </>
  );
}
