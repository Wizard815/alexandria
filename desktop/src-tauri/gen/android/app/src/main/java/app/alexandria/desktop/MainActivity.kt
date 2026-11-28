package app.alexandria.desktop

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.alexandria.desktop.widget.Glance

class MainActivity : TauriActivity() {
  private val updater by lazy { AppUpdater(this) }
  private var notifyWatch: android.os.FileObserver? = null
  private var recWatch: android.os.FileObserver? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // The app is dark: transparent bars with light icons, over the same colour as the web app's top and bottom bars
    // (--side in web/src/theme.css), so the status bar reads as part of the app's own top bar.
    val bar = Color.parseColor("#171C26")
    enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
    // The system bars (and the on-screen keyboard) are padded here, once, and consumed, so the web page sees no inset
    // of its own and its top bar does not add a second one underneath the status bar.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(bar)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(sys.left, sys.top, sys.right, maxOf(sys.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    // A table app: the screen stays on while Alexandria is open. The back button goes back in the
    // web app's history and leaves the app at the first page (TauriActivity handles it).
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    openFromWidget(intent)
    shareIntoPage(intent)
    updater.start()
    notifyWatch = Notifications.watch(this)
    recWatch = RecordingService.watch(this)
    Notifications.schedule(this)
  }

  // Recording as a table mic: the screen going off pauses the web view (and with it the
  // microphone); while the recording service runs, it is resumed at once.
  override fun onPause() {
    super.onPause()
    if (RecordingService.running) findWebView(findViewById(android.R.id.content))?.onResume()
  }

  override fun onResume() {
    super.onResume()
    updater.resume()
  }

  override fun onDestroy() {
    updater.stop()
    notifyWatch?.stopWatching()
    recWatch?.stopWatching()
    stopService(android.content.Intent(this, RecordingService::class.java))
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    openFromWidget(intent)
    shareIntoPage(intent)
  }

  // Leaving the app: the home-screen widgets load again, so they show what just changed
  // (and pick up a widget link made a moment ago).
  override fun onStop() {
    super.onStop()
    Glance.refreshAll(this)
    // A widget link made while the app was open starts (or an unlink stops) the background check.
    Notifications.schedule(this)
    if (Glance.link(this) != null) Notifications.askOnce(this)
  }

  /**
   * A tap on a widget opens a page of the world ("/w/<world>/live"). Only a path on the
   * linked server is loaded, once the web view exists (on a cold start Rust makes it a moment
   * after onCreate).
   */
  private fun openFromWidget(intent: Intent?) {
    val path = intent?.getStringExtra(Glance.EXTRA_PATH) ?: return
    intent.removeExtra(Glance.EXTRA_PATH)
    if (path.isEmpty() || !path.startsWith("/w/") || path.contains("..") || path.contains("//")) return
    // The widget's server, or (for a notification, which needs no widget link) the saved one.
    val server = Glance.link(this)?.server ?: savedServer() ?: return
    val main = Handler(Looper.getMainLooper())
    val attempt = object : Runnable {
      var tries = 0
      override fun run() {
        val wv = findWebView(findViewById(android.R.id.content))
        val at = wv?.url
        // Wait for the first page of the server, so the web app's own sign-in is in place, then go.
        if (wv != null && at != null && (at == server || at.startsWith("$server/"))) wv.loadUrl(server + path)
        else if (tries++ < 40) main.postDelayed(this, 250)
      }
    }
    main.post(attempt)
  }

  /**
   * Shared from another app (text, a link, pictures): opens /share on the saved server and hands
   * the page what was shared once it says it is ready (window.__alxShareReady). Pictures are
   * read here (up to 12 MB in all) and passed as base64; the page uploads them with its own sign-in.
   */
  private fun shareIntoPage(intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    val server = savedServer() ?: return
    val o = org.json.JSONObject()
    intent.getStringExtra(Intent.EXTRA_TEXT)?.let { o.put("text", it.take(4000)) }
    intent.getStringExtra(Intent.EXTRA_SUBJECT)?.let { o.put("subject", it.take(200)) }
    val uris = mutableListOf<android.net.Uri>()
    @Suppress("DEPRECATION")
    if (action == Intent.ACTION_SEND) (intent.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
    else intent.getParcelableArrayListExtra<android.net.Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
    val files = org.json.JSONArray()
    var total = 0
    for (u in uris.take(6)) {
      try {
        val type = contentResolver.getType(u) ?: "application/octet-stream"
        if (!type.startsWith("image/")) continue
        val bytes = contentResolver.openInputStream(u)?.use { it.readBytes() } ?: continue
        if (total + bytes.size > 12 * 1024 * 1024) break
        total += bytes.size
        val name = (u.lastPathSegment ?: "shared").substringAfterLast('/').replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).let { if (it.contains('.')) it else "$it." + type.substringAfter('/') }
        files.put(org.json.JSONObject().put("name", name).put("type", type).put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)))
      } catch (_: Exception) {}
    }
    if (files.length() > 0) o.put("files", files)
    if (o.length() == 0) return
    intent.action = Intent.ACTION_MAIN // handled once
    val payload = o.toString()
    val main = Handler(Looper.getMainLooper())
    val attempt = object : Runnable {
      var tries = 0
      var loaded = false
      override fun run() {
        val wv = findWebView(findViewById(android.R.id.content))
        val at = wv?.url
        if (wv == null || at == null || !(at == server || at.startsWith("$server/"))) { if (tries++ < 60) main.postDelayed(this, 250); return }
        if (!loaded) { loaded = true; wv.loadUrl("$server/share"); main.postDelayed(this, 500); return }
        wv.evaluateJavascript("(function(){ if (window.__alxShareReady === true) { window.__alxShare = $payload; return true; } return false; })()") { r ->
          if (r != "true" && tries++ < 80) main.postDelayed(this, 300)
        }
      }
    }
    main.post(attempt)
  }

  private fun savedServer(): String? = try {
    org.json.JSONObject(java.io.File(java.io.File(dataDir, packageName), "settings.json").readText()).optString("server").trimEnd('/').takeIf { it.startsWith("http") }
  } catch (_: Exception) { null }

  private fun findWebView(v: View?): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findWebView(v.getChildAt(i))?.let { return it }
    return null
  }
}
