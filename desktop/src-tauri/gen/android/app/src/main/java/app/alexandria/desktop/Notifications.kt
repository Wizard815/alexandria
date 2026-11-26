package app.alexandria.desktop

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import app.alexandria.desktop.widget.Glance
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Notifications: the alerts of the glance (librarian/src/features/glance), each shown once.
 * - While the app runs, the page sends each new alert through /app-link/notify; src/lib.rs writes
 *   notify.json and [watch] posts it.
 * - When the app is closed, [CheckWorker] reads the glance every 15 minutes with the widget's
 *   read-only link (Glance.link), for that one world.
 * Which kinds a person gets is their own choice on This device; the server filters by it.
 */
object Notifications {
  private const val CHANNEL = "alerts"
  private const val PREFS = "alexandria_notify"
  private const val WORK = "alexandria-alerts"

  private fun dir(ctx: Context) = File(ctx.dataDir, ctx.packageName)

  fun channel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.notify_channel), NotificationManager.IMPORTANCE_HIGH).apply {
        description = ctx.getString(R.string.notify_channel_desc)
      })
    }
  }

  fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  /** Android 13+: ask once, the first time Alexandria has something to show. */
  fun askOnce(a: Activity) {
    if (allowed(a) || Build.VERSION.SDK_INT < 33) return
    val p = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (p.getBoolean("asked", false)) return
    p.edit().putBoolean("asked", true).apply()
    a.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
  }

  /** Show an alert unless it was shown before (by the page or the background check). */
  @Synchronized
  fun post(ctx: Context, id: String, title: String, body: String, path: String?) {
    if (id.isEmpty() || title.isEmpty()) return
    val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val seen = try { JSONObject(p.getString("seen", "{}")!!) } catch (_: Exception) { JSONObject() }
    if (seen.has(id)) return
    seen.put(id, System.currentTimeMillis())
    // Keep three days of ids.
    val cut = System.currentTimeMillis() - 3 * 86_400_000L
    seen.keys().asSequence().toList().forEach { if (seen.optLong(it) < cut) seen.remove(it) }
    p.edit().putString("seen", seen.toString()).apply()
    if (!allowed(ctx)) return
    channel(ctx)
    val safePath = path?.takeIf { it.startsWith("/w/") && !it.contains("..") && !it.contains("//") } ?: ""
    val n = NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(R.drawable.ic_notify)
      .setContentTitle(title.take(80))
      .setContentText(body.take(240))
      .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(240)))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_EVENT)
      .setAutoCancel(true)
      .setContentIntent(Glance.openApp(ctx, safePath, 9000 + (id.hashCode() and 0xfff)))
      .build()
    try { NotificationManagerCompat.from(ctx).notify(id.hashCode(), n) } catch (_: SecurityException) {}
  }

  /** Every alert in a glance answer. */
  fun postAll(ctx: Context, glance: JSONObject) {
    val list = glance.optJSONArray("alerts") ?: return
    for (i in 0 until list.length()) {
      val a = list.optJSONObject(i) ?: continue
      post(ctx, a.optString("id"), a.optString("title"), a.optString("body"), a.optString("path"))
    }
  }

  /** Watches for notify.json from the page while the app runs. */
  @Suppress("DEPRECATION")
  fun watch(a: Activity): FileObserver {
    val d = dir(a).apply { mkdirs() }
    val main = Handler(Looper.getMainLooper())
    val read = {
      val f = File(d, "notify.json")
      if (f.exists()) {
        val o = try { JSONObject(f.readText()) } catch (_: Exception) { null }
        f.delete()
        if (o != null) {
          askOnce(a)
          post(a, o.optString("id"), o.optString("title"), o.optString("body"), if (o.isNull("path")) null else o.optString("path"))
        }
      }
    }
    return object : FileObserver(d.absolutePath, MOVED_TO or CLOSE_WRITE) {
      override fun onEvent(event: Int, path: String?) { if (path == "notify.json") main.post { read() } }
    }.also { it.startWatching() }
  }

  /** The background check, while a widget link exists; cancelled when it is gone. */
  fun schedule(ctx: Context) {
    val wm = WorkManager.getInstance(ctx)
    if (Glance.link(ctx) == null) { wm.cancelUniqueWork(WORK); return }
    val req = PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .build()
    wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
  }

  class CheckWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
      val l = Glance.link(applicationContext) ?: return Result.success()
      when (val r = Glance.fetch(l)) {
        is Glance.Result.Ok -> { Glance.save(applicationContext, r.data); postAll(applicationContext, r.data) }
        else -> {}
      }
      return Result.success()
    }
  }
}
