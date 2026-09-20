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
            // Only a dialling code is ever dialled. Anything else, however
            // it got here, is refused rather than sent to the network.
            if (!looksLikeUssd(code)) {
                settings.markDialled(id)
                val refused = JSONObject().put("ok", false).put("failure", "This phone refused to dial it: it is not a top-up code.")
                post(settings.serverUrl + "/bridge/commands/$id/result", settings.token, refused.toString())
                settings.lastCommand = "Command $id: refused, not a top-up code."
                continue
            }
            settings.markDialled(id)
            val result = dial(context, code)
            // The network often repeats the code it was sent, PIN and all.
            // The PIN never leaves this phone, so it is taken out of both
            // the reply we send back and the words shown on this screen.
            val response = hidePin(result.response, settings.pin)
            val failure = hidePin(result.failure, settings.pin)
            val payload = JSONObject().put("ok", result.ok)
            if (response != null) payload.put("response", response)
            if (failure != null) payload.put("failure", failure)
            post(settings.serverUrl + "/bridge/commands/$id/result", settings.token, payload.toString())
            settings.lastCommand = "Command $id: " + (if (result.ok) "dialled, reply: $response" else "failed: $failure")
            done += 1
            // Networks dislike back-to-back USSD sessions.
            Thread.sleep(4000)
        }
        return "Sent $done command(s)."
    }

    class DialResult(val ok: Boolean, val response: String?, val failure: String?)

    // A top-up code and nothing else. Two stars, or a star and a hash, at
    // the front is how a phone is told to forward its calls or change its
    // own settings, and no top-up code looks like that. The server keeps
    // the same rule, so neither side alone decides what a SIM may dial.
    fun looksLikeUssd(code: String): Boolean = Regex("^\\*[^*#][0-9*#A-Za-z ]{0,60}#$").matches(code)

    fun hidePin(text: String?, pin: String): String? {
        if (text == null || pin.isEmpty()) return text
        return text.replace(pin, "****")
    }

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
