package app.alexandria.desktop.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import app.alexandria.desktop.MainActivity
import app.alexandria.desktop.R
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The home-screen widgets' shared part: where the link lives, the one request they make
 * (GET /api/worlds/<world>/glance with the widget key) and the last answer, kept so a widget
 * still shows something with no connection.
 *
 * The link (server, world, widget key) is written by the app (src/lib.rs, app_link) when a
 * page of the person's own server opens /app-link/widget. A widget key opens nothing but that
 * one read, for that one world.
 */
object Glance {
  const val EXTRA_PATH = "app.alexandria.desktop.OPEN_PATH"
  private const val PREFS = "alexandria_widget"

  data class Link(val server: String, val world: String, val key: String)

  /** Tauri's app_config_dir on Android: <dataDir>/<identifier>, next to settings.json. */
  private fun linkFile(ctx: Context) = File(File(ctx.dataDir, ctx.packageName), "widget.json")

  fun link(ctx: Context): Link? = try {
    val o = JSONObject(linkFile(ctx).readText())
    val server = o.getString("server").trimEnd('/')
    if (!server.startsWith("http://") && !server.startsWith("https://")) null
    else Link(server, o.getString("world"), o.getString("key"))
  } catch (_: Exception) { null }

  sealed class Result {
    data class Ok(val data: JSONObject) : Result()
    /** The key was revoked, or the person left the world. */
    object Unlinked : Result()
    data class Failed(val why: String) : Result()
  }

  /** Blocking: call from a worker thread. */
  fun fetch(l: Link): Result = try {
    val c = URL("${l.server}/api/worlds/${l.world}/glance").openConnection() as HttpURLConnection
    c.connectTimeout = 6000
    c.readTimeout = 6000
    c.setRequestProperty("Authorization", "Bearer ${l.key}")
    c.setRequestProperty("Accept", "application/json")
    try {
      when (val code = c.responseCode) {
        200 -> Result.Ok(JSONObject(c.inputStream.bufferedReader().use { it.readText() }))
        401, 403, 404 -> Result.Unlinked
        else -> Result.Failed("Server said $code")
      }
    } finally { c.disconnect() }
  } catch (e: Exception) { Result.Failed("No connection") }

  fun save(ctx: Context, o: JSONObject) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("last", o.toString()).apply()
  }

  fun cached(ctx: Context): JSONObject? = try {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("last", null)?.let { JSONObject(it) }
  } catch (_: Exception) { null }

  fun clearCache(ctx: Context) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }

  /** Ask every Alexandria widget to load again (after the app closes, or the refresh button). */
  fun refreshAll(ctx: Context) {
    for (cls in listOf(CharacterWidget::class.java, TableWidget::class.java)) {
      val mgr = AppWidgetManager.getInstance(ctx)
      val ids = mgr.getAppWidgetIds(ComponentName(ctx, cls))
      if (ids.isEmpty()) continue
      ctx.sendBroadcast(Intent(ctx, cls).setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE).putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids))
    }
  }

  /** Opens the app at a page of the world (MainActivity loads it once the web view is up). */
  fun openApp(ctx: Context, path: String, request: Int): PendingIntent {
    val i = Intent(ctx, MainActivity::class.java)
      .setAction(Intent.ACTION_VIEW)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_PATH, path)
    return PendingIntent.getActivity(ctx, request, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun refreshIntent(ctx: Context, cls: Class<*>, ids: IntArray): PendingIntent {
    val i = Intent(ctx, cls).setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE).putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
    return PendingIntent.getBroadcast(ctx, cls.name.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  // ---- reading the glance ----------------------------------------------------------------

  /** The server's ISO times ("2026-11-26T19:00:00.000Z"); java.time needs API 26, the app starts at 24. */
  fun parseIso(s: String): Date? {
    for (p in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX")) {
      try { return SimpleDateFormat(p, Locale.US).parse(s) } catch (_: Exception) {}
    }
    return null
  }

  fun isDM(o: JSONObject) = o.optString("role") == "dm"

  fun worldPath(o: JSONObject, page: String = ""): String {
    val slug = o.optJSONObject("world")?.optString("slug").orEmpty()
    val base = if (isDM(o)) "/w/$slug/dm" else "/w/$slug"
    return if (page.isEmpty()) base else "$base/$page"
  }

  fun str(o: JSONObject?, key: String): String? = if (o == null || o.isNull(key)) null else o.optString(key).takeIf { it.isNotEmpty() }
  fun int(o: JSONObject?, key: String): Int? = if (o == null || o.isNull(key)) null else o.optInt(key)

  /** "23 / 40 (+5)", or null when there is no number. */
  fun hpText(me: JSONObject?): String? {
    val hp = int(me, "hp") ?: return null
    val max = int(me, "maxHp")
    val temp = int(me, "tempHp") ?: 0
    return buildString {
      append(hp)
      if (max != null) append(" / ").append(max)
      if (temp > 0) append(" (+").append(temp).append(")")
    }
  }

  fun percent(now: Int?, max: Int?): Int = if (now == null || max == null || max <= 0) 0 else (now * 100 / max).coerceIn(0, 100)

  fun conditions(me: JSONObject?): String? {
    val arr = me?.optJSONArray("conditions") ?: return null
    if (arr.length() == 0) return null
    return (0 until arr.length()).joinToString(", ") { arr.optString(it) }
  }

  /** "Round 3 · your turn", "Live · 4 here", or "Next: Fri 28 Nov, 19:00 · Into the Crypt · going". */
  fun sessionLine(o: JSONObject): String {
    val combat = o.optJSONObject("combat")
    val session = o.optJSONObject("session")
    if (combat?.optBoolean("active") == true) {
      val parts = mutableListOf("Fight · round ${combat.optInt("round", 1)}")
      when {
        combat.optBoolean("myTurn") -> parts.add("your turn!")
        str(combat, "turnName") != null -> parts.add("${str(combat, "turnName")}'s turn")
      }
      return parts.joinToString(" · ")
    }
    if (session?.optBoolean("live") == true) {
      val title = str(session, "title")
      val here = session.optInt("here", 0)
      return listOfNotNull("Session live", title, if (here > 0) "$here here" else null).joinToString(" · ")
    }
    val next = o.optJSONObject("next") ?: return "No game night set"
    val whenText = str(next, "startsAt")?.let { iso ->
      parseIso(iso)?.let { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(it) }
    }
    val rsvp = when (str(next, "rsvp")) { "yes" -> "going"; "maybe" -> "maybe"; "no" -> "not going"; else -> if (isDM(o)) "${next.optInt("going")} going" else "answer in the app" }
    return listOfNotNull("Next", whenText, str(next, "title"), rsvp).joinToString(" · ")
  }

  /** "Quick event: Something moves", "2 quick events", or null. */
  fun quickLine(o: JSONObject): String? {
    val q = o.optJSONArray("quick") ?: return null
    val open = (0 until q.length()).map { q.getJSONObject(it) }.filter { isDM(o) || !it.optBoolean("answered") }
    if (open.isEmpty()) return null
    if (isDM(o)) {
      val e = open[0]
      return "Quick event: ${e.optString("title")} (${e.optInt("answers")}/${e.optInt("of")} answered)" + if (open.size > 1) " +${open.size - 1}" else ""
    }
    return if (open.size == 1) "Quick event: ${open[0].optString("title")}, answer now" else "${open.size} quick events waiting"
  }

  /** "2 offers · 1 reply" (players) or "3 approvals · 1 request" (DM). */
  fun waitingLine(o: JSONObject): String? {
    val w = o.optJSONObject("waiting") ?: return null
    val label = mapOf("offers" to "offer", "replies" to "reply from the DM", "approvals" to "approval", "requests" to "request", "broker" to "broker question")
    val parts = w.keys().asSequence().mapNotNull { k ->
      val n = w.optInt(k)
      if (n <= 0) null else "$n ${label[k] ?: k}${if (n == 1 || k == "replies") "" else "s"}"
    }.toList()
    return if (parts.isEmpty()) null else parts.joinToString(" · ")
  }

  fun updatedText(ctx: Context, o: JSONObject, stale: Boolean): String {
    val at = str(o, "at")?.let { iso -> parseIso(iso)?.let { DateFormat.getTimeInstance(DateFormat.SHORT).format(it) } }
    return when {
      stale && at != null -> ctx.getString(R.string.widget_offline_since, at)
      at != null -> ctx.getString(R.string.widget_updated, at)
      else -> ""
    }
  }

  fun show(v: RemoteViews, id: Int, text: String?) {
    if (text.isNullOrEmpty()) v.setViewVisibility(id, View.GONE)
    else { v.setTextViewText(id, text); v.setViewVisibility(id, View.VISIBLE) }
  }
}
