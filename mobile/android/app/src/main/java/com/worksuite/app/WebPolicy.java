package com.worksuite.app;

/*
 * What the WebView trusts, and where links may go.
 *
 * Kept free of Android classes so the rules run as plain JVM unit tests
 * (app/src/test). MainActivity asks this class before it grants the camera,
 * microphone or location, and before it hands a link to another app.
 *
 * The app's own origin is the scheme, host and port of SITE_URL, compared
 * exactly: another scheme, another port or a look-alike host is a stranger.
 */

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class WebPolicy {

    /** What to do with a navigation the page starts. */
    enum Link {
        /** The app's own origin: load it in the WebView. */
        STAY,
        /** Hand it to the browser, mail app or dialler. */
        EXTERNAL,
        /** Do nothing: javascript:, file:, content:, data:, intent: and unknown schemes. */
        BLOCK
    }

    /**
     * Schemes another app may open. Web links leave for the browser (plain
     * http included: it is an ordinary link, and the WebView itself refuses
     * cleartext); mailto and tel open the mail app and the dialler.
     */
    private static final List<String> EXTERNAL_SCHEMES = Arrays.asList("https", "http", "mailto", "tel");
    private static final Pattern SCHEME = Pattern.compile("^([a-zA-Z][a-zA-Z0-9+.-]*):");

    private final String scheme;
    private final String host;
    private final int port;

    WebPolicy(String siteUrl) {
        URI u = parse(siteUrl);
        String s = u == null ? null : lower(u.getScheme());
        if (u == null || !isWeb(s) || u.getHost() == null || u.getRawUserInfo() != null) {
            throw new IllegalArgumentException("SITE_URL must be an http(s) URL with a host: " + siteUrl);
        }
        scheme = s;
        host = lower(u.getHost());
        port = effectivePort(s, u.getPort());
    }

    /** True only for the app's own origin: the same scheme, host and port as SITE_URL. */
    boolean isTrustedOrigin(String url) {
        URI u = parse(url);
        if (u == null || u.getHost() == null || u.getRawUserInfo() != null) return false;
        String s = lower(u.getScheme());
        return scheme.equals(s) && host.equals(lower(u.getHost())) && port == effectivePort(s, u.getPort());
    }

    /**
     * Where a navigation goes. Only the main frame may send someone to
     * another app; an embedded frame trying to is blocked.
     */
    Link classify(String url, boolean mainFrame) {
        if (isTrustedOrigin(url)) return Link.STAY;
        if (!mainFrame) return Link.BLOCK;
        String s = schemeOf(url);
        if (s == null || !EXTERNAL_SCHEMES.contains(s)) return Link.BLOCK;
        if (isWeb(s)) {
            URI u = parse(url);
            if (u == null || u.getHost() == null) return Link.BLOCK;
        }
        return Link.EXTERNAL;
    }

    /** The resources in `requested` that are also in `allowed`, in request order; empty when none are. */
    static String[] grantable(String[] requested, String... allowed) {
        List<String> out = new ArrayList<>();
        if (requested == null) return new String[0];
        List<String> ok = Arrays.asList(allowed);
        for (String r : requested) {
            if (r != null && ok.contains(r) && !out.contains(r)) out.add(r);
        }
        return out.toArray(new String[0]);
    }

    /* ---- helpers ---- */

    private static boolean isWeb(String scheme) {
        return "https".equals(scheme) || "http".equals(scheme);
    }

    private static String schemeOf(String url) {
        if (url == null) return null;
        Matcher m = SCHEME.matcher(url.trim());
        return m.find() ? lower(m.group(1)) : null;
    }

    private static URI parse(String url) {
        if (url == null) return null;
        try {
            return new URI(url.trim());
        } catch (URISyntaxException e) {
            return null;
        }
    }

    private static int effectivePort(String scheme, int port) {
        if (port != -1) return port;
        return "https".equals(scheme) ? 443 : "http".equals(scheme) ? 80 : -1;
    }

    private static String lower(String s) {
        return s == null ? null : s.toLowerCase(Locale.ROOT);
    }
}
