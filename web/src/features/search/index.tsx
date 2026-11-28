import type { WebFeature } from '../registry.ts';
import SearchOverlay, { SearchButton } from './SearchBox.tsx';

// A search box over every GM and player page: "/" or Ctrl/Cmd+/ opens it.
const feature: WebFeature = {
  id: 'search',
  overlay: SearchOverlay,
  topbar: SearchButton,
};
export default feature;
