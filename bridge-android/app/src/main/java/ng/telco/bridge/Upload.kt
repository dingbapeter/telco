package ng.telco.bridge

import android.content.Context
import android.os.BatteryManager
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

object Upload {
    private const val ONE_OFF = "upload-now"
    private const val PERIODIC = "heartbeat"
    const val BATCH = 100

    private val needsNetwork = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    // Runs as soon as there is a connection, and keeps trying with a growing
    // wait until the server has accepted everything.
    fun now(context: Context) {
        val work = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(needsNetwork)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(ONE_OFF, ExistingWorkPolicy.APPEND_OR_REPLACE, work)
    }

    // Every 15 minutes, the shortest Android allows, the phone reports in
    // even with nothing to send, so the command centre knows it is alive.
    fun schedulePeriodic(context: Context) {
        val work = PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES)
            .setConstraints(needsNetwork)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work)
    }
}

class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        val settings = Settings(ctx)
        if (!settings.configured) {
            settings.lastResult = "Not set up yet. Enter the server address (https) and the token."
            return Result.failure()
        }
        return try {
            var sentAny = false
            do {
                val batch = Queue.peek(ctx, Upload.BATCH)
                val body = JSONObject()
                    .put("messages", batch)
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("battery", battery(ctx))
                    .put("queueSize", Queue.size(ctx))
                val (status, response) = post(settings.serverUrl + "/bridge/messages", settings.token, body.toString())
                when (status) {
                    200 -> {
                        Queue.removeFirst(ctx, batch.length())
                        sentAny = sentAny || batch.length() > 0
                        settings.lastResult = if (batch.length() == 0) "Reported in; nothing waiting." else "Sent ${batch.length()} message(s). " + summarise(response)
                    }
                    401 -> {
                        settings.lastResult = "The server does not recognise this phone's token. Create the phone again in the command centre and enter the new token."
                        return Result.failure()
                    }
                    else -> {
                        settings.lastResult = "Server answered $status. Will try again. " + response.take(200)
                        return Result.retry()
                    }
                }
            } while (batch.length() == Upload.BATCH)
            Result.success()
        } catch (e: Exception) {
            settings.lastResult = "Could not reach the server (${e.javaClass.simpleName}: ${e.message}). Will try again when there is a connection."
            Result.retry()
        }
    }

    private fun summarise(response: String): String = try {
        val results = JSONObject(response).getJSONArray("results")
        val counts = HashMap<String, Int>()
        for (i in 0 until results.length()) {
            val o = results.getJSONObject(i).getString("outcome")
            counts[o] = (counts[o] ?: 0) + 1
        }
        counts.entries.joinToString(", ") { "${it.value} ${it.key}" }
    } catch (e: Exception) {
        ""
    }

    private fun battery(ctx: Context): Int {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
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
