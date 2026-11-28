import type { WebFeature } from '../registry.ts';
import ItemsGM from './ItemsGM.tsx';
import PlayerShop from './PlayerShop.tsx';
import ShopsGM from './ShopsGM.tsx';
import ShopPresent from './ShopPresent.tsx';
import TableShops from './TableBlock.tsx';
import './shop.css';

const feature: WebFeature = {
  id: 'shop',
  gmRoutes: [{ path: 'shops', element: <ShopsGM /> }, { path: 'items', element: <ItemsGM /> }],
  playerRoutes: [{ path: 'shop', element: <PlayerShop /> }],
  gmNav: [{ to: 'shops' }, { to: 'items' }],
  playerNav: [{ to: 'shop', label: 'Shop', icon: 'fa-store' }],
  overlay: ShopPresent,
  gmTable: [{ id: 'shops', label: 'Shops', zone: 'world', order: 10, component: TableShops }],
};
export default feature;
