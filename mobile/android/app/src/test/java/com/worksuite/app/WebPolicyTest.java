package com.worksuite.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WebPolicyTest {

    private static final String SITE = "https://work-suite-mauve.vercel.app";
    private static final String VIDEO = "android.webkit.resource.VIDEO_CAPTURE";
    private static final String AUDIO = "android.webkit.resource.AUDIO_CAPTURE";
    private static final String MIDI = "android.webkit.resource.MIDI_SYSEX";
    private static final String DRM = "android.webkit.resource.PROTECTED_MEDIA_ID";

    private final WebPolicy policy = new WebPolicy(SITE);

    @Test
    public void ownOriginIsTrusted() {
        assertTrue(policy.isTrustedOrigin("https://work-suite-mauve.vercel.app/"));
        assertTrue(policy.isTrustedOrigin("https://work-suite-mauve.vercel.app"));
        assertTrue(policy.isTrustedOrigin("https://work-suite-mauve.vercel.app/attendance/?x=1#y"));
        assertTrue(policy.isTrustedOrigin("https://WORK-SUITE-MAUVE.vercel.app/"));
        assertTrue(policy.isTrustedOrigin("HTTPS://work-suite-mauve.vercel.app/"));
        assertTrue("the default port written out is the same origin",
            policy.isTrustedOrigin("https://work-suite-mauve.vercel.app:443/"));
    }

    @Test
    public void otherSchemePortOrHostIsNotTrusted() {
        assertFalse(policy.isTrustedOrigin("http://work-suite-mauve.vercel.app/"));
        assertFalse(policy.isTrustedOrigin("https://work-suite-mauve.vercel.app:8443/"));
        assertFalse(policy.isTrustedOrigin("https://other.vercel.app/"));
        assertFalse(policy.isTrustedOrigin("wss://work-suite-mauve.vercel.app/"));
        assertFalse(policy.isTrustedOrigin("file:///android_asset/index.html"));
        assertFalse(policy.isTrustedOrigin("about:blank"));
        assertFalse(policy.isTrustedOrigin("null"));
        assertFalse(policy.isTrustedOrigin(""));
        assertFalse(policy.isTrustedOrigin(null));
    }

    @Test
    public void lookAlikeHostsAreNotTrusted() {
        assertFalse(policy.isTrustedOrigin("https://work-suite-mauve.vercel.app.evil.com/"));
        assertFalse(policy.isTrustedOrigin("https://evil-work-suite-mauve.vercel.app/"));
        assertFalse(policy.isTrustedOrigin("https://sub.work-suite-mauve.vercel.app/"));
        assertFalse(policy.isTrustedOrigin("https://work-suite-mauve.vercel.app.:443/"));
        assertFalse("credentials before the @ are not our host",
            policy.isTrustedOrigin("https://work-suite-mauve.vercel.app@evil.com/"));
        assertFalse("a URL carrying credentials is never treated as ours",
            policy.isTrustedOrigin("https://user:pass@work-suite-mauve.vercel.app/"));
        assertFalse(policy.isTrustedOrigin("https://work-suite-mauve.vercel.app%2eevil.com/"));
    }

    @Test
    public void ownLinksStayInTheApp() {
        assertEquals(WebPolicy.Link.STAY, policy.classify("https://work-suite-mauve.vercel.app/tasks/", true));
        assertEquals(WebPolicy.Link.STAY, policy.classify("https://work-suite-mauve.vercel.app/tasks/", false));
    }

    @Test
    public void webMailAndPhoneLinksOpenElsewhere() {
        assertEquals(WebPolicy.Link.EXTERNAL, policy.classify("https://example.com/report.pdf", true));
        assertEquals(WebPolicy.Link.EXTERNAL, policy.classify("http://example.com/", true));
        assertEquals(WebPolicy.Link.EXTERNAL, policy.classify("https://work-suite-mauve.vercel.app.evil.com/", true));
        assertEquals(WebPolicy.Link.EXTERNAL, policy.classify("mailto:hr@example.com?subject=Leave", true));
        assertEquals(WebPolicy.Link.EXTERNAL, policy.classify("tel:+919876543210", true));
        assertEquals(WebPolicy.Link.EXTERNAL, policy.classify("MAILTO:hr@example.com", true));
    }

    @Test
    public void dangerousAndUnknownSchemesAreBlocked() {
        String[] blocked = {
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///data/data/com.worksuite.app/shared_prefs/x.xml",
            "content://com.android.contacts/contacts",
            "data:text/html,<script>alert(1)</script>",
            "intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end",
            "market://details?id=com.example",
            "whatsapp://send?text=hi",
            "sms:+919876543210",
            "blob:https://example.com/uuid",
            "about:blank",
            "no-scheme-at-all",
            "",
            "https:///no-host",
        };
        for (String url : blocked) {
            assertEquals(url, WebPolicy.Link.BLOCK, policy.classify(url, true));
        }
        assertEquals(WebPolicy.Link.BLOCK, policy.classify(null, true));
    }

    @Test
    public void embeddedFramesNeverLaunchOtherApps() {
        assertEquals(WebPolicy.Link.BLOCK, policy.classify("tel:+919876543210", false));
        assertEquals(WebPolicy.Link.BLOCK, policy.classify("mailto:a@example.com", false));
        assertEquals(WebPolicy.Link.BLOCK, policy.classify("https://example.com/", false));
    }

    @Test
    public void onlyCameraAndMicrophoneAreGranted() {
        assertArrayEquals(new String[] { VIDEO, AUDIO },
            WebPolicy.grantable(new String[] { VIDEO, AUDIO }, VIDEO, AUDIO));
        assertArrayEquals(new String[] { AUDIO },
            WebPolicy.grantable(new String[] { AUDIO, MIDI }, VIDEO, AUDIO));
        assertArrayEquals(new String[] { VIDEO },
            WebPolicy.grantable(new String[] { DRM, VIDEO, VIDEO }, VIDEO, AUDIO));
        assertArrayEquals(new String[0], WebPolicy.grantable(new String[] { MIDI, DRM }, VIDEO, AUDIO));
        assertArrayEquals(new String[0], WebPolicy.grantable(new String[0], VIDEO, AUDIO));
        assertArrayEquals(new String[0], WebPolicy.grantable(null, VIDEO, AUDIO));
    }

    @Test
    public void siteWithAPortIsMatchedExactly() {
        WebPolicy staging = new WebPolicy("https://staging.example.com:8443/app/");
        assertTrue(staging.isTrustedOrigin("https://staging.example.com:8443/"));
        assertFalse(staging.isTrustedOrigin("https://staging.example.com/"));
        assertFalse(staging.isTrustedOrigin("https://staging.example.com:443/"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void siteUrlMustBeWeb() {
        new WebPolicy("file:///android_asset/index.html");
    }

    @Test(expected = IllegalArgumentException.class)
    public void siteUrlMustHaveAHost() {
        new WebPolicy("not a url");
    }
}
