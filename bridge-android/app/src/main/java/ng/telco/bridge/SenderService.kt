package ng.telco.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// Keeps the phone asking the server for things to send, every thirty
// seconds, for as long as the phone is on. A visible notification is the
// price Android charges for that, and it says plainly what the app does.
class SenderService : Service() {
    private val pool = Executors.newSingleThreadScheduledExecutor()

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Telco bridge", NotificationManager.IMPORTANCE_LOW))
        }
        val note: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.service_title))
            .setContentText(getString(R.string.service_text))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
        startForeground(1, note)
        pool.scheduleWithFixedDelay({
            try {
                val outcome = Sender.run(this)
                if (outcome != "Nothing to send." && outcome != "Not set up.") Settings(this).lastCommand = outcome
                Upload.now(this)
            } catch (e: Exception) {
                Settings(this).lastCommand = "Sending loop error: ${e.javaClass.simpleName} ${e.message}"
            }
        }, 5, 30, TimeUnit.SECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        pool.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val CHANNEL = "bridge"
        fun start(context: Context) {
            val intent = Intent(context, SenderService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }
    }
}
