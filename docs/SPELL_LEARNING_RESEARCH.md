# Learning Spells: Research and a Time/Cost Rule for the Mana-Tree Homebrew

Prepared for a D&D 2024 homebrew with a mana-point system. In that system you learn a new spell by combining 1–5 spells you already know, plus an optional item, stat minimum, level minimum and mana minimum.

**How sure each number is.** A **[V]** tag means I checked the number against a primary source fetched for this report: SRD 5.2 (D&D 2024), Archives of Nethys for Pathfinder 2e, and the legacy Pathfinder 1e PRD. An **[M]** tag means the number comes from my knowledge of the rulebook, or from secondary search results, and someone should check it against the book before relying on it. Many wikis (UESP, Fandom, d20srd, D&D Beyond) blocked automated fetches, so most video-game numbers are [M].

---

## Part 1: Tabletop RPGs

### D&D 5e (2014) and D&D 2024
- **Copying into a spellbook.** In 2024 each spell level takes 2 hours and costs 50 GP [V, SRD 5.2]. 2014 uses the same numbers [M]. Recopying a spell you already know into a backup book costs 1 hour and 10 GP per level [V]. A wizard also learns 2 spells free at each level-up.
- **Copying from a scroll (2024).** The copier makes an Intelligence (Arcana) check against DC 10 + spell level. The scroll is destroyed whether the check succeeds or fails [V].
- **Scribing scrolls (2024)** [V], working 8-hour days that need not be consecutive:

  | Level | Cantrip | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | Time | 1 day | 1 day | 3 days | 5 days | 10 days | 25 days | 40 days | 50 days | 60 days | 120 days |
  | Cost | 15 GP | 25 GP | 100 GP | 150 GP | 1,000 GP | 1,500 GP | 10,000 GP | 12,500 GP | 15,000 GP | 50,000 GP |

- **Xanathar's (2014)** [M]:
  - Scribing scrolls is much steeper. A 3rd-level scroll takes 1 workweek and 500 gp. A 9th-level scroll takes 48 workweeks and 250,000 gp.
  - The downtime "Training" activity teaches a language or tool. It takes 10 workweeks, reduced by your Intelligence modifier, and costs 25 gp per workweek.
  - "Research" costs 50 gp per week.
- **DMG 2014.** The DMG gives guidance on creating a spell but no time or cost rule for it.
- **DMG 2014 spell-points variant** [M]:
  - Points per slot level 1–9: 2/3/5/6/7/9/10/11/13.
  - Slots of 6th level and higher can be used only once per long rest.
  - Your mana table (2/3/5/6/7/9/**11/13/15**) matches this through 6th level and is steeper from 7th up.

**Good for a table:** the costs are trivial to run and tied to gold. **Bad:** costs scale linearly, so a 9th-level spell copies in 18 hours. Copying is a transcription cost, not a learning cost. Scroll scribing, by contrast, uses steep time scaling (1 → 120 days), which is the better model for creating magic. Source: [SRD 5.2](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.pdf).

### Pathfinder 2e: Learn a Spell [V]
- **Requirements.** Spend 1 hour per spell rank with a teacher or a written source, pay for materials, and roll the tradition skill (Arcana, Religion, Occultism or Nature).

  | Rank | 1 or cantrip | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | Price | 2 gp | 6 gp | 16 gp | 36 gp | 70 gp | 140 gp | 300 gp | 650 gp | 1,500 gp | 7,000 gp |
  | Typical DC | 15 | 18 | 20 | 23 | 26 | 28 | 31 | 34 | 36 | 41 |

- **Results.**
  - Critical success: you learn the spell and spend only half the materials.
  - Success: you learn it and spend the materials.
  - Failure: you can't retry until you gain a level, but nothing is spent.
  - Critical failure: as failure, and you lose half the materials.

**Good:** costs rise roughly geometrically, the four degrees of success are elegant, and failure is cheap but blocks retries. **Bad:** the hours are trivial, so this is a gold and skill gate, not a time gate. Source: [AoN – Learn a Spell](https://2e.aonprd.com/Actions.aspx?ID=2366).

### Pathfinder 1e / D&D 3.5 [V for PF1]
- **Learning from a book or scroll.** Decipher the text, study for 1 hour, then roll Spellcraft against DC 15 + spell level. On a failure you can't retry that spell for a week.
- **Writing it into your book.** 1 hour per spell level (30 minutes for a cantrip). Cost is 10 gp × level²: 0th 5, 1st 10, 2nd 40, 3rd 90, 4th 160, 5th 250, 6th 360, 7th 490, 8th 640, 9th 810 gp.
- **Copying fee.** Another wizard usually charges half the writing cost to let you copy.
- **Independent research.** At GM discretion, but "at least 1 week and at least 1,000 gp per level" of the spell, plus Spellcraft and Knowledge checks.
- **D&D 3.5 [M].** Writing a spell takes 24 hours and costs 100 gp per page.

**Good:** a quadratic gold curve, and a clear split between copying a known spell (cheap) and inventing one (slow and expensive). Source: [PF1 PRD – Magic](https://legacy.aonprd.com/coreRulebook/magic.html).

### OSR (B/X, Old-School Essentials, AD&D) [M]
Researching a spell takes about 2 weeks and 1,000 gp per spell level, often with a minimum chance of failure (around 15%). A 9th-level spell takes 18 weeks. **Good:** research is a real campaign undertaking and a gold sink. **Bad:** it is very slow at the low end. Source: [OSE SRD](https://oldschoolessentials.necroticgnome.com/srd/).

### GURPS Magic (4e) [M]
- **Spells are skills.** Most are IQ/Hard, a few are Very Hard, and each needs at least 1 character point.
- **Prerequisite chains.** For example, Fireball needs Magery 1, Create Fire and Shape Fire, and Explosive Fireball needs Fireball. Advanced spells often need "10 other spells" or a higher Magery.
- **Study time.** One point takes about 200 hours with a teacher. Self-study counts at half (400 hours).
- **Combinations.** Learning a new spell requires knowing its parents. This is the closest tabletop analogue to your spell trees.

**Good:** the tree is the gate, and time is measured in study hours, so downtime matters. **Bad:** a lot of bookkeeping, and points-per-hour doesn't map onto D&D. Source: [Gaming Ballistic on GURPS study rates](https://gamingballistic.com/2015/01/12/10000-hours-and-gurps/); GURPS Basic Set p.292 and GURPS Magic.

### Ars Magica 5e [M/secondary]
- **Seasons.** Lab work happens in seasons of about 3 months. A magus usually gets 2–3 lab seasons a year.
- **Lab Total.** Intelligence + Technique + Form + Magic Theory + aura.
- **Learning from a lab text.** You can learn spells whose combined levels are no more than your Lab Total, all in one season.
- **Inventing a spell.**
  - Your Lab Total must exceed the spell's level.
  - Each season you bank (Lab Total − level) points, and you finish when the bank reaches the spell's level.
  - If you know a *similar spell*, add its magnitude (level ÷ 5) to the Lab Total. Only the single best similar spell counts.
- **Takeaway.** Banked partial progress, plus a bonus from a related spell you already know, is exactly the "combining known spells reduces time" lever you want. Note that Ars Magica deliberately does **not** stack bonuses from several similar spells.

**Bad:** a season is very coarse for D&D. Source: [Redcap – ArM5 Chapter 8: Laboratory](https://www.redcap.org/page/Ars_Magica_5E_Standard_Edition,_Chapter_Eight:_Laboratory).

### Shadowrun (4e/5e) [M/secondary]
- A spell costs 5 Karma (4e, stated; the 5e cost is assumed to be the same).
- You need a spell formula or a teacher.
- You roll a learning test. In 5e that is (Spellcasting or Alchemy) + Intuition, and time is roughly 12 days ÷ hits, studying 8 hours a day.
- A teacher's Instruction test adds dice.
- On a failure you lose no Karma, but you lose the teacher's fee and the time.

**Good:** the formula or teacher is an in-world gate, better rolls shorten the time, and failure is cheap. Source: [rpg.net wiki – Learning New Spells](https://wiki.rpg.net/index.php/Learning_New_Spells), [SR4 notes](https://amurgsval.org/shadowrun/learning.html).

### Warhammer FRP 4e [M]
- Spells cost XP: about 50 XP for a Petty spell and 100 XP for an Arcane or Lore spell.
- The price multiplies as you know more spells relative to your Willpower Bonus (Petty) or Intelligence Bonus (Lore).
- You need the matching talent (Petty Magic, Arcane Magic (Lore)) and a teacher or grimoire.

**Good:** costs rise with the number of spells you know, which self-limits sprawl and rewards high Int. Source: [Cubicle 7 WFRP FAQ](https://cubicle7games.com/wfrp-faq/), [WindsofChaos discussion](https://windsofchaos.com/forum/viewtopic.php?p=1608).

### The Witcher TRPG [M]
- Spells come in Novice, Journeyman and Master tiers.
- You learn them from a mentor or text through learning rolls against a DC.
- Mentoring generates 1–5 IP a day toward the taught skill, and the mentor must be better at it than you.
- I could not confirm exact IP costs per spell tier.

**Good:** a tiered DC with a mentor requirement, which is very close to your existing rules. Source: [R. Talsorian – Sage's Answers pt 5](https://rtalsoriangames.com/2018/08/20/the-sages-answers-part-5/).

### Mage: The Ascension / Awakening [M]
- Mage has no spell list. You raise Spheres or Arcana with XP: in M20 about new rating × 7–8, and 10 XP for a first dot.
- Awakening 1e sells "rotes" (fixed spells) for about 2 XP per dot.

**Good:** "knowing the components lets you improvise," which mirrors your trees. **Bad:** no time cost. Source: Mage 20th Anniversary core.

### Dungeon Crawl Classics [M]
- A wizard learns a fixed number of spells per level, which must be *found* through tomes, patrons or teachers.
- Each learned spell rolls on the Mercurial Magic table, so every caster's version is unique.
- Casting is a spell check (d20 + level + Int) with failure tables. Spellburn lets you trade stat points for bonuses.

**Good:** discovery is the gate, and each spell gets a personal quirk. Source: DCC RPG core, ch. 5.

### Savage Worlds (SWADE) [M]
- The New Powers edge grants 2 powers per advance.
- Powers are gated by Rank (Novice through Legendary).
- No time or gold cost.

**Good:** fast and simple. **Bad:** no downtime game at all. Source: SWADE core, Arcane Backgrounds.

### 13th Age [M]
Spells are chosen at level-up by spell-level band and swapped freely. There is no learning time or cost. Its takeaway is "don't tax what you already gate by level." Source: [13th Age SRD](https://www.13thagesrd.com/).

### Third-party and homebrew 5e
Spell research for 5e is usually adapted from 3.5 (a week and 1,000 gp per level) or from the Xanathar's downtime framework (workweeks, a gold cost per week, and complications). Community "spell fusion" systems usually combine two known spells into a hybrid, requiring the parents to be within one level of each other and slot level = highest parent + 1. **Good:** familiar. **Bad:** often untested numbers. Source: XGE downtime, ch. 2.

---

## Part 2: Video games

- **Divinity: Original Sin 2 [M]**
  - Skills need points in a school (for example Pyrokinetic 1/2/3+) and a free memory slot.
  - You can craft skillbooks by combining two books from different schools; for example, any Pyrokinetic book plus any Huntsman book gives Deploy Mass Traps. A blank skillbook plus a scroll gives that scroll's skillbook.
  - Hybrid skills require points in both schools.
  - **Good:** this is literally "combine two known schools to unlock a hybrid." **Bad:** the recipes are hard to discover without a wiki.
  - [GameRant guide](https://gamerant.com/divinity-original-sin-2-crafting-guide/)
- **Arcanum [M]**
  - 16 colleges with 5 spells each, learned strictly in order.
  - Each spell costs 1 character point.
  - Higher spells need character level and Intelligence/Willpower minimums (roughly level 5/10/15/20 for tiers 2–5).
  - **Good:** a clear linear tree with stat and level minimums, like your stat and level minimums.
- **Morrowind spellmaking [M]**
  - Cost per effect = (min + max magnitude) × (duration + area) × (base cost ÷ 40), × 1.5 if the spell is on-target.
  - A multi-effect spell sums its effects.
  - The spellmaker's gold price scales with spell cost.
  - **Good:** a transparent "power → cost" formula, the same logic as tying learning cost to mana cost.
  - [UESP Spellmaking](https://en.uesp.net/wiki/Morrowind:Spellmaking)
- **Oblivion [M]**
  - Spellmaking requires access to the Arcane University, and you can only use effects you already know.
  - Spells are tiered by skill (Novice 0 through Master 100).
  - **Good:** "you can only build from known components," exactly your combining rule.
- **Skyrim [M]**
  - Spell tomes are bought or found; the price rises by tier, roughly tens of gold for Novice up to about 2,000 for Expert.
  - Learning is instant.
  - Master spells require skill 90 and a College quest.
  - **Good:** quest and skill gates for the top tier, like your 8th–9th "research/divine only" rule.
- **WoW Classic [M]**
  - New spell ranks are bought from trainers every 2 levels.
  - Prices run from copper at level 1 to several gold per rank near 60, about 200 gold in total for levels 1–60.
  - **Good:** a steady gold sink tied to level. **Bad:** pure tax, no choice.
  - [dtgre summary](https://www.dtgre.com/2026/11/wow-forever-spell-training-too-expensive-save-gold.html)
- **Final Fantasy IX [M]**
  - Equipment teaches abilities.
  - Earning AP while the item is equipped masters the ability permanently, from about 20 AP for basic spells to about 100 for top ones.
  - **Good:** "an item teaches the spell over time," which is a model for your optional item component.
- **FFX Sphere Grid and FFXII License Board [M]**
  - FFX: spells are nodes on a shared grid, and you need adjacency (prerequisites) plus Ability Spheres.
  - FFXII: you buy a license with LP *and* buy the spell from a shop with gil, so permission and purchase are two separate gates.
  - **Good:** splitting "eligible (tree)" from "acquired (cost)" is clean.
- **Magicka [M]**
  - 8 elements; you queue up to 5 to cast, and combinations make new effects (Water + Cold = Ice).
  - Named Magicks are learned from tomes.
  - **Good:** 5 components, the same cap as your recipes.
- **Path of Exile / Grim Dawn [M]**
  - Path of Exile: skill gems have level and stat requirements and level up with XP. Support gems link (combine) up to 6 sockets.
  - Grim Dawn: Devotion constellations need affinity points earned from earlier constellations, which is a prerequisite currency.
- **Pillars of Eternity [M]**
  - Wizards copy spells from found grimoires into their own for a fee that scales with spell level.
  - A grimoire holds a limited number of spells per level.
- **Baldur's Gate 3 [M]**
  - Learning a spell from a scroll costs 50 gold per spell level, a direct port of the 5e copying rule.
- **Elden Ring [M]**
  - Each sorcery or incantation has an Int or Faith minimum, and you buy it from a teacher. Stat minimums alone carry the progression.
- **Noita [M]**
  - Spells are found, not learned. Wands combine modifiers, triggers and projectiles freely.
  - It shows that combining can be open-ended, but in a tabletop game it needs strict recipes to stay balanced.

---

## Part 3: Diagnosis of the the earlier draft rules

| Rule | Problem |
|---|---|
| Study alone, 3 days per level (9th = 27 days) | Linear time against superlinear power. Your mana scale goes 2 → 15 (7.5×), but time goes 3 → 27 (9×) even for 1st-level spells, so the low end is slow and the high end is fast. 9th-level spells take less time than PF1 research (≥ 9 weeks), OSR research (18 weeks) or 2024 scroll scribing (120 days). |
| Mentor, 1 day per level + 10 coins × level | A 9th-level spell takes 9 days and 90 coins. That fee is trivial next to any D&D economy, where 5e copying alone is 450 GP and PF2 is 1,500 gp. |
| Lab research, 1 week flat | The incentives are inverted. Lab beats studying alone from 3rd level up and beats a mentor from 8th up. A flat time ignores spell level entirely. |
| memory relic, instant | Fine as a rare consumable shortcut. At 9th level the WIS save is DC 28, which is nearly impossible, so it is self-limiting, but it gives no partial benefit on a failure. |
| Scroll decode, 1 hour per level | Fine. This matches 5e and PF2 scales. |
| Insight roll at level-up (SDC 10–22) | Good. It works like 5e's free wizard spells. On a failure it should bank progress instead of wasting the attempt. |
| No failure or partial-progress rules for study | You need banked progress (Ars Magica, 2024 scrolls) and a graded failure (PF2). |
| Combining prerequisites don't affect time | Recipes with more components should be slightly cheaper (the Ars Magica similar-spell idea), but the discount needs a cap, since Ars Magica deliberately doesn't stack it. |

**Pacing assumptions:**
- Assumed: a typical 5e campaign gains a level every 2–4 sessions, with about 1–3 weeks of in-world downtime per level.
- 5e baseline: a 5e wizard gains 2 free spells per level and copies more for cheap.
- Target: about 1 spell per level from the level-up roll, plus about 1–2 from downtime with help.
  - Tiers 1–2: about 1 spell per downtime week studying alone.
  - Tier 3: one spell per arc.
  - 8th–9th: a month-plus project with gold and a lab.
- **Gold:** I assume 1 coin = 1 gp.

---

## Part 4: Proposals

### A. Recommended: "Complexity" study points, tied to mana cost

1. **Complexity (C)** is the spell's mana cost, counting a cantrip as 1. That gives C = 1 / 2 / 3 / 5 / 6 / 7 / 9 / 11 / 13 / 15 for cantrip through 9th. This reuses a number already on every spell sheet and is superlinear in power.
2. **Study Points (SP) needed = ⌈C² ÷ 2⌉.** That gives 1, 2, 5, 13, 18, 25, 41, 61, 85, 113.
3. **Recipe discount:** −10% SP for each component spell beyond your tier's minimum, up to −20%. The tier minimums are 2 for 1st–5th and 3 for 6th and up. This follows Ars Magica's similar-spell bonus with a cap.
4. **Daily progress** for an 8-hour workday. Days don't need to be consecutive, and SP stays banked indefinitely.
   - Studying alone, experimenting with your components: 1 SP per day.
   - Written source (spellbook, decoded scroll, ancient text): 2 SP per day.
   - Mentor who knows the spell: 3 SP per day.
   - Working in a lab: +1 SP per day, stacking with the above.
   - On the road: 2 hours at each long rest earns 1 SP per 4 long rests.
   - Tier gates still apply. 6th–7th needs a mentor or an ancient text. 8th–9th needs a lab and research, or divine grant.
5. **Materials = 10 × C² coins.** This is the PF1 curve applied to Complexity. A mentor charges the same again as a fee. A required recipe item covers half of the materials.
6. **Completion check:** d20 + INT + proficiency bonus against your existing SDC (10 / 13 / 15 / 18 / 22). A mentor grants advantage, and a lab gives +2.
   - Succeed by 5 or more: you learn the spell and get half the materials back.
   - Success: you learn the spell.
   - Fail by 1–4: study another 25% of the SP, then roll again. No materials are lost.
   - Fail by 5 or more, or roll a natural 1: lose half the materials and half the banked SP. For 8th–9th spells you also suffer Mana Exhaustion.
7. **Shortcuts:**
   - Level-up Insight roll: succeed and you learn one eligible spell free; fail and you bank half its SP.
   - memory relic: unchanged, except a failed save banks a quarter of the SP.
   - Consuming a decoded scroll of the spell during study completes a quarter of the SP.
8. **DM dial:** for a grander top tier, double the SP of 8th–9th spells ("Grand Research").

### B. Simple alternative: "level squared"
- **Days:** level² days alone (half a day for a cantrip). Divide by 2 with a text and by 3 with a mentor. A lab removes 25%.
- **Cost:** 25 × level² coins (10 for a cantrip). A mentor's fee equals the cost.
- **Check:** one roll against SDC at the end. On a failure, study 25% more time and roll again.
- **No recipe discount.** The tree is the only gate.

### Resulting time and cost, compared with the existing rules and reference systems

| Spell lvl | Existing: alone / mentor (fee) / lab | **A: SP** | **A: days alone / text / mentor / mentor+lab** | **A: materials** | **B: days alone / text / mentor** | **B: cost** | 5e 2024 copy | PF2 Learn | 2024 scroll scribe |
|---|---|---|---|---|---|---|---|---|---|
| Cantrip | ? / ? / 7d | 1 | 1 / 1 / 1 / 1 | 10 | ½ / ½ / ½ | 10 | — | 1h, 2gp | 1d, 15gp |
| 1 | 3d / 1d (10) / 7d | 2 | 2 / 1 / 1 / 1 | 40 | 1 / 1 / 1 | 25 | 2h, 50gp | 1h, 2gp | 1d, 25gp |
| 2 | 6d / 2d (20) / 7d | 5 | 5 / 3 / 2 / 2 | 90 | 4 / 2 / 2 | 100 | 4h, 100gp | 2h, 6gp | 3d, 100gp |
| 3 | 9d / 3d (30) / 7d | 13 | 13 / 7 / 5 / 4 | 250 | 9 / 5 / 3 | 225 | 6h, 150gp | 3h, 16gp | 5d, 150gp |
| 4 | 12d / 4d (40) / 7d | 18 | 18 / 9 / 6 / 5 | 360 | 16 / 8 / 6 | 400 | 8h, 200gp | 4h, 36gp | 10d, 1,000gp |
| 5 | 15d / 5d (50) / 7d | 25 | 25 / 13 / 9 / 7 | 490 | 25 / 13 / 9 | 625 | 10h, 250gp | 5h, 70gp | 25d, 1,500gp |
| 6 | 18d / 6d (60) / 7d | 41 | — / 21 / 14 / 11 | 810 | 36 / 18 / 12 | 900 | 12h, 300gp | 6h, 140gp | 40d, 10,000gp |
| 7 | 21d / 7d (70) / 7d | 61 | — / 31 / 21 / 16 | 1,210 | 49 / 25 / 17 | 1,225 | 14h, 350gp | 7h, 300gp | 50d, 12,500gp |
| 8 | 24d / 8d (80) / 7d | 85 | lab research: 43 (lab only) / 29 (lab + ancient text) | 1,690 | 64 / 32 / 22 | 1,600 | 16h, 400gp | 8h, 650gp | 60d, 15,000gp |
| 9 | 27d / 9d (90) / 7d | 113 | lab research: 57 (lab only) / 38 (lab + ancient text) | 2,250 | 81 / 41 / 27 | 2,025 | 18h, 450gp | 9h, 1,500gp | 120d, 50,000gp |

Notes on reading the table:
- All A days are before the recipe discount. With the full −20%, a 9th-level spell takes 46 days in a lab alone or 31 days in a lab with an ancient text.
- "—" means the tier rules forbid that method.

**Why A over B.**
- A ties time and cost to mana, which is already your power metric, so they rise with power. The low tiers get faster than now (1st–2nd: 1–5 days), and the top tier gets a real project (6–8 weeks plus about 2,250 coins).
- Banked progress handles interrupted downtime.
- Graded failure (from PF2) avoids wasted sessions.
- Combining spells matters, but its discount is capped.
- B is easier to remember and close in shape, but it ignores the mana curve and recipe richness.

**Compared with the existing rules.** Under both proposals:
- Spells of 1st–4th level get faster or stay about the same with help.
- Spells of 6th–9th get 2–4× slower and about 25× more expensive.
- The flat 1-week lab becomes a +1 SP per day bonus, which removes the inversion where the lab beat every other method.
