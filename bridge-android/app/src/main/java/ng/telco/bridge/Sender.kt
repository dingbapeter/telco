package ng.telco.bridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// Asks the server for things to dial, dials each one on this SIM with the
// PIN filled in, and reports the network's reply. One at a time, each once.
object Sender {
    fun canSend(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED

    fun run(context: Context): String {
        val settings = Settings(context)
        if (!settings.configured) return "Not set up."
        if (!canSend(context)) return "Sending not allowed yet."
        if (settings.pin.isEmpty()) return "No PIN entered."
        val (status, body) = post(settings.serverUrl + "/bridge/commands/fetch", settings.token, "{}")
        if (status != 200) return "Could not fetch commands: HTTP $status"
        val commands = JSONObject(body).optJSONArray("commands") ?: JSONArray()
        if (commands.length() == 0) return "Nothing to send."
        var done = 0
        for (i in 0 until commands.length()) {
            val c = commands.getJSONObject(i)
            val id = c.getLong("id")
            if (settings.wasDialled(id)) continue
            val code = c.getString("code").replace("{pin}", settings.pin)
            settings.markDialled(id)
            val result = dial(context, code)
            val payload = JSONObject().put("ok", result.ok)
            if (result.response != null) payload.put("response", result.response)
            if (result.failure != null) payload.put("failure", result.failure)
            post(settings.serverUrl + "/bridge/commands/$id/result", settings.token, payload.toString())
            settings.lastCommand = "Command $id: " + (if (result.ok) "dialled, reply: ${result.response}" else "failed: ${result.failure}")
            done += 1
            // Networks dislike back-to-back USSD sessions.
            Thread.sleep(4000)
        }
        return "Sent $done command(s)."
    }

    class DialResult(val ok: Boolean, val response: String?, val failure: String?)

    // A single USSD request and its reply. Menus that need a second step
    // cannot be driven this way; the network's text message settles those.
    private fun dial(context: Context, code: String): DialResult {
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        val latch = CountDownLatch(1)
        var out = DialResult(false, null, "No reply from the dialler.")
        val handler = Handler(Looper.getMainLooper())
        try {
            handler.post {
                try {
                    tm.sendUssdRequest(code, object : TelephonyManager.UssdResponseCallback() {
                        override fun onReceiveUssdResponse(telephonyManager: TelephonyManager, request: String, response: CharSequence) {
                            out = DialResult(true, response.toString(), null)
                            latch.countDown()
                        }
                        override fun onReceiveUssdResponseFailed(telephonyManager: TelephonyManager, request: String, failureCode: Int) {
                            val why = if (failureCode == TelephonyManager.USSD_ERROR_SERVICE_UNAVAIL) "USSD service unavailable, try again later" else "USSD request failed (code $failureCode)"
                            out = DialResult(false, null, why)
                            latch.countDown()
                        }
                    }, handler)
                } catch (e: SecurityException) {
                    out = DialResult(false, null, "Sending is not allowed: ${e.message}")
                    latch.countDown()
                } catch (e: Exception) {
                    out = DialResult(false, null, "Could not dial: ${e.javaClass.simpleName} ${e.message}")
                    latch.countDown()
                }
            }
            if (!latch.await(45, TimeUnit.SECONDS)) out = DialResult(false, null, "USSD timeout, no reply in 45 seconds, try again later")
        } catch (e: InterruptedException) {
            out = DialResult(false, null, "Interrupted while dialling")
        }
        return out
    }

    private fun post(url: String, token: String, json: String): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 20_000
        conn.readTimeout = 30_000
        conn.doOutput = true
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        return status to text
    }
}
