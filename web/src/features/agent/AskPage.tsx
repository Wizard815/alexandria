// The player's Ask page: the player harness. It knows only what the player
// knows, cannot change anything, and its answers are checked for leaks.
import { PageHead } from '../../ui/index.tsx';
import Chat from './Chat.tsx';
import './agent.css';

export default function AskPage() {
  return (
    <div className="page">
      <PageHead title="Ask" lead="Ask about what your character knows: places, people, what happened and your items. It cannot change anything." />
      <div className="card ag-ask"><Chat harness="player" placeholder="What would you like to know?" /></div>
    </div>
  );
}
