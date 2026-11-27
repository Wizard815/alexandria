// A QR code for a link (an invite), drawn as an SVG. Always dark on white with a quiet zone,
// whatever the theme, so a phone camera reads it off the screen.
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export default function QrCode({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const path = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [text]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} shapeRendering="crispEdges" style={{ background: '#fff', borderRadius: 6 }} data-testid="qr">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
