package ng.telco.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// After a restart, make sure the regular heartbeat is scheduled and anything
// queued before the restart goes out.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Upload.schedulePeriodic(context)
            Upload.now(context)
            if (Settings(context).configured) SenderService.start(context)
        }
    }
}
