package ng.telco.bridge

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// Messages waiting to be sent, kept in a file so nothing is lost when the
// phone has no signal, restarts, or the app is killed to save memory.
object Queue {
    private const val FILE = "queue.json"
    private val lock = Any()

    fun add(context: Context, from: String, body: String, receivedAtMillis: Long) {
        synchronized(lock) {
            val all = readAll(context)
            all.put(JSONObject().put("from", from).put("body", body).put("receivedAt", Iso.format(receivedAtMillis)))
            write(context, all)
        }
    }

    fun peek(context: Context, max: Int): JSONArray = synchronized(lock) {
        val all = readAll(context)
        val out = JSONArray()
        for (i in 0 until minOf(max, all.length())) out.put(all.getJSONObject(i))
        out
    }

    fun removeFirst(context: Context, count: Int) {
        synchronized(lock) {
            val all = readAll(context)
            val rest = JSONArray()
            for (i in count until all.length()) rest.put(all.getJSONObject(i))
            write(context, rest)
        }
    }

    fun size(context: Context): Int = synchronized(lock) { readAll(context).length() }

    private fun file(context: Context) = File(context.filesDir, FILE)

    private fun readAll(context: Context): JSONArray {
        val f = file(context)
        if (!f.exists()) return JSONArray()
        return try {
            JSONArray(f.readText())
        } catch (e: Exception) {
            // A half-written file after a crash must not stop future messages.
            JSONArray()
        }
    }

    private fun write(context: Context, arr: JSONArray) {
        val tmp = File(context.filesDir, "$FILE.tmp")
        tmp.writeText(arr.toString())
        tmp.renameTo(file(context))
    }
}

object Iso {
    fun format(millis: Long): String {
        val f = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        f.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return f.format(java.util.Date(millis))
    }
}
