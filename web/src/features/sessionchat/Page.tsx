import { PageHead } from '../../ui/index.tsx';
import { ChatPanel } from './ChatPanel.tsx';

export default function ChatPage() {
  return (
    <div className="page">
      <PageHead title="Table chat" lead="Table chat is for everyone; party chat for players only." />
      <section className="card"><ChatPanel tall /></section>
    </div>
  );
}
