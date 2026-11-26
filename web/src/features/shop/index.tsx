import type { WebFeature } from '../registry.ts';
import ItemsDM from './ItemsDM.tsx';
import PlayerShop from './PlayerShop.tsx';
import ShopsDM from './ShopsDM.tsx';
import ShopPresent from './ShopPresent.tsx';
import './shop.css';

const feature: WebFeature = {
  id: 'shop',
  dmRoutes: [{ path: 'shops', element: <ShopsDM /> }, { path: 'items', element: <ItemsDM /> }],
  playerRoutes: [{ path: 'shop', element: <PlayerShop /> }],
  dmNav: [{ to: 'shops' }, { to: 'items' }],
  playerNav: [{ to: 'shop', label: 'Shop', icon: 'fa-store' }],
  overlay: ShopPresent,
};
export default feature;
