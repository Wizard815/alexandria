// A new spell from a spell template: the DM describes it, the world's chat model drafts it following the template
// (levels, schools, classes, balance, mana note), and the result is checked by the Codex's own normalizeSpell, so
// it saves through POST /spells/s like any homebrew spell. Without a model the DM gets a skeleton in the right
// shape to fill in. Nothing is saved here.
//
// MANA spell lines (Fire, Frost ...) come back as names in `lines`, beside the spell, not inside it: the Codex on a
// world without lines ignores them, and the lines editor can tag the spell by name.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, type ChatMessage } from '../../core/ai.ts';
import { normalizeSpell, SCHOOLS, type Spell } from '../spells/format.ts';
import { guideText, type SpellSpec } from './spec.ts';
import type { Template } from './store.ts';

export interface SpellDraft { spell: Omit<Spell, 'id'>; lines: string[]; usedModel: boolean; note: string | null }

const SYSTEM = [
  'You design ONE new spell for a D&D 5e style tabletop campaign, in the app Alexandria\'s Codex format. Follow the DM\'s spell template below.',
  'Return one JSON object: {"name": "...", "level": 0-9 (0 = cantrip), "school": "' + SCHOOLS.join('|') + '", "classes": ["Wizard", ...], "castingTime": "1 action", "ritual": false, "range": "60 feet", "components": "V, S, M (a pinch of soot)", "duration": "Instantaneous", "concentration": false, "damageTypes": ["Fire"], "saves": ["Dexterity"], "attack": "" | "melee" | "ranged", "text": "the description in Markdown, ending with what happens at higher levels", "manaCost": null or a number only when the template gives a mana rule, "lines": ["spell line names from the template that fit"]}.',
  'Keep it balanced against the SRD spells of the same level. Never copy a published spell\'s text; write it fresh. Never invent campaign facts beyond what the DM wrote.',
].join('\n');

/** The skeleton without a model: the template's lowest level and first school, the DM's words as the text. */
export function spellSkeleton(spec: SpellSpec, prompt: string): Omit<Spell, 'id'> {
  const p = prompt.trim().replace(/\s+/g, ' ');
  const name = (/^([^:.\n]{2,60})[:.]/.exec(p)?.[1] ?? p.split(/\s+/).slice(0, 4).join(' ')).replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim() || 'New spell';
  const level = spec.minLevel;
  return normalizeSpell({
    name, level, school: spec.schools[0] ?? 'Evocation', classes: spec.classes, castingTime: '1 action', range: '30 feet', components: 'V, S',
    duration: 'Instantaneous', text: `${p || 'Describe what the spell does.'}${spec.higherLevels ? `\n\n**${level === 0 ? 'Cantrip Upgrade' : 'Using a Higher-Level Spell Slot'}.** Say what changes.` : ''}`,
  }, 'Homebrew');
}

export async function draftSpell(d: Deps, t: Template, prompt: string, worldName: string): Promise<SpellDraft> {
  const spec = t.spec as SpellSpec;
  const base = spellSkeleton(spec, prompt);
  const fits = (lines: unknown) => (Array.isArray(lines) ? lines.map(String) : []).filter((l) => spec.lines.some((x) => x.toLowerCase() === l.toLowerCase())).slice(0, 5);
  if (!hasJob(d, 'chat')) return { spell: base, lines: spec.lines.slice(0, 1), usedModel: false, note: 'No chat model is set up, so this is a skeleton to fill in.' };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: guideText(t).slice(0, 4000) },
    { role: 'user', content: `World: ${worldName.slice(0, 100)}\nThe DM wants:\n${prompt.slice(0, 3000)}` },
  ];
  const j: any = await chatJson(d, 'chat', messages, undefined, { maxTokens: 2000 }).catch(() => null);
  if (!j || typeof j !== 'object') return { spell: base, lines: spec.lines.slice(0, 1), usedModel: false, note: 'The model gave no usable answer, so this is a skeleton to fill in.' };
  try {
    const spell = normalizeSpell({ ...j, source: 'Homebrew' }, 'Homebrew');
    // The template's level range holds, whatever the model wrote.
    spell.level = Math.max(spec.minLevel, Math.min(spec.maxLevel, spell.level));
    if (!spec.mana) delete spell.manaCost;
    return { spell, lines: fits(j.lines), usedModel: true, note: null };
  } catch (e: any) {
    return { spell: base, lines: spec.lines.slice(0, 1), usedModel: false, note: `The model's spell did not hold together (${String(e?.message ?? e).slice(0, 120)}), so this is a skeleton to fill in.` };
  }
}
