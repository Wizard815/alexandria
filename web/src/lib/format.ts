// Coins are stored in copper. Show them the way the world counts them.
export function coins(cp: number, mode: 'gsc' | 'all' | 'gold' = 'gsc'): string {
  const neg = cp < 0;
  let n = Math.abs(Math.round(cp));
  const parts: string[] = [];
  const take = (size: number, label: string) => {
    const q = Math.floor(n / size);
    if (q) parts.push(`${q.toLocaleString()} ${label}`);
    n -= q * size;
  };
  if (mode === 'gold') {
    const gp = Math.abs(cp) / 100;
    return `${neg ? '−' : ''}${gp.toLocaleString(undefined, { maximumFractionDigits: 2 })} gp`;
  }
  if (mode === 'all') { take(1000, 'pp'); take(100, 'gp'); take(50, 'ep'); take(10, 'sp'); take(1, 'cp'); }
  else { take(100, 'gp'); take(10, 'sp'); take(1, 'cp'); }
  return (neg ? '−' : '') + (parts.join(' ') || '0 cp');
}

/** "12 gp 5 sp" or "-3sp" → copper. Plain numbers are gold. */
export function parseCoins(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/,/g, '');
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 100);
  const sign = t.startsWith('-') || t.startsWith('−') ? -1 : 1;
  const rates: Record<string, number> = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
  let total = 0;
  let found = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(pp|gp|ep|sp|cp)/g)) { total += Number(m[1]) * rates[m[2]]; found = true; }
  return found ? sign * Math.round(total) : null;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dateLong(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function timeShort(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
