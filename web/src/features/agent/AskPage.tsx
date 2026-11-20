// The player's Ask page: the player harness. It knows only what the player knows, cannot change anything, and its
// answers are checked for leaks. Two voices: the broker (in the world, for what your character could learn) and your
// table helper (out of character: your character, items, the rules, what the party learned tonight). The DM can turn
// the helper off (setting agentPlayerHelper).
import { useState } from 'react';
import { PageHead } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import Chat from './Chat.tsx';
import './agent.css';

const KEY = 'alx-ask-mode';
const remembered = (): 'broker' | 'helper' => { try { return localStorage.getItem(KEY) === 'helper' ? 'helper' : 'broker'; } catch { return 'broker'; } };

export default function AskPage() {
  const { info } = useWorld();
  const helperOn = (info?.settings as any)?.agentPlayerHelper !== false;
  const [mode, setMode] = useState<'broker' | 'helper'>(remembered);
  const m = helperOn ? mode : 'broker';
  const pick = (v: 'broker' | 'helper') => { setMode(v); try { localStorage.setItem(KEY, v); } catch { /* private window */ } };
  return (
    <div className="page">
      <PageHead title="Ask" lead={m === 'helper' ? 'Your table helper: your character, your items, the rules and what the party learned tonight. Out of character; it cannot change anything.' : 'Ask about what your character knows: places, people, what happened and your items. It cannot change anything.'} />
      {helperOn && (
        <div className="row" role="tablist" aria-label="Who to ask" style={{ marginBottom: 8 }}>
          <button type="button" role="tab" aria-selected={m === 'broker'} className={`btn small${m === 'broker' ? ' on' : ''}`} onClick={() => pick('broker')} data-testid="ask-broker">The broker</button>
          <button type="button" role="tab" aria-selected={m === 'helper'} className={`btn small${m === 'helper' ? ' on' : ''}`} onClick={() => pick('helper')} data-testid="ask-helper">Table helper</button>
        </div>
      )}
      <div className="card ag-ask">
        {m === 'helper'
          ? <Chat key="helper" harness="player" mode="helper" placeholder="What does Shield do? What's in my pack? What did we learn tonight?" />
          : <Chat key="broker" harness="player" placeholder="What would you like to know?" />}
      </div>
    </div>
  );
}
