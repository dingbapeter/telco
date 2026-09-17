package ng.telco.bridge

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.text.DateFormat
import java.util.Date

class MainActivity : AppCompatActivity() {
    private lateinit var settings: Settings
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            showStatus()
            handler.postDelayed(this, 2000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        settings = Settings(this)
        val url = findViewById<EditText>(R.id.serverUrl)
        val token = findViewById<EditText>(R.id.token)
        url.setText(settings.serverUrl)
        if (settings.token.isNotEmpty()) token.hint = "Token is saved. Type a new one to replace it."

        findViewById<Button>(R.id.save).setOnClickListener {
            settings.serverUrl = url.text.toString()
            if (token.text.isNotEmpty()) settings.token = token.text.toString()
            token.setText("")
            if (!settings.serverUrl.startsWith("https://")) {
                settings.lastResult = "The server address must start with https://"
            } else {
                settings.lastResult = "Saved. Connecting."
                Upload.now(this)
            }
            showStatus()
        }
        findViewById<Button>(R.id.grantSms).setOnClickListener {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECEIVE_SMS), 1)
        }
        findViewById<Button>(R.id.battery).setOnClickListener {
            val intent = Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            startActivity(intent)
        }
        findViewById<Button>(R.id.sendNow).setOnClickListener {
            settings.lastResult = "Sending."
            Upload.now(this)
            showStatus()
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(refresh)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(refresh)
    }

    private fun showStatus() {
        val smsOk = ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val batteryOk = pm.isIgnoringBatteryOptimizations(packageName)
        val lines = ArrayList<String>()
        lines.add(if (smsOk) "Reading text messages: allowed" else "Reading text messages: NOT allowed. Tap the button above.")
        lines.add(if (batteryOk) "Battery saving: off for this app" else "Battery saving: ON. The phone may stop reporting. Tap the button above.")
        lines.add(if (settings.configured) "Server: ${settings.serverUrl}" else "Server: not set up")
        lines.add("Waiting to send: ${Queue.size(this)}")
        val at = if (settings.lastAt > 0) DateFormat.getDateTimeInstance().format(Date(settings.lastAt)) else ""
        lines.add("Last result: ${settings.lastResult} $at")
        findViewById<TextView>(R.id.status).text = lines.joinToString("\n\n")
    }
}
