package app.alexandria.desktop.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.view.View
import android.widget.RemoteViews
import app.alexandria.desktop.R
import org.json.JSONObject

/**
 * Loads the glance and draws it. On every update the last answer is drawn at once (so the
 * widget is never blank), then a fresh one is fetched off the main thread.
 */
abstract class GlanceWidget : AppWidgetProvider() {
  /** Draw a glance. `stale` when it is the saved one because the server could not be reached. */
  abstract fun draw(ctx: Context, o: JSONObject, stale: Boolean, ids: IntArray): RemoteViews
  abstract val layout: Int

  override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
    val link = Glance.link(ctx)
    if (link == null) {
      Glance.clearCache(ctx)
      mgr.updateAppWidget(ids, message(ctx, ids, ctx.getString(R.string.widget_not_linked)))
      return
    }
    Glance.cached(ctx)?.let { mgr.updateAppWidget(ids, draw(ctx, it, true, ids)) }
    val pending = goAsync()
    Thread {
      try {
        val views = when (val r = Glance.fetch(link)) {
          is Glance.Result.Ok -> { Glance.save(ctx, r.data); draw(ctx, r.data, false, ids) }
          is Glance.Result.Unlinked -> { Glance.clearCache(ctx); message(ctx, ids, ctx.getString(R.string.widget_link_expired)) }
          is Glance.Result.Failed -> Glance.cached(ctx)?.let { draw(ctx, it, true, ids) } ?: message(ctx, ids, r.why)
        }
        mgr.updateAppWidget(ids, views)
      } finally {
        pending.finish()
      }
    }.start()
  }

  /** A single line, e.g. "Link the widget in the app". Tapping opens the app. */
  private fun message(ctx: Context, ids: IntArray, text: String): RemoteViews {
    val v = RemoteViews(ctx.packageName, R.layout.widget_message)
    v.setTextViewText(R.id.w_message, text)
    v.setOnClickPendingIntent(R.id.w_root, Glance.openApp(ctx, "", 1))
    return v
  }

  protected fun common(ctx: Context, v: RemoteViews, o: JSONObject, stale: Boolean, ids: IntArray) {
    v.setTextViewText(R.id.w_updated, Glance.updatedText(ctx, o, stale))
    v.setOnClickPendingIntent(R.id.w_refresh, Glance.refreshIntent(ctx, javaClass, ids))
  }

  /** HP and mana bars: shown only when there is a number. */
  protected fun bars(v: RemoteViews, o: JSONObject) {
    val me = o.optJSONObject("combat")?.optJSONObject("me")
    val hp = Glance.hpText(me)
    if (hp != null) {
      v.setViewVisibility(R.id.w_hp_row, View.VISIBLE)
      v.setTextViewText(R.id.w_hp, hp)
      v.setProgressBar(R.id.w_hp_bar, 100, Glance.percent(Glance.int(me, "hp"), Glance.int(me, "maxHp")), false)
    } else v.setViewVisibility(R.id.w_hp_row, View.GONE)
    val mana = o.optJSONObject("mana")
    val now = Glance.int(mana, "now")
    if (mana != null && now != null) {
      val max = Glance.int(mana, "max")
      v.setViewVisibility(R.id.w_mana_row, View.VISIBLE)
      v.setTextViewText(R.id.w_mana, if (max != null) "$now / $max" else "$now")
      v.setProgressBar(R.id.w_mana_bar, 100, Glance.percent(now, max), false)
    } else v.setViewVisibility(R.id.w_mana_row, View.GONE)
    Glance.show(v, R.id.w_conditions, Glance.conditions(me))
  }
}

/** Small (2x1 and up): your HP, mana and conditions, or whose turn it is for the DM. */
class CharacterWidget : GlanceWidget() {
  override val layout = R.layout.widget_character

  override fun draw(ctx: Context, o: JSONObject, stale: Boolean, ids: IntArray): RemoteViews {
    val v = RemoteViews(ctx.packageName, layout)
    v.setTextViewText(R.id.w_name, o.optString("name").ifEmpty { o.optJSONObject("world")?.optString("name").orEmpty() })
    bars(v, o)
    val me = o.optJSONObject("combat")?.optJSONObject("me")
    val hasNumbers = Glance.hpText(me) != null || o.optJSONObject("mana")?.isNull("now") == false
    // Nothing to show as a bar (no fight and no mana, or the DM): the session line instead.
    Glance.show(v, R.id.w_line, if (hasNumbers && o.optJSONObject("combat")?.optBoolean("myTurn") != true) null else Glance.sessionLine(o))
    common(ctx, v, o, stale, ids)
    val inFight = o.optJSONObject("combat")?.optBoolean("active") == true
    v.setOnClickPendingIntent(R.id.w_root, Glance.openApp(ctx, Glance.worldPath(o, if (inFight) (if (Glance.isDM(o)) "combat" else "live") else ""), 2))
    return v
  }
}

/** Large (4x2 and up): the world date, the session, quick events, your bars and what waits for you. */
class TableWidget : GlanceWidget() {
  override val layout = R.layout.widget_table

  override fun draw(ctx: Context, o: JSONObject, stale: Boolean, ids: IntArray): RemoteViews {
    val v = RemoteViews(ctx.packageName, layout)
    v.setTextViewText(R.id.w_world, o.optJSONObject("world")?.optString("name").orEmpty())
    Glance.show(v, R.id.w_date, Glance.str(o, "date"))
    v.setTextViewText(R.id.w_session, Glance.sessionLine(o))
    Glance.show(v, R.id.w_quick, Glance.quickLine(o))
    Glance.show(v, R.id.w_waiting, Glance.waitingLine(o))
    bars(v, o)
    common(ctx, v, o, stale, ids)
    v.setOnClickPendingIntent(R.id.w_root, Glance.openApp(ctx, Glance.worldPath(o), 3))
    val inFight = o.optJSONObject("combat")?.optBoolean("active") == true
    v.setOnClickPendingIntent(R.id.w_session, Glance.openApp(ctx, Glance.worldPath(o, if (inFight) (if (Glance.isDM(o)) "combat" else "live") else if (Glance.isDM(o)) "" else "calendar"), 4))
    v.setOnClickPendingIntent(R.id.w_quick, Glance.openApp(ctx, Glance.worldPath(o, if (Glance.isDM(o)) "quick" else ""), 5))
    return v
  }
}
