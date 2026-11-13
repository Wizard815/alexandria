// The world date in the top bar, e.g. "3 Frostmoot 1492 DR · evening".
import { useClock } from './shared.tsx';

export default function WorldDate() {
  const c = useClock();
  if (!c.data) return null;
  const d = c.data.date;
  const moons = d.moons.map((m) => `${m.name}: ${m.phase}`).join(', ');
  const title = [d.weekday, d.season, moons].filter(Boolean).join(' · ');
  return <span className="chip gold" role="status" aria-label={`World date: ${c.data.label}`} title={title} data-testid="world-date">{c.data.label}</span>;
}
