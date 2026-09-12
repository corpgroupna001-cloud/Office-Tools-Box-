/* ============================================================================
   Security — the settings a person keeps for their own account: two-step
   verification with an authenticator app, and their password.

   The second step is Supabase Auth's TOTP (mfa.js wraps it): the secret is
   held by the auth service, never by WorkSuite, and codes are checked there.
   Nothing on this page can change anyone else's account.

   URL: /security
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, esc = C.esc, B = window.WSB24, M = window.WSMfa;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: '', crumb: 'Security' });
    const sb = ctx.sb, me = ctx.user;

    const fmt = iso => { try { return C.L.fmtDateTime(iso); } catch (e) { return ''; } };

    async function load() {
        const s = await M.status(sb);
        render(s);
    }

    function render(s) {
        const factors = s.factors || [];
        const on = factors.length > 0;
        view.innerHTML = B.titleBar({ title: 'Security' }) + `
            <div class="sec-page">
                <section class="sec-card">
                    <div class="sec-head">
                        <span class="sec-ic">${C.icon('shield')}</span>
                        <div class="t">
                            <h2>Two-step verification</h2>
                            <p>Ask for a 6-digit code from an authenticator app after your password. Anyone who learns your password still cannot sign in.</p>
                        </div>
                        <span class="sec-state${on ? ' on' : ''}">${on ? 'On' : 'Off'}</span>
                    </div>
                    ${!s.supported ? '<div class="crm-info">This browser loaded an older sign-in library. Refresh the page to set up two-step verification.</div>' : ''}
                    ${on ? `<ul class="sec-list">${factors.map(f => `<li>
                            <span class="ic">${C.icon('lock')}</span>
                            <div class="main"><b>${esc(f.friendly_name || 'Authenticator app')}</b><span>Added ${esc(fmt(f.created_at) || 'earlier')}</span></div>
                            <button type="button" class="ws-btn sm danger" data-remove="${esc(f.id)}">${C.icon('trash')}<span>Remove</span></button>
                        </li>`).join('')}</ul>
                        <button type="button" class="ws-btn" data-add>${C.icon('plus')}<span>Add another app</span></button>`
                      : `<div class="sec-steps">
                            <div><b>1</b><span>Install an authenticator app — Google Authenticator, Microsoft Authenticator, 1Password or similar.</span></div>
                            <div><b>2</b><span>Scan the square code we show you, or type the setup key.</span></div>
                            <div><b>3</b><span>Enter the 6-digit code the app shows, to confirm it works.</span></div>
                         </div>
                         <button type="button" class="ws-btn primary" data-add ${s.supported ? '' : 'disabled'}>${C.icon('shield')}<span>Set up two-step verification</span></button>`}
                    <p class="sec-note">Keep a second device or your app's backup ready. Without the app you cannot sign in, and an administrator has to reset your account.</p>
                </section>

                <section class="sec-card">
                    <div class="sec-head">
                        <span class="sec-ic">${C.icon('user')}</span>
                        <div class="t">
                            <h2>Sign-in details</h2>
                            <p>Signed in as <b>${esc(me.email || '')}</b>.</p>
                        </div>
                    </div>
                    <button type="button" class="ws-btn" data-password>${C.icon('lock')}<span>Change password</span></button>
                </section>
            </div>`;
    }

    /* ------------------------------------------------------ set up an app */
    async function addApp() {
        const started = await M.beginEnrol(sb, 'Authenticator app');
        if (started.error) return C.toast(started.error, 'bad');
        const body = document.createElement('div');
        body.className = 'sec-enrol';
        body.innerHTML = `
            <p>Scan this with your authenticator app, then enter the code it shows.</p>
            <div class="qr">${started.qr ? `<img src="${esc(started.qr)}" alt="Setup code" width="200" height="200">` : ''}</div>
            <p class="key">Can't scan it? Enter this setup key by hand:<br><code>${esc(M.groupSecret(started.secret))}</code></p>
            <label class="sec-code"><span>6-digit code</span>
                <input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" data-code></label>`;
        const input = body.querySelector('[data-code]');
        input.addEventListener('input', () => { input.value = M.normaliseCode(input.value); });
        const m = C.modal({
            title: 'Set up two-step verification', body,
            actions: [
                { label: 'Cancel', close: true },
                { label: 'Turn it on', primary: true, onClick: async api => {
                    const r = await M.finishEnrol(sb, started.id, input.value);
                    if (!r.ok) { input.focus(); throw new Error(r.message); }
                    api.close();
                    C.toast('Two-step verification is on', 'ok');
                    await load();
                } },
            ],
            onClose: async () => {
                // An unfinished setup would otherwise sit on the account for ever.
                const s = await M.status(sb);
                if (!(s.factors || []).some(f => f.id === started.id)) await M.remove(sb, started.id);
            },
        });
        setTimeout(() => input.focus(), 40);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const b = m.el.querySelector('.foot button[data-primary]'); if (b) b.click(); } });
    }

    async function removeApp(id) {
        const ok = await C.confirm({
            title: 'Remove this authenticator?',
            message: 'Signing in will only ask for your password again. You can set up an app again at any time.',
            okText: 'Remove', danger: true,
        });
        if (!ok) return;
        const r = await M.remove(sb, id);
        if (!r.ok) return C.toast(r.message, 'bad');
        C.toast('Authenticator removed', 'ok');
        load();
    }

    /* ------------------------------------------------------- password */
    async function changePassword() {
        await C.formModal({
            title: 'Change password', submitLabel: 'Save password',
            fields: [
                { name: 'pw', label: 'New password', type: 'password', required: true, full: true, placeholder: 'At least 8 characters' },
                { name: 'pw2', label: 'Repeat the new password', type: 'password', required: true, full: true },
            ],
            onSubmit: async v => {
                const pw = String(v.pw || '');
                if (pw.length < 8) throw new Error('Use at least 8 characters.');
                if (pw !== v.pw2) throw new Error('The two passwords are not the same.');
                const { error } = await sb.auth.updateUser({ password: pw });
                if (error) throw new Error(error.message || 'The password was not changed.');
                C.toast('Password changed', 'ok');
            },
        });
    }

    view.addEventListener('click', e => {
        if (e.target.closest('[data-add]')) return addApp();
        const rm = e.target.closest('[data-remove]');
        if (rm) return removeApp(rm.dataset.remove);
        if (e.target.closest('[data-password]')) return changePassword();
    });

    load().catch(e => C.errorState(view, e, load));
})();
