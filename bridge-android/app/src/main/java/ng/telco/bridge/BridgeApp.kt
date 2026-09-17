package ng.telco.bridge

import android.app.Application

class BridgeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Upload.schedulePeriodic(this)
    }
}
