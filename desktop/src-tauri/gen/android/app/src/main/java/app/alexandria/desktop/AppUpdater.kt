package app.alexandria.desktop

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Updates from the person's own Alexandria server. The web app (signed in) asks the server for a
 * 15-minute download link and hands it to the app through /app-link/update; src/update.rs writes
 * it to update.json. This class sees that file, downloads the APK from the saved server only,
 * checks its SHA-256 against the server's list, and opens Android's installer, which asks the
 * person to confirm. Android keeps the app's data when the new APK is signed with the same key.
 */
/** An update that downloaded fine but must not be installed; the message says why. */
private class Refused(message: String) : Exception(message)

class AppUpdater(private val activity: Activity) {
  private val dir = File(activity.dataDir, activity.packageName)
  private val main = Handler(Looper.getMainLooper())
  private var observer: FileObserver? = null
  /** A checked APK waiting for "Install unknown apps" to be allowed. */
  private var ready: File? = null
  @Volatile private var running = false

  fun start() {
    dir.mkdirs()
    @Suppress("DEPRECATION")
    observer = object : FileObserver(dir.absolutePath, MOVED_TO or CLOSE_WRITE) {
      override fun onEvent(event: Int, path: String?) {
        if (path == "update.json") main.post { check() }
      }
    }.also { it.startWatching() }
    check() // one left from before (the app was closed mid-way)
  }

  fun stop() { observer?.stopWatching(); observer = null }

  /** Back from the "Install unknown apps" setting: install what is ready. */
  fun resume() { ready?.let { if (canInstall()) install(it) } }

  private fun check() {
    val f = File(dir, "update.json")
    if (!f.exists() || running) return
    val o = try { JSONObject(f.readText()) } catch (_: Exception) { null }
    f.delete()
    o ?: return
    val url = o.optString("url")
    val file = o.optString("file")
    val sha = o.optString("sha256").lowercase()
    val server = serverOrigin() ?: return
    // Only the saved server, only a file name like the server's, only a real checksum.
    if (!url.startsWith("$server/api/apps/file/") || !Regex("^[A-Za-z0-9][A-Za-z0-9._+-]*\\.apk$").matches(file) || !Regex("^[0-9a-f]{64}$").matches(sha)) {
      notify("failed", "That update link was not for this app's server.")
      return
    }
    running = true
    Thread { download(url, file, sha) }.start()
  }

  private fun download(url: String, file: String, sha: String) {
    try {
      val outDir = File(activity.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
      val out = File(outDir, file)
      val c = URL(url).openConnection() as HttpURLConnection
      c.connectTimeout = 15000
      c.readTimeout = 30000
      val md = MessageDigest.getInstance("SHA-256")
      try {
        if (c.responseCode != 200) throw Exception("the server said ${c.responseCode}")
        val total = c.contentLengthLong
        var done = 0L
        var lastPct = -1
        c.inputStream.use { input ->
          out.outputStream().use { output ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              md.update(buf, 0, n)
              output.write(buf, 0, n)
              done += n
              val pct = if (total > 0) (done * 100 / total).toInt() else -1
              if (pct >= 0 && pct / 10 != lastPct / 10) { lastPct = pct; notify("downloading", "Downloading the update… $pct%") }
            }
          }
        }
      } finally { c.disconnect() }
      val got = md.digest().joinToString("") { "%02x".format(it) }
      if (got != sha) { out.delete(); throw Exception("the download does not match the server's checksum") }
      // Android installs an update only over an app signed with the same key. Say so plainly
      // instead of letting the installer fail with "App not installed".
      if (!sameSigner(out)) {
        out.delete()
        throw Refused("This update was signed with a different key than the app you have, so Android would refuse it. Uninstall Alexandria, then install the new version (you will pick the server again). Ask your DM to sign every build with the same key.")
      }
      main.post {
        ready = out
        if (canInstall()) install(out)
        else {
          notify("permission", "Allow Alexandria to install apps, then come back: the update installs then.")
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
        }
      }
    } catch (e: Exception) {
      notify("failed", if (e is Refused) e.message ?: "" else "The update did not download: ${e.message}")
    } finally {
      running = false
    }
  }

  /** True when the downloaded APK is signed by the same certificate as this app (or it can't tell). */
  private fun sameSigner(apk: File): Boolean = try {
    val pm = activity.packageManager
    @Suppress("DEPRECATION")
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val mine = signers(pm.getPackageInfo(activity.packageName, flags))
    val theirs = pm.getPackageArchiveInfo(apk.absolutePath, flags)?.let { signers(it) }
    when {
      theirs == null -> false // not an APK Android can read
      theirs.isEmpty() -> false // unsigned: Android refuses it anyway
      mine.isEmpty() -> true
      else -> mine.intersect(theirs).isNotEmpty()
    }
  } catch (_: Exception) { true }

  @Suppress("DEPRECATION")
  private fun signers(p: PackageInfo): Set<String> {
    val sigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) p.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory } else p.signatures
    val md = MessageDigest.getInstance("SHA-256")
    return sigs.orEmpty().map { s -> md.digest(s.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
  }

  private fun canInstall() = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

  private fun install(apk: File) {
    ready = null
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
    val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    notify("installing", "Android asks you to confirm the update.")
    activity.startActivity(i)
  }

  private fun serverOrigin(): String? = try {
    JSONObject(File(dir, "settings.json").readText()).optString("server").trimEnd('/').takeIf { it.startsWith("http") }
  } catch (_: Exception) { null }

  /** The same `alexandria-update` event the desktop app sends, for the page to show. */
  private fun notify(state: String, message: String) {
    val detail = JSONObject().put("state", state).put("message", message).toString()
    main.post { findWebView(activity.findViewById(android.R.id.content))?.evaluateJavascript("window.dispatchEvent(new CustomEvent('alexandria-update', { detail: $detail }))", null) }
  }

  private fun findWebView(v: View?): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findWebView(v.getChildAt(i))?.let { return it }
    return null
  }
}
