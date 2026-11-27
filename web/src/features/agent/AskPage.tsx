// The player's Ask page: the player harness. It knows only what the player knows, cannot change anything, and its
// answers are checked for leaks. Two voices: the broker (in the world, for what your character could learn) and your
// table helper (out of character: your character, items, the rules, what the party learned tonight). The GM can turn
// the helper off (setting agentPlayerHelper).
import { useState } from 'react';
import { PageHead } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import Chat from './Chat.tsx';
import QuickHelp, { type QuickHandoff } from './QuickHelp.tsx';
import './agent.css';

const KEY = 'alx-ask-mode';
const remembered = (): 'broker' | 'helper' => { try { return localStorage.getItem(KEY) === 'helper' ? 'helper' : 'broker'; } catch { return 'broker'; } };

export default function AskPage() {
  const { info } = useWorld();
  const helperOn = (info?.settings as any)?.agentPlayerHelper !== false;
  const [mode, setMode] = useState<'broker' | 'helper'>(remembered);
  const brokerOn = (info?.settings as any)?.brokerEnabled !== false;
  const m = !brokerOn ? 'helper' : helperOn ? mode : 'broker';
  const pick = (v: 'broker' | 'helper') => { setMode(v); try { localStorage.setItem(KEY, v); } catch { /* private window */ } };
  // The quick helper hands a question on: into the box of the table helper or the broker, to check and send.
  const [prefill, setPrefill] = useState<{ text: string; n: number } | null>(null);
  const handoff = (h: QuickHandoff) => {
    const to = h.to === 'broker' && brokerOn ? 'broker' : helperOn ? 'helper' : 'broker';
    pick(to);
    setPrefill((p) => ({ text: h.question, n: (p?.n ?? 0) + 1 }));
  };
  return (
    <div className="page">
      <PageHead title="Ask" lead={m === 'helper' ? 'Your table helper: your character, your items, the rules and what the party learned tonight. Out of character; it cannot change anything.' : 'Ask about what your character knows: places, people, what happened and your items. It cannot change anything.'} />
      {helperOn && brokerOn && (
        <div className="row" role="tablist" aria-label="Who to ask" style={{ marginBottom: 8 }}>
          <button type="button" role="tab" aria-selected={m === 'broker'} className={`btn small${m === 'broker' ? ' on' : ''}`} onClick={() => pick('broker')} data-testid="ask-broker">The broker</button>
          <button type="button" role="tab" aria-selected={m === 'helper'} className={`btn small${m === 'helper' ? ' on' : ''}`} onClick={() => pick('helper')} data-testid="ask-helper">Table helper</button>
        </div>
      )}
      {m === 'helper' && <QuickHelp onHandoff={handoff} />}
      <div className="card ag-ask">
        {m === 'helper'
          ? <Chat key="helper" harness="player" mode="helper" prefill={prefill} placeholder="What does Shield do? What's in my pack? What did we learn tonight?" />
          : <Chat key="broker" harness="player" prefill={prefill} placeholder="What would you like to know?" />}
      </div>
    </div>
  );
}
