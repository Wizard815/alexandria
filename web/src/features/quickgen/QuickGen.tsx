// Quick generators: a popup the DM opens from a small floating button or
// Alt+G. Names, items and gold, rolled by the server from tables (no model).
// A bottom sheet on phones. The last choices are remembered on this device.
import { useCallback, useEffect, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { ErrorBox, Tabs, useAction } from '../../ui/index.tsx';
import './quickgen.css';

type Tab = 'names' | 'items' | 'gold';
interface Options { races: string[]; genders: string[]; rarities: string[]; types: string[]; modes: string[]; coins: string }
interface NameRow { name: string; race: string; gender: string }
interface ItemRow { name: string; rarity: string; type: string; priceGp: number | null; summary: string; termId: string | null; pageId: string | null; source: string }
interface CoinRow { pp: number; gp: number; ep: number; sp: number; cp: number; totalCp: number; text: string; mode: string; level: number; roll: string }
interface Sel { tab: Tab; race: string; gender: string; count: number; rarity: string; type: string; mode: string; level: number }

const KEY = 'alx.quickgen';
const DEFAULT: Sel = { tab: 'names', race: 'any', gender: 'any', count: 8, rarity: 'any', type: 'any', mode: 'individual', level: 5 };
function load(): Sel {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULT; }
}
function save(s: Sel) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window */ } }

const gp = (n: number | null) => (n === null ? 'priceless' : `${n.toLocaleString('en-US')} gp`);
const copy = (text: string) => { try { void navigator.clipboard?.writeText(text); } catch { /* not allowed */ } };

export default function QuickGenOverlay() {
  const { isDM } = useWorld();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isDM) return;
    const k = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'g' || e.key === 'G' || e.code === 'KeyG')) { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [isDM]);
  if (!isDM) return null;
  return (
    <>
      {!open && <button type="button" className="qg-fab" onClick={() => setOpen(true)} aria-label="Quick generators (Alt+G)" title="Quick generators (Alt+G)">🎲 <span>Quick gen</span></button>}
      {open && <Panel onClose={() => setOpen(false)} />}
    </>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const { w, members } = useWorld();
  const act = useAction();
  const [sel, setSel] = useState<Sel>(load);
  const [opts, setOpts] = useState<Options | null>(null);
  const [names, setNames] = useState<NameRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [coin, setCoin] = useState<CoinRow | null>(null);
  const [flavour, setFlavour] = useState<string | null>(null);
  const [who, setWho] = useState('party');
  const [note, setNote] = useState('');
  const set = (p: Partial<Sel>) => setSel((s) => { const n = { ...s, ...p }; save(n); return n; });

  useEffect(() => {
    void w.call('GET', '/quickgen/options').then((o: Options) => setOpts(o)).catch(() => {});
  }, [w]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const roll = useCallback(() => act.run(async () => {
    setFlavour(null); setNote('');
    if (sel.tab === 'names') setNames((await w.call('GET', `/quickgen/names?race=${enc(sel.race)}&gender=${enc(sel.gender)}&count=${sel.count}`)).names);
    else if (sel.tab === 'items') setItems((await w.call('GET', `/quickgen/items?rarity=${enc(sel.rarity)}&type=${enc(sel.type)}&count=${Math.min(sel.count, 20)}`)).items);
    else setCoin(await w.call('GET', `/quickgen/coins?mode=${enc(sel.mode)}&level=${sel.level}`));
  }), [w, sel.tab, sel.race, sel.gender, sel.count, sel.rarity, sel.type, sel.mode, sel.level]); // eslint-disable-line react-hooks/exhaustive-deps

  // Roll when the popup opens and when the tab changes.
  useEffect(() => { void roll(); }, [sel.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const players = members.filter((m) => m.role === 'player');
  const holder = who === 'party' ? 'the party' : (players.find((p) => p.id === who)?.character_name || players.find((p) => p.id === who)?.display_name || 'them');

  const giveItem = (it: ItemRow) => act.run(async () => {
    await w.call('POST', '/inventory', { owner: who, name: it.name, qty: 1, note: `${it.rarity} ${it.type}${it.priceGp ? ` · ${gp(it.priceGp)}` : ''}`, ...(it.pageId ? { pageId: it.pageId } : {}), reason: 'Quick gen' });
    setNote(`Gave ${it.name} to ${holder}.`);
  });
  const giveCoin = () => coin && act.run(async () => {
    await w.call('POST', '/live/ledger', { owner: who, amountCp: coin.totalCp, note: `Quick gen ${coin.mode}: ${coin.text}` });
    setNote(`Gave ${coin.text} to ${holder}.`);
  });
  const addFlavour = () => act.run(async () => {
    const text = sel.tab === 'names' ? names.slice(0, 3).map((n) => `${n.name} (${n.race})`).join(', ') : sel.tab === 'items' ? items.slice(0, 3).map((i) => i.name).join(', ') : coin?.text ?? '';
    const r = await w.call('POST', '/quickgen/flavour', { kind: sel.tab === 'items' ? 'item' : sel.tab === 'gold' ? 'coins' : 'name', text });
    setFlavour(r.flavour ?? null);
  });

  const allText = sel.tab === 'names' ? names.map((n) => n.name).join('\n') : sel.tab === 'items' ? items.map((i) => `${i.name} (${i.rarity} ${i.type}, ${gp(i.priceGp)})`).join('\n') : coin?.text ?? '';
  const whoPicker = (
    <label className="qg-field">Give to
      <select value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="party">The party</option>
        {players.map((p) => <option key={p.id} value={p.id}>{p.character_name || p.display_name}</option>)}
      </select>
    </label>
  );

  return (
    <div className="qg-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qg-sheet" role="dialog" aria-modal="true" aria-label="Quick generators">
        <div className="qg-head">
          <h2>🎲 Quick gen</h2>
          <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <Tabs<Tab> label="Generator" value={sel.tab} onChange={(tab) => set({ tab })} items={[['names', 'Names'], ['items', 'Items'], ['gold', 'Gold']]} />

        <div className="qg-controls">
          {sel.tab === 'names' && <>
            <Pick label="Race" value={sel.race} options={opts?.races ?? ['any']} onChange={(race) => set({ race })} />
            <Pick label="Gender" value={sel.gender} options={opts?.genders ?? ['any']} onChange={(gender) => set({ gender })} />
            <label className="qg-field">How many<input type="number" min={1} max={30} value={sel.count} onChange={(e) => set({ count: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} /></label>
          </>}
          {sel.tab === 'items' && <>
            <Pick label="Rarity" value={sel.rarity} options={opts?.rarities ?? ['any']} onChange={(rarity) => set({ rarity })} />
            <Pick label="Type" value={sel.type} options={opts?.types ?? ['any']} onChange={(type) => set({ type })} />
            <label className="qg-field">How many<input type="number" min={1} max={20} value={Math.min(sel.count, 20)} onChange={(e) => set({ count: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} /></label>
          </>}
          {sel.tab === 'gold' && <>
            <Pick label="Kind" value={sel.mode} options={opts?.modes ?? ['individual', 'hoard']} onChange={(mode) => set({ mode })} />
            <label className="qg-field">Party level<input type="number" min={1} max={20} value={sel.level} onChange={(e) => set({ level: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} /></label>
          </>}
        </div>

        <div className="qg-actions">
          <button type="button" className="btn primary small" disabled={act.busy} onClick={() => void roll()}>Generate</button>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void roll()}>Re-roll</button>
          <button type="button" className="btn small" onClick={() => { copy(allText); setNote('Copied.'); }}>Copy</button>
          <button type="button" className="btn ghost small" disabled={act.busy} onClick={() => void addFlavour()}>Add flavour</button>
        </div>
        <ErrorBox error={act.error} />
        {flavour && <p className="qg-flavour">{flavour}</p>}

        <div className="qg-results" aria-live="polite">
          {sel.tab === 'names' && (
            <ul className="qg-list">
              {names.map((n) => <li key={n.name}><button type="button" className="qg-row" onClick={() => { copy(n.name); setNote(`Copied ${n.name}.`); }}><strong>{n.name}</strong><span className="muted">{n.race}, {n.gender}</span></button></li>)}
            </ul>
          )}
          {sel.tab === 'items' && (
            <>
              {items.length === 0 && <p className="muted">Nothing matches that rarity and type.</p>}
              <ul className="qg-list">
                {items.map((i) => (
                  <li key={`${i.source}${i.name}`} className="qg-item">
                    <button type="button" className="qg-row" onClick={() => { copy(i.name); setNote(`Copied ${i.name}.`); }}>
                      <strong>{i.name}</strong><span className="muted">{i.rarity} {i.type} · {gp(i.priceGp)}</span>
                    </button>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => void giveItem(i)}>Give</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {sel.tab === 'gold' && coin && (
            <div className="qg-coin">
              <button type="button" className="qg-row" onClick={() => { copy(coin.text); setNote('Copied.'); }}><strong>{coin.text}</strong><span className="muted">{coin.totalCp.toLocaleString('en-US')} cp in all · {coin.roll}</span></button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void giveCoin()}>Give</button>
            </div>
          )}
        </div>

        {sel.tab !== 'names' && <div className="qg-foot">{whoPicker}</div>}
        {note && <div className="qg-note" role="status">{note}</div>}
      </div>
    </div>
  );
}

const enc = encodeURIComponent;
function Pick({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="qg-field">{label}
      <select value={options.includes(value) ? value : options[0]} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
