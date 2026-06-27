package com.youtubezero.screen;

import android.content.Context;
import android.util.AttributeSet;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;

/**
 * A WebView that does NOT let Chromium suspend its media when the host window is
 * backgrounded (lock/minimize). A plain WebView pauses HTML5 media + JS timers as
 * soon as the window visibility leaves VISIBLE — and that's independent of whether
 * the Activity calls web.onPause().
 *
 * Chromium observes window visibility through several paths, so we force "visible"
 * on all of them (unless GONE = truly detached). Logs let us confirm on-device
 * which transitions actually fire (`adb logcat -s YTZeroMedia`).
 */
public class MediaWebView extends WebView {

    static final String TAG = "YTZeroMedia";

    public MediaWebView(Context context) { super(context); }
    public MediaWebView(Context context, AttributeSet attrs) { super(context, attrs); }
    public MediaWebView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    @Override
    public void dispatchWindowVisibilityChanged(int visibility) {
        Log.i(TAG, "dispatchWindowVisibilityChanged real=" + visibility);
        super.dispatchWindowVisibilityChanged(visibility == View.GONE ? View.GONE : View.VISIBLE);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(visibility == View.GONE ? View.GONE : View.VISIBLE);
    }

    @Override
    public int getWindowVisibility() {
        int real = super.getWindowVisibility();
        return real == View.GONE ? View.GONE : View.VISIBLE;
    }
}
