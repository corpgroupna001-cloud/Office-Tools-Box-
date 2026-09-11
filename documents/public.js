/* ============================================================================
   Public document page: /documents/public?t=<token>
   No sign-in. Reads one published document through ws_published_document()
   (the token is the only key; unpublished or deleted documents return
   nothing) and shows it read-only. Files come from the public "published"
   bucket, where a copy lives only while the link is on.
   ============================================================================ */
(async function () {
    'use strict';
    const D = window.WSDrive, main = document.getElementById('main');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const msg = (title, sub) => { main.innerHTML = `<div class="pub-msg"><b>${esc(title)}</b>${esc(sub || '')}</div>`; };
    const bytes = n => { n = Number(n) || 0; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; };
    const token = new URLSearchParams(location.search).get('t') || '';
    if (!/^[a-z0-9]{24,64}$/i.test(token)) return msg('This link is not valid', 'Check that you copied the whole address.');
    try {
        const st = document.createElement('style'); st.textContent = D.STATIC_CSS; document.head.appendChild(st);
        const cfg = await (await fetch('/api/config')).json();
        if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) throw new Error('not configured');
        const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
        const r = await sb.rpc('ws_published_document', { p_token: token });
        if (r.error) throw r.error;
        const d = r.data;
        if (!d) return msg('This link is no longer available', 'The owner may have turned it off, or the document was deleted.');
        document.title = `${d.name} · WorkSuite`;
        document.getElementById('name').textContent = d.name;
        if (d.doc_kind && d.doc_kind !== 'file') {
            main.innerHTML = `<div class="pub-card k-${esc(d.doc_kind)}">${D.renderStatic(d.doc_kind, d.content)}</div>`;
            return;
        }
        if (!d.path) return msg('This file is not available', 'Ask the person who shared it for a new link.');
        const url = `${cfg.supabaseUrl}/storage/v1/object/public/published/${String(d.path).split('/').map(encodeURIComponent).join('/')}`;
        const dlUrl = `${url}?download=${encodeURIComponent(d.name)}`;
        const dl = document.getElementById('dl'); dl.href = dlUrl; dl.hidden = false;
        const m = String(d.mime_type || '');
        main.innerHTML = m.startsWith('image/') ? `<div class="pub-card pub-file"><img src="${esc(url)}" alt="${esc(d.name)}"></div>`
            : m === 'application/pdf' ? `<div class="pub-card pub-file flush"><iframe src="${esc(url)}" title="${esc(d.name)}"></iframe></div>`
            : m.startsWith('video/') ? `<div class="pub-card pub-file"><video src="${esc(url)}" controls style="width:100%"></video></div>`
            : m.startsWith('audio/') ? `<div class="pub-card pub-file"><audio src="${esc(url)}" controls style="width:100%"></audio></div>`
            : `<div class="pub-card pub-msg"><b>${esc(d.name)}</b>${esc(bytes(d.size_bytes))}<p style="margin:18px 0 0"><a class="pub-btn" href="${esc(dlUrl)}" rel="noopener">Download</a></p></div>`;
    } catch (e) {
        console.warn('[public document]', e);
        msg('This document could not be loaded', 'Try again in a moment.');
    }
})();
