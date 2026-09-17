package ng.telco.bridge

import android.content.Context

// Where the phone keeps the two things it needs and what it last reported.
// The token is stored here because the app must present it on every upload;
// the phone is a company phone dedicated to this job.
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("bridge", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", "") ?: ""
        set(v) = prefs.edit().putString("serverUrl", v.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()

    var lastResult: String
        get() = prefs.getString("lastResult", "Nothing sent yet.") ?: ""
        set(v) = prefs.edit().putString("lastResult", v).putLong("lastAt", System.currentTimeMillis()).apply()

    val lastAt: Long get() = prefs.getLong("lastAt", 0L)

    val configured: Boolean get() = serverUrl.startsWith("https://") && token.isNotEmpty()
}
