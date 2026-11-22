// Phone keyboards: how much of the layout viewport the on-screen keyboard covers,
// kept in the CSS variable --kb so sticky bars and sheets can lift above it.
import { useEffect, useState } from 'react';

export function useKeyboardInset(): number {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const read = () => {
      const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty('--kb', `${covered}px`);
      setKb(covered);
    };
    // A focused field scrolls clear of the keyboard and any bar above it.
    const focus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    document.addEventListener('focusin', focus);
    return () => { vv.removeEventListener('resize', read); vv.removeEventListener('scroll', read); document.removeEventListener('focusin', focus); document.documentElement.style.removeProperty('--kb'); };
  }, []);
  return kb;
}
