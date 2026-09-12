package com.worksuite.app;

/*
 * WorkSuite for Android.
 *
 * A WebView onto the deployed workspace: the site is always the live one,
 * so the app never has to be updated to keep up with it. What the WebView
 * needs from Android is arranged here — camera and microphone for calls,
 * a location fix for attendance, and a file picker for attachments.
 */

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.CookieManager;

public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_PERMS = 1002;

    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;
    private PermissionRequest pendingWebRequest;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

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

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isOurs(url)) return false;
                // Anything that is not WorkSuite opens in the phone's browser.
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> grantWebPermission(request));
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                if (!granted) requestPermissions(new String[]{ Manifest.permission.ACCESS_FINE_LOCATION }, REQ_PERMS);
                callback.invoke(origin, granted, false);
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

    private boolean isOurs(Uri url) {
        try {
            String host = Uri.parse(BuildConfig.SITE_URL).getHost();
            return host != null && host.equalsIgnoreCase(url.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    /** The page asked for the camera or microphone: ask Android first, then answer the page. */
    private void grantWebPermission(PermissionRequest request) {
        boolean wantsCamera = false, wantsMic = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
        }
        boolean haveCamera = !wantsCamera || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean haveMic = !wantsMic || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;

        if (haveCamera && haveMic) {
            request.grant(request.getResources());
            return;
        }
        pendingWebRequest = request;
        requestPermissions(new String[]{ Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO }, REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != REQ_PERMS || pendingWebRequest == null) return;
        boolean allowed = results.length > 0;
        for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) allowed = false;
        if (allowed) pendingWebRequest.grant(pendingWebRequest.getResources());
        else pendingWebRequest.deny();
        pendingWebRequest = null;
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
}
