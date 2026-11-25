# Spell Plan

The plan for Alexandria's spell system: the spell list, mana, casting limits, dual casting, spell trees and learning new spells by combining spells you already know. Everything here becomes a per-world setting with these numbers as defaults; a world can import its own numbers as a "spell rules profile".

Status: **steps 1 and 2 are built**: the rules engine (`librarian/src/features/spells/rules.ts`) and spell lines with the spell rules profile (`lines.ts`); the rest is planned. The Codex (spell list, mana, spell crafting recipes, spell sheets) is on main; see [docs/SPELLS.md](docs/SPELLS.md). This plan extends it. The research behind the learning rule is in [docs/SPELL_LEARNING_RESEARCH.md](docs/SPELL_LEARNING_RESEARCH.md).

Words: plain terms only (mana, fire, frost, lightning, earth, air, light, shadow, Arcana check, Dual cast, fatigue, coin).

---

## 1. The spell list

| Group | Spells | Shown by default |
|---|---|---|
| 2024 Player's Handbook | 391 (339 of them in SRD 5.2.1) | yes |
| Other 2024-rules books (Heroes of Faerûn, Forge of the Artificer, Arcana Unleashed, D&D Beyond Drops) | 65 | yes |
| 2014 books, only spells with no 2024 version (Xanathar's, Tasha's, Wildemount, Acquisitions Inc., Fizban's, Strixhaven …) | 135 | yes |
| World of Warcraft (2024-rules crossover) | 69 | 21 kept, the rest hidden |
| Unearthed Arcana, 2024 era | 20 | 10 kept |
| Unearthed Arcana, 2014 era (never printed) | 33 | 10 kept |
| **Total** | **713**, one entry per spell | 632 visible, 81 hidden |

- **Duplicates:** one entry per spell. Official book beats Unearthed Arcana; newer beats older. 123 duplicate versions were dropped; each kept spell notes what it replaced.
- **Hidden, not deleted:** World of Warcraft spells (crossover), the Modern Magic tech spells, the psionic spells reviewers found overpowered (Id Insinuation, Psychic Crush, Mental Barrier, Thought Shield), playtest versions of class features (Pact Weapon, Book of Shadows, Pact Familiar, Create/Modify/Memorize/Scribe Spell, Sorcery Incarnate, Sorcerous Vitality, Arcane Eruption), Healing Elixir and the four Conjure-demon spells.
- **World of Warcraft spells kept:** Arcane Pulse, Frost Nova, Chains of Ice, Living Flame, Moonfire, Consecration, Eruption, Flurry, Rain of Fire, Remorseless Winter, Regrowth, Prayer of Mending, Emberstorm, Upheaval, Holy Nova, Starfall, Divine Shield, Innervate, Tranquility, Combustion, and Mass Polymorph (its only 2024 version).
- **Fields per spell:** name, source, group, era, level, school, classes, casting time, ritual, range, targets, V/S/M, material and its gold cost (consumed or not), duration, concentration, damage types, save, attack, types, hidden + reason, notes, verified, supersedes.
- **Types:** damage, control, debuff, buff, heal, defense, utility, movement, summon, divination, social, trickery. To add: restoration, revival, counter-magic, transformation, terrain, creation, communication, planar. Plus a **line** tag (below) and an area / single-target filter.
- **Copyright:** the repo is public, so it only ships the SRD 5.2.1 spells (CC-BY-4.0). Every other spell is metadata only (no rules text) and is imported by each DM on their own server as a JSON file; it is never committed here. The import format is the field list above.

## 2. Mana

**Cost to cast**

| Spell level | Cantrip | 1st | 2nd | 3rd | 4th | 5th | 6th | 7th | 8th | 9th |
|---|---|---|---|---|---|---|---|---|---|---|
| Mana | 0 | 2 | 3 | 5 | 6 | 7 | 9 | 11 | 13 | 15 |

**Pools** match what normal 5e spell slots are worth at these costs, nudged up a point or two where slots stay flat so the pool grows every level.

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Full | 4 | 6 | 14 | 17 | 27 | 32 | 38 | 44 | 57 | 64 | 73 | 77 | 84 | 88 | 97 | 101 | 112 | 119 | 128 | 139 |
| Half | 4 | 5 | 6 | 8 | 14 | 15 | 17 | 19 | 27 | 28 | 32 | 34 | 38 | 40 | 44 | 46 | 57 | 58 | 64 | 66 |
| Third | 0 | 0 | 4 | 5 | 6 | 7 | 14 | 15 | 16 | 17 | 18 | 19 | 27 | 28 | 29 | 32 | 33 | 34 | 38 | 40 |
| None | 0 | … | | | | | | | | | | | | | | | | | | 0 |

Why not a flat 6 per level: it gave a level 2 caster twice the casting of a normal wizard and ran about 10% short from level 9 on. Tables stay editable, and a caster type can switch to "per level × N, plus casting modifier from level X".

**Highest spell level** follows the slot progression:
- Full: ceil(level ÷ 2), so 1st at 1, 2nd at 3 … 9th at 17.
- Half: 1st at 1, 2nd at 5, 3rd at 9, 4th at 13, 5th at 17.
- Third (Eldritch Knight, Arcane Trickster): 1st at 3, 2nd at 7, 3rd at 13, 4th at 19.
- Multiclass: caster level = full levels + half levels ÷ 2 + third levels ÷ 3 (rounded down), then the full table.

**Upcasting:** cost of the target level **+1 mana per level raised** (setting; 0 turns it off). Fireball: 5 at 3rd, 7 at 4th, 9 at 5th. Without the surcharge, +1 mana for +1d6 over an area is cheaper than slots, because mana never runs out of "high slots".

**Mana potions** (example values): 10 / 25 / 50 / 75 / 100 mana, Common to Legendary.

## 3. Limits on casting

**Per turn** (2024 rule: one spell slot per turn)
- One leveled spell per turn. Extra actions from features (Action Surge, Haste) may cast cantrips.
- **Surge cast** (optional): a second leveled spell in the same turn costs ×2 mana and needs a CON save, DC 10 + spell level; a failure gives 1 level of fatigue. Once per short rest.
- Dual cast counts as the turn's leveled spell.

**Against spamming one spell** (each a setting)
1. **Echo strain** (on): each repeat of the same leveled spell before a short rest costs +1 more (Fireball 5, 6, 7 …). Cantrips don't count.
2. **High-level limit** (on): spells of 6th level and up once per long rest each (the 2014 DMG spell points rule).
3. **Overchannel** (on): go below 0 mana, down to minus your character level. CON save DC 10 + the mana you're short; a failure gives 1 fatigue.
4. **Low mana** (off): below 25%, disadvantage on concentration saves.

## 4. Dual cast

Needs the Dual cast ability (granted by the DM), once per short rest, using action + bonus action.
- **Empower** (the same spell twice): ×2 mana; counts as cast 2 levels higher (Fireball becomes 10d6).
- **Fuse** (two different known spells): both costs added ×1.5; both effects land on the same target or area; at most one needs concentration.
- **Arcana check** DC 10 + both spell levels added. On a failure the mana is spent and the next roll is at −2.
- **Learning in play:** a successful fuse of two spells that are parts of a recipe banks 1 study point toward that recipe (up to half of it) and reveals the recipe if it was hidden.

## 5. Spell lines and trees

- The DM defines **lines** (name, colour, theme): e.g. Fire, Frost, Lightning, Earth, Air, Light, Shadow, Mind, Healing. A spell can be in more than one.
- **Line mastery** = how many spells you know in that line.
- **Hybrid spells** (in two lines, like fire + air) need mastery 2 in both and take ×1.25 study. This is the Divinity: Original Sin 2 skillbook-crafting idea.
- The tree shows tiers (cantrip → 9th) with links from each recipe's spells. Each spell is shown as known, gift, can learn, in progress (with a bar), locked or hidden ("???"). Hover or tap for the cost to cast and upcast, every requirement with ✓/✗ for the chosen character, the learning cost per method and progress.

## 6. Learning a spell

### Requirements (all optional per recipe; all must be met)

| Requirement | Default |
|---|---|
| Known spells | "all of" and/or "any N of", 1–5 spells |
| Tier gate | 1st: 2 related cantrips · 2nd–3rd: 2 from the level below · 4th–5th: + Arcana check · 6th–7th: 3 + mentor or text · 8th–9th: research or DM gift only |
| Ability minimum (casting ability) | 12 for 1st–2nd, 13 for 3rd–4th, 15 for 5th–6th, 17 for 7th–8th, 18 for 9th |
| Character level | when your caster type reaches that spell level |
| Mana pool | at least 2 × the cast cost |
| Item | kept or used up; linked to the shop's item database |
| Methods allowed | e.g. a 9th-level spell only by research or a memory |
| Extra price | HP, max HP or max mana lost, for the strongest or forbidden spells |

### Time and cost

Built from Morrowind's spellmaking (cost follows power), Oblivion (you only build from what you know), Ars Magica (banked progress, a discount for related spells), Pathfinder 2e (graded checks) and D&D 2024 (scroll scribing times as the yardstick).

- **Complexity** C = the spell's mana cost (a cantrip counts as 1).
- **Study points needed** = ceil(C² ÷ 2) × 1.25 if hybrid × (1 − 10% per recipe spell beyond the tier minimum, at most 20%).
- **Progress per 8-hour day:** alone 1 · with a written text 2 · with a mentor 3 · in a lab +1. Progress is banked, so days don't need to be in a row.
- **Materials:** 10 × C² coin. A mentor charges the same again.
- **Final check:** d20 + casting modifier + proficiency bonus against:

  | Spell level | Cantrip | 1–2 | 3–4 | 5–6 | 7–9 |
  |---|---|---|---|---|---|
  | DC | 10 | 13 | 15 | 18 | 22 |

  - Beat it by 10: learned, and half the materials back.
  - Success: learned.
  - Failure: keep your progress, try again after a long rest.
  - Fail by 10 or a natural 1: lose 25% of your progress and gain 1 fatigue.

| Spell level | Days alone / with text / with mentor | Materials |
|---|---|---|
| 1st | 2 / 1 / 1 | 40 |
| 2nd | 5 / 3 / 2 | 90 |
| 3rd | 13 / 7 / 5 | 250 |
| 4th | 18 / 9 / 6 | 360 |
| 5th | 25 / 13 / 9 | 490 |
| 6th | text or mentor only: 21 / 14 | 810 |
| 7th | text or mentor only: 31 / 21 | 1,210 |
| 8th | research only: 29–43 | 1,690 |
| 9th | research only: 38–57 | 2,250 |

Compared with an earlier draft (3 days per spell level alone): low spells get a little faster, high spells become real projects (2–4× longer), in line with D&D 2024 scroll scribing (120 days for 9th) and Pathfinder.

**Shortcuts**
- **Level-up insight:** a free attempt when you level up; a failure banks half the study.
- **Memory:** a full memory of learning a spell (taken whole, e.g. by a memory spell) teaches it at once. Optional WIS save DC 10 + 2 × spell level (off by default); a failure banks a quarter and gives 1 exhaustion.
- **Scroll:** a study aid, not the spell: 1 hour per spell level to decode; using it up adds a quarter of the study. The spell still has to be studied and checked.

### Flow
1. The player picks a spell they can learn and a method, and starts studying.
2. They log downtime days; the DM approves them (or a setting approves them automatically).
3. When the study is complete, the player rolls the final check (or lets the app roll); the DM confirms.
4. The DM can add days or progress, adjust anything, or **gift** any spell to any character, magic user or not, with a reason ("Gift of a fire elemental"). A gift skips every requirement and costs nothing.
5. Non-casters with gifts: cantrips at will; a leveled spell once per long rest (setting). The DM picks the casting ability.
6. Everything is in an audit log.

## 7. Build plan

1. **Rules engine (server):** the settings above with defaults; formulas for pools, highest level, multiclass, upcast, study points, discounts, hybrids, graded checks, banked progress, dual cast, echo strain, overchannel, surge, gates. Unit tests for every formula.
2. **Spell rules profile:** import/export of all settings, lines, recipes and spell→line tags as JSON, with a preview.
3. **Spell list import:** the JSON field list in section 1, hidden spells stay hidden; the new types.
4. **Tree view and cards** in the Codex, the player Study panel, the DM queue (day approvals, final checks, requests, gifts), a cast panel applying all the limits with clear costs. Must work at phone width.
5. **Settings → Spell rules** with a live preview table (pool per level per caster type; time and cost per spell level per method).
6. **Assistant tools:** read rules, list lines and recipes, check a character's eligibility and costs, suggest recipes (drafts the DM approves).
7. **Security:** players never see DM notes, hidden recipes, other characters' progress or DM-only spells (fail closed); seeds in the leak tests.
8. **Tests and docs:** unit tests, an e2e that studies → checks → learns on a phone, a dual cast revealing a recipe, a gift to a non-caster and a settings import; update docs/SPELLS.md.

## 8. Open questions (answered as settings)

- Keep the third-caster pool, or let each world set its own? **Both: the plan's table is the default and every pool table is editable per world (`spellRules.pools`).**
- Dual cast at level 5, or tie it to a feat? **An ability the DM grants per character; nothing in play gives it yet. `spellRules.dualCast.unlock: "level"` opens it at a character level instead.**
- Should failed final checks cost coin as well as time? **No by default; `learning.failCoinLoss` and `learning.setbackCoinLoss` set a share of the materials lost.**
- Do spells learned by gift count toward line mastery? **Yes by default; `lines.giftsCountForMastery: false` turns it off.** A scroll still has to be learned; a memory teaches at once.
