// What a player may see of a monster card. The GM's card is the whole statblock;
// a player's has no armor class, ability scores or challenge rating, and no hit
// points unless the world shows monster health exactly (monsterHealth: exact).
// Applied to the card route, the term route and the rules search.
import type { WorldSettings } from '../../core/policy.ts';

interface Cardish { kind?: string; summary?: string; text?: string; data?: any }

const KEYS_ALWAYS = ['ac', 'acType', 'abilities', 'cr', 'xp', 'savingThrows'];
const KEYS_HP = ['hp', 'hitDice'];

function stripText(text: string, exactHp: boolean): string {
  return text
    // **AC** 17 · **HP** 150 (20d10 + 40) · **Speed** ...: keep the speed (and the HP when shown).
    .split('\n')
    .map((line) => {
      if (!/\*\*AC\*\*/.test(line)) return line;
      const parts = line.split(/\s·\s/).filter((p) => !/^\*\*AC\*\*/.test(p) && (exactHp || !/^\*\*HP\*\*/.test(p)));
      return parts.join(' · ');
    })
    .filter((line, i, all) => {
      if (/^\*\*CR\*\*/.test(line.trim())) return false;
      // The ability table: header, separator and the row of scores.
      if (/^\|\s*STR\s*\|/.test(line)) return false;
      if (/^\|[-\s|:]+\|$/.test(line) && /^\|\s*STR\s*\|/.test(all[i - 1] ?? '')) return false;
      if (/^\|\s*\d+\s*\(/.test(line) && /^\|[-\s|:]+\|$/.test(all[i - 1] ?? '') && /^\|\s*STR\s*\|/.test(all[i - 2] ?? '')) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const stripSummary = (s: string, exactHp: boolean) => s.split(/\s·\s/).filter((p) => !/^(CR|AC)\s/.test(p) && (exactHp || !/^HP\s/.test(p))).join(' · ');

/** The card as a player may see it. Other kinds of term are returned as they are. */
export function playerCard<T extends Cardish>(card: T, settings: Pick<WorldSettings, 'monsterHealth'>): T {
  if (card.kind !== 'monster') return card;
  const exactHp = settings.monsterHealth === 'exact';
  const out: T = { ...card };
  if (typeof card.text === 'string') out.text = stripText(card.text, exactHp);
  if (typeof card.summary === 'string') out.summary = stripSummary(card.summary, exactHp);
  if (card.data && typeof card.data === 'object') {
    const data = { ...card.data };
    for (const k of KEYS_ALWAYS) delete data[k];
    if (!exactHp) for (const k of KEYS_HP) delete data[k];
    out.data = data;
  }
  return out;
}
