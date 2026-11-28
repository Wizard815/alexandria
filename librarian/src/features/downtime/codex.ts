// Downtime and the Codex: with spell crafting on, every recipe a character
// does not know yet is a downtime activity ("Craft Fire Shield"), its tier by
// the spell's level. Finishing it files the usual learn request in the Codex,
// so the DM's approval, item use and mana cost work as they always do.
// "Study a spell" and one "Study <spell>" per open MANA study (link
// spell-study) feed MANA's study flow, which counts their downtime days
// through the `downtime-day` event.
import { all, one, run } from '../../core/db.ts';
import { featureSetting } from '../../core/policy.ts';
import { id, now } from '../../core/util.ts';
import { dmAnd } from '../../core/events.ts';
import { recipeById, recipes } from '../spells/craft.ts';
import { knownIds, spellById } from '../spells/store.ts';
import { NO_REWARD, tierForSpellLevel, type Activity } from './catalog.ts';
import { addDowntimeLink } from './hooks.ts';
import { worldSettings } from './store.ts';

addDowntimeLink({
  kind: 'spell-craft',
  activities(db, worldId, accountId) {
    if (featureSetting<boolean>(worldSettings(db, worldId), 'spellCrafting') !== true) return [];
    const known = knownIds(db, worldId, accountId);
    const out: Activity[] = [];
    for (const rc of recipes(db, worldId)) {
      if (rc.draft || rc.visibility !== 'visible' || known.has(rc.resultId)) continue;
      const sp = spellById(db, worldId, rc.resultId);
      if (!sp) continue;
      const lvl = Number(sp.level) || 0;
      out.push({
        id: `craft-${rc.id}`, name: `Craft ${sp.name}`, tier: tierForSpellLevel(lvl), days: null, hoursPerDay: 8, repeatable: false,
        summary: `Work out ${sp.name} (${lvl ? `level ${lvl}` : 'cantrip'}) from spells you know. When the time is done the Codex asks the DM to approve it.`,
        reward: { ...NO_REWARD, text: `Learn ${sp.name}` }, link: { kind: 'spell-craft', ref: rc.id }, tags: ['magic', 'codex'], group: false, events: [], eventChance: null,
      });
      if (out.length >= 60) break;
    }
    return out;
  },
  onComplete(d, worldId, task, link) {
    const rc = link.ref ? recipeById(d.db, worldId, link.ref) : null;
    if (!rc) return 'The Codex recipe is gone, so nothing was filed';
    if (one(d.db, "SELECT 1 FROM spells_learn WHERE world_id = ? AND account_id = ? AND recipe_id = ? AND status = 'pending'", worldId, task.account_id, rc.id)) return 'A learn request was already waiting in the Codex';
    const lid = id('lrn_');
    run(d.db, 'INSERT INTO spells_learn (id, world_id, account_id, recipe_id, spell_id, status, note, at) VALUES (?,?,?,?,?,?,?,?)', lid, worldId, task.account_id, rc.id, rc.resultId, 'pending', `Finished in downtime: ${task.name}`.slice(0, 300), now());
    d.hub.emit(worldId, 'spells-learn', { id: lid, accountId: task.account_id, status: 'pending' }, dmAnd(task.account_id));
    return 'Sent to the Codex for the DM to approve';
  },
});

// MANA spell study: each open study is an activity ("Study Fireball") whose days the spells feature counts
// (it listens for `downtime-day` with link spell-study, ref = the study's id). Only when MANA's study table exists.
addDowntimeLink({
  kind: 'spell-study',
  activities(db, worldId, accountId) {
    if (!one(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spells_study'")) return [];
    const out: Activity[] = [];
    for (const st of all<any>(db, "SELECT id, spell_id FROM spells_study WHERE world_id = ? AND account_id = ? AND status = 'studying' ORDER BY updated_at DESC LIMIT 20", worldId, accountId)) {
      const sp = spellById(db, worldId, st.spell_id);
      if (!sp) continue;
      const lvl = Number(sp.level) || 0;
      out.push({
        id: `study-${st.id}`, name: `Study ${sp.name}`, tier: tierForSpellLevel(lvl), days: null, hoursPerDay: 8, repeatable: false,
        summary: `Every downtime day here counts toward learning ${sp.name} in the Codex, at your study's pace. The Codex says when it is learned.`,
        reward: { ...NO_REWARD, text: `Study days toward ${sp.name}` }, link: { kind: 'spell-study', ref: st.id }, tags: ['magic', 'codex', 'study'], group: false, events: [], eventChance: null,
      });
    }
    return out;
  },
});
