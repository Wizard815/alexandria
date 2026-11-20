// First-run screen: ask for the server address, check it answers, hand it to
// the app (Rust), which remembers it and loads the web app in this window.
const invoke = window.__TAURI__.core.invoke;
const form = document.getElementById('f');
const input = document.getElementById('url');
const msg = document.getElementById('msg');
const go = document.getElementById('go');
const anyway = document.getElementById('anyway');

function normalize(raw) {
  let v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = (/^(localhost|127\.|10\.|192\.168\.|[^/]*\.local\b)/i.test(v) ? 'http://' : 'https://') + v;
  return v;
}

async function reachable(base) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try { await fetch(base + '/health', { mode: 'no-cors', signal: ctl.signal, cache: 'no-store' }); return true; } catch { return false; } finally { clearTimeout(t); }
}

async function connect(base) {
  go.disabled = true;
  try { await invoke('set_server', { url: base }); } catch (e) { msg.style.color = 'var(--danger)'; msg.textContent = String(e); go.disabled = false; }
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  anyway.hidden = true;
  const base = normalize(input.value);
  input.value = base;
  msg.style.color = 'var(--muted)';
  msg.textContent = 'Checking…';
  go.disabled = true;
  if (await reachable(base)) { msg.textContent = ''; await connect(base); return; }
  go.disabled = false;
  msg.style.color = 'var(--danger)';
  msg.textContent = 'Could not reach that address. Check it, or connect anyway if you know it is right.';
  anyway.hidden = false;
});
anyway.addEventListener('click', () => connect(normalize(input.value)));

invoke('get_server').then((s) => { if (s) input.value = s; }).catch(() => {});
