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
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    openFromWidget(intent)
  }

  // Leaving the app: the home-screen widgets load again, so they show what just changed
  // (and pick up a widget link made a moment ago).
  override fun onStop() {
    super.onStop()
    Glance.refreshAll(this)
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
    val server = Glance.link(this)?.server ?: return
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

  private fun findWebView(v: View?): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findWebView(v.getChildAt(i))?.let { return it }
    return null
  }
}
