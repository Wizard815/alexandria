// The admin's light or dark look. "system" follows the OS. Remembered per browser.
// It puts .adm-dark on <html>; only .t-admin rules read it, so the table side is untouched.
import { useEffect, useState } from 'react';

export type AdminTheme = 'system' | 'light' | 'dark';
const KEY = 'alx.adminTheme';

function saved(): AdminTheme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* storage blocked */ }
  return 'system';
}

export function useAdminTheme(): [AdminTheme, (t: AdminTheme) => void] {
  const [theme, setTheme] = useState<AdminTheme>(saved);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('adm-dark', theme === 'dark' || (theme === 'system' && !!mq?.matches));
    apply();
    mq?.addEventListener?.('change', apply);
    return () => { mq?.removeEventListener?.('change', apply); document.documentElement.classList.remove('adm-dark'); };
  }, [theme]);
  const set = (t: AdminTheme) => {
    try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
    setTheme(t);
  };
  return [theme, set];
}
