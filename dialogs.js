// @ts-check
// WorkSuite styled dialogs — replaces ugly native alert()/confirm() popups.
// Include with <script src="/dialogs.js"></script>, then:
//   await wsDialog.alert({ icon, title, message, okText })
//   const ok = await wsDialog.confirm({ icon, title, message, okText, cancelText, danger })

//
// Keyboard: focus starts on Cancel for a destructive confirm, on the main
// button otherwise; Tab stays inside the dialog; Enter/Space activate the
// focused button (so Enter on Cancel cancels); Escape cancels; focus returns
// to where it was. Dialogs asked for while one is open queue up.

(function () {
    function ensureDom() {
        if (document.getElementById('ws-dialog-overlay')) return;
        const style = document.createElement('style');
        style.textContent = `
            #ws-dialog-overlay {
                position: fixed; inset: 0; z-index: 300;
                display: none; align-items: center; justify-content: center; padding: 16px;
                background: rgba(11,17,32,0.85);
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            }
            #ws-dialog-overlay.show { display: flex; }
            #ws-dialog-card {
                width: 100%; max-width: 400px;
                background: rgba(23,30,48,0.98);
                border: 1px solid rgba(255,255,255,0.14);
                border-radius: 24px; padding: 26px; text-align: center;
                box-shadow: 0 30px 90px rgba(0,0,0,0.6);
                color: #e2e8f0; font-family: inherit;
                animation: ws-dialog-in .18s ease-out;
            }
            @keyframes ws-dialog-in { from { transform: scale(0.94); opacity: 0 } to { transform: scale(1); opacity: 1 } }
            #ws-dialog-ic {
                width: 60px; height: 60px; border-radius: 18px;
                margin: 0 auto 14px; display: flex; align-items: center; justify-content: center;
                font-size: 28px;
                background: linear-gradient(135deg,#3b82f6,#6366f1);
                box-shadow: 0 15px 40px rgba(59,130,246,0.4);
            }
            #ws-dialog-ic.danger { background: linear-gradient(135deg,#f43f5e,#dc2626); box-shadow: 0 15px 40px rgba(244,63,94,0.4); }
            #ws-dialog-ic.success { background: linear-gradient(135deg,#059669,#047857); box-shadow: 0 15px 40px rgba(16,185,129,0.4); }
            #ws-dialog-title { font-size: 19px; font-weight: 900; color: #fff; margin: 0 0 8px; }
            #ws-dialog-msg { font-size: 13.5px; color: #cbd5e1; line-height: 1.55; margin: 0 0 20px; font-weight: 600; }
            #ws-dialog-msg b { color: #fff; }
            #ws-dialog-btns { display: flex; gap: 10px; }
            .ws-dialog-btn {
                flex: 1; padding: 13px; border-radius: 14px; cursor: pointer;
                font-family: inherit; font-size: 13px; font-weight: 900; color: #fff;
                border: 1px solid rgba(255,255,255,0.15);
                background: rgba(255,255,255,0.07);
                transition: transform .12s, background .12s;
            }
            .ws-dialog-btn:hover { transform: translateY(-1px); background: rgba(255,255,255,0.12); }
            .ws-dialog-btn:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
            .ws-dialog-btn.ok { border: none; background: linear-gradient(135deg,#3b82f6,#6366f1); box-shadow: 0 10px 28px rgba(59,130,246,0.45); }
            .ws-dialog-btn.ok.danger { background: linear-gradient(135deg,#f43f5e,#dc2626); box-shadow: 0 10px 28px rgba(244,63,94,0.45); }
            .ws-dialog-btn.ok.success { background: linear-gradient(135deg,#059669,#047857); box-shadow: 0 10px 28px rgba(16,185,129,0.45); }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'ws-dialog-overlay';
        overlay.innerHTML = `
            <div id="ws-dialog-card" role="alertdialog" aria-modal="true" aria-labelledby="ws-dialog-title" aria-describedby="ws-dialog-msg">
                <div id="ws-dialog-ic" aria-hidden="true">ℹ️</div>
                <h3 id="ws-dialog-title">Notice</h3>
                <p id="ws-dialog-msg"></p>
                <div id="ws-dialog-btns">
                    <button type="button" class="ws-dialog-btn" id="ws-dialog-cancel">Cancel</button>
                    <button type="button" class="ws-dialog-btn ok" id="ws-dialog-ok">OK</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        // Each button answers for itself: Enter or Space on Cancel cancels, on OK confirms
        // (the browser turns those keys into a click on the focused button).
        document.getElementById('ws-dialog-ok').addEventListener('click', () => done(true));
        document.getElementById('ws-dialog-cancel').addEventListener('click', () => done(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
            if (e.key === 'Tab') {                                   // focus stays on the dialog's buttons
                const btns = buttons();
                if (!btns.length) return;
                const i = btns.indexOf(/** @type {HTMLElement} */ (document.activeElement));
                e.preventDefault();
                btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
            }
        });
        // Focus that wanders outside (a click on a background element) comes back.
        document.addEventListener('focusin', (e) => {
            if (!current || overlay.contains(/** @type {Node} */ (e.target))) return;
            const btns = buttons();
            if (btns.length) btns[0].focus();
        });
    }

    const buttons = () => ['ws-dialog-cancel', 'ws-dialog-ok'].map(id => document.getElementById(id)).filter(b => b && b.style.display !== 'none');

    // One dialog at a time. A dialog asked for while another is open waits its
    // turn, so neither promise is lost and an answer never goes to the wrong question.
    const queue = [];
    let current = null;     // { opts, resolve, returnFocus, inerted }

    function done(val) {
        if (!current) return;
        const { resolve, returnFocus, inerted, opts } = current;
        current = null;
        const overlay = document.getElementById('ws-dialog-overlay');
        if (overlay) overlay.classList.remove('show');
        inerted.forEach(el => el.removeAttribute('inert'));
        if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
            try { returnFocus.focus({ preventScroll: true }); } catch (e) { /* element went away */ }
        }
        resolve(opts.showCancel ? val : undefined);
        if (queue.length) show(queue.shift());
    }

    function show(item) {
        ensureDom();
        const { opts } = item;
        const overlay = document.getElementById('ws-dialog-overlay');
        const card = document.getElementById('ws-dialog-card');
        card.setAttribute('role', opts.showCancel ? 'alertdialog' : 'dialog');
        const ic = document.getElementById('ws-dialog-ic');
        ic.textContent = opts.icon || 'ℹ️';
        ic.className = opts.danger ? 'danger' : (opts.success ? 'success' : '');
        document.getElementById('ws-dialog-title').textContent = opts.title || 'Notice';
        document.getElementById('ws-dialog-msg').innerHTML = opts.message || '';
        const okBtn = document.getElementById('ws-dialog-ok');
        okBtn.textContent = opts.okText || 'OK';
        okBtn.className = 'ws-dialog-btn ok' + (opts.danger ? ' danger' : '') + (opts.success ? ' success' : '');
        const cancelBtn = document.getElementById('ws-dialog-cancel');
        cancelBtn.textContent = opts.cancelText || 'Cancel';
        cancelBtn.style.display = opts.showCancel ? '' : 'none';
        // The rest of the page is out of reach (keyboard, pointer, screen readers) until it is answered.
        const inerted = Array.from(document.body.children).filter(el => el !== overlay && !el.hasAttribute('inert'));
        inerted.forEach(el => el.setAttribute('inert', ''));
        current = { ...item, inerted };
        overlay.classList.add('show');
        // Safe first focus: Cancel when the action is destructive, otherwise the main button.
        (opts.showCancel && opts.danger ? cancelBtn : okBtn).focus();
    }

    function open(opts) {
        return new Promise(resolve => {
            const item = { opts, resolve, returnFocus: document.activeElement };
            if (current) queue.push(item); else show(item);
        });
    }

    window.wsDialog = {
        alert(opts) { return open({ ...opts, showCancel: false }); },
        confirm(opts) { return open({ ...opts, showCancel: true }); },
    };
})();
