// A 25-session campaign under the MANA rules, over the API on the demo world, to check that what players see
// matches the rules: pools, highest spell level, cast costs, study points, days and gold, requirements, names.
//
// - Jessamine: a human wizard who levels from 1 to 12 over 25 sessions (about 1.3 years in game, ~19 days of
//   downtime between sessions). She starts with the 2024 wizard's spellbook (3 cantrips, 6 first-level spells)
//   and learns everything else by studying in downtime: the best spell her tree offers, with a text, or a
//   mentor once she can afford one.
// - Tomas: a paladin (half caster), levels 1 to 12. Anselm: a wizard 6 / paladin 4 multiclass.
//
// Every number the API gives is checked against the rules engine (librarian/src/features/spells/rules.ts).
// With MANA_REAL=1 the player's assistant is also asked about it at sessions 1, 5, 10, 15, 20 and 25 on a real
// model (OpenRouter, default tencent/hy4-flash), and its answers are graded against the API. It stops asking
// once the spend reaches MANA_REAL_CAP dollars (default 0.45). Run from web/ after a build:
//   node e2e/mana-campaign.mjs                                   # the rules only, no model
//   NODE_USE_ENV_PROXY=1 MANA_REAL=1 node e2e/mana-campaign.mjs  # and the assistant
// A report is written to MANA_REPORT (default: a temp folder) as JSON and Markdown.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root, startScript, tmpDir } from './lib.mjs';

const R = await import(path.join(root, 'librarian/src/features/spells/rules.ts'));
const SRD = JSON.parse(fs.readFileSync(path.join(root, 'librarian/src/features/spells/data/srd-5.2.1-spells.json'), 'utf8')).spells ?? [];
const REAL = process.env.MANA_REAL === '1';
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const MODEL = process.env.MANA_MODEL || 'tencent/hy4-flash';
const CAP = Number(process.env.MANA_REAL_CAP || 0.45);
const PORT = Number(process.env.MANA_PORT || 8231);
const base = `http://127.0.0.1:${PORT}`;
const out = process.env.MANA_REPORT || tmpDir('mana-report');
fs.mkdirSync(out, { recursive: true });
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };

// A seeded die, so a run is repeatable.
let seed = 20261126;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const d20 = () => 1 + Math.floor(rnd() * 20);

const problems = [];
const notes = [];
const fail = (what) => { problems.push(what); console.log('  ✗ ' + what); };
const check = (cond, what) => { if (!cond) fail(what); return !!cond; };
const data = path.join(tmpDir('mana-campaign'), 'data');
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', data, '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const db = new DatabaseSync(path.join(data, 'librarian.db'), { readOnly: true });
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
const ok = async (m, p, tok, b) => { const r = await j(m, p, tok, b); if (r.s >= 300) throw new Error(`${m} ${p} -> ${r.s} ${JSON.stringify(r.x).slice(0, 300)}`); return r.x; };

const rules = R.resolveRules({});
const COSTS = R.PLAN_COSTS;
const mod = (s) => Math.floor((s - 10) / 2);
const prof = (lv) => 2 + Math.floor((lv - 1) / 4);
const srdById = new Map(SRD.map((s) => [s.id, s]));
const sessions = [];
const asked = [];
let spend0 = null;
let spent = 0;

try {
  const admin = (await ok('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).token;
  if (REAL) {
    spend0 = await usage();
    const prov = await ok('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' });
    const pid = prov.provider?.id ?? prov.id;
    const job = { providerId: pid, model: MODEL, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } };
    await ok('PUT', '/api/admin/models', admin, { jobs: { chat: job, dm: job, player: job } });
  }
  const dm = (await ok('POST', '/api/auth/login', null, { username: 'dm', password: 'dungeon master 123' })).token;
  const tok = {};
  for (const u of ['jess', 'tom', 'ana']) tok[u] = (await ok('POST', '/api/auth/login', null, { username: u, password: 'player pass 123' })).token;
  const WID = (await ok('GET', '/api/worlds', dm))[0].id;
  const P = `/api/worlds/${WID}`;
  const SP = `${P}/spells`;
  const members = await ok('GET', `${P}/members`, dm);
  const acc = (u) => members.find((m) => String(m.character_name ?? '').toLowerCase().startsWith(u))?.id;
  const id = { jess: acc('jess'), tom: acc('tom'), ana: acc('ans') };
  await ok('PATCH', `${P}/settings`, dm, { spellMana: true, spellRulesOn: true, spellCraftApproval: 'auto' });

  // ---- the rules every character is checked against, each level ----
  const setChar = async (who, level, ability, score, casterLevels, cls) => {
    await ok('PUT', `${SP}/characters/${id[who]}`, dm, { level, class: cls, castingAbility: ability, abilities: { [ability]: score } });
    await ok('PUT', `${SP}/characters/${id[who]}/caster`, dm, { casterLevels });
  };
  const checkChar = async (who, label, casterLevels) => {
    const me = await ok('GET', `${SP}/characters/me`, tok[who]);
    const pool = R.multiclassPool(casterLevels, rules);
    const hi = R.multiclassHighest(casterLevels);
    check(me.mana?.max === pool, `${label}: pool ${me.mana?.max}, the rules say ${pool}`);
    check(me.mana?.maxCastLevel === hi, `${label}: highest spell level ${me.mana?.maxCastLevel}, the rules say ${hi}`);
    // Every known leveled spell, at its own level and at the highest: the quote is the cost table plus the surcharge.
    for (const k of me.known.filter((k) => k.level > 0 && k.level <= hi)) {
      for (const at of [...new Set([k.level, hi])]) {
        const q = await j('POST', `${SP}/cast/quote`, tok[who], { spellId: k.id, level: at });
        const want = R.upcastCost(k.level, at, COSTS, rules, null);
        if (q.s !== 200) fail(`${label}: no quote for ${k.name} at ${at} (${q.s} ${q.x.error ?? ''})`);
        else check(q.x.cost === want, `${label}: ${k.name} at level ${at} costs ${q.x.cost}, the rules say ${want}`);
      }
    }
    return { me, pool, hi };
  };

  // Names: the tree, the Codex list and the SRD file agree.
  {
    const tree = await ok('GET', `${SP}/tree?compact=1&limit=100&status=dark,locked,learn`, tok.jess);
    for (const s of tree.spells) { const src = srdById.get(s.id); if (src) check(src.name === s.name && src.level === s.level, `name or level differs for ${s.id}: tree "${s.name}" ${s.level}, SRD "${src.name}" ${src.level}`); }
  }

  // ---- Jessamine, a human wizard, 25 sessions ----
  // Levels per session (1-based): 12 by session 24. About 475 days in all: ~19 days of downtime after each session.
  const LEVEL = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12];
  const DOWNTIME = 19;
  const INT = (lv) => Math.min(20, 16 + (lv >= 4 ? 2 : 0) + (lv >= 8 ? 2 : 0)); // 16, an ASI at 4 and 8
  const WIZ = SRD.filter((s) => (s.classes ?? []).includes('Wizard'));
  const start = { cantrips: ['Fire Bolt', 'Mage Hand', 'Light'], first: ['Magic Missile', 'Shield', 'Detect Magic', 'Mage Armor', 'Sleep', 'Burning Hands'] };
  for (const n of [...start.cantrips, ...start.first]) await ok('POST', `${SP}/characters/${id.jess}/known`, dm, { spellId: n });
  let gold = 75; // a 2024 wizard's starting gold, near enough
  let spentGold = 0;
  let study = null;
  const learned = [];
  const insight = [];

  for (let n = 1; n <= 25; n++) {
    const lv = LEVEL[n - 1];
    const cl = { full: lv };
    await setChar('jess', lv, 'int', INT(lv), cl, 'Wizard');
    gold += 40 * lv; // treasure from the session
    const { me, pool, hi } = await checkChar('jess', `S${n} wizard ${lv}`, cl);
    const known = new Set(me.known.map((k) => k.id));

    // The tree: what she may start now. Each "learn" spell's plan must agree, and must match the rules.
    const tree = await ok('GET', `${SP}/tree?compact=1&status=learn&limit=100`, tok.jess);
    const open = tree.spells;
    for (const s of open.slice(0, 6)) {
      const plan = await ok('POST', `${SP}/study/plan`, tok.jess, { spellId: s.id, source: 'text' });
      check(plan.canStart, `S${n}: ${s.name} shows "can learn" but its plan says: ${plan.missing.join('; ')}`);
      const cx = R.complexity(s.level, COSTS, null);
      const need = R.studyPoints(cx, { hybrid: s.lines.length >= 2 }, rules);
      check(plan.needed === need, `S${n}: ${s.name} needs ${plan.needed} points, the rules say ${need}`);
      for (const src of ['alone', 'text', 'mentor']) {
        const days = R.studyDays(need, 0, R.dailyProgress(src, false, rules));
        const g = R.studyCoin(cx, src, rules);
        check(plan.days[src] === days, `S${n}: ${s.name} ${src} takes ${plan.days[src]} days, the rules say ${days}`);
        check(plan.gold[src] === g.materials + g.mentorFee, `S${n}: ${s.name} ${src} costs ${plan.gold[src]} gp, the rules say ${g.materials + g.mentorFee}`);
      }
      check(plan.finalDC === R.finalCheckDC(s.level, rules), `S${n}: ${s.name} final DC ${plan.finalDC}`);
      check(plan.checkBonus === mod(INT(lv)) + prof(lv), `S${n}: check bonus ${plan.checkBonus}, should be ${mod(INT(lv)) + prof(lv)}`);
    }
    // A spell one level above her highest is never open; the level gate says why.
    if (hi < 9) {
      const over = WIZ.find((s) => s.level === hi + 1 && !known.has(s.id));
      if (over) {
        const p = await ok('POST', `${SP}/study/plan`, tok.jess, { spellId: over.id, source: 'text' });
        check(!p.canStart && p.missing.some((m) => /cast level/.test(m)), `S${n}: ${over.name} (level ${over.level}) should wait for level ${hi + 1} casting: ${p.missing.join('; ')}`);
      }
    }

    // Downtime: study the best open wizard spell she can afford; mentor when gold allows.
    let days = DOWNTIME;
    let log = [];
    while (days > 0) {
      if (!study) {
        const pick = open.filter((s) => srdById.get(s.id)?.classes?.includes('Wizard') && !known.has(s.id) && !learned.includes(s.name)).sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
        let chosen = null;
        for (const s of pick) {
          const pm = await ok('POST', `${SP}/study/plan`, tok.jess, { spellId: s.id, source: 'mentor' });
          const pt = await ok('POST', `${SP}/study/plan`, tok.jess, { spellId: s.id, source: 'text' });
          const src = gold >= pm.gold.mentor * 2 ? 'mentor' : gold >= pt.gold.text ? 'text' : gold >= pt.gold.alone ? 'alone' : null;
          if (src) { chosen = { s, src, plan: src === 'mentor' ? pm : pt }; break; }
        }
        if (!chosen) { log.push(`nothing she can afford (gold ${gold})`); break; }
        const arcana = chosen.plan.arcanaDC !== null ? d20() + mod(INT(lv)) + prof(lv) : undefined;
        const st = await j('POST', `${SP}/study`, tok.jess, { spellId: chosen.s.id, source: chosen.src, ...(arcana === undefined ? {} : { arcana }) });
        if (st.s >= 300) { log.push(`could not start ${chosen.s.name}: ${st.x.error}`); if (/Arcana/.test(st.x.error ?? '')) break; open.splice(open.indexOf(chosen.s), 1); continue; }
        const cost = chosen.plan.gold[chosen.src];
        gold -= cost; spentGold += cost;
        study = st.x;
        log.push(`started ${chosen.s.name} (L${chosen.s.level}, ${chosen.src}, ${study.needed} pts, ${cost} gp${arcana !== undefined ? `, Arcana ${arcana} vs ${chosen.plan.arcanaDC}` : ''})`);
      }
      if (study.status === 'studying') {
        const use = Math.min(days, study.daysLeft);
        study = await ok('POST', `${SP}/study/${study.id}/days`, tok.jess, { days: use });
        days -= use;
      }
      if (study.status === 'ready') {
        const roll = d20();
        const c = await j('POST', `${SP}/study/${study.id}/check`, tok.jess, { d20: roll });
        if (c.s >= 300) { log.push(`check: ${c.x.error}`); break; }
        check(c.x.total === roll + mod(INT(lv)) + prof(lv), `S${n}: check total ${c.x.total} for d20 ${roll}`);
        if (c.x.learned) { learned.push(study.name); log.push(`learned ${study.name} (d20 ${roll}, ${c.x.outcome})`); study = null; known.add(c.x.study.spellId); }
        else { log.push(`check failed on ${study.name} (d20 ${roll}, ${c.x.total} vs ${c.x.dc}); waits for a long rest`); study = c.x.study; break; }
      }
    }
    await ok('POST', `${P}/clock/advance`, dm, { preset: 'long-rest' });
    if (study && study.waitLongRest) study = (await ok('GET', `${SP}/study`, tok.jess)).studies.find((x) => x.id === study.id) ?? null;
    const byLevel = {};
    for (const k of (await ok('GET', `${SP}/characters/me`, tok.jess)).known) byLevel[k.level] = (byLevel[k.level] ?? 0) + 1;
    sessions.push({ n, level: lv, pool, highest: hi, open: open.length, gold, known: byLevel, downtime: log });
    console.log(`S${n} L${lv} pool ${pool} hi ${hi} open ${open.length} gold ${gold}: ${log.join('; ')}`);
    // 2024 wizards add two spells to the spellbook each level; compare.
    if (n > 1 && LEVEL[n - 1] > LEVEL[n - 2]) insight.push(lv);

    // ---- the assistant, at a few sessions ----
    if (REAL && [1, 5, 10, 15, 20, 25].includes(n)) {
      const now = await usage();
      spent = now !== null && spend0 !== null ? now - spend0 : 0;
      if (spent >= CAP) { notes.push(`stopped asking at session ${n}: spend $${spent.toFixed(3)}`); }
      else await askAll(n, lv, pool, hi, P, SP, tok.jess, 'jess');
    }
  }
  notes.push(`Jessamine learned ${learned.length} spells by study over 25 sessions and spent ${spentGold} gp on it; a 2024 wizard adds ${2 * 11} to the spellbook by levelling 1 to 12, plus copied ones.`);

  // ---- Tomas, a paladin (half caster) 1 to 12 ----
  for (let lv = 1; lv <= 12; lv++) {
    await setChar('tom', lv, 'cha', lv >= 4 ? 18 : 16, { half: lv }, 'Paladin');
    const r = await checkChar('tom', `paladin ${lv}`, { half: lv });
    if (lv === 1) for (const nm of ['Bless', 'Cure Wounds', 'Shield of Faith']) await ok('POST', `${SP}/characters/${id.tom}/known`, dm, { spellId: nm });
    if (lv === 5) {
      const t = await ok('GET', `${SP}/tree?compact=1&status=learn&limit=100`, tok.tom);
      check(t.spells.every((s) => s.level <= r.hi), `paladin 5: the tree offers spells above level ${r.hi}`);
      check(t.spells.some((s) => s.level === 2), 'paladin 5: no 2nd-level spell to learn');
    }
    if (REAL && (lv === 5 || lv === 12)) { const now = await usage(); spent = now !== null && spend0 !== null ? now - spend0 : 0; if (spent < CAP) await askAll(`paladin ${lv}`, lv, r.pool, r.hi, P, SP, tok.tom, 'tom', true); }
  }

  // ---- Anselm, a wizard 6 / paladin 4 ----
  {
    const cl = { full: 6, half: 4 };
    await setChar('ana', 10, 'int', 18, cl, 'Wizard 6 / Paladin 4');
    for (const nm of ['Fire Bolt', 'Magic Missile', 'Misty Step', 'Fireball', 'Bless']) await ok('POST', `${SP}/characters/${id.ana}/known`, dm, { spellId: nm });
    const r = await checkChar('ana', 'wizard 6 / paladin 4', cl);
    check(r.hi === 4, `wizard 6 / paladin 4 should cast up to 4th (caster level 8): got ${r.hi}`);
    if (REAL) { const now = await usage(); spent = now !== null && spend0 !== null ? now - spend0 : 0; if (spent < CAP) await askAll('multiclass', 10, r.pool, r.hi, P, SP, tok.ana, 'ana', true); }
  }
} catch (e) { fail('run failed: ' + (e.stack ?? e.message)); } finally { srv.kill(); }

// Ask the player's assistant and grade each answer against the API.
async function askAll(n, lv, pool, hi, P, SP, t, who, short = false) {
  const ask = async (text) => {
    const chat = (await j('POST', `${P}/agent/chats`, t, {})).x;
    const since = new Date().toISOString();
    await j('POST', `${P}/agent/chats/${chat.id}/messages`, t, { text });
    let c;
    for (let i = 0; i < 900; i++) { c = (await j('GET', `${P}/agent/chats/${chat.id}`, t)).x; if (!c.busy) break; await new Promise((r) => setTimeout(r, 200)); }
    const used = db.prepare(`SELECT detail FROM audit WHERE action IN ('agent.read', 'agent.propose', 'agent.action') AND at >= ? ORDER BY rowid`).all(since).map((r) => String(r.detail).split(' ')[0]);
    return { reply: c?.messages?.filter((m) => m.role === 'assistant').at(-1)?.text ?? '', used: [...new Set([...used, ...(c?.actions ?? []).map((a) => a.tool)])] };
  };
  // A number as digits, or as a word ("Six mana"): the model may write either.
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  const has = (txt, num) => new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(txt) || (WORDS[num] !== undefined && new RegExp(`\\b${WORDS[num]}\\b`, 'i').test(txt));
  const grade = (q, r, good, why) => { asked.push({ session: n, who, q, reply: r.reply, tools: r.used, ok: good, why }); console.log(`  [${n} ${who}] ${good ? 'ok ' : 'BAD'} ${q}\n      tools: ${r.used.join(', ') || 'none'}\n      ${r.reply.replace(/\s+/g, ' ').slice(0, 260)}`); if (!good) fail(`assistant (${n}, ${who}): "${q}": ${why}`); };

  let r = await ask("What's my mana pool, and what's the highest level of spell I can cast?");
  grade('pool and highest level', r, has(r.reply, pool) && (hi === 0 || has(r.reply, hi)), `wanted pool ${pool} and level ${hi}`);
  const tree = (await j('GET', `${SP}/tree?compact=1&status=learn&limit=100`, t)).x;
  const open = tree.spells ?? [];
  r = await ask('What spells can I start learning right now?');
  const named = open.filter((s) => r.reply.includes(s.name));
  const notOpen = (await j('GET', `${SP}/tree?compact=1&status=locked,dark&limit=100`, t)).x.spells?.filter((s) => r.reply.includes(s.name)).map((s) => s.name) ?? [];
  grade('what can I learn', r, open.length === 0 ? /no|none|nothing/i.test(r.reply) : named.length > 0 && notOpen.length === 0, `named ${named.length} of ${open.length} open spells${notOpen.length ? `; also named ones that are not open: ${notOpen.slice(0, 5).join(', ')}` : ''}`);
  if (short) return;
  const target = [...open].sort((a, b) => b.level - a.level)[0];
  if (target) {
    const plan = (await j('POST', `${SP}/study/plan`, t, { spellId: target.id, source: 'text' })).x;
    r = await ask(`How long would it take me to learn ${target.name} with a text, and how much gold does it cost?`);
    grade(`study plan for ${target.name}`, r, has(r.reply, plan.days.text) && has(r.reply, plan.gold.text), `wanted ${plan.days.text} days and ${plan.gold.text} gp`);
    r = await ask(`What do I still need before I can learn a level ${Math.min(9, hi + 1)} spell?`);
    grade('the level gate', r, /level|cast/i.test(r.reply), 'should say she must reach the next spell level (or the gate)');
  }
  const me = (await j('GET', `${SP}/characters/me`, t)).x;
  const k = me.known?.filter((x) => x.level > 0).sort((a, b) => b.level - a.level)[0];
  if (k) {
    const q = (await j('POST', `${SP}/cast/quote`, t, { spellId: k.id, level: hi })).x;
    r = await ask(`How much mana does ${k.name} cost if I cast it at level ${hi}?`);
    grade(`cast cost of ${k.name} at ${hi}`, r, has(r.reply, q.cost), `wanted ${q.cost} mana`);
  }
}

const spend1 = REAL ? await usage() : null;
const spendText = REAL ? (spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown') : 'no model';
const report = { model: REAL ? MODEL : null, spend: spendText, problems, notes, sessions, asked };
fs.writeFileSync(path.join(out, 'mana-campaign.json'), JSON.stringify(report, null, 2));
const md = [
  `# MANA campaign run`, '', `Model: ${REAL ? MODEL : 'none (rules only)'} · spend ${spendText} · ${problems.length} problem(s)`, '',
  '## Sessions (Jessamine, human wizard)', '', '| # | Level | Pool | Casts up to | Open to learn | Gold after | Known by level | Downtime |', '|---|---|---|---|---|---|---|---|',
  ...sessions.map((s) => `| ${s.n} | ${s.level} | ${s.pool} | ${s.highest} | ${s.open} | ${s.gold} | ${Object.entries(s.known).map(([l, c]) => `${l}:${c}`).join(' ')} | ${s.downtime.join('; ')} |`),
  '', '## Assistant answers', '', ...asked.map((a) => `- **${a.session} ${a.who}: ${a.q}** ${a.ok ? 'ok' : 'WRONG'} (tools: ${a.tools.join(', ') || 'none'})${a.ok ? '' : ` — ${a.why}`}\n  > ${a.reply.replace(/\s+/g, ' ').slice(0, 400)}`),
  '', '## Problems', '', ...(problems.length ? problems.map((p) => `- ${p}`) : ['None.']), '', '## Notes', '', ...notes.map((x) => `- ${x}`),
].join('\n');
fs.writeFileSync(path.join(out, 'mana-campaign.md'), md);
console.log(`\nreport: ${path.join(out, 'mana-campaign.md')}\nspend: ${spendText}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('mana-campaign ok');
