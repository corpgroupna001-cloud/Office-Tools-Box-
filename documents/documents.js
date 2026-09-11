/* ============================================================================
   Documents — folders, upload, search, preview and links to CRM/work records.
   One file is stored once (Supabase Storage, private `documents` bucket) and
   can be attached to any number of projects, tasks, contacts, deals, leads
   or invoices through document_links. Files are served as 1-hour signed URLs
   only; nothing here builds a public URL.

   URLs:  /documents/                 root          /documents/?folder=<uuid>  a folder
          /documents/?id=<uuid>       one document  /documents/?new=1          focus the upload zone
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'documents', crumb: 'Documents' });
    const sb = ctx.sb, me = ctx.user;

    const SELECT = 'id, company, name, original_name, bucket, storage_path, mime_type, size_bytes, sha256, folder_id, description, archived_at, created_by, created_at, updated_at, links:document_links(entity_type, entity_id)';
    const LINK_TYPES = ['project', 'task', 'contact', 'deal', 'lead', 'invoice'];
    const TYPE_FILTERS = {
        pdf: { label: 'PDF', test: m => m === 'application/pdf' },
        image: { label: 'Images', test: m => m.startsWith('image/') },
        office: { label: 'Office documents', test: m => /word|presentation|powerpoint|msword/.test(m) },
        sheet: { label: 'Spreadsheets', test: m => /sheet|excel|csv/.test(m) },
        archive: { label: 'Archives', test: m => /zip/.test(m) },
        media: { label: 'Audio & video', test: m => /^(audio|video)\//.test(m) },
        other: { label: 'Other', test: m => !/pdf|^image\/|word|presentation|powerpoint|msword|sheet|excel|csv|zip|^audio\/|^video\//.test(m) },
    };
    function typeLabel(mime) {
        const m = String(mime || '');
        for (const [k, t] of Object.entries(TYPE_FILTERS)) if (k !== 'other' && t.test(m)) return t.label.replace(/s$/, '').replace('Office document', 'Document');
        return m ? m.split('/').pop().toUpperCase().slice(0, 12) : 'File';
    }
    const labelCache = new Map();          // `${type}:${id}` -> label
    async function labelsFor(links) {
        const need = links.filter(l => !labelCache.has(`${l.entity_type}:${l.entity_id}`));
        await Promise.all(need.map(async l => {
            try { labelCache.set(`${l.entity_type}:${l.entity_id}`, await C.entityLabel(l.entity_type, l.entity_id)); }
            catch (e) { labelCache.set(`${l.entity_type}:${l.entity_id}`, ''); }
        }));
    }
    function chips(links, max) {
        const list = (links || []).slice(0, max || 3);
        const extra = (links || []).length - list.length;
        return list.map(l => C.entityChip(l.entity_type, l.entity_id, labelCache.get(`${l.entity_type}:${l.entity_id}`) || (C.ENTITY_META[l.entity_type] || {}).label)).join(' ') + (extra > 0 ? ` <span class="muted">+${extra}</span>` : '');
    }
    const canManage = d => ctx.isManager || d.created_by === me.id;

    /* ------------------------------------------------------------ routing */
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id);
        return showList(C.param('folder') || null);
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    /* ------------------------------------------------------------ folders */
    let folders = [];
    async function loadFolders() {
        const { data } = await C.q(sb.from('document_folders').select('id, name, parent_id, created_by, created_at').order('name'));
        folders = data || [];
        return folders;
    }
    function folderPath(id) {
        const out = []; let cur = folders.find(f => f.id === id); let guard = 0;
        while (cur && guard++ < 20) { out.unshift(cur); cur = folders.find(f => f.id === cur.parent_id); }
        return out;
    }
    function folderName(id) { const f = folders.find(x => x.id === id); return f ? f.name : 'Documents'; }
    async function newFolder(parentId, after) {
        await C.formModal({
            title: 'New folder', fields: [{ name: 'name', label: 'Folder name', type: 'text', required: true, full: true }],
            submitLabel: 'Create', onSubmit: async v => {
                await C.q(sb.from('document_folders').insert({ name: v.name.trim(), parent_id: parentId || null, created_by: me.id }));
                C.toast('Folder created', 'ok'); if (after) after();
            },
        });
    }
    async function renameFolder(f, after) {
        await C.formModal({
            title: 'Rename folder', fields: [{ name: 'name', label: 'Folder name', type: 'text', required: true, full: true }], values: { name: f.name },
            submitLabel: 'Rename', onSubmit: async v => { await C.q(sb.from('document_folders').update({ name: v.name.trim() }).eq('id', f.id)); C.toast('Folder renamed', 'ok'); if (after) after(); },
        });
    }
    async function deleteFolder(f, after) {
        const [docs, subs] = await Promise.all([
            sb.from('documents').select('id', { count: 'exact', head: true }).eq('folder_id', f.id),
            sb.from('document_folders').select('id', { count: 'exact', head: true }).eq('parent_id', f.id),
        ]);
        const n = (docs.count || 0) + (subs.count || 0);
        if (n) return C.alert({ title: 'Folder is not empty', message: `"${f.name}" still holds ${docs.count || 0} document${docs.count === 1 ? '' : 's'} and ${subs.count || 0} sub-folder${subs.count === 1 ? '' : 's'}. Move or delete them first.` });
        if (!await C.confirm({ title: `Delete the folder "${f.name}"?`, message: 'The folder is empty, so nothing else is affected.', okText: 'Delete', danger: true })) return;
        try { await C.q(sb.from('document_folders').delete().eq('id', f.id)); C.toast('Folder deleted', 'ok'); if (after) after(); } catch (e) { C.toast(e.message, 'bad'); }
    }
    function folderOptions(selected, excludeId) {
        const opts = [{ value: '', label: 'Documents (root)' }];
        const walk = (parent, depth) => folders.filter(f => (f.parent_id || null) === parent && f.id !== excludeId).forEach(f => { opts.push({ value: f.id, label: `${'— '.repeat(depth)}${f.name}` }); walk(f.id, depth + 1); });
        walk(null, 0);
        return opts;
    }

    /* ---------------------------------------------------- document actions */
    async function renameDoc(d, after) {
        await C.formModal({
            title: 'Rename document', intro: '<div class="crm-info">Only the display name and description change; the stored file stays exactly as uploaded.</div>',
            fields: [{ name: 'name', label: 'Name', type: 'text', required: true, full: true }, { name: 'description', label: 'Description', type: 'textarea', full: true }],
            values: { name: d.name, description: d.description || '' },
            submitLabel: 'Save', onSubmit: async v => { await C.q(sb.from('documents').update({ name: v.name.trim(), description: v.description || null }).eq('id', d.id)); C.toast('Renamed', 'ok'); if (after) after(); },
        });
    }
    async function moveDoc(d, after) {
        if (!folders.length) await loadFolders();
        await C.formModal({
            title: 'Move to folder', fields: [{ name: 'folder_id', label: 'Folder', type: 'select', options: folderOptions(), full: true }], values: { folder_id: d.folder_id || '' },
            submitLabel: 'Move', onSubmit: async v => { await C.q(sb.from('documents').update({ folder_id: v.folder_id || null }).eq('id', d.id)); C.toast('Moved', 'ok'); if (after) after(); },
        });
    }
    /** Attach to any record: pick a type, then search that type. */
    function attachDoc(d, after) {
        const body = document.createElement('div');
        body.className = 'crm-form';
        body.innerHTML = `<div class="crm-field"><label for="att-type">Record type</label><select id="att-type">${LINK_TYPES.map(t => `<option value="${t}">${esc(C.ENTITY_META[t].label)}</option>`).join('')}</select></div><div class="crm-field full" id="att-pick-wrap"><label>Record</label></div>`;
        let picker = null;
        function mountPicker(type) {
            const wrap = body.querySelector('#att-pick-wrap');
            wrap.querySelectorAll('.crm-menu-host').forEach(x => x.remove());
            picker = C.entityPicker(type, null, { placeholder: `Search ${C.ENTITY_META[type].label.toLowerCase()}s…` });
            wrap.appendChild(picker.el);
            setTimeout(() => picker.input.focus(), 20);
        }
        mountPicker(LINK_TYPES[0]);
        body.querySelector('#att-type').addEventListener('change', e => mountPicker(e.target.value));
        C.modal({
            title: `Attach "${d.name}" to a record`, body,
            actions: [{ label: 'Cancel', close: true }, { label: 'Attach', primary: true, onClick: async api => {
                const id = picker.get(); const type = body.querySelector('#att-type').value;
                if (!id) return api.setMessage('Pick a record first.');
                await C.linkDocument(d.id, type, id);
                C.toast('Attached', 'ok'); api.close(); if (after) after();
            } }],
        });
    }
    async function setArchived(d, archived, after) {
        try {
            await C.q(sb.from('documents').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', d.id));
            C.toast(archived ? 'Document archived' : 'Document restored', 'ok'); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteDoc(d, after) {
        const n = (d.links || []).length;
        const ok = await C.confirm({ title: 'Delete this file permanently?', message: `${d.name} will be removed from storage${n ? ` and detached from ${n} record${n === 1 ? '' : 's'}` : ''}. This cannot be undone. Archiving keeps it recoverable.`, okText: 'Delete permanently', danger: true });
        if (!ok) return;
        try {
            // The storage delete policy for managers checks the documents row, so the object goes first.
            const r = await sb.storage.from(d.bucket || 'documents').remove([d.storage_path]);
            if (r.error) { console.warn('[documents] storage remove', r.error); throw new Error('The file could not be removed from storage.'); }
            await C.q(sb.from('document_links').delete().eq('document_id', d.id));
            await C.q(sb.from('documents').delete().eq('id', d.id));
            C.toast('Document deleted', 'ok'); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function download(d) {
        try { const url = await C.signedUrl(d); window.open(url, '_blank', 'noopener'); } catch (e) { C.toast(e.message, 'bad'); }
    }
    function docMenu(anchor, d, after) {
        const items = [
            { label: 'Open / preview', icon: 'doc', onClick: () => C.openDocument(d) },
            { label: 'Download', icon: 'download', onClick: () => download(d) },
            { label: 'Details', icon: 'arrow', onClick: () => go(`/documents/?id=${d.id}`) },
            'sep',
            { label: 'Attach to record', icon: 'link', onClick: () => attachDoc(d, after) },
        ];
        if (canManage(d)) {
            items.push({ label: 'Rename', icon: 'edit', onClick: () => renameDoc(d, after) });
            items.push({ label: 'Move to folder', icon: 'folder', onClick: () => moveDoc(d, after) });
            items.push('sep');
            items.push(d.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(d, false, after) } : { label: 'Archive', icon: 'trash', onClick: () => setArchived(d, true, after) });
            items.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteDoc(d, after) });
        }
        C.menu(anchor, items);
    }

    /* --------------------------------------------------------------- list */
    const listState = { q: '', type: '', by: '', attached: '', archived: false, rows: [], serverSearch: false };
    async function fetchDocs(folderId) {
        let b = sb.from('documents').select(SELECT).order('created_at', { ascending: false }).limit(500);
        if (listState.archived) b = b.not('archived_at', 'is', null); else b = b.is('archived_at', null);
        if (!(listState.q && listState.serverSearch) && !listState.attached) { if (folderId) b = b.eq('folder_id', folderId); else b = b.is('folder_id', null); }
        if (listState.by) b = b.eq('created_by', listState.by);
        if (listState.q && listState.serverSearch) b = b.ilike('name', `%${listState.q.replace(/[%,()]/g, ' ')}%`);
        const { data } = await C.q(b);
        return data || [];
    }
    function filterRows(rows) {
        const q = listState.q.trim().toLowerCase();
        return rows.filter(d => {
            if (listState.type && !TYPE_FILTERS[listState.type].test(String(d.mime_type || ''))) return false;
            if (listState.attached && !(d.links || []).some(l => l.entity_type === listState.attached)) return false;
            if (q && !listState.serverSearch && !String(d.name).toLowerCase().includes(q) && !String(d.description || '').toLowerCase().includes(q)) return false;
            return true;
        });
    }
    async function showList(folderId) {
        document.title = 'Documents · WorkSuite';
        WSShell.setCrumb('Documents');
        C.loading(view, 'Loading documents…');
        try { await loadFolders(); } catch (e) { return C.errorState(view, e, () => showList(folderId)); }
        const path = folderId ? folderPath(folderId) : [];
        const children = folders.filter(f => (f.parent_id || null) === (folderId || null)).sort((a, b) => a.name.localeCompare(b.name));
        WSShell.setCrumb(folderId ? folderName(folderId) : 'Documents');
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">Collaboration</p><h1>Documents</h1><p>Company files, stored once and attached wherever they are needed. Private: links expire after an hour.</p></div>
                <div class="actions">
                    <button type="button" class="ws-btn" id="new-folder">${C.icon('folder')}<span>New folder</span></button>
                    <button type="button" class="ws-btn primary" id="upload-btn">${C.icon('upload')}<span>Upload</span></button>
                </div>
            </div>
            <nav class="crm-crumbs" aria-label="Folder path" style="margin-bottom:12px">
                <a href="/documents/" data-folder="">${C.icon('folder', 'sm')} Documents</a>
                ${path.map(f => `<span class="sep">›</span><a href="/documents/?folder=${esc(f.id)}" data-folder="${esc(f.id)}">${esc(f.name)}</a>`).join('')}
            </nav>
            ${children.length ? `<div class="crm-folders">${children.map(f => `<span class="crm-menu-host"><a class="crm-entity" href="/documents/?folder=${esc(f.id)}" data-folder="${esc(f.id)}">${C.icon('folder')}<span>${esc(f.name)}</span></a> <button type="button" class="ws-btn sm icon ghost" data-folder-menu="${esc(f.id)}" aria-label="Folder options" style="width:26px;min-height:26px">${C.icon('more', 'sm')}</button></span>`).join('')}</div>` : ''}
            <div class="crm-toolbar">
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search file names…" aria-label="Search documents"></div>
                <select id="f-type" aria-label="File type"><option value="">Any type</option>${Object.entries(TYPE_FILTERS).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select>
                <select id="f-by" aria-label="Uploaded by"><option value="">Anyone</option>${C.peopleOptions('', { none: null })}</select>
                <select id="f-att" aria-label="Attached to"><option value="">Attached to anything</option>${LINK_TYPES.map(t => `<option value="${t}">Attached to a ${esc(C.ENTITY_META[t].label.toLowerCase())}</option>`).join('')}</select>
                <label class="crm-check" style="min-height:38px"><input type="checkbox" id="f-arch"> Archived</label>
                <span class="crm-count" id="count"></span>
            </div>
            <div class="ws-card flush" style="margin-bottom:16px"><div id="table"></div></div>
            <div class="ws-card">
                <div class="crm-section-title"><h3>Upload to ${esc(folderId ? folderName(folderId) : 'Documents')}</h3></div>
                <div id="progress"></div>
                <label class="crm-drop" id="drop" tabindex="0">${C.icon('upload')} Drop files here or <b>browse</b> · PDF, images, Office files, archives · up to 50 MB each<input type="file" multiple></label>
                <p class="muted" style="font-size:12.5px;margin:10px 0 0">Identical files are stored once: uploading a file that already exists links to the existing copy.</p>
            </div>`;
        view.querySelector('#q').value = listState.q; view.querySelector('#f-type').value = listState.type; view.querySelector('#f-by').value = listState.by;
        view.querySelector('#f-att').value = listState.attached; view.querySelector('#f-arch').checked = listState.archived;
        view.querySelectorAll('[data-folder]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go(a.dataset.folder ? `/documents/?folder=${a.dataset.folder}` : '/documents/'); }));
        view.querySelectorAll('[data-folder-menu]').forEach(b => b.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            const f = folders.find(x => x.id === b.dataset.folderMenu); if (!f) return;
            const items = [{ label: 'Open', icon: 'folder', onClick: () => go(`/documents/?folder=${f.id}`) }];
            if (ctx.isManager || f.created_by === me.id) items.push({ label: 'Rename', icon: 'edit', onClick: () => renameFolder(f, () => showList(folderId)) }, { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteFolder(f, () => showList(folderId)) });
            C.menu(b, items);
        }));
        view.querySelector('#new-folder').addEventListener('click', () => newFolder(folderId, () => showList(folderId)));
        const drop = view.querySelector('#drop'), progress = view.querySelector('#progress');
        view.querySelector('#upload-btn').addEventListener('click', () => drop.querySelector('input').click());

        const tableEl = view.querySelector('#table');
        C.skeletonRows(tableEl, 5);
        let tbl = null;
        function columns() {
            return [
                { key: 'name', label: 'Name', lead: true, render: d => `<div class="who">${C.fileIcon(d)}<div><span class="primary-text">${esc(d.name)}</span>${d.description ? `<span class="sub">${esc(d.description)}</span>` : ''}</div></div>` },
                { key: 'mime_type', label: 'Type', hideMobile: true, render: d => esc(typeLabel(d.mime_type)) },
                { key: 'size_bytes', label: 'Size', num: true, render: d => esc(L.fmtBytes(d.size_bytes)) },
                { key: 'created_by', label: 'Uploaded by', value: d => C.personName(d.created_by), render: d => C.personHtml(d.created_by, { link: false }) },
                { key: 'created_at', label: 'Uploaded', render: d => `<span class="muted" title="${esc(L.fmtDateTime(d.created_at))}">${esc(L.fmtRelative(d.created_at))}</span>` },
                { key: 'links', label: 'Attached to', sort: false, render: d => (d.links || []).length ? chips(d.links, 3) : '<span class="muted">—</span>' },
                { key: 'actions', label: '', sort: false, cls: 'actions', render: d => `<button type="button" class="ws-btn sm icon" data-menu="${esc(d.id)}" aria-label="Actions">${C.icon('more')}</button>` },
            ];
        }
        function paint() {
            const rows = filterRows(listState.rows);
            view.querySelector('#count').textContent = `${rows.length} file${rows.length === 1 ? '' : 's'}${listState.rows.length >= 500 ? ' (first 500 loaded, search to narrow)' : ''}`;
            if (!tbl) tbl = C.table(tableEl, {
                columns: columns(), rows, sort: { key: 'created_at', dir: 'desc' }, pageSize: 50, onRow: d => go(`/documents/?id=${d.id}`),
                empty: { title: listState.q || listState.type || listState.by || listState.attached ? 'No documents match' : (listState.archived ? 'No archived documents' : 'No documents here yet'), sub: listState.q ? 'Try another name or clear the filters.' : 'Upload a file below, or attach one from a project, task, contact or deal.' },
            });
            else tbl.update(rows);
        }
        async function reload() {
            try { listState.rows = await fetchDocs(folderId); await labelsFor(listState.rows.flatMap(d => (d.links || []).slice(0, 3))); paint(); }
            catch (e) { C.errorState(tableEl, e, reload); }
        }
        tableEl.addEventListener('click', e => {
            const b = e.target.closest('[data-menu]'); if (!b) return;
            e.stopPropagation();
            const d = listState.rows.find(x => x.id === b.dataset.menu); if (d) docMenu(b, d, reload);
        });
        const onSearch = C.debounce(async () => {
            listState.q = view.querySelector('#q').value;
            const needServer = listState.rows.length >= 500 || listState.serverSearch;
            if (needServer) { listState.serverSearch = !!listState.q.trim(); await reload(); } else paint();
        }, 220);
        view.querySelector('#q').addEventListener('input', onSearch);
        view.querySelector('#f-type').addEventListener('change', e => { listState.type = e.target.value; paint(); });
        view.querySelector('#f-by').addEventListener('change', e => { listState.by = e.target.value; reload(); });
        view.querySelector('#f-att').addEventListener('change', e => { listState.attached = e.target.value; reload(); });
        view.querySelector('#f-arch').addEventListener('change', e => { listState.archived = e.target.checked; reload(); });

        async function handleFiles(files) {
            for (const file of Array.from(files || [])) {
                const row = h(`<div class="crm-upload-row"><span>${esc(file.name)}</span><span class="ws-bar" style="flex:1"><i style="width:30%"></i></span><span class="st">Uploading…</span></div>`);
                progress.appendChild(row);
                try {
                    const doc = await C.uploadDocument(file, { folder_id: folderId || null });
                    row.querySelector('i').style.width = '100%';
                    const existed = doc.created_at && (Date.now() - new Date(doc.created_at)) > 60000;
                    row.querySelector('.st').textContent = existed ? 'Identical file already existed — linked' : 'Done';
                    if (existed && folderId && !doc.folder_id && (doc.created_by === me.id || ctx.isManager)) { try { await sb.from('documents').update({ folder_id: folderId }).eq('id', doc.id); } catch (e) { /* keep where it was */ } }
                    else if (existed && folderId && doc.folder_id && doc.folder_id !== folderId) row.querySelector('.st').textContent = 'Identical file already exists in another folder — linked there';
                    setTimeout(() => row.remove(), 3500);
                } catch (e) { row.querySelector('.st').textContent = e.message; row.querySelector('.st').style.color = 'var(--ws-danger-text)'; setTimeout(() => row.remove(), 8000); }
            }
            reload();
        }
        drop.querySelector('input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('over'));
        drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });
        drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.querySelector('input').click(); } });
        await reload();
        if (C.param('new') === '1') { C.setParam('new', null, true); drop.scrollIntoView({ block: 'center' }); drop.focus(); drop.classList.add('over'); setTimeout(() => drop.classList.remove('over'), 1200); }
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        C.loading(view, 'Loading document…');
        let d;
        try {
            await loadFolders();
            d = (await C.q(sb.from('documents').select(SELECT).eq('id', id).maybeSingle())).data;
        } catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!d) { view.innerHTML = `<a class="crm-back" href="/documents/">${C.icon('arrow')}All documents</a>`; return C.empty(view.appendChild(document.createElement('div')), 'Document not found', 'It may have been deleted, or you may not have access to it.'); }
        document.title = `${d.name} · Documents · WorkSuite`;
        WSShell.setCrumb(d.name);
        await labelsFor(d.links || []);
        const mime = String(d.mime_type || '');
        const path = d.folder_id ? folderPath(d.folder_id) : [];
        const reload = () => showRecord(id);
        view.innerHTML = `
            <a class="crm-back" href="${d.folder_id ? `/documents/?folder=${esc(d.folder_id)}` : '/documents/'}" data-nav>${C.icon('arrow')}${esc(d.folder_id ? folderName(d.folder_id) : 'All documents')}</a>
            <div class="crm-record-head">
                ${C.fileIcon(d)}
                <div class="titles">
                    <h1>${esc(d.name)}</h1>
                    <div class="meta">
                        <span>${esc(typeLabel(mime))} · ${esc(L.fmtBytes(d.size_bytes))}</span>
                        ${d.archived_at ? C.badge('mute', 'Archived') : ''}
                        <span>Uploaded by ${C.personHtml(d.created_by)} · ${esc(L.fmtDateTime(d.created_at))}</span>
                    </div>
                </div>
                <div class="actions">
                    <button type="button" class="ws-btn" id="open-btn">${C.icon('doc')}<span>Open</span></button>
                    <button type="button" class="ws-btn" id="dl-btn">${C.icon('download')}<span>Download</span></button>
                    <button type="button" class="ws-btn primary" id="attach-btn">${C.icon('link')}<span>Attach to record</span></button>
                    <button type="button" class="ws-btn icon" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div class="crm-detail">
                <div class="ws-stack">
                    <div class="ws-card"><div class="crm-section-title"><h3>Preview</h3></div><div id="preview"><div class="ws-empty">Loading preview…</div></div></div>
                    <div class="ws-card"><div class="crm-section-title"><h3>Activity</h3></div><div id="activity"></div></div>
                </div>
                <div class="ws-stack">
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Details</h3></div>
                        <dl class="crm-props one">
                            <div><dt>Name</dt><dd>${esc(d.name)}</dd></div>
                            ${d.description ? `<div><dt>Description</dt><dd>${C.linkify(C.nl2br(d.description))}</dd></div>` : ''}
                            ${d.original_name && d.original_name !== d.name ? `<div><dt>Original file name</dt><dd>${esc(d.original_name)}</dd></div>` : ''}
                            <div><dt>Type</dt><dd>${esc(mime || 'Unknown')}</dd></div>
                            <div><dt>Size</dt><dd>${esc(L.fmtBytes(d.size_bytes))}</dd></div>
                            <div><dt>Folder</dt><dd>${path.length ? path.map(f => `<a href="/documents/?folder=${esc(f.id)}" data-nav>${esc(f.name)}</a>`).join(' › ') : '<span class="muted">Documents (root)</span>'}</dd></div>
                            <div><dt>Uploaded</dt><dd>${esc(L.fmtDateTime(d.created_at))} by ${esc(C.personName(d.created_by))}</dd></div>
                            ${d.sha256 ? `<div><dt>Fingerprint</dt><dd class="muted" style="font-size:12px" title="SHA-256">${esc(d.sha256.slice(0, 16))}…</dd></div>` : ''}
                            ${ctx.isManager ? `<div><dt>Storage path</dt><dd class="muted" style="font-size:12px;overflow-wrap:anywhere">${esc(d.bucket)}/${esc(d.storage_path)}</dd></div>` : ''}
                        </dl>
                    </div>
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Attached to</h3></div>
                        <div id="links"></div>
                    </div>
                </div>
            </div>`;
        view.querySelectorAll('[data-nav]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go(a.getAttribute('href')); }));
        // Preview
        const pv = view.querySelector('#preview');
        try {
            if (mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('text/')) {
                const url = await C.signedUrl(d);
                pv.innerHTML = mime.startsWith('image/') ? `<div style="text-align:center"><img class="crm-preview" src="${esc(url)}" alt="${esc(d.name)}"></div>`
                    : mime.startsWith('video/') ? `<video class="crm-preview" src="${esc(url)}" controls style="width:100%"></video>`
                    : mime.startsWith('audio/') ? `<audio src="${esc(url)}" controls style="width:100%"></audio>`
                    : `<iframe class="crm-preview-frame" src="${esc(url)}" title="${esc(d.name)}"></iframe>`;
            } else pv.innerHTML = `<div class="ws-empty"><b>No inline preview for this type</b><div>Use Open or Download to view it.</div></div>`;
        } catch (e) { pv.innerHTML = `<div class="ws-empty"><b>Preview unavailable</b><div>${esc(e.message)}</div></div>`; }
        // Links
        const linksEl = view.querySelector('#links');
        function paintLinks() {
            const links = d.links || [];
            if (!links.length) return C.empty(linksEl, 'Not attached to anything yet', 'Attach it to a project, task, contact, deal, lead or invoice.');
            linksEl.innerHTML = `<ul class="crm-list compact">${links.map(l => `<li>${C.icon((C.ENTITY_META[l.entity_type] || {}).icon || 'link')}<div class="main"><b><a href="${esc(C.entityUrl(l.entity_type, l.entity_id))}">${esc(labelCache.get(`${l.entity_type}:${l.entity_id}`) || (C.ENTITY_META[l.entity_type] || {}).label || l.entity_type)}</a></b><span>${esc((C.ENTITY_META[l.entity_type] || {}).label || l.entity_type)}</span></div><div class="right"><button type="button" class="ws-btn sm" data-unlink="${esc(l.entity_type)}:${esc(l.entity_id)}" title="Detach">${C.icon('x')}</button></div></li>`).join('')}</ul>`;
        }
        paintLinks();
        linksEl.addEventListener('click', async e => {
            const b = e.target.closest('[data-unlink]'); if (!b) return;
            const [type, eid] = b.dataset.unlink.split(':');
            if (!await C.confirm({ title: 'Detach this document?', message: 'The file stays in Documents; only the link to the record is removed.', okText: 'Detach' })) return;
            try { await C.q(sb.from('document_links').delete().eq('document_id', d.id).eq('entity_type', type).eq('entity_id', eid)); C.toast('Detached', 'ok'); reload(); } catch (err) { C.toast(err.message, 'bad'); }
        });
        C.activityFeed(view.querySelector('#activity'), { entity_type: 'document', entity_id: id, withComments: false, limit: 40 });
        view.querySelector('#open-btn').addEventListener('click', () => C.openDocument(d));
        view.querySelector('#dl-btn').addEventListener('click', () => download(d));
        view.querySelector('#attach-btn').addEventListener('click', () => attachDoc(d, reload));
        view.querySelector('#more-btn').addEventListener('click', e => {
            const items = [];
            if (canManage(d)) {
                items.push({ label: 'Rename', icon: 'edit', onClick: () => renameDoc(d, reload) }, { label: 'Move to folder', icon: 'folder', onClick: () => moveDoc(d, reload) }, 'sep');
                items.push(d.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(d, false, reload) } : { label: 'Archive', icon: 'trash', onClick: () => setArchived(d, true, reload) });
                items.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteDoc(d, () => go(d.folder_id ? `/documents/?folder=${d.folder_id}` : '/documents/')) });
            } else items.push({ label: 'Only the uploader or a manager can change this file', icon: 'lock', onClick: () => {} });
            C.menu(e.currentTarget, items);
        });
    }

    route();
})();
