// A back button in the top bar for an installed web app on iPhone and iPad: there is no
// browser bar and no back gesture there. Shown when there is a page to go back to, except on
// the world's home page (the bottom tabs' first stop, and where sign-in lands).
import { useLocation, useNavigate } from 'react-router-dom';
import { isIOS, isStandalone } from '../../lib/install.tsx';

export default function BackButton() {
  const nav = useNavigate();
  const loc = useLocation(); // re-render on every navigation, so the button follows history
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  if (!isStandalone() || !isIOS() || idx < 1 || /^\/w\/[^/]+(\/dm)?\/?$/.test(loc.pathname)) return null;
  return (
    <button type="button" className="icon-btn ios-back" aria-label="Back" onClick={() => nav(-1)} data-testid="ios-back">
      <i className="fa-solid fa-chevron-left" aria-hidden="true" />
    </button>
  );
}
