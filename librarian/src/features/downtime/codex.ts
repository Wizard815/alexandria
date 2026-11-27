// Downtime and the Codex: with spell crafting on, every recipe a character
// does not know yet is a downtime activity ("Craft Fire Shield"), its tier by
// the spell's level. Finishing it files the usual learn request in the Codex,
// so the GM's approval, item use and mana cost work as they always do. "Study
// a spell" (link spell-study) is for MANA's study flow, which counts downtime
// days through the `downtime-day` event once MANA is on this server.
import { one, run } from '../../core/db.ts';
import { featureSetting } from '../../core/policy.ts';
import { id, now } from '../../core/util.ts';
import { gmAnd } from '../../core/events.ts';
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
        summary: `Work out ${sp.name} (${lvl ? `level ${lvl}` : 'cantrip'}) from spells you know. When the time is done the Codex asks the GM to approve it.`,
        reward: { ...NO_REWARD, text: `Learn ${sp.name}` }, link: { kind: 'spell-craft', ref: rc.id }, tags: ['magic', 'codex'], group: false,
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
    d.hub.emit(worldId, 'spells-learn', { id: lid, accountId: task.account_id, status: 'pending' }, gmAnd(task.account_id));
    return 'Sent to the Codex for the GM to approve';
  },
});
