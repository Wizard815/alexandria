// Seconds left on a timed encounter step, ticking. onZero fires once when it reaches zero.
import { useEffect, useRef, useState } from 'react';

export function useSecondsLeft(endsAt: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [endsAt]);
  return endsAt ? Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 1000)) : null;
}

export function Countdown({ endsAt, secs, onZero }: { endsAt: string; secs?: number; onZero?: () => void }) {
  const left = useSecondsLeft(endsAt) ?? 0;
  const fired = useRef(false);
  useEffect(() => { fired.current = false; }, [endsAt]);
  useEffect(() => { if (left === 0 && onZero && !fired.current) { fired.current = true; onZero(); } }, [left, onZero]);
  if (!secs) return <span data-testid="enc-countdown">{left ? `${left}s left` : 'time is up'}</span>;
  const pct = Math.max(0, Math.min(100, (left / secs) * 100));
  return (
    <div className={`enc-countdown${left <= 5 ? ' urgent' : ''}`} data-testid="enc-countdown" role="timer" aria-live="off" aria-label={`${left} seconds left`}>
      <div className="enc-countdown-bar" style={{ width: `${pct}%` }} />
      <span className="enc-countdown-text"><i className="fa-solid fa-stopwatch" aria-hidden="true" /> {left ? `${left}s to answer` : 'Time is up!'}</span>
    </div>
  );
}
