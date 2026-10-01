package com.worksuite.app;

/*
 * WorkSuite for Android.
 *
 * A WebView onto the deployed workspace: the site is always the live one,
 * so the app never has to be updated to keep up with it. What the WebView
 * needs from Android is arranged here — camera and microphone for calls,
 * a location fix for attendance, and a file picker for attachments.
 *
 * Only the site's own origin (WebPolicy) gets the camera, microphone or
 * location, and only links Android can safely hand on leave the app.
 */

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.CookieManager;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_MEDIA = 1002;
    private static final int REQ_NOTIFY = 1003;
    private static final int REQ_LOCATION = 1004;
    private static final String CHANNEL = "worksuite";

    /* A WebView has no Notification API of its own, so the page's notifications
       would go nowhere. This hands them to Android instead; the polyfill below
       makes `new Notification(...)` on the page arrive here unchanged. */
    private static final String NOTIFY_SHIM =
        "(function(){if(!window.WorkSuiteNotify||window.Notification&&window.Notification.__ws)return;" +
        "function N(t,o){o=o||{};try{WorkSuiteNotify.show(String(t||''),String(o.body||''),String(o.tag||''));}catch(e){}" +
        "this.close=function(){};}" +
        "N.__ws=true;N.permission='granted';N.requestPermission=function(cb){" +
        "var p=Promise.resolve('granted');if(cb)cb('granted');return p;};" +
        "window.Notification=N;})();";

    /** A page's location request, held while Android asks the person. */
    private static final class PendingGeo {
        final String origin;
        final GeolocationPermissions.Callback callback;
        PendingGeo(String origin, GeolocationPermissions.Callback callback) {
            this.origin = origin;
            this.callback = callback;
        }
    }

    private WebPolicy policy;
    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;
    /* Camera / microphone: the page's request and the resources it may have. */
    private PermissionRequest pendingMedia;
    private String[] pendingMediaResources;
    private boolean mediaPromptOpen;
    /* Location: every prompt that arrived while Android's dialog was up. */
    private final List<PendingGeo> pendingGeo = new ArrayList<>();
    private boolean locationPromptOpen;
    /** Whether the main frame shows our own site; read on the JavaScript bridge's thread. */
    private volatile boolean trustedPage;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        policy = new WebPolicy(BuildConfig.SITE_URL);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // ringtones and call audio
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setUserAgentString(s.getUserAgentString() + " WorkSuiteAndroid");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new NotifyBridge(), "WorkSuiteNotify");
        createChannel();
        askToNotify();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                trustedPage = policy.isTrustedOrigin(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                trustedPage = policy.isTrustedOrigin(url);
                if (trustedPage) view.evaluateJavascript(NOTIFY_SHIM, null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                switch (policy.classify(url.toString(), request.isForMainFrame())) {
                    case STAY:
                        return false;
                    case EXTERNAL:
                        // Web links, email and phone numbers open in the app made for them.
                        openElsewhere(url);
                        return true;
                    default:
                        // javascript:, file:, content:, intent:, other apps' schemes, or an
                        // embedded frame trying to leave: go nowhere.
                        return true;
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> answerMediaRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == pendingMedia) {
                    pendingMedia = null;
                    pendingMediaResources = null;
                }
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!policy.isTrustedOrigin(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (hasLocation()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                // Answer once Android's dialog closes (onRequestPermissionsResult), not before:
                // answering "no" now fails the first punch even when the person then allows it.
                pendingGeo.add(new PendingGeo(origin, callback));
                if (!locationPromptOpen) {
                    locationPromptOpen = true;
                    // Android 12+ ignores a request for precise location made without approximate.
                    requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, REQ_LOCATION);
                }
            }

            @Override
            public void onGeolocationPermissionsHidePrompt() {
                // The page withdrew its request (it navigated away): nobody is waiting any more.
                pendingGeo.clear();
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    pendingFiles = null;
                    return false;
                }
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(BuildConfig.SITE_URL);
    }

    /** What the page calls to raise a real Android notification. */
    private class NotifyBridge {
        @JavascriptInterface
        public void show(String title, String body, String tag) {
            if (!trustedPage) return;
            if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
            Intent open = new Intent(MainActivity.this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent tap = PendingIntent.getActivity(MainActivity.this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(MainActivity.this, CHANNEL)
                : new Notification.Builder(MainActivity.this);
            b.setContentTitle(title == null || title.isEmpty() ? "WorkSuite" : title)
             .setContentText(body == null ? "" : body)
             .setSmallIcon(android.R.drawable.stat_notify_chat)
             .setAutoCancel(true)
             .setContentIntent(tap);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify((tag == null || tag.isEmpty() ? "ws" : tag).hashCode(), b.build());
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel c = new NotificationChannel(CHANNEL, "WorkSuite", NotificationManager.IMPORTANCE_DEFAULT);
        c.setDescription("Messages, tasks and reminders");
        nm.createNotificationChannel(c);
    }

    private void askToNotify() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFY);
        }
    }

    /** Hand a link to another app; a phone with nothing to open it shows a message instead of crashing. */
    private void openElsewhere(Uri url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, url);
        // Only apps that agree to be opened from web links may take it.
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, "No app on this phone can open that link.", Toast.LENGTH_SHORT).show();
        }
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Precise or approximate: either lets the page get a fix. */
    private boolean hasLocation() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    /** The Android permissions behind these page resources that are not granted yet. */
    private String[] missingFor(String[] resources) {
        List<String> missing = new ArrayList<>();
        for (String r : resources) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && !granted(Manifest.permission.CAMERA)) {
                missing.add(Manifest.permission.CAMERA);
            }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && !granted(Manifest.permission.RECORD_AUDIO)) {
                missing.add(Manifest.permission.RECORD_AUDIO);
            }
        }
        return missing.toArray(new String[0]);
    }

    /**
     * The page asked for the camera or microphone. Our own origin gets those
     * two only, once Android says yes; anything else (another site, a frame
     * from elsewhere, other resources) is refused.
     */
    private void answerMediaRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        String[] wanted = WebPolicy.grantable(request.getResources(),
            PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_AUDIO_CAPTURE);
        if (origin == null || !policy.isTrustedOrigin(origin.toString()) || wanted.length == 0) {
            request.deny();
            return;
        }
        String[] missing = missingFor(wanted);
        if (missing.length == 0) {
            request.grant(wanted);
            return;
        }
        // A newer request replaces one still waiting; the older one gets an answer, not silence.
        if (pendingMedia != null && pendingMedia != request) pendingMedia.deny();
        pendingMedia = request;
        pendingMediaResources = wanted;
        if (!mediaPromptOpen) {
            mediaPromptOpen = true;
            requestPermissions(missing, REQ_MEDIA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        // The outcome is read back from Android rather than from `results`: those are
        // empty when the dialog is dismissed, and a person may allow approximate location only.
        if (code == REQ_LOCATION) {
            locationPromptOpen = false;
            boolean allowed = hasLocation();
            List<PendingGeo> waiting = new ArrayList<>(pendingGeo);
            pendingGeo.clear();
            for (PendingGeo g : waiting) g.callback.invoke(g.origin, allowed, false);
        } else if (code == REQ_MEDIA) {
            mediaPromptOpen = false;
            PermissionRequest request = pendingMedia;
            String[] wanted = pendingMediaResources;
            pendingMedia = null;
            pendingMediaResources = null;
            if (request == null) return;
            if (missingFor(wanted).length == 0) request.grant(wanted);
            else request.deny();
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_FILE) {
            if (pendingFiles != null) {
                pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
                pendingFiles = null;
            }
            return;
        }
        super.onActivityResult(code, result, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Back goes back through the workspace before it leaves the app.
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        // Answer whatever is still waiting, then let the WebView go, so nothing keeps
        // a callback into this activity after it is gone.
        if (pendingMedia != null) pendingMedia.deny();
        pendingMedia = null;
        pendingMediaResources = null;
        for (PendingGeo g : pendingGeo) g.callback.invoke(g.origin, false, false);
        pendingGeo.clear();
        if (pendingFiles != null) pendingFiles.onReceiveValue(null);
        pendingFiles = null;
        if (web != null) {
            web.stopLoading();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
