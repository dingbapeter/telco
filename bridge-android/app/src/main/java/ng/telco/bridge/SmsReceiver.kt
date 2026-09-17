package ng.telco.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

// Every text message the phone receives is queued and an upload is asked
// for at once. The server decides which ones are airtime arriving.
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // A long message arrives in parts that share a sender; join them.
        val bySender = LinkedHashMap<String, StringBuilder>()
        var receivedAt = System.currentTimeMillis()
        for (part in parts) {
            val from = part.displayOriginatingAddress ?: "unknown"
            bySender.getOrPut(from) { StringBuilder() }.append(part.displayMessageBody ?: "")
            if (part.timestampMillis > 0) receivedAt = part.timestampMillis
        }
        for ((from, body) in bySender) Queue.add(context, from, body.toString(), receivedAt)
        Upload.now(context)
    }
}
