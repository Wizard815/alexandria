// One shared whiteboard per world. Pen, text and eraser. Every save is a
// version; if someone else saved first, your strokes are merged onto theirs.
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { ErrorBox, Loading, Modal, PageHead, useAction } from '../../ui/index.tsx';

type Shape = { id: string; t: 'path' | 'text'; color: string; w?: number; pts?: [number, number][]; x?: number; y?: number; text?: string; by?: string };
type Doc = { shapes: Shape[] };
const COLORS = ['#F3D99B', '#EDE3CF', '#86CFC4', '#F0A096', '#B9A7E8', '#A8D8B0'];
const W = 1600, H = 1000;
const uid = () => Math.random().toString(36).slice(2, 10);

export default function Whiteboard() {
  const { w, me, isDM, info, nameOf } = useWorld();
  const [doc, setDoc] = useState<Doc>({ shapes: [] });
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<Shape[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [tool, setTool] = useState<'pen' | 'text' | 'erase'>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [drawing, setDrawing] = useState<Shape | null>(null);
  const [history, setHistory] = useState(false);
  const [meta, setMeta] = useState<{ by: string | null; at: string | null }>({ by: null, at: null });
  const svg = useRef<SVGSVGElement>(null);
  const a = useAction();
  const dirty = pending.length > 0 || removed.length > 0;

  const load = useCallback(async () => {
    const r = (await w.whiteboard()) as any;
    setDoc(r.doc?.shapes ? r.doc : { shapes: [] });
    setVersion(r.version);
    setMeta({ by: r.updated_by, at: r.updated_at });
  }, [w]);
  useEffect(() => { void a.run(load); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const { on } = useWorld();
  useEffect(() => on(['whiteboard'], (e) => { if (e.data.by !== me && !dirty) void load(); }), [on, me, dirty, load]);

  const shapes = [...doc.shapes.filter((s) => !removed.includes(s.id)), ...pending];

  const save = () => void a.run(async () => {
    let baseShapes = doc.shapes;
    let baseVersion = version;
    for (let i = 0; i < 3; i++) {
      const merged = [...baseShapes.filter((s) => !removed.includes(s.id)), ...pending];
      try {
        const r = (await w.saveWhiteboard(baseVersion, { shapes: merged })) as any;
        setDoc({ shapes: merged });
        setVersion(r.version);
        setPending([]);
        setRemoved([]);
        setMeta({ by: me, at: r.updated_at });
        return;
      } catch (e: any) {
        if (e.status !== 409) throw e;
        // Someone saved first: take their board and put our changes on top.
        const fresh = (await w.whiteboard()) as any;
        baseShapes = fresh.doc?.shapes ?? [];
        baseVersion = fresh.version;
      }
    }
    throw new Error('The board keeps changing. Try saving again.');
  });

  const pt = (e: PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)];
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    const p = pt(e);
    if (tool === 'pen') { (e.target as Element).setPointerCapture?.(e.pointerId); setDrawing({ id: uid(), t: 'path', color, w: 4, pts: [p], by: me }); }
    else if (tool === 'text') { const text = prompt('Text'); if (text) setPending((x) => [...x, { id: uid(), t: 'text', color, x: p[0], y: p[1], text: text.slice(0, 300), by: me }]); }
  };
  const move = (e: PointerEvent<SVGSVGElement>) => { if (drawing) setDrawing({ ...drawing, pts: [...drawing.pts!, pt(e)] }); };
  const up = () => { if (drawing && drawing.pts!.length > 1) setPending((x) => [...x, drawing]); setDrawing(null); };
  const erase = (s: Shape) => {
    if (tool !== 'erase') return;
    if (pending.some((p) => p.id === s.id)) setPending((x) => x.filter((p) => p.id !== s.id));
    else setRemoved((x) => [...x, s.id]);
  };
  const canWipe = isDM || info.settings.whiteboardWipe === 'all';
  const wipe = () => { if (confirm('Wipe the whole board for everyone? The old board stays in History.')) void a.run(async () => { await w.call('POST', '/whiteboard/wipe', { confirm: true }); setPending([]); setRemoved([]); await load(); }); };

  return (
    <div className="page wide">
      <PageHead title="Whiteboard" lead={`One board for the whole table. It stays between sessions. ${meta.at ? `Last saved ${when(meta.at)}${meta.by ? ` by ${meta.by === me ? 'you' : nameOf(meta.by)}` : ''}.` : ''}`}>
        <button type="button" className="btn" onClick={() => setHistory(true)}>History</button>
        {canWipe && <button type="button" className="btn danger" onClick={wipe}>Wipe</button>}
        <button type="button" className="btn primary" disabled={!dirty || a.busy} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>
      </PageHead>
      <div className="row" role="toolbar" aria-label="Whiteboard tools">
        {(['pen', 'text', 'erase'] as const).map((t) => <button key={t} type="button" aria-pressed={tool === t} className={`btn small${tool === t ? ' on' : ''}`} onClick={() => setTool(t)}>{t === 'pen' ? '✎ Pen' : t === 'text' ? 'T Text' : '⌫ Erase'}</button>)}
        <span className="row" role="radiogroup" aria-label="Colour">{COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: color === c ? '3px solid var(--text)' : '1px solid var(--line)', cursor: 'pointer' }} />)}</span>
        {dirty && <span className="small muted">Unsaved changes</span>}
      </div>
      <ErrorBox error={a.error} />
      {a.busy && !version && !doc.shapes.length ? <Loading /> : (
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Shared whiteboard"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
          style={{ width: '100%', aspectRatio: `${W} / ${H}`, background: '#171C26', border: '1px solid var(--line-strong)', borderRadius: 10, touchAction: 'none', cursor: tool === 'erase' ? 'not-allowed' : 'crosshair' }}>
          {[...shapes, ...(drawing ? [drawing] : [])].map((s) => s.t === 'path'
            ? <polyline key={s.id} points={s.pts!.map((p) => p.join(',')).join(' ')} fill="none" stroke={s.color} strokeWidth={s.w ?? 4} strokeLinecap="round" strokeLinejoin="round" onPointerDown={(e) => { if (tool === 'erase') { e.stopPropagation(); erase(s); } }} style={{ cursor: tool === 'erase' ? 'pointer' : undefined }} />
            : <text key={s.id} x={s.x} y={s.y} fill={s.color} fontSize={32} fontFamily="Alegreya, serif" onPointerDown={(e) => { if (tool === 'erase') { e.stopPropagation(); erase(s); } }}>{s.text}</text>)}
        </svg>
      )}
      {history && <History onClose={() => setHistory(false)} onRestore={(d) => { setRemoved(doc.shapes.map((s) => s.id)); setPending(d.shapes.map((s) => ({ ...s, id: uid() }))); setHistory(false); }} />}
    </div>
  );
}

function History({ onClose, onRestore }: { onClose: () => void; onRestore: (d: Doc) => void }) {
  const { w, nameOf, me } = useWorld();
  const list = useLoad(() => w.call<any[]>('GET', '/whiteboard/history'), [w]);
  const restore = async (v: number) => { const r = await w.call('GET', `/whiteboard/history/${v}`); onRestore(r.doc); };
  return (
    <Modal title="Board history" onClose={onClose}>
      <p className="small muted">Pick a version to bring back. It loads as unsaved changes; press Save to keep it.</p>
      <div className="list" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
        {(list.data ?? []).map((h) => <button key={h.version} type="button" className="list-item" onClick={() => void restore(h.version)}><span className="grow">Version {h.version}</span><span className="small muted">{when(h.updated_at)} · {h.updated_by === me ? 'you' : nameOf(h.updated_by)}</span></button>)}
        {!list.data?.length && <p className="muted">No versions yet.</p>}
      </div>
    </Modal>
  );
}
