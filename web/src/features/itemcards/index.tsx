// Item cards have no screen of their own: other screens use <ItemHover> and
// <PagePicker>. Importing them from here keeps the one public entry point.
import type { WebFeature } from '../registry.ts';

export { ItemCard, ItemHover } from './ItemCard.tsx';
export { PagePicker } from './PagePicker.tsx';
export { useHoverDelay } from './settings.ts';

const feature: WebFeature = { id: 'itemcards' };
export default feature;
