package com.youtubezero.screen;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.webkit.WebView;

/**
 * A WebView that does NOT pause its media when the host window is backgrounded.
 *
 * A plain WebView pauses HTML5 media (and JS timers) the moment its window
 * visibility flips away from VISIBLE — this happens on lock/minimize even if the
 * Activity never calls web.onPause(). Reporting VISIBLE keeps audio decoding so
 * playback continues in the background; PlaybackService keeps the process alive
 * and surfaces the media controls.
 */
public class MediaWebView extends WebView {

    public MediaWebView(Context context) { super(context); }
    public MediaWebView(Context context, AttributeSet attrs) { super(context, attrs); }
    public MediaWebView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        // GONE = truly detached/destroyed → let it stop. Otherwise stay "visible"
        // so backgrounding (INVISIBLE) doesn't pause playback.
        super.onWindowVisibilityChanged(visibility == View.GONE ? View.GONE : View.VISIBLE);
    }
}
