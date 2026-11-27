// A router of a pane's own. The GM pages use <Link>, navigate() and the URL's query, and each pane must have its own: a link
// inside the Combat pane must not move the whole window, and two panes must not share one ?tab=. React Router refuses a Router
// inside a Router, so this provides the same contexts a MemoryRouter does, with history kept in the pane. A link to a page
// that is not a GM page (a player route, a full URL) goes to the real router.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Route, Routes, UNSAFE_LocationContext, UNSAFE_NavigationContext, UNSAFE_RouteContext, createPath, parsePath, useNavigate, type Location, type To } from 'react-router-dom';
import { pageOfRoute } from '../../lib/workspace.ts';
import { tablePage, type PaneRoute } from './pages.tsx';

interface Hist { list: Location[]; i: number }

const mk = (path: string, key: string): Location => { const p = parsePath(path); return { pathname: p.pathname ?? '/', search: p.search ?? '', hash: p.hash ?? '', state: null, key }; };

export default function PaneRouter({ slug, entry, routes, onPage }: {
  slug: string;
  /** The first location, path and query: /w/<slug>/dm/<route>?... */
  entry: string;
  routes: PaneRoute[];
  /** The pane moved to another GM page by itself (a link on the page); `entry` is where. */
  onPage: (page: string, entry: string) => void;
}) {
  const outer = useNavigate();
  const prefix = `/w/${slug}/dm`;
  const pageOf = useCallback((pathname: string): string | null => {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
    const first = pathname.slice(prefix.length + 1).split('/')[0];
    return first === '' ? 'table' : routes.some((r) => r.path.split('/')[0] === first) ? pageOfRoute(first) : null;
  }, [prefix, routes]);
  const [hist, setHist] = useState<Hist>(() => ({ list: [mk(entry, '0')], i: 0 }));
  const cur = useRef(hist); cur.current = hist;
  const seq = useRef(1);

  const go = useCallback((to: To, replace: boolean) => {
    const path = typeof to === 'string' ? to : createPath(to);
    const loc = mk(path, String(seq.current++));
    const here = pageOf(cur.current.list[cur.current.i].pathname);
    const there = pageOf(loc.pathname);
    if (there === null) { outer(to, { replace }); return; }
    setHist((h) => (replace ? { list: h.list.map((x, k) => (k === h.i ? loc : x)), i: h.i } : { list: [...h.list.slice(0, h.i + 1), loc], i: h.i + 1 }));
    if (there !== here) onPage(there, path);
  }, [outer, pageOf, onPage]);

  const navigator = useMemo(() => ({
    createHref: (to: To) => (typeof to === 'string' ? to : createPath(to)),
    encodeLocation: (to: To) => { const p = typeof to === 'string' ? parsePath(to) : to; return { pathname: p.pathname ?? '', search: p.search ?? '', hash: p.hash ?? '' }; },
    push: (to: To) => go(to, false),
    replace: (to: To) => go(to, true),
    go: (n: number) => setHist((h) => ({ ...h, i: Math.max(0, Math.min(h.list.length - 1, h.i + n)) })),
  }), [go]);
  const nav = useMemo(() => ({ basename: '/', navigator, static: false, future: {} }), [navigator]);
  const location = hist.list[hist.i];
  const loc = useMemo(() => ({ location, navigationType: 'PUSH' as never }), [location]);
  const route = useMemo(() => ({ outlet: null, matches: [], isDataRoute: false }), []);

  const children: ReactNode[] = routes.map((r) => <Route key={r.path} path={r.path} element={r.element} />);
  return (
    <UNSAFE_NavigationContext.Provider value={nav as never}>
      <UNSAFE_LocationContext.Provider value={loc}>
        <UNSAFE_RouteContext.Provider value={route as never}>
          <Routes>
            <Route path="/w/:world/dm">
              <Route index element={tablePage} />
              {children}
            </Route>
          </Routes>
        </UNSAFE_RouteContext.Provider>
      </UNSAFE_LocationContext.Provider>
    </UNSAFE_NavigationContext.Provider>
  );
}
