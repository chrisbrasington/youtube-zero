package com.youtubezero.screen;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Fullscreen WebView wrapper for youtube-zero's /watch screen.
 *
 * The whole app is this one activity: it loads <server_url>?name=<screen_name>&kiosk=1
 * (both from res/values/config.xml) and lets the page do everything else. The kiosk
 * flag tells /watch it may autoplay with sound, which works here because the WebView
 * is configured with mediaPlaybackRequiresUserGesture(false).
 */
public class MainActivity extends Activity {

    private FrameLayout root;
    private WebView web;
    private View customView;                                  // YouTube/page fullscreen view
    private WebChromeClient.CustomViewCallback customCallback;
    private boolean immersive = true;                         // false for the phone flavor

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        immersive = getResources().getBoolean(R.bool.immersive);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        setContentView(root);

        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);                  // localStorage → stable screen id/name
        ws.setMediaPlaybackRequiresUserGesture(false);  // autoplay WITH sound
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        // Force YouTube's desktop player (the default WebView UA gets the mobile
        // player, which ignores the caption-toggle API and single-click play/pause).
        ws.setUserAgentString("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode,
                                        String description, String failingUrl) {
                // Screen may boot before the server is reachable — keep retrying.
                view.postDelayed(() -> view.loadUrl(buildUrl()), 5000);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view;
                customCallback = callback;
                root.addView(customView, new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                hideSystemUi();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                if (customCallback != null) {
                    customCallback.onCustomViewHidden();
                    customCallback = null;
                }
                hideSystemUi();
            }
        });

        if (immersive) hideSystemUi();
        web.loadUrl(buildUrl());
    }

    private String buildUrl() {
        String url = getString(R.string.server_url);
        String name = getString(R.string.screen_name);
        url += url.contains("?") ? "&" : "?";
        if (name != null && !name.isEmpty()) {
            url += "name=" + Uri.encode(name) + "&";
        }
        return url + "kiosk=1";
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
              | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersive) hideSystemUi();
    }

    // Intercept the remote's center/OK at dispatch — BEFORE the focused WebView can
    // consume it (that's why the earlier onKeyDown version did nothing). This remote
    // sends Linux KEY_SELECT → Android DPAD_CENTER; we also cover the other common
    // "OK"/select/play-pause codes. Center = one-tap play/pause and nothing else.
    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        int kc = event.getKeyCode();
        android.util.Log.i("ScreenKey", "keyCode=" + kc + " action=" + event.getAction());
        switch (kc) {
            case android.view.KeyEvent.KEYCODE_DPAD_CENTER:
            case android.view.KeyEvent.KEYCODE_ENTER:
            case android.view.KeyEvent.KEYCODE_NUMPAD_ENTER:
            case android.view.KeyEvent.KEYCODE_BUTTON_SELECT:
            case android.view.KeyEvent.KEYCODE_BUTTON_A:
            case android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                if (event.getAction() == android.view.KeyEvent.ACTION_DOWN
                        && event.getRepeatCount() == 0 && web != null) {
                    web.evaluateJavascript(
                        "if (typeof castTogglePlay==='function') castTogglePlay();", null);
                }
                return true;   // consume down+up so the player doesn't also act on it

            // D-pad directions. Forwarded to the page so /watch can drive the whole
            // UI (seek while watching; move a focus cursor over the queue/buttons
            // when the queue is shown). Without this they'd reach the focused
            // YouTube iframe and just seek/change volume. Left/right allow key-repeat
            // (hold to scrub); up/down are discrete (repeatCount == 0 only).
            case android.view.KeyEvent.KEYCODE_DPAD_LEFT:
            case android.view.KeyEvent.KEYCODE_DPAD_RIGHT:
            case android.view.KeyEvent.KEYCODE_DPAD_UP:
            case android.view.KeyEvent.KEYCODE_DPAD_DOWN:
                if (event.getAction() == android.view.KeyEvent.ACTION_DOWN && web != null) {
                    boolean vertical = (kc == android.view.KeyEvent.KEYCODE_DPAD_UP
                                     || kc == android.view.KeyEvent.KEYCODE_DPAD_DOWN);
                    if (!vertical || event.getRepeatCount() == 0) {
                        String dir = kc == android.view.KeyEvent.KEYCODE_DPAD_LEFT  ? "left"
                                   : kc == android.view.KeyEvent.KEYCODE_DPAD_RIGHT ? "right"
                                   : kc == android.view.KeyEvent.KEYCODE_DPAD_UP    ? "up"
                                   :                                                  "down";
                        web.evaluateJavascript(
                            "if (typeof castKey==='function') castKey('" + dir + "');", null);
                    }
                }
                return true;   // consume so the iframe doesn't also act on it
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) { web.getWebChromeClient().onHideCustomView(); return; }
        if (web != null) {
            // Let the page handle Back first: if a player overlay is open it
            // closes it (back to the browse page on /tv, or idle on /watch) and
            // returns true. Only when the page doesn't handle it do we exit.
            web.evaluateJavascript(
                "(typeof castBack==='function') ? castBack() : false",
                value -> {
                    if (!"true".equals(value)) {
                        if (web.canGoBack()) web.goBack();
                        else finish();
                    }
                });
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
