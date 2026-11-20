// The DM's one-tap prompts for the Ask tab: what is worth a single tap in the middle of a fight. Editable, and kept
// per browser (and world) in localStorage, which can be blocked: then they still work for the page's life.
import { useCallback, useState } from 'react';
import { lsGet, lsSet } from './hooks.ts';

export interface QuickPrompt { label: string; text: string }
export const MAX_QUICK = 12;

export const DEFAULT_QUICK: QuickPrompt[] = [
  { label: 'Next turn', text: 'next turn' },
  { label: 'Recap, last 10 min', text: 'Recap the last 10 minutes of the session from the transcript, in a few short bullets.' },
  { label: 'What did they decide?', text: 'What did the players just decide? Give the decision and who argued for what, in a line or two.' },
  { label: 'Describe this place', text: 'Describe the place the party is in right now in a few vivid sentences I can read aloud, using what the library knows about it.' },
  { label: 'Roll initiative', text: 'Roll initiative for the monsters in the fight.' },
  { label: 'Who is concentrating?', text: 'Who is concentrating on a spell right now, and what is the save DC if they are hit?' },
];

const key = (world: string) => `alx.dmphone.quick.${world}`;

/** Parse what was stored; anything that is not a list of labelled prompts is ignored. */
export function readQuick(raw: string | null): QuickPrompt[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const out = v.filter((x) => x && typeof x.label === 'string' && typeof x.text === 'string' && x.label.trim() && x.text.trim())
      .map((x) => ({ label: x.label.trim().slice(0, 30), text: x.text.trim().slice(0, 600) })).slice(0, MAX_QUICK);
    return out;
  } catch { return null; }
}

export function useQuickPrompts(world: string): [QuickPrompt[], (v: QuickPrompt[]) => void] {
  const [list, setList] = useState<QuickPrompt[]>(() => readQuick(lsGet(key(world))) ?? DEFAULT_QUICK);
  const save = useCallback((v: QuickPrompt[]) => { setList(v); lsSet(key(world), JSON.stringify(v)); }, [world]);
  return [list, save];
}
