// Shops on the GM's Table: which are open, one tap to open or close one, and purchases waiting for the GM's yes.
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { TableCard } from '../../ui/TableCard.tsx';
import { STATUS_LABEL, statusChip, type Order, type Shop } from './types.ts';

const RANK = { open: 0, closed: 1, hidden: 2 } as const;

export default function TableShops() {
  const { w, info } = useWorld();
  const act = useAction();
  const list = useLoad<{ shops: Shop[] }>(() => w.call('GET', '/shop/shops'), [w], ['shop']);
  const orders = useLoad<{ orders: Order[]; pending: number }>(() => w.call('GET', '/shop/orders'), [w], ['shop-order']);
  if (!list.data) return null;
  const shops = [...list.data.shops].sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));
  if (!shops.length) return <TableCard id="shops" title="Shops" icon="fa-store" link={['shops?tab=generate', 'Make one']} quiet="No shops yet." />;
  const pending = orders.data?.pending ?? 0;
  const set = (s: Shop, status: Shop['status']) => act.run(async () => { await w.call('POST', `/shop/shops/${encodeURIComponent(s.id)}/status`, { status }); await list.reload(); });
  const open = shops.filter((s) => s.status === 'open').length;
  return (
    <TableCard id="shops" title="Shops" icon="fa-store" badge={`${open} open`} link={['shops', 'Shops']}>
      {pending > 0 && <Link className="tb-alert" to={`/w/${info.slug}/dm/shops?tab=orders`}><i className="fa-solid fa-cart-shopping" aria-hidden="true" /> {pending} purchase{pending === 1 ? '' : 's'} waiting for you</Link>}
      <ul className="tb-list">
        {shops.slice(0, 6).map((s) => (
          <li key={s.id} className="row between" data-testid="tb-shop">
            <Link className="tb-ellipsis grow" to={`/w/${info.slug}/dm/shops?shop=${encodeURIComponent(s.id)}`}>{s.name}{s.town?.name ? <span className="tiny faint"> · {s.town.name}</span> : null}</Link>
            {s.status === 'hidden'
              ? <span className={statusChip(s.status)}>{STATUS_LABEL[s.status]}</span>
              : <button type="button" className={`btn small${s.status === 'open' ? ' on' : ''}`} disabled={act.busy} aria-pressed={s.status === 'open'} onClick={() => void set(s, s.status === 'open' ? 'closed' : 'open')} title={s.status === 'open' ? 'Open: press to close' : 'Closed: press to open'}>{s.status === 'open' ? 'Open' : 'Closed'}</button>}
          </li>
        ))}
      </ul>
      {shops.length > 6 && <span className="small muted">and {shops.length - 6} more</span>}
      <ErrorBox error={act.error} />
    </TableCard>
  );
}
