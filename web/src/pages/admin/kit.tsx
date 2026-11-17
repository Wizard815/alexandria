// Small pieces of the gateway admin look: the sidebar icons, status pills, number tiles.
// The styling is in src/admin.css.
import type { ReactNode } from 'react';

const PATHS: Record<string, string> = {
  brand: 'M3 21h18M5 21V10M9.5 21V10M14.5 21V10M19 21V10M2 10l10-6 10 6z',
  overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  worlds: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9',
  library: 'M4 5a2 2 0 012-2h4v18H6a2 2 0 01-2-2zM10 3h4v18h-4zM14 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4z',
  connections: 'M7 7h4v4H7zM13 13h4v4h-4zM11 9h3a2 2 0 012 2v2M5 9H3M21 15h-2M9 3v4M15 17v4',
  sources: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  'source-keys': 'M8 15a4 4 0 110-8 4 4 0 010 8zM11 11h10M18 11v3M15 11v2',
  accounts: 'M16 20v-1.5A3.5 3.5 0 0012.5 15h-5A3.5 3.5 0 004 18.5V20M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1.5a3.5 3.5 0 00-2.5-3.35M15.5 4.2a3.5 3.5 0 010 6.6',
  permissions: 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6zM9 12l2 2 4-4',
  models: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M7 6h10a1 1 0 011 1v10a1 1 0 01-1 1H7a1 1 0 01-1-1V7a1 1 0 011-1zM10 10h4v4h-4z',
  integrations: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4',
  keys: 'M8 15a4 4 0 110-8 4 4 0 010 8zM11 11h10M18 11v3M15 11v2',
  audit: 'M7 4h10a2 2 0 012 2v14l-3-2-2 2-2-2-2 2-2-2-3 2V6a2 2 0 012-2zM9 9h6M9 13h4',
  security: 'M6 11V8a6 6 0 1112 0v3M5 11h14v9H5zM12 15v2',
  back: 'M15 5l-7 7 7 7',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  mirror: 'M4 6h16M4 12h16M4 18h10M17 15l3 3-3 3',
  'source-files': 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  access: 'M8 15a4 4 0 110-8 4 4 0 010 8zM11 11h10M18 11v3M15 11v2',
};

export function Icon({ name, size = 18, color }: { name: string; size?: number; color?: string }) {
  const d = PATHS[name] ?? PATHS.overview;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={name === 'brand' ? 1.6 : 1.8} aria-hidden="true"><path d={d} /></svg>;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'teal' | '';

/** A status pill. */
export function Pill({ tone = '', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

/** A big number with a label and one line under it. */
export function Tile({ label, value, sub, tone, to }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; to?: string }) {
  const inner = <><span className="tile-label">{label}</span><b className="tile-value">{value}</b>{sub && <span className="tile-sub">{sub}</span>}</>;
  return <div className={`tile${tone ? ` ${tone}` : ''}`} data-to={to}>{inner}</div>;
}

/** A card with a heading, a short line under it and actions on the right. */
export function Section({ title, lead, actions, children, flush }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; children?: ReactNode; flush?: boolean }) {
  return (
    <section className="card adm-section">
      <div className="adm-section-head">
        <div className="stack tight"><h2>{title}</h2>{lead && <p className="small muted">{lead}</p>}</div>
        {actions && <div className="row">{actions}</div>}
      </div>
      {flush ? <div className="scroll-x">{children}</div> : children}
    </section>
  );
}

export function Callout({ tone = 'warn', children }: { tone?: 'warn' | 'bad' | 'ok'; children: ReactNode }) {
  return <div className={`callout ${tone}`} role="status">{children}</div>;
}
