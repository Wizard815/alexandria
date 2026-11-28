// The GM's worker: keeps the Owlbear scene's map picture and fog in step with Alexandria. It runs in the background
// page (and, if that page is not running, in the popover), once per browser: a Web Lock makes sure of that. In a
// player's browser it does nothing.
import OBR, { buildImage, buildPath, type Image, type Item } from '@owlbear-rodeo/sdk';
import { api, ApiError, getKey, listen, NS, tell, type FogCells, type Hello, type Status, type WorkerNote } from './api.ts';
import { fogMask, frameOf, rectCommands } from './geometry.ts';

/** Metadata on the picture item this extension put in the scene: { pic, url }. */
export const MAP = `${NS}/map`;
/** Metadata on the fog shape this extension draws (Alexandria leads): { pic, version }. */
export const FOG = `${NS}/fog`;
/** Room metadata for every browser in the room (no secrets): { origin, worldId, worldName }. */
export const ROOM = `${NS}/room`;
const POLL_MS = 2000;
const COLS = 240;

const meta = (it: Item, k: string) => (it.metadata?.[k] ?? null) as Record<string, any> | null;
const naturalSize = (url: string) => new Promise<{ w: number; h: number }>((res, rej) => {
  const im = new window.Image();
  im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
  im.onerror = () => rej(new Error('The map picture did not load from Alexandria'));
  im.src = url;
});

export function startWorker(): () => void {
  let hello: Hello | null = null;
  let helloKey = '';
  let lastFog = '';
  let lastLead: string | null = null;
  let lastMask: string | null = null;
  let note: WorkerNote = { state: 'idle', text: 'Starting', at: Date.now() };
  let busy = false, again = false, stopped = false;

  const say = (n: Omit<WorkerNote, 'at'>) => {
    note = { ...n, world: n.world ?? hello?.world.name, at: Date.now() };
    tell({ type: 'note', note });
  };

  async function sharedInfo(h: Hello) {
    const want = { origin: location.origin, worldId: h.world.slug || h.world.id, worldName: h.world.name };
    const cur = (await OBR.room.getMetadata())[ROOM] as typeof want | undefined;
    if (!cur || cur.origin !== want.origin || cur.worldId !== want.worldId || cur.worldName !== want.worldName) await OBR.room.setMetadata({ [ROOM]: want });
  }

  /** The linked picture in the scene: added, swapped or re-pointed as needed. Null while it is being added. */
  async function ensurePicture(st: Status): Promise<Image | null> {
    const t = st.target;
    const url = new URL(t.url!, location.origin).href;
    const ours = await OBR.scene.items.getItems((it) => !!meta(it, MAP)) as Image[];
    const keep = ours.find((it) => meta(it, MAP)!.pic === t.pic);
    const old = ours.filter((it) => it !== keep);
    if (old.length) {
      const att = await OBR.scene.items.getItemAttachments(old.map((i) => i.id));
      await OBR.scene.items.deleteItems([...new Set([...old.map((i) => i.id), ...att.map((i) => i.id)])]);
    }
    if (keep) {
      if (keep.image.url !== url) await OBR.scene.items.updateItems([keep.id], (d) => { for (const it of d as Image[]) { it.image.url = url; it.metadata[MAP] = { pic: t.pic, url }; } });
      return keep;
    }
    const { w, h } = await naturalSize(url);
    const sceneDpi = await OBR.scene.grid.getDpi();
    const dpi = st.link.cells > 0 ? Math.max(1, w / st.link.cells) : sceneDpi;
    const at = old[0]?.position ?? { x: 0, y: 0 };
    const item = buildImage({ width: w, height: h, url, mime: t.mime || 'image/png' }, { dpi, offset: { x: 0, y: 0 } })
      .layer('MAP').name(t.label || 'Alexandria map').position(at).metadata({ [MAP]: { pic: t.pic, url } }).build();
    await OBR.scene.items.addItems([item]);
    lastFog = '';
    return null;
  }

  const mirrorItems = () => OBR.scene.items.getItems((it) => !!meta(it, FOG));

  /** Alexandria leads: one locked fog path, attached to the picture so it moves with it. */
  async function mirrorFog(st: Status, img: Image) {
    const mine = await mirrorItems();
    if (!st.fog?.enabled) { if (mine.length) await OBR.scene.items.deleteItems(mine.map((i) => i.id)); lastFog = ''; return; }
    const sig = `${st.target.pic}:${st.fog.version}:${img.id}:${img.image.width}x${img.image.height}:${img.grid.dpi}`;
    if (sig === lastFog && mine.length) return;
    const rows = Math.max(8, Math.min(400, Math.round((COLS * img.image.height) / Math.max(1, img.image.width))));
    const cells = await api<FogCells>('GET', `/fog?cols=${COLS}&rows=${rows}`);
    const f = frameOf(img, await OBR.scene.grid.getDpi());
    const commands = rectCommands(cells.rects, cells.cols, cells.rows, f);
    const fit = mine.find((i) => i.attachedTo === img.id);
    const extra = mine.filter((i) => i !== fit);
    if (extra.length) await OBR.scene.items.deleteItems(extra.map((i) => i.id));
    if (!commands.length) { if (fit) await OBR.scene.items.deleteItems([fit.id]); }
    else if (fit) await OBR.scene.items.updateItems([fit.id], (d) => { for (const it of d as any[]) { it.commands = commands; it.metadata[FOG] = { pic: cells.pic, version: cells.version }; } });
    else {
      const p = buildPath().commands(commands).fillRule('nonzero').layer('FOG').name('Alexandria fog')
        .position(img.position).rotation(img.rotation).scale(img.scale).attachedTo(img.id)
        .fillColor('#222222').fillOpacity(1).strokeWidth(0).strokeOpacity(0).locked(true)
        .metadata({ [FOG]: { pic: cells.pic, version: cells.version } }).build();
      await OBR.scene.items.addItems([p]);
    }
    lastFog = sig;
  }

  /** Owlbear leads: hand the mirrored fog to the GM as a plain Owlbear fog shape, then send Owlbear's fog when it changes. */
  async function pushFog(img: Image, entering: boolean) {
    const mine = await mirrorItems();
    if (mine.length) await OBR.scene.items.updateItems(mine.map((i) => i.id), (d) => { for (const it of d) { delete it.metadata[FOG]; it.locked = false; it.name = 'Fog'; } });
    if (await OBR.scene.fog.getFilled()) { say({ state: 'error', text: "Owlbear's fog Fill is on. Turn it off to send Owlbear's fog to Alexandria.", picture: img.name, lead: 'owlbear' }); return false; }
    const items = await OBR.scene.items.getItems((it) => it.layer === 'FOG' && !meta(it, FOG));
    const mask = fogMask(items, img, await OBR.scene.grid.getDpi());
    // Switching to Owlbear leads sends nothing by itself: only a change made in Owlbear after that does.
    if (entering || lastMask === null) { lastMask = mask; return true; }
    if (mask !== lastMask) { await api('PUT', '/fog', { mask }); lastMask = mask; }
    return true;
  }

  async function step() {
    if ((await OBR.player.getRole()) !== 'GM') { say({ state: 'player', text: 'Only the GM links the room to Alexandria.' }); return; }
    const key = getKey();
    if (!key) { hello = null; say({ state: 'no-key', text: 'Paste the link key from Alexandria (GM, Setup, Owlbear Rodeo).' }); return; }
    if (!(await OBR.scene.isReady())) { say({ state: 'no-scene', text: 'Open a scene in Owlbear Rodeo.' }); return; }
    if (!hello || helloKey !== key) {
      const q = new URLSearchParams({ room: OBR.room.id, player: await OBR.player.getName() });
      hello = await api<Hello>('GET', `/hello?${q}`, undefined, key);
      helloKey = key;
      await sharedInfo(hello);
    }
    const st = await api<Status>('GET', '/state');
    if (!st.target.pic || !st.target.url) {
      say({ state: 'nothing', lead: st.link.lead, picture: null, text: st.target.hidden
        ? 'The table screen shows a map picture the players may not see. Share its page with them, or pick another picture.'
        : st.link.follow ? 'The table screen shows no map picture yet. Put one on it from the Map page, or pick one here.' : 'Pick a map picture.' });
      return;
    }
    const img = await ensurePicture(st);
    if (!img) { say({ state: 'ok', text: 'Adding the map picture…', picture: st.target.label, lead: st.link.lead }); again = true; return; }
    const entering = lastLead !== st.link.lead;
    lastLead = st.link.lead;
    if (st.link.lead === 'alexandria') {
      lastMask = null;
      await mirrorFog(st, img);
      say({ state: 'ok', lead: 'alexandria', picture: st.target.label, text: st.fog?.enabled ? "Alexandria's fog is on the map." : 'Fog is off for this picture in Alexandria.' });
    } else if (await pushFog(img, entering)) {
      lastFog = '';
      say({ state: 'ok', lead: 'owlbear', picture: st.target.label, text: "Owlbear's fog is sent to Alexandria as you draw it." });
    }
  }

  async function tick() {
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try { await step(); }
    catch (e: any) {
      if (e instanceof ApiError && e.status === 401) hello = null;
      say({ state: 'error', text: e?.message || String(e) });
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(() => void tick(), 300); }
    }
  }

  let soon: ReturnType<typeof setTimeout> | null = null;
  const kick = (ms = 0) => { if (soon) clearTimeout(soon); soon = setTimeout(() => { soon = null; void tick(); }, ms); };
  const timer = setInterval(() => void tick(), POLL_MS);
  const offs = [
    listen((m) => {
      if (m.type === 'ask') tell({ type: 'note', note });
      if (m.type === 'key') { hello = null; kick(); }
      if (m.type === 'kick') { lastFog = ''; kick(); }
    }),
    // Owlbear leads: a fog change is sent soon after the GM stops drawing.
    OBR.scene.items.onChange(() => { if (lastLead === 'owlbear') kick(700); }),
    OBR.scene.onReadyChange(() => { lastFog = ''; lastLead = null; kick(); }),
  ];
  void tick();
  return () => { stopped = true; clearInterval(timer); if (soon) clearTimeout(soon); for (const o of offs) o(); };
}

/** Run the worker in this page unless another page of this browser already runs it. */
export function startWorkerOnce(): void {
  const locks = (navigator as any).locks;
  if (!locks?.request) { startWorker(); return; }
  void locks.request('alx-obr-worker', () => new Promise<void>(() => { startWorker(); }));
}
