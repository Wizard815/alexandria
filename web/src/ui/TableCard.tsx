// One block on the GM's Table (pages/gm/Table.tsx), for the page itself and for features that add blocks (registry gmTable).
// A block with nothing going on shrinks to one line ("quiet"), so the busy ones get the room.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useWorld } from '../lib/world.tsx';

export interface TableCardProps {
  id: string;
  title: string;
  /** A Font Awesome solid name, e.g. 'fa-khanda'. */
  icon: string;
  /** Under /w/:world/gm/, with its words. */
  link?: [string, string];
  /** Set when there is nothing to show: the block is one line with this text. */
  quiet?: ReactNode;
  tone?: 'gold' | 'teal' | 'red' | 'live';
  /** Shown next to the title (a count, a round number). */
  badge?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function TableCard({ id, title, icon, link, quiet, tone, badge, className, children }: TableCardProps) {
  const { info } = useWorld();
  const href = link && `/w/${info.slug}/gm/${link[0]}`;
  const h = `tb-${id}-h`;
  if (quiet) {
    return (
      <section className={`tb-card quiet${className ? ` ${className}` : ''}`} aria-labelledby={h} data-testid={`tb-${id}`} data-quiet="true">
        <i className={`fa-solid ${icon} tb-icon`} aria-hidden="true" />
        <h2 id={h}>{title}</h2>
        <span className="small muted grow">{quiet}</span>
        {href && <Link to={href} className="small">{link![1]} →</Link>}
      </section>
    );
  }
  return (
    <section className={`tb-card${tone ? ` ${tone}` : ''}${className ? ` ${className}` : ''}`} aria-labelledby={h} data-testid={`tb-${id}`}>
      <div className="tb-head">
        <i className={`fa-solid ${icon} tb-icon`} aria-hidden="true" />
        <h2 id={h}>{title}</h2>
        {badge !== undefined && badge !== null && badge !== false && <span className="tb-badge">{badge}</span>}
        <span className="grow" />
        {href && <Link to={href} className="small">{link![1]} →</Link>}
      </div>
      {children}
    </section>
  );
}
