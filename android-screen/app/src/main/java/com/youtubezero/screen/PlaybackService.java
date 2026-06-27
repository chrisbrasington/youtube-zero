package com.youtubezero.screen;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Foreground service that makes the WebView behave like a real media app:
 *   - keeps the process alive while a video plays, so audio survives the app
 *     being backgrounded or the phone being locked;
 *   - owns a {@link MediaSession} + a MediaStyle notification, so playback shows
 *     up in the system media controls (notification shade, lock screen, BT).
 *
 * The actual audio is produced by the WebView in {@link MainActivity}. This
 * service only holds the session/notification and forwards transport commands
 * (play/pause/next/prev) back to the page via JS, which drives the YT player.
 * The page reports its state here through the AndroidMedia JS bridge.
 */
public class PlaybackService extends Service {

    static final String ACTION_UPDATE = "com.youtubezero.screen.UPDATE";
    static final String ACTION_STOP   = "com.youtubezero.screen.STOP";
    static final String ACTION_TOGGLE = "com.youtubezero.screen.TOGGLE";
    static final String ACTION_NEXT   = "com.youtubezero.screen.NEXT";
    static final String ACTION_PREV   = "com.youtubezero.screen.PREV";
    static final String EXTRA_PLAYING  = "playing";
    static final String EXTRA_TITLE    = "title";
    static final String EXTRA_ARTIST   = "artist";
    static final String EXTRA_VIDEO_ID = "videoId";

    private static final String CHANNEL_ID = "playback";
    private static final int NOTIF_ID = 1001;

    private MediaSession session;
    private boolean playing = false;
    private String title = "";
    private String artist = "";
    private String videoId = "";
    private Bitmap art;                                       // current thumbnail, or null
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null
                && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        session = new MediaSession(this, "yt-zero");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay()           { MainActivity.evalJs("nativeTogglePlay()"); }
            @Override public void onPause()          { MainActivity.evalJs("nativeTogglePlay()"); }
            @Override public void onStop()           { MainActivity.evalJs("nativeTogglePlay()"); }
            @Override public void onSkipToNext()     { MainActivity.evalJs("nativeNext()"); }
            @Override public void onSkipToPrevious() { MainActivity.evalJs("nativePrev()"); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) { stopPlayback(); return START_NOT_STICKY; }
        if (ACTION_TOGGLE.equals(action)) { MainActivity.evalJs("nativeTogglePlay()"); return START_STICKY; }
        if (ACTION_NEXT.equals(action))   { MainActivity.evalJs("nativeNext()");       return START_STICKY; }
        if (ACTION_PREV.equals(action))   { MainActivity.evalJs("nativePrev()");        return START_STICKY; }

        // ACTION_UPDATE (or a sticky restart with null intent)
        if (intent != null) {
            playing = intent.getBooleanExtra(EXTRA_PLAYING, playing);
            String t = intent.getStringExtra(EXTRA_TITLE);
            String a = intent.getStringExtra(EXTRA_ARTIST);
            String v = intent.getStringExtra(EXTRA_VIDEO_ID);
            if (t != null) title = t;
            if (a != null) artist = a;
            if (v != null && !v.equals(videoId)) {
                videoId = v;
                art = null;          // drop stale thumbnail; fetch the new one
                fetchArt(v);
            }
        }
        refresh();
        return START_STICKY;
    }

    /** Push current state to the MediaSession and (re)post the foreground notification. */
    private void refresh() {
        updateSession();
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    /** Download the YouTube thumbnail off the main thread, then refresh if still current. */
    private void fetchArt(final String vid) {
        if (vid.isEmpty()) return;
        new Thread(() -> {
            Bitmap bmp = null;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(
                        "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg").openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                InputStream in = c.getInputStream();
                bmp = BitmapFactory.decodeStream(in);
                in.close();
            } catch (Exception e) {
                return;
            } finally {
                if (c != null) c.disconnect();
            }
            final Bitmap result = bmp;
            if (result == null) return;
            main.post(() -> {
                if (vid.equals(videoId)) {   // ignore if the video moved on while loading
                    art = result;
                    refresh();
                }
            });
        }).start();
    }

    private void updateSession() {
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist);
        if (art != null) {
            md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
            md.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, art);
        }
        session.setMetadata(md.build());
        int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build());
    }

    private Notification buildNotification() {
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle(title.isEmpty() ? "YT Zero" : title);
        b.setContentText(artist);
        b.setSmallIcon(R.mipmap.ic_launcher);
        if (art != null) b.setLargeIcon(art);
        b.setVisibility(Notification.VISIBILITY_PUBLIC);
        b.setOngoing(playing);
        b.setContentIntent(launchIntent());

        b.addAction(action(android.R.drawable.ic_media_previous, "Prev", ACTION_PREV));
        b.addAction(playing
                ? action(android.R.drawable.ic_media_pause, "Pause", ACTION_TOGGLE)
                : action(android.R.drawable.ic_media_play,  "Play",  ACTION_TOGGLE));
        b.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT));

        b.setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private Notification.Action action(int icon, String label, String act) {
        Intent i = new Intent(this, PlaybackService.class).setAction(act);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getService(this, act.hashCode(), i, flags);
        return new Notification.Action.Builder(icon, label, pi).build();
    }

    private PendingIntent launchIntent() {
        Intent i = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private void stopPlayback() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }
}
