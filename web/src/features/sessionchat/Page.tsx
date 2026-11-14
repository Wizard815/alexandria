import { PageHead } from '../../ui/index.tsx';
import { ChatPanel } from './ChatPanel.tsx';

export default function ChatPage() {
  return (
    <div className="page">
      <PageHead title="Session chat" lead="Table chat is for everyone. Party chat is for the players only." />
      <section className="card"><ChatPanel tall /></section>
    </div>
  );
}
