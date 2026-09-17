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

    // The SIM's transfer PIN. It is used only to fill {pin} in a code the
    // server sends, on this phone, and is never uploaded.
    var pin: String
        get() = prefs.getString("pin", "") ?: ""
        set(v) = prefs.edit().putString("pin", v.trim()).apply()

    var lastCommand: String
        get() = prefs.getString("lastCommand", "Nothing sent from this SIM yet.") ?: ""
        set(v) = prefs.edit().putString("lastCommand", v).apply()

    // Commands this phone has already dialled, so a lost reply can never
    // make it dial the same one twice.
    fun wasDialled(id: Long): Boolean = prefs.getStringSet("dialled", emptySet())!!.contains(id.toString())
    fun markDialled(id: Long) {
        val set = HashSet(prefs.getStringSet("dialled", emptySet())!!)
        set.add(id.toString())
        // Keep the set small; ids only grow.
        val trimmed = set.map { it.toLong() }.sortedDescending().take(200).map { it.toString() }.toSet()
        prefs.edit().putStringSet("dialled", trimmed).apply()
    }

    val configured: Boolean get() = serverUrl.startsWith("https://") && token.isNotEmpty()
}
