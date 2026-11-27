package app.alexandria.desktop

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.File

/**
 * Keeps the phone recording as a table microphone with the screen locked. While the page records
 * (web/src/features/apps/RecordingKeeper.tsx sends /app-link/recording#on=1), src/lib.rs writes
 * recording.on; this starts a microphone foreground service (Android's rule for using the mic
 * in the background, with its "Recording" notification) and a CPU wake lock, and MainActivity
 * keeps the web view running when the screen goes off. Stopping deletes the file.
 */
class RecordingService : Service() {
  private var lock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
    val n: Notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notify)
      .setContentTitle("Recording the session")
      .setContentText("Alexandria keeps listening with the screen off. Stop it in the app.")
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    try {
      ServiceCompat.startForeground(this, 41, n, if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
    } catch (_: Exception) { stopSelf(); return START_NOT_STICKY }
    if (lock == null) {
      lock = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "alexandria:recording").apply { setReferenceCounted(false); acquire(6 * 3600_000L) }
    }
    running = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    lock?.let { if (it.isHeld) it.release() }
    lock = null
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "recording"
    @Volatile var running = false
      private set

    private fun flag(ctx: Context) = File(File(ctx.dataDir, ctx.packageName), "recording.on")

    fun sync(ctx: Context) {
      val on = flag(ctx).exists()
      val i = Intent(ctx, RecordingService::class.java)
      if (on && !running) {
        try { androidx.core.content.ContextCompat.startForegroundService(ctx, i) } catch (_: Exception) {}
      } else if (!on && running) ctx.stopService(i)
    }

    @Suppress("DEPRECATION")
    fun watch(a: Activity): FileObserver {
      val d = File(a.dataDir, a.packageName).apply { mkdirs() }
      flag(a).delete() // a recording from before the app closed is over
      val main = Handler(Looper.getMainLooper())
      return object : FileObserver(d.absolutePath, CLOSE_WRITE or MOVED_TO or DELETE) {
        override fun onEvent(event: Int, path: String?) { if (path == "recording.on") main.post { sync(a) } }
      }.also { it.startWatching() }
    }
  }
}
