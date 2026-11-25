package app.alexandria.desktop

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

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
  }
}
