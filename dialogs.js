// WorkSuite styled dialogs — replaces ugly native alert()/confirm() popups.
// Include with <script src="/dialogs.js"></script>, then:
//   await wsDialog.alert({ icon, title, message, okText })
//   const ok = await wsDialog.confirm({ icon, title, message, okText, cancelText, danger })

(function () {
    let resolver = null;

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
            .ws-dialog-btn.ok { border: none; background: linear-gradient(135deg,#3b82f6,#6366f1); box-shadow: 0 10px 28px rgba(59,130,246,0.45); }
            .ws-dialog-btn.ok.danger { background: linear-gradient(135deg,#f43f5e,#dc2626); box-shadow: 0 10px 28px rgba(244,63,94,0.45); }
            .ws-dialog-btn.ok.success { background: linear-gradient(135deg,#059669,#047857); box-shadow: 0 10px 28px rgba(16,185,129,0.45); }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'ws-dialog-overlay';
        overlay.innerHTML = `
            <div id="ws-dialog-card">
                <div id="ws-dialog-ic">ℹ️</div>
                <h3 id="ws-dialog-title">Notice</h3>
                <p id="ws-dialog-msg"></p>
                <div id="ws-dialog-btns">
                    <button type="button" class="ws-dialog-btn" id="ws-dialog-cancel">Cancel</button>
                    <button type="button" class="ws-dialog-btn ok" id="ws-dialog-ok">OK</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        document.getElementById('ws-dialog-ok').addEventListener('click', () => done(true));
        document.getElementById('ws-dialog-cancel').addEventListener('click', () => done(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
        document.addEventListener('keydown', (e) => {
            if (!overlay.classList.contains('show')) return;
            if (e.key === 'Escape') done(false);
            if (e.key === 'Enter') done(true);
        });
    }

    function done(val) {
        const overlay = document.getElementById('ws-dialog-overlay');
        if (overlay) overlay.classList.remove('show');
        if (resolver) { resolver(val); resolver = null; }
    }

    function open({ icon, title, message, okText, cancelText, danger, success, showCancel }) {
        ensureDom();
        return new Promise(resolve => {
            resolver = resolve;
            const ic = document.getElementById('ws-dialog-ic');
            ic.textContent = icon || 'ℹ️';
            ic.className = danger ? 'danger' : (success ? 'success' : '');
            document.getElementById('ws-dialog-title').textContent = title || 'Notice';
            document.getElementById('ws-dialog-msg').innerHTML = message || '';
            const okBtn = document.getElementById('ws-dialog-ok');
            okBtn.textContent = okText || 'OK';
            okBtn.className = 'ws-dialog-btn ok' + (danger ? ' danger' : '') + (success ? ' success' : '');
            const cancelBtn = document.getElementById('ws-dialog-cancel');
            cancelBtn.textContent = cancelText || 'Cancel';
            cancelBtn.style.display = showCancel ? '' : 'none';
            document.getElementById('ws-dialog-overlay').classList.add('show');
        });
    }

    window.wsDialog = {
        alert(opts) { return open({ ...opts, showCancel: false }).then(() => undefined); },
        confirm(opts) { return open({ ...opts, showCancel: true }); }
    };
})();
