// ============================================================
// WorkSuite — two-step verification (authenticator app).
//
// The second step is Supabase Auth's own TOTP: the secret lives with the
// auth service, never in our tables, and the code is checked there. This
// file is the shared piece used by the sign-in page, the Security page and
// the auth guard, so all three agree on what "signed in" means.
//
// Wording: a session that has not passed the second step is "aal1"; one
// that has is "aal2". A person with no authenticator is always aal1 and
// that is fine — nextLevel says what their own account expects.
//
// Loaded as a plain script: window.WSMfa.
// ============================================================
(function () {
    'use strict';
    if (window.WSMfa) return;

    /** Does this session still owe a code? (from auth.mfa.getAuthenticatorAssuranceLevel) */
    function needsSecondStep(aal) {
        if (!aal) return false;
        return aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2';
    }
    /** The authenticators a person has actually finished setting up. */
    function verifiedFactors(list) {
        const all = (list && (list.totp || list.all)) || [];
        return all.filter(f => f && f.status === 'verified');
    }
    const normaliseCode = s => String(s == null ? '' : s).replace(/\D/g, '').slice(0, 6);
    const isCode = s => /^[0-9]{6}$/.test(normaliseCode(s));
    /** The secret, in the groups of four that authenticator apps show. */
    const groupSecret = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

    /** A friendly message for what Supabase reports back. */
    function friendly(error) {
        const m = String((error && (error.message || error)) || '').toLowerCase();
        if (!m) return 'Something went wrong. Try again.';
        if (m.includes('invalid totp code') || m.includes('invalid code') || m.includes('otp')) return 'That code is not right. Check the app and try the current code.';
        if (m.includes('expired')) return 'That code has expired. Enter the one showing now.';
        if (m.includes('rate') || m.includes('too many')) return 'Too many tries. Wait a minute, then try again.';
        if (m.includes('not enabled') || m.includes('disabled')) return 'Two-step verification is not enabled for this workspace yet.';
        if (m.includes('factor') && m.includes('exist')) return 'This device is already set up.';
        return (error && error.message) || 'Something went wrong. Try again.';
    }

    /* ---- the thin wrappers over supabase-js, kept here so every page agrees ---- */

    /** { needs, factors, aal } — what this session's second step looks like right now. */
    async function status(sb) {
        const out = { needs: false, factors: [], aal: null, supported: !!(sb && sb.auth && sb.auth.mfa) };
        if (!out.supported) return out;
        try {
            const a = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
            out.aal = (a && a.data) || null;
            out.needs = needsSecondStep(out.aal);
        } catch (e) { /* older client: treated as no second step */ }
        try {
            const f = await sb.auth.mfa.listFactors();
            out.factors = verifiedFactors((f && f.data) || {});
        } catch (e) { /* listing is only needed for the Security page */ }
        return out;
    }
    /** Ask for a code and finish the sign-in. Returns { ok, message }. */
    async function submitCode(sb, factorId, code) {
        if (!isCode(code)) return { ok: false, message: 'Enter the 6-digit code from your app.' };
        try {
            const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: normaliseCode(code) });
            if (error) return { ok: false, message: friendly(error) };
            return { ok: true };
        } catch (e) { return { ok: false, message: friendly(e) }; }
    }
    /** Start setting up an app: returns { id, qr, secret, uri } or { error }. */
    async function beginEnrol(sb, friendlyName) {
        try {
            const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: friendlyName || undefined });
            if (error) return { error: friendly(error) };
            const t = (data && data.totp) || {};
            return { id: data && data.id, qr: t.qr_code || '', secret: t.secret || '', uri: t.uri || '' };
        } catch (e) { return { error: friendly(e) }; }
    }
    /** Finish setting up: the code proves the app and the account agree. */
    async function finishEnrol(sb, factorId, code) {
        if (!isCode(code)) return { ok: false, message: 'Enter the 6-digit code from your app.' };
        try {
            const ch = await sb.auth.mfa.challenge({ factorId });
            if (ch.error) return { ok: false, message: friendly(ch.error) };
            const { error } = await sb.auth.mfa.verify({ factorId, challengeId: ch.data.id, code: normaliseCode(code) });
            if (error) return { ok: false, message: friendly(error) };
            return { ok: true };
        } catch (e) { return { ok: false, message: friendly(e) }; }
    }
    /** Remove an authenticator (the person must already be past the second step). */
    async function remove(sb, factorId) {
        try {
            const { error } = await sb.auth.mfa.unenroll({ factorId });
            if (error) return { ok: false, message: friendly(error) };
            return { ok: true };
        } catch (e) { return { ok: false, message: friendly(e) }; }
    }

    window.WSMfa = { needsSecondStep, verifiedFactors, normaliseCode, isCode, groupSecret, friendly, status, submitCode, beginEnrol, finishEnrol, remove };
})();
