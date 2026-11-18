// The player's own notebook, kept by the information broker: their journal,
// goals and what they know, and what the whole party knows. Nothing here says
// who else is involved; the DM's side is a different page.
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Markdown, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import './minerva.css';
import { HEATS, type Mine, type View } from './shared.ts';

type Tab = 'journal' | 'goals' | 'know' | 'party' | 'add';
const heatTone = (h?: string) => (h === 'on' ? 'gold' : h === 'ongoing' ? 'teal' : h === 'sleeping' ? 'red' : '');
const bodyOf = (v: View) => v.body.replace(/^#\s.*\n+/, '');

export default function Journal() {
  const { w } = useWorld();
  const [tab, setTab] = useState<Tab>('journal');
  const mine = useLoad<Mine | null>(() => w.call<Mine>('GET', '/minerva/me').catch(() => null), [w], ['settings']);
  // The broker is who keeps it for them: their own name and title.
  const broker = useLoad<{ persona?: { name?: string; title?: string } } | null>(() => w.call<any>('GET', '/broker').catch(() => null), [w]);
  const name = broker.data?.persona?.name || 'The Broker';
  const m = mine.data;
  return (
    <div className="page">
      <PageHead title="My journal" lead={`Your notes, goals and what you have worked out. Kept for you by ${name}.`} />
      <ErrorBox error={mine.error} />
      {mine.loading ? <Loading /> : !m ? <Empty>{name} has nothing of yours on file yet.</Empty> : (
        <>
          <div className="tabs mn-tabs"><Tabs<Tab> label="Sections" value={tab} onChange={setTab} items={[['journal', 'Journal'], ['goals', 'Goals'], ['know', 'What I know'], ['party', 'The party'], ['add', 'Write']]} /></div>
          {tab === 'journal' && (m.journal.length ? <div className="stack">{[...m.journal].reverse().map((j) => <article key={j.key} className="card"><h2 style={{ margin: 0 }}>{j.title}</h2><Markdown text={bodyOf(j)} /></article>)}</div> : <Empty>No journal entries yet. Ask {name} to write something down, or add a line under Write.</Empty>)}
          {tab === 'goals' && (m.goals.length ? <div className="card flush">{m.goals.map((g) => <div key={g.key} className="list-item" style={{ alignItems: 'flex-start' }}><span className={`chip mn-heat ${heatTone(g.heat)}`}>{g.heat ?? 'ongoing'}</span><span className="stack tight grow"><strong style={{ fontWeight: 500 }}>{g.title}</strong><Markdown text={bodyOf(g)} /></span></div>)}</div> : <Empty>No goals yet. What does your character want?</Empty>)}
          {tab === 'know' && (
            <div className="stack">
              {m.knowledge ? <article className="card"><Markdown text={bodyOf(m.knowledge)} /></article> : <Empty>Nothing yet.</Empty>}
              {m.bonds && /\n\s*[-*]\s/.test(m.bonds.body) && <article className="card"><h2 style={{ margin: 0 }}>Who and what you care about</h2><Markdown text={bodyOf(m.bonds)} /></article>}
            </div>
          )}
          {tab === 'party' && (
            <div className="stack">
              {m.others.map((o) => <article key={o.key} className="card"><h2 style={{ margin: 0 }}>{o.title} lets you know</h2><Markdown text={bodyOf(o)} /></article>)}
              {m.party.map((p) => <article key={p.key} className="card"><h2 style={{ margin: 0 }}>{p.title}</h2><Markdown text={bodyOf(p)} /></article>)}
              {!m.others.length && !m.party.length && <Empty>Nothing the whole table knows has been written down yet.</Empty>}
            </div>
          )}
          {tab === 'add' && <Write session={m.session} name={name} done={() => void mine.reload()} />}
        </>
      )}
    </div>
  );
}

function Write({ session, name, done }: { session: number; name: string; done: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [line, setLine] = useState('');
  const [goal, setGoal] = useState('');
  const [heat, setHeat] = useState<string>('ongoing');
  const [goalText, setGoalText] = useState('');
  const [share, setShare] = useState('');
  const send = (path: string, body: unknown, reset: () => void) => act.run(async () => {
    const r = await w.call<{ note: string }>('POST', path, body);
    toast(r.note);
    reset(); done();
  });
  return (
    <div className="mn-write">
      {toastNode}
      <ErrorBox error={act.error} />
      <form className="card" onSubmit={(e) => { e.preventDefault(); if (line.trim()) void send('/minerva/me/journal', { text: line }, () => setLine('')); }}>
        <h2 style={{ margin: 0 }}>Write in your journal</h2>
        <Field label={`Session ${session}`} help="The DM looks it over before it goes in."><textarea rows={3} value={line} onChange={(e) => setLine(e.target.value)} placeholder="What do you want to remember?" /></Field>
        <button type="submit" className="btn primary" disabled={act.busy || !line.trim()}>Add to my journal</button>
      </form>
      <form className="card" onSubmit={(e) => { e.preventDefault(); if (goal.trim()) void send('/minerva/me/goals', { goal, heat, text: goalText }, () => { setGoal(''); setGoalText(''); }); }}>
        <h2 style={{ margin: 0 }}>A goal</h2>
        <Field label="What your character is after"><input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Find my brother" /></Field>
        <Field label="How hot is it"><select value={heat} onChange={(e) => setHeat(e.target.value)}>{HEATS.map((h) => <option key={h} value={h}>{h}</option>)}</select></Field>
        <Field label="A note (optional)"><input value={goalText} onChange={(e) => setGoalText(e.target.value)} /></Field>
        <button type="submit" className="btn primary" disabled={act.busy || !goal.trim()}>Save the goal</button>
      </form>
      <form className="card" onSubmit={(e) => { e.preventDefault(); if (share.trim()) void send('/minerva/me/share', { text: share }, () => setShare('')); }}>
        <h2 style={{ margin: 0 }}>Share with the party</h2>
        <Field label="A line the other players can read" help={`Only this. Everything else here stays yours and ${name}'s.`}><input value={share} onChange={(e) => setShare(e.target.value)} placeholder="My character once served in the harbour guard" /></Field>
        <button type="submit" className="btn primary" disabled={act.busy || !share.trim()}>Share it</button>
      </form>
    </div>
  );
}
