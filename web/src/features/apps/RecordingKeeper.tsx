// In the Android app: tells the app when this phone starts or stops recording as a table mic,
// so it keeps recording with the screen locked (desktop/.../Recording.kt).
import { useEffect, useRef } from 'react';
import { useEngine } from '../audio/engine.ts';
import { inAndroidApp, appInfo } from '../../lib/nativeApp.ts';

export default function RecordingKeeper() {
  const st = useEngine();
  const last = useRef(false);
  // A microphone of this phone is actually recording (not just a session running somewhere).
  const on = !!st.recording && Object.values(st.mics ?? {}).some((m) => m.recording);
  useEffect(() => {
    if (!inAndroidApp() || !appInfo() || on === last.current) return;
    last.current = on;
    window.location.assign(`/app-link/recording#on=${on ? 1 : 0}`);
  }, [on]);
  return null;
}
