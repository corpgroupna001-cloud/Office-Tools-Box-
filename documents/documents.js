/* ============================================================================
   Documents — the company drive in the Bitrix24 layout.

   Files (Supabase Storage, private `documents` bucket, opened through 1-hour
   signed URLs) and WorkSuite documents, spreadsheets and presentations
   (JSON on the row, edited in documents/editors.js) live side by side in
   folders. Each item is private, company-wide or shared with chosen people,
   and can have a public link (documents/public.html) that its owner turns on
   and off. Deleting moves an item to the Recycle bin; only from there is it
   removed for good. The same file can be attached to any number of CRM and
   work records through document_links.

   URLs:  /documents/                  the drive          /documents/?folder=<uuid>   a folder
          /documents/?id=<uuid>        open one item      /documents/?view=list|grid|tiles
          /documents/?create=document|spreadsheet|presentation   /documents/?new=1  (upload)
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h, B = window.WSB24, D = window.WSDrive;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'documents', crumb: 'Documents' });
    const sb = ctx.sb, me = ctx.user;

    const BASE = 'id, company, name, original_name, bucket, storage_path, mime_type, size_bytes, sha256, folder_id, description, archived_at, created_by, created_at, updated_at';
    const LINKS = ', links:document_links(entity_type, entity_id)';
    const FULL = BASE + ', visibility, doc_kind, published_token, published_at, updated_by' + LINKS;
    const LEGACY = BASE + LINKS;
    const cols = await B.columns('documents', FULL, LEGACY);        // before supabase-b24-migration.sql: files and folders only

    const LINK_TYPES = ['project', 'task', 'contact', 'deal', 'lead', 'invoice'];
    const MIMES = {
        office: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint',
                 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.text',
                 'application/vnd.oasis.opendocument.presentation', 'application/rtf', 'text/rtf'],
        sheet: ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet'],
        archive: ['application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/vnd.rar', 'application/gzip', 'application/x-tar'],
    };
    const TYPES = [
        ...(cols.full ? [['document', 'Documents', b => b.eq('doc_kind', 'document')], ['spreadsheet', 'Spreadsheets', b => b.eq('doc_kind', 'spreadsheet')],
                         ['presentation', 'Presentations', b => b.eq('doc_kind', 'presentation')]] : []),
        ['pdf', 'PDF files', b => b.eq('mime_type', 'application/pdf')],
        ['image', 'Images', b => b.like('mime_type', 'image/%')],
        ['office', 'Word and PowerPoint files', b => b.in('mime_type', MIMES.office)],
        ['sheet', 'Excel and CSV files', b => b.in('mime_type', MIMES.sheet)],
        ['archive', 'Archives', b => b.in('mime_type', MIMES.archive)],
        ['video', 'Video', b => b.like('mime_type', 'video/%')],
        ['audio', 'Audio', b => b.like('mime_type', 'audio/%')],
    ];
    const VIS = {
        company: { label: 'Company', color: 'ok', hint: 'Everyone in the company can open it' },
        private: { label: 'Private', color: 'mute', hint: 'Only you' },
        shared: { label: 'Shared', color: 'warn', hint: 'Only the people you choose' },
    };
    const visOptions = () => Object.entries(VIS).map(([value, x]) => ({ value, label: `${x.label}: ${x.hint}` }));
    const pref = (k, dflt) => { try { return localStorage.getItem(k) || dflt; } catch (e) { return dflt; } };
    const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

    /* ------------------------------------------------------------ items */
    const isNative = d => !!d && !!d.doc_kind && d.doc_kind !== 'file';
    const vis = d => d.visibility || 'company';
    const mine = d => d.created_by === me.id;
    let myShares = new Map();                                     // document_id -> can_edit
    async function loadMyShares() {
        if (!cols.full) return;
        const r = await sb.from('document_shares').select('document_id, can_edit').eq('user_id', me.id).limit(2000);
        if (!r.error) myShares = new Map((r.data || []).map(s => [s.document_id, s.can_edit]));
    }
    // The same rule as ws_document_access(…, edit): the owner, managers for company items, people shared with edit rights.
    const canEdit = d => mine(d) || (ctx.isManager && vis(d) === 'company') || myShares.get(d.id) === true;
    const canDelete = d => mine(d) || (ctx.isManager && vis(d) === 'company');
    function kindOf(d) {
        if (d._folder) return 'folder';
        if (isNative(d)) return { document: 'doc', spreadsheet: 'xls', presentation: 'ppt' }[d.doc_kind];
        const m = String(d.mime_type || ''), ext = String(d.name || '').split('.').pop().toLowerCase();
        if (m === 'application/pdf') return 'pdf';
        if (m.startsWith('image/')) return 'img';
        if (/sheet|excel|csv/.test(m) || ['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return 'xls';
        if (/presentation|powerpoint/.test(m) || ['pptx', 'ppt', 'odp'].includes(ext)) return 'ppt';
        if (/word|msword|opendocument\.text|rtf/.test(m) || ['docx', 'doc', 'odt', 'rtf'].includes(ext)) return 'doc';
        if (/zip|rar|7z|tar|gzip/.test(m)) return 'zip';
        if (/^(audio|video)\//.test(m)) return 'media';
        return 'file';
    }
    function glyph(d) {
        if (d._folder) return '';
        if (isNative(d)) return { document: 'DOC', spreadsheet: 'XLS', presentation: 'PPT' }[d.doc_kind];
        const name = String(d.name || '');
        return (name.includes('.') ? name.split('.').pop() : String(d.mime_type || 'file').split('/').pop()).slice(0, 4).toUpperCase();
    }
    const ico = (d, big) => `<span class="dv-ico k-${kindOf(d)}${big ? ' big' : ''}" aria-hidden="true">${esc(glyph(d))}</span>`;
    function typeText(d) {
        if (d._folder) return 'Folder';
        if (isNative(d)) return D.KINDS[d.doc_kind].label;
        return { pdf: 'PDF', img: 'Image', xls: 'Spreadsheet file', ppt: 'Presentation file', doc: 'Word document', zip: 'Archive', media: 'Audio or video' }[kindOf(d)]
            || (String(d.mime_type || '').split('/').pop().toUpperCase().slice(0, 14) || 'File');
    }
    const accessBadge = d => C.badge(VIS[vis(d)].color, VIS[vis(d)].label);
    const sizeText = d => (d._folder || !d.size_bytes ? '' : L.fmtBytes(d.size_bytes));

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

    /* ------------------------------------------------------------ routing */
    const dv = { inDrive: false, folderId: null, mode: 'list', filter: null, grid: null, cards: null, attachedIds: null,
                 doc: null, editor: null, pending: null, saving: false, stamp: null, timer: null, unsub: null, presence: null };
    function route() {
        const id = C.param('id'), folder = C.param('folder') || null;
        if (!id && dv.inDrive && dv.filter) { dv.folderId = folder; WSShell.setCrumb(folder ? folderName(folder) : 'Documents'); paintCrumbs(); mountBody(); return; }
        cleanup();
        if (id) return openDoc(id);
        return showDrive(folder);
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }
    /** Leaving the editor: save what is left once any save in flight has finished (same version check). */
    function saveOnLeave(d, data) {
        const json = JSON.parse(JSON.stringify(data));
        Promise.resolve(dv.saveP).then(async () => {
            let b = sb.from('documents').update({ content: json, updated_by: me.id, size_bytes: JSON.stringify(json).length }).eq('id', d.id);
            if (d._stamp) b = b.eq('updated_at', d._stamp);
            const r = await b.select('updated_at');
            if (r.error || !(r.data || []).length) C.toast(`Your last change to ${d.name} was not saved: ${r.error ? C.friendly(r.error) : 'someone saved a newer version first'}.`, 'bad');
            else d._stamp = r.data[0].updated_at;
        });
    }
    function cleanup() {
        if (dv.editor && dv.editor.flush) dv.editor.flush();     // the text editor waits for a pause in typing before reporting
        if (dv.pending && dv.doc) saveOnLeave(dv.doc, dv.pending);
        clearTimeout(dv.timer);
        if (dv.unsub) { dv.unsub(); dv.unsub = null; }
        if (dv.presence) { try { sb.removeChannel(dv.presence); } catch (e) { /* already gone */ } dv.presence = null; }
        if (dv.grid) { dv.grid.destroy(); dv.grid = null; }
        if (dv.filter) { dv.filter.destroy(); dv.filter = null; }
        if (dv.editor) { dv.editor.destroy(); dv.editor = null; }
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('resize', onResize);
        dv.inDrive = false; dv.cards = null; dv.doc = null; dv.pending = null;
    }
    window.addEventListener('beforeunload', e => {
        if (dv.editor && dv.editor.flush) dv.editor.flush();
        if ((dv.pending || dv.saving) && dv.doc) { if (dv.pending) saveNow(); e.preventDefault(); e.returnValue = ''; }
    });

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
    const childFolders = () => folders.filter(f => (f.parent_id || null) === (dv.folderId || null)).sort((a, b) => a.name.localeCompare(b.name))
        .map(f => ({ ...f, _folder: true, updated_at: f.created_at }));
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
        if (n) return C.alert({ title: 'Folder is not empty', message: `"${f.name}" still holds ${docs.count || 0} item${docs.count === 1 ? '' : 's'} (the Recycle bin included) and ${subs.count || 0} sub-folder${subs.count === 1 ? '' : 's'}. Move or delete them first.` });
        if (!await C.confirm({ title: `Delete the folder "${f.name}"?`, message: 'The folder is empty, so nothing else is affected.', okText: 'Delete', danger: true })) return;
        try { await C.q(sb.from('document_folders').delete().eq('id', f.id)); C.toast('Folder deleted', 'ok'); if (after) after(); } catch (e) { C.toast(e.message, 'bad'); }
    }
    function folderOptions(excludeId) {
        const opts = [{ value: '', label: 'Documents (top level)' }];
        const walk = (parent, depth) => folders.filter(f => (f.parent_id || null) === parent && f.id !== excludeId).forEach(f => { opts.push({ value: f.id, label: `${'— '.repeat(depth)}${f.name}` }); walk(f.id, depth + 1); });
        walk(null, 0);
        return opts;
    }
    function folderMenu(f) {
        const items = [{ label: 'Open', icon: 'folder', onClick: () => go(`/documents/?folder=${f.id}`) }];
        if (ctx.isManager || f.created_by === me.id) items.push({ label: 'Rename', icon: 'edit', onClick: () => renameFolder(f, refreshDrive) }, 'sep', { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteFolder(f, refreshDrive) });
        return items;
    }

    /* ---------------------------------------------------- document actions */
    async function renameDoc(d, after) {
        await C.formModal({
            title: 'Rename', intro: isNative(d) ? '' : '<div class="crm-info">Only the display name and description change; the stored file stays exactly as uploaded.</div>',
            fields: [{ name: 'name', label: 'Name', type: 'text', required: true, full: true }, { name: 'description', label: 'Description', type: 'textarea', full: true }],
            values: { name: d.name, description: d.description || '' },
            submitLabel: 'Save', onSubmit: async v => {
                await C.q(sb.from('documents').update({ name: v.name.trim(), description: v.description || null }).eq('id', d.id));
                d.name = v.name.trim(); d.description = v.description || null;
                C.toast('Renamed', 'ok'); if (after) after();
            },
        });
    }
    async function moveDoc(d, after) {
        if (!folders.length) await loadFolders();
        await C.formModal({
            title: 'Move to folder', fields: [{ name: 'folder_id', label: 'Folder', type: 'select', options: folderOptions(), full: true }], values: { folder_id: d.folder_id || '' },
            submitLabel: 'Move', onSubmit: async v => { await C.q(sb.from('documents').update({ folder_id: v.folder_id || null }).eq('id', d.id)); d.folder_id = v.folder_id || null; C.toast('Moved', 'ok'); if (after) after(); },
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
    async function toTrash(d, after) {
        try {
            if (d.published_token) await unpublishCopy(d);                 // a deleted item is not public any more
            const r = await C.q(sb.from('documents').update({ archived_at: new Date().toISOString(), ...(cols.full ? { published_token: null, published_at: null } : {}) }).eq('id', d.id).select('id'));
            if (!(r.data || []).length) throw new Error('Only people who can edit this item can delete it.');
            d.archived_at = new Date().toISOString(); d.published_token = null;
            C.toast(`${d.name} moved to the Recycle bin`, 'ok'); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function restoreDoc(d, after) {
        try {
            const r = await C.q(sb.from('documents').update({ archived_at: null }).eq('id', d.id).select('id'));
            if (!(r.data || []).length) throw new Error('Only people who can edit this item can restore it.');
            d.archived_at = null; C.toast('Restored', 'ok'); if (after) after();
        }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function removeForGood(d) {
        if (d.published_token) await unpublishCopy(d);
        if (d.storage_path) {
            // The storage delete policy for managers checks the documents row, so the object goes first.
            const r = await sb.storage.from(d.bucket || 'documents').remove([d.storage_path]);
            if (r.error) { console.warn('[documents] storage remove', r.error); throw new Error(`${d.name} could not be removed from storage.`); }
        }
        await C.q(sb.from('document_links').delete().eq('document_id', d.id));
        await C.q(sb.from('documents').delete().eq('id', d.id));
    }
    async function deleteDoc(d, after) {
        const n = (d.links || []).length;
        const ok = await C.confirm({ title: `Delete ${d.name} for good?`, message: `${isNative(d) ? 'Its content is' : 'The file is'} removed${n ? ` and detached from ${n} record${n === 1 ? '' : 's'}` : ''}. This cannot be undone.`, okText: 'Delete for good', danger: true });
        if (!ok) return false;
        try { await removeForGood(d); C.toast('Deleted', 'ok'); if (after) after(); return true; }
        catch (e) { C.toast(e.message, 'bad'); return false; }
    }
    async function exportNative(d, fmt) {
        // Export without opening the editor: mount it hidden and read-only.
        try {
            const row = (await C.q(sb.from('documents').select('content').eq('id', d.id).single())).data;
            const tmp = document.createElement('div'); tmp.hidden = true; document.body.appendChild(tmp);
            const ed = WSDocEditors.mount(tmp, { kind: d.doc_kind, content: row.content, canEdit: false, name: d.name });
            ed.exportAs(fmt);
            setTimeout(() => { ed.destroy(); tmp.remove(); }, 3000);
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function download(d) {
        if (isNative(d)) return exportNative(d, d.doc_kind === 'spreadsheet' ? 'csv' : d.doc_kind === 'document' ? 'doc' : 'pdf');
        try { const url = await C.signedUrl(d); window.open(url, '_blank', 'noopener'); } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function copyDoc(d) {
        try {
            const src = (await C.q(sb.from('documents').select('name, doc_kind, content, mime_type, size_bytes, folder_id').eq('id', d.id).single())).data;
            const { data } = await C.q(sb.from('documents').insert({ name: `Copy of ${src.name}`, doc_kind: src.doc_kind, content: src.content, mime_type: src.mime_type, size_bytes: src.size_bytes || 0, folder_id: src.folder_id, visibility: 'private', created_by: me.id }).select('id').single());
            C.toast('Copy created (private to you)', 'ok'); go(`/documents/?id=${data.id}`);
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function createNative(kind) {
        if (!cols.full) return C.alert({ title: 'Needs the latest database update', message: 'An administrator needs to run supabase-b24-migration.sql in Supabase before documents, spreadsheets and presentations can be created. Uploading files works meanwhile.' });
        const K = D.KINDS[kind];
        await C.formModal({
            title: `New ${K.label.toLowerCase()}`, submitLabel: 'Create and open',
            fields: [{ name: 'name', label: 'Name', type: 'text', required: true, full: true, placeholder: { document: 'e.g. Meeting notes', spreadsheet: 'e.g. Q4 budget', presentation: 'e.g. Product launch' }[kind] },
                     { name: 'visibility', label: 'Access', type: 'select', required: true, full: true, options: visOptions() }],
            values: { visibility: 'company' },
            onSubmit: async v => {
                const { data } = await C.q(sb.from('documents').insert({ name: v.name.trim(), doc_kind: kind, visibility: v.visibility, content: K.blank(), mime_type: K.mime, size_bytes: 0, folder_id: dv.folderId || null, created_by: me.id }).select('id').single());
                go(`/documents/?id=${data.id}`);
            },
        });
    }
    async function shareDoc(d, after) {
        const cur = await sb.from('document_shares').select('user_id, can_edit').eq('document_id', d.id);
        const shares = cur.data || [];
        await C.formModal({
            title: `Access to ${d.name}`, size: 'wide', submitLabel: 'Save',
            fields: [
                { name: 'visibility', label: 'Who can open it', type: 'select', required: true, full: true, options: visOptions() },
                { name: 'people', label: 'People', type: 'peoples', full: true },
                { name: 'can_edit', label: isNative(d) ? 'They can edit (otherwise view only)' : 'They can rename, move and replace it (otherwise view only)', type: 'check', full: true },
            ],
            values: { visibility: vis(d), people: shares.map(s => s.user_id), can_edit: shares.length ? shares.every(s => s.can_edit) : true },
            onReady: f => { const sync = () => { const shared = f.field('visibility').get() === 'shared'; f.field('people').wrap.hidden = !shared; f.field('can_edit').wrap.hidden = !shared; }; f.field('visibility').el.addEventListener('change', sync); sync(); },
            onSubmit: async v => {
                await C.q(sb.from('documents').update({ visibility: v.visibility }).eq('id', d.id));
                const want = v.visibility === 'shared' ? (v.people || []).filter(id => id !== me.id) : [];
                const gone = shares.map(s => s.user_id).filter(id => !want.includes(id));
                if (gone.length) await C.q(sb.from('document_shares').delete().eq('document_id', d.id).in('user_id', gone));
                if (want.length) await C.q(sb.from('document_shares').upsert(want.map(id => ({ document_id: d.id, user_id: id, can_edit: !!v.can_edit, created_by: me.id })), { onConflict: 'document_id,user_id' }));
                want.filter(id => !shares.some(s => s.user_id === id)).forEach(id => C.pushNotify({ to: id, title: 'A document was shared with you', body: d.name, url: `/documents/?id=${d.id}`, tag: 'document' }));
                d.visibility = v.visibility;
                C.toast('Access updated', 'ok'); if (after) after();
            },
        });
    }

    /* ------------------------------------------------------- public links */
    const publicUrl = token => `${location.origin}/documents/public?t=${encodeURIComponent(token)}`;
    async function unpublishCopy(d) {
        if (d.storage_path && d.published_token) { const r = await sb.storage.from('published').remove([`${d.published_token}/file`]); if (r.error) console.warn('[documents] unpublish copy', r.error); }
    }
    async function publish(d) {
        const token = D.newToken(), at = new Date().toISOString();
        await C.q(sb.from('documents').update({ published_token: token, published_at: at }).eq('id', d.id));
        if (d.storage_path) {
            // Files: a copy goes to the public "published" bucket under the token, and only lives while the link is on.
            try {
                const dl = await sb.storage.from(d.bucket || 'documents').download(d.storage_path);
                if (dl.error) throw dl.error;
                const up = await sb.storage.from('published').upload(`${token}/file`, dl.data, { contentType: d.mime_type || 'application/octet-stream', upsert: false });
                if (up.error) throw up.error;
            } catch (e) {
                console.warn('[documents] publish', e);
                await sb.from('documents').update({ published_token: null, published_at: null }).eq('id', d.id);
                throw new Error('The file could not be published. Try again.');
            }
        }
        d.published_token = token; d.published_at = at;
    }
    async function unpublish(d) {
        await unpublishCopy(d);
        await C.q(sb.from('documents').update({ published_token: null, published_at: null }).eq('id', d.id));
        d.published_token = null; d.published_at = null;
    }
    function publishDoc(d, after) {
        const what = isNative(d) ? `this ${D.KINDS[d.doc_kind].label.toLowerCase()}` : 'this file';
        const body = document.createElement('div');
        body.innerHTML = d.published_token
            ? `<p style="margin:0 0 12px">Anyone with this link can view ${what} without signing in. Turning the link off stops it working straight away.</p>
               <div class="dv-link"><input type="text" readonly value="${esc(publicUrl(d.published_token))}" aria-label="Public link"><button type="button" class="ws-btn" data-copy>Copy</button></div>
               <p class="muted" style="font-size:12.5px;margin:10px 0 0">On since ${esc(L.fmtDateTime(d.published_at))}. ${isNative(d) ? 'Viewers always see the latest saved version.' : 'Viewers get the file as it was when the link was turned on.'}</p>`
            : `<p style="margin:0">Create a link that lets anyone view ${what} without signing in, for example to send it to a customer. You can turn it off at any time.</p>`;
        const m = C.modal({
            title: 'Public link', body,
            actions: d.published_token
                ? [{ label: 'Turn the link off', danger: true, onClick: async api => { await unpublish(d); api.close(); C.toast('Public link turned off', 'ok'); if (after) after(); } }, { label: 'Done', primary: true, close: true }]
                : [{ label: 'Cancel', close: true }, { label: 'Create public link', primary: true, onClick: async api => { await publish(d); api.close(); if (after) after(); publishDoc(d, after); } }],
        });
        const cp = body.querySelector('[data-copy]');
        if (cp) cp.addEventListener('click', async () => {
            const input = body.querySelector('input');
            try { await navigator.clipboard.writeText(input.value); C.toast('Link copied', 'ok'); } catch (e) { input.select(); document.execCommand('copy'); C.toast('Link copied', 'ok'); }
        });
        return m;
    }

    function docMenu(d, after) {
        after = after || refreshDrive;
        if (d.archived_at) {
            const items = [
                ...(canEdit(d) ? [{ label: 'Restore', icon: 'refresh', onClick: () => restoreDoc(d, after) }] : []),
                ...(canDelete(d) ? ['sep', { label: 'Delete for good', icon: 'trash', danger: true, onClick: () => deleteDoc(d, after) }] : []),
            ].filter((x, i) => !(x === 'sep' && i === 0));
            return items.length ? items : [{ label: 'Only the owner or a manager can restore this', icon: 'lock', onClick: () => {} }];
        }
        const items = [
            { label: isNative(d) ? 'Open' : 'Preview', icon: 'doc', onClick: () => openItem(d) },
            { label: 'Download', icon: 'download', onClick: () => download(d) },
            ...(isNative(d) ? [] : [{ label: 'Details', icon: 'arrow', onClick: () => go(`/documents/?id=${d.id}`) }]),
            'sep',
        ];
        if (cols.full && mine(d)) items.push({ label: 'Access…', icon: 'users', onClick: () => shareDoc(d, after) });
        if (cols.full && canEdit(d)) items.push({ label: d.published_token ? 'Public link (on)…' : 'Public link…', icon: 'globe', onClick: () => publishDoc(d, after) });
        items.push({ label: 'Attach to record', icon: 'link', onClick: () => attachDoc(d, after) });
        if (canEdit(d)) items.push({ label: 'Rename', icon: 'edit', onClick: () => renameDoc(d, after) }, { label: 'Move to folder', icon: 'folder', onClick: () => moveDoc(d, after) });
        if (isNative(d)) items.push({ label: 'Make a copy', icon: 'plus', onClick: () => copyDoc(d) });
        if (canEdit(d)) items.push('sep', { label: 'Delete', icon: 'trash', danger: true, onClick: () => toTrash(d, after) });
        return items;
    }
    function openItem(d) {
        if (d._folder) return go(`/documents/?folder=${d.id}`);
        if (isNative(d) || d.archived_at) return go(`/documents/?id=${d.id}`);
        C.openDocument(d);
    }

    /* ------------------------------------------------------------ uploads */
    const fileInput = h('<input type="file" multiple hidden aria-hidden="true">');
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', () => { uploadFiles(fileInput.files, dv.folderId); fileInput.value = ''; });
    let upPanel = null;
    function uploadsPanel() {
        if (upPanel && upPanel.isConnected) return upPanel;
        upPanel = h(`<div class="dv-uploads" role="status" aria-live="polite"><header><span data-title>Uploading</span><button type="button" class="ws-btn sm icon ghost" data-x aria-label="Close">${C.icon('x')}</button></header><div data-rows></div></div>`);
        upPanel.querySelector('[data-x]').addEventListener('click', () => { upPanel.remove(); upPanel = null; });
        document.body.appendChild(upPanel);
        return upPanel;
    }
    async function uploadFiles(files, folderId) {
        const list = Array.from(files || []); if (!list.length) return;
        const p = uploadsPanel(), rowsEl = p.querySelector('[data-rows]');
        let done = 0, failed = 0;
        p.querySelector('[data-title]').textContent = `Uploading ${list.length} file${list.length === 1 ? '' : 's'}…`;
        for (const file of list) {
            const row = h(`<div class="row"><span class="n">${esc(file.name)}</span><span class="st">Uploading…</span></div>`);
            rowsEl.prepend(row);
            try {
                const doc = await C.uploadDocument(file, { folder_id: folderId || null });
                const existed = doc.created_at && (Date.now() - new Date(doc.created_at)) > 60000;
                let note = 'Done';
                if (existed) {
                    note = 'Already in Documents: linked to that copy';
                    if (folderId && !doc.folder_id && canEdit(doc)) { try { await sb.from('documents').update({ folder_id: folderId }).eq('id', doc.id); } catch (e) { /* keep where it was */ } }
                }
                row.querySelector('.st').textContent = note; done++;
            } catch (e) { const st = row.querySelector('.st'); st.textContent = e.message; st.classList.add('bad'); failed++; }
        }
        p.querySelector('[data-title]').textContent = failed ? `${done} uploaded, ${failed} failed` : `${done} file${done === 1 ? '' : 's'} uploaded`;
        if (!failed) setTimeout(() => { if (upPanel === p) { p.remove(); upPanel = null; } }, 6000);
        refreshDrive();
    }
    // Drop files anywhere on the drive.
    let dragDepth = 0, dropEl = null;
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const endDrag = () => { dragDepth = 0; if (dropEl) { dropEl.remove(); dropEl = null; } };
    document.addEventListener('dragenter', e => {
        if (!dv.inDrive || !hasFiles(e)) return;
        e.preventDefault(); dragDepth++;
        if (!dropEl) { dropEl = h(`<div class="dv-drop"><span>Drop to upload to ${esc(dv.folderId ? folderName(dv.folderId) : 'Documents')}</span></div>`); document.body.appendChild(dropEl); }
    });
    document.addEventListener('dragover', e => { if (dv.inDrive && hasFiles(e)) e.preventDefault(); });
    document.addEventListener('dragleave', () => { if (dropEl && --dragDepth <= 0) endDrag(); });
    document.addEventListener('drop', e => { if (!dv.inDrive || !hasFiles(e)) return; e.preventDefault(); endDrag(); uploadFiles(e.dataTransfer.files, dv.folderId); });

    /* -------------------------------------------------------------- drive */
    const presets = [
        { key: 'drive', title: 'All documents', values: {} },
        { key: 'mine', title: 'My documents', values: { mine: true } },
        ...(cols.full ? [{ key: 'shared', title: 'Shared with me', values: { sharedme: true } }, { key: 'company', title: 'Company documents', values: { access: 'company' } }] : []),
        { key: 'recent', title: 'Changed in the last 30 days', values: { recent: true } },
        { key: 'trash', title: 'Recycle bin', values: { trash: true } },
    ];
    const filled = v => v !== '' && v != null && v !== false && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.values(v).some(x => x !== '' && x != null));
    /** Folder browsing: no search and no filter, so the drive shows folders and the current folder's items. */
    function folderMode() {
        if (!dv.filter) return true;
        const st = dv.filter.get();
        return !st.search && !Object.values(st.values || {}).some(filled);
    }
    const inTrash = () => !!(dv.filter && dv.filter.get().values.trash);
    function scoped(b) {
        b = inTrash() ? b.not('archived_at', 'is', null) : b.is('archived_at', null);
        if (folderMode()) b = dv.folderId ? b.eq('folder_id', dv.folderId) : b.is('folder_id', null);
        if (dv.attachedIds) b = b.in('id', dv.attachedIds.length ? dv.attachedIds : ['00000000-0000-0000-0000-000000000000']);
        return dv.filter ? dv.filter.apply(b, { searchColumns: ['name', 'description'] }) : b;
    }
    async function syncAttached() {
        const t = dv.filter && dv.filter.get().values.attached;
        dv.attachedIds = null;
        if (!t) return;
        const r = await sb.from('document_links').select('document_id').eq('entity_type', t).limit(3000);
        dv.attachedIds = [...new Set((r.data || []).map(x => x.document_id))];
    }
    const CARD_SORTS = [['updated_at:desc', 'Date modified'], ['name:asc', 'Name'], ['size_bytes:desc', 'Size'], ['created_at:desc', 'Date created']];
    function cardSort() {
        let v = pref('ws-docs-sort', 'updated_at:desc');
        if (!CARD_SORTS.some(s => s[0] === v)) v = 'updated_at:desc';
        const [key, dir] = v.split(':');
        return { key, asc: dir === 'asc', value: v };
    }
    const createItems = () => [
        ...(cols.full ? [{ label: 'Document', icon: 'doc', onClick: () => createNative('document') }, { label: 'Spreadsheet', icon: 'dashboard', onClick: () => createNative('spreadsheet') },
                         { label: 'Presentation', icon: 'board', onClick: () => createNative('presentation') }, 'sep'] : []),
        { label: 'Folder', icon: 'folder', onClick: () => newFolder(dv.folderId, refreshDrive) },
        { label: 'Upload files', icon: 'upload', onClick: () => fileInput.click() },
        'sep',
        { label: 'Board', icon: 'board', onClick: () => { location.href = '/boards/?new=1'; } },
    ];

    async function showDrive(folderId) {
        dv.inDrive = true; dv.folderId = folderId;
        view.classList.remove('b24-legacy-panel');
        document.title = 'Documents · WorkSuite';
        C.loading(view, 'Loading documents…');
        try { await Promise.all([loadFolders(), loadMyShares()]); } catch (e) { return C.errorState(view, e, () => showDrive(folderId)); }
        if (!dv.inDrive) return;
        WSShell.setCrumb(folderId ? folderName(folderId) : 'Documents');
        let mode = pref('ws-docs-view', 'list');
        if (['list', 'grid', 'tiles'].includes(C.param('view'))) mode = C.param('view');
        dv.mode = ['list', 'grid', 'tiles'].includes(mode) ? mode : 'list';
        const cs = cardSort();
        view.innerHTML = B.titleBar({ title: 'Documents', createLabel: 'Create', createMenu: true, extra: `<button type="button" class="b24-btn-glass" data-upload>${C.icon('upload')}<span>Upload</span></button>` })
            + `<div class="b24-toolbar dv-toolbar">
                <nav class="dv-crumbs" aria-label="Where you are" data-crumbs></nav>
                <span class="grow"></span>
                <button type="button" class="ws-btn sm" data-empty-trash hidden>${C.icon('trash')}<span>Empty the Recycle bin</span></button>
                <button type="button" class="ws-btn sm" data-open-trash>${C.icon('trash')}<span>Recycle bin</span></button>
                <select class="dv-sort" data-sort aria-label="Sort by">${CARD_SORTS.map(([v, l]) => `<option value="${v}"${v === cs.value ? ' selected' : ''}>${l}</option>`).join('')}</select>
                <div class="b24-views" role="tablist" aria-label="View"><button type="button" role="tab" data-view="list">List</button><button type="button" role="tab" data-view="grid">Grid</button><button type="button" role="tab" data-view="tiles">Tiles</button></div>
            </div>`
            + (cols.full ? '' : `<div class="crm-notice" style="margin:0 0 12px">${C.icon('lock')}<div><b>Private and shared documents, public links and WorkSuite documents need the latest database update.</b><br>An administrator needs to run <code>supabase-b24-migration.sql</code> in Supabase → SQL Editor. Files and folders work as before.</div></div>`)
            // The row of big "create" tiles above the drive.
            + `<div class="dv-create" data-create-strip role="group" aria-label="Create">
                ${cols.full ? [['document', 'doc', 'DOC', 'Document'], ['spreadsheet', 'xls', 'XLS', 'Spreadsheet'], ['presentation', 'ppt', 'PPT', 'Presentation']].map(([k, cls, g, label]) => `<button type="button" class="dv-tile" data-new-kind="${k}"><span class="dv-ico big k-${cls}">${g}</span><span class="plus" aria-hidden="true">+</span><span class="l">${label}</span></button>`).join('') : ''}
                <button type="button" class="dv-tile" data-new-board><span class="dv-ico big k-board">BOARD</span><span class="plus" aria-hidden="true">+</span><span class="l">Board</span></button>
                <span class="dv-create-sep" aria-hidden="true"></span>
                <button type="button" class="dv-tile open" data-new-upload><span class="dv-ico big k-file">${C.icon('upload')}</span><span class="l">Upload from computer</span></button>
                <button type="button" class="dv-tile open" data-new-folder><span class="dv-ico big k-folder"></span><span class="l">New folder</span></button>
            </div>`
            + '<div id="body"></div>';
        dv.filter = WSFilter.mount(view.querySelector('[data-filter]'), {
            id: 'documents', me: me.id, defaultPreset: 'drive', presets, placeholder: 'Filter + search',
            fields: [
                { key: 'type', title: 'Type', type: 'select', options: TYPES.map(([value, label]) => ({ value, label })), apply: (b, v) => { const t = TYPES.find(x => x[0] === v); return t ? t[2](b) : b; } },
                { key: 'owner', title: 'Owner', type: 'user', column: 'created_by', options: B.peopleOptions(), none: false },
                { key: 'modified', title: 'Modified', type: 'date', column: 'updated_at', datetime: true },
                ...(cols.full ? [{ key: 'access', title: 'Access', type: 'select', column: 'visibility', options: Object.entries(VIS).map(([value, x]) => ({ value, label: x.label })) }] : []),
                { key: 'attached', title: 'Attached to', type: 'select', options: LINK_TYPES.map(t => ({ value: t, label: `a ${C.ENTITY_META[t].label.toLowerCase()}` })), apply: b => b },
                { key: 'mine', title: 'Created by me', type: 'check', apply: b => b.eq('created_by', me.id) },
                ...(cols.full ? [{ key: 'sharedme', title: 'Shared with me', type: 'check', apply: b => b.neq('created_by', me.id).eq('visibility', 'shared') }] : []),
                { key: 'recent', title: 'Changed in the last 30 days', type: 'check', apply: b => b.gte('updated_at', new Date(Date.now() - 30 * 864e5).toISOString()) },
                { key: 'trash', title: 'In the Recycle bin', type: 'check', apply: b => b },
            ],
            onChange: async () => { await syncAttached(); paintCrumbs(); mountBody(); },
        });
        await syncAttached();
        const openCreate = e => C.menu(e.currentTarget, createItems());
        view.querySelector('[data-create]').addEventListener('click', openCreate);
        view.querySelector('[data-create-menu]').addEventListener('click', openCreate);
        view.querySelector('[data-upload]').addEventListener('click', () => fileInput.click());
        view.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { dv.mode = b.dataset.view; setPref('ws-docs-view', dv.mode); C.setParam('view', null, true); mountBody(); }));
        view.querySelector('[data-sort]').addEventListener('change', e => { setPref('ws-docs-sort', e.target.value); mountBody(); });
        view.querySelector('[data-crumbs]').addEventListener('click', e => {
            const a = e.target.closest('[data-crumb]'); if (!a || e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            if (!folderMode()) { dv.folderId = a.dataset.crumb || null; history.pushState(null, '', a.getAttribute('href')); dv.filter.set({}, 'drive'); return; }
            go(a.getAttribute('href'));
        });
        view.querySelector('[data-empty-trash]').addEventListener('click', emptyTrash);
        view.querySelector('[data-open-trash]').addEventListener('click', () => dv.filter.set({ trash: true }, 'trash'));
        view.querySelector('[data-create-strip]').addEventListener('click', e => {
            const k = e.target.closest('[data-new-kind]'); if (k) return createNative(k.dataset.newKind);
            if (e.target.closest('[data-new-board]')) { location.href = '/boards/?new=1'; return; }
            if (e.target.closest('[data-new-upload]')) return fileInput.click();
            if (e.target.closest('[data-new-folder]')) return newFolder(dv.folderId, refreshDrive);
        });
        paintCrumbs();
        mountBody();
        const create = C.param('create');
        if (create && D.KINDS[create]) { C.setParam('create', null, true); createNative(create); }
        if (C.param('new') === '1') {
            C.setParam('new', null, true);
            C.toast('Choose Upload, or drop files anywhere on this page', 'ok');
            const up = view.querySelector('[data-upload]'); up.classList.add('pulse'); setTimeout(() => up.classList.remove('pulse'), 3200);
        }
    }
    function paintCrumbs() {
        const el = view.querySelector('[data-crumbs]'); if (!el || !dv.filter) return;
        const st = dv.filter.get();
        if (!folderMode()) {
            const p = presets.find(x => x.key === st.preset);
            el.innerHTML = `<a href="/documents/" data-crumb="">Documents</a><span class="sep">›</span><span>${esc(st.search ? `Search: ${st.search}` : p ? p.title : 'Filtered')}</span>`;
        } else {
            const path = dv.folderId ? folderPath(dv.folderId) : [];
            el.innerHTML = `<a href="/documents/" data-crumb="">Documents</a>${path.map(f => `<span class="sep">›</span><a href="/documents/?folder=${esc(f.id)}" data-crumb="${esc(f.id)}">${esc(f.name)}</a>`).join('')}`;
        }
        view.querySelector('[data-empty-trash]').hidden = !inTrash();
        view.querySelector('[data-open-trash]').hidden = inTrash();
        view.querySelector('[data-create-strip]').hidden = !folderMode();
    }
    async function refreshDrive() {
        if (!dv.inDrive) return;
        try { await Promise.all([loadFolders(), loadMyShares()]); } catch (e) { /* keep what is on screen */ }
        paintCrumbs();
        if (dv.grid) dv.grid.refresh(); else mountBody();
    }
    function emptyState() {
        if (inTrash()) return { title: 'The Recycle bin is empty', sub: 'Deleted documents stay here until they are deleted for good.' };
        if (dv.filter && dv.filter.get().search) return { title: 'Nothing matches', sub: 'Try another name, or clear the filter.' };
        if (folderMode()) return { title: dv.folderId ? 'This folder is empty' : 'No documents yet', sub: 'Create a document, upload files, or drop them anywhere on this page.' };
        return { title: 'No documents match', sub: 'Try another filter.' };
    }
    function mountBody() {
        const body = view.querySelector('#body'); if (!body) return;
        if (dv.grid) { dv.grid.destroy(); dv.grid = null; }
        dv.cards = null;
        body.innerHTML = '';
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === dv.mode); b.setAttribute('aria-selected', b.dataset.view === dv.mode ? 'true' : 'false'); });
        view.querySelector('[data-sort]').hidden = dv.mode === 'list';
        const host = document.createElement('div');
        body.appendChild(host);
        if (dv.mode === 'list') mountList(host); else mountCards(host, dv.mode === 'tiles');
    }

    // Who each item on screen is shared with (Shared column).
    const shareMap = new Map();
    async function loadShares(docs) {
        const ids = docs.filter(d => vis(d) === 'shared').map(d => d.id);
        if (!cols.full || !ids.length) return;
        const r = await sb.from('document_shares').select('document_id, user_id').in('document_id', ids);
        ids.forEach(id => shareMap.set(id, []));
        (r.data || []).forEach(s => shareMap.get(s.document_id).push(s.user_id));
    }
    function sharedCell(d) {
        if (d._folder) return '';
        if (vis(d) === 'private') return `<span class="muted" title="Only the owner">${C.icon('lock', 'sm')} Only ${mine(d) ? 'me' : 'the owner'}</span>`;
        if (vis(d) === 'company') return `<span class="muted" title="Everyone in the company">${C.icon('users', 'sm')} Company</span>`;
        const ids = shareMap.get(d.id) || [];
        return ids.length ? `<span title="${esc(ids.map(id => C.personName(id)).join(', '))}">${C.avatarsHtml(ids, 3)}</span>` : '<span class="muted">No one yet</span>';
    }
    function pubCell(d) {
        if (d._folder) return '';
        const on = !!d.published_token, can = canEdit(d) && !d.archived_at;
        return `<button type="button" class="dv-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-pub="${esc(d.id)}"${can ? '' : ' disabled'} title="${can ? (on ? 'Turn the public link off' : 'Publish with a public link') : 'Only people who can edit it can publish it'}"><i></i></button><span class="dv-switch-l">${on ? 'Published' : 'Not published'}</span>`;
    }
    function nameCell(d) {
        if (d._folder) return `<span class="b24-who">${ico(d)}<span><a href="/documents/?folder=${esc(d.id)}" data-folder="${esc(d.id)}">${esc(d.name)}</a><span class="sub">Folder</span></span></span>`;
        return `<span class="b24-who">${ico(d)}<span><a href="/documents/?id=${esc(d.id)}" data-doc="${esc(d.id)}">${esc(d.name)}</a><span class="sub">${esc(typeText(d))}${d.description ? ' · ' + esc(d.description) : ''}</span></span></span>`;
    }
    async function docIdsFor(ids, o) {
        if (o && o.all) { const r = await C.q(scoped(sb.from('documents').select('id')).limit(1000)); return (r.data || []).map(x => x.id); }
        return ids.filter(id => !folders.some(f => f.id === id));
    }
    function bulkActions() {
        if (inTrash()) return [
            { label: 'Restore', icon: 'refresh', run: async (ids, o) => {
                const list = await docIdsFor(ids, o); if (!list.length) return;
                const r = await C.q(sb.from('documents').update({ archived_at: null }).in('id', list).select('id'));
                C.toast(`${(r.data || []).length} restored`, 'ok'); refreshDrive();
            } },
            { label: 'Delete for good', icon: 'trash', danger: true, run: async (ids, o) => {
                const list = await docIdsFor(ids, o); if (!list.length) return;
                await deleteMany(list);
            } },
        ];
        return [
            { label: 'Move to folder', icon: 'folder', run: async (ids, o) => {
                const list = await docIdsFor(ids, o);
                if (!list.length) return C.toast('Select documents to move (folders stay where they are).', 'warn');
                await C.formModal({
                    title: `Move ${list.length} item${list.length === 1 ? '' : 's'}`, fields: [{ name: 'folder_id', label: 'Folder', type: 'select', options: folderOptions(), full: true }], values: { folder_id: dv.folderId || '' },
                    submitLabel: 'Move', onSubmit: async v => {
                        const r = await C.q(sb.from('documents').update({ folder_id: v.folder_id || null }).in('id', list).select('id'));
                        const n = (r.data || []).length;
                        C.toast(n === list.length ? `${n} moved` : `${n} of ${list.length} moved: you can only move items you can edit`, n === list.length ? 'ok' : 'warn');
                        refreshDrive();
                    },
                });
            } },
            { label: 'Delete', icon: 'trash', danger: true, run: async (ids, o) => {
                const list = await docIdsFor(ids, o); if (!list.length) return;
                if (cols.full) {                                            // deleted items are not public any more
                    const pub = (await sb.from('documents').select('id, published_token, storage_path').in('id', list).not('published_token', 'is', null)).data || [];
                    for (const x of pub) await unpublishCopy(x);
                }
                const r = await C.q(sb.from('documents').update({ archived_at: new Date().toISOString(), ...(cols.full ? { published_token: null, published_at: null } : {}) }).in('id', list).select('id'));
                const n = (r.data || []).length;
                C.toast(n === list.length ? `${n} moved to the Recycle bin` : `${n} of ${list.length} moved to the Recycle bin: you can only delete items you can edit`, n === list.length ? 'ok' : 'warn');
                refreshDrive();
            } },
        ];
    }
    async function deleteMany(ids) {
        const rows = [];
        for (let i = 0; i < ids.length; i += 200) rows.push(...((await C.q(sb.from('documents').select(cols.select).in('id', ids.slice(i, i + 200)))).data || []));
        const allowed = rows.filter(canDelete);
        if (!allowed.length) return C.toast('You can only delete items you own, or company items as a manager.', 'warn');
        if (!await C.confirm({ title: `Delete ${allowed.length} item${allowed.length === 1 ? '' : 's'} for good?`, message: `${allowed.length < rows.length ? `${rows.length - allowed.length} item${rows.length - allowed.length === 1 ? '' : 's'} you cannot delete will stay. ` : ''}This cannot be undone.`, okText: 'Delete for good', danger: true })) return;
        let ok = 0; const errors = [];
        for (const d of allowed) { try { await removeForGood(d); ok++; } catch (e) { errors.push(e.message); } }
        C.toast(errors.length ? `${ok} deleted, ${errors.length} failed: ${errors[0]}` : `${ok} deleted`, errors.length ? 'bad' : 'ok');
        refreshDrive();
    }
    async function emptyTrash() {
        try {
            const r = await C.q(sb.from('documents').select('id').not('archived_at', 'is', null).limit(1000));
            const ids = (r.data || []).map(x => x.id);
            if (!ids.length) return C.toast('The Recycle bin is already empty', 'ok');
            await deleteMany(ids);
        } catch (e) { C.toast(e.message, 'bad'); }
    }

    function mountList(host) {
        const fm = folderMode();
        dv.grid = WSGrid.mount(host, {
            id: 'documents', sort: { key: 'updated_at', dir: 'desc' },
            columns: [
                { key: 'name', title: 'Name', width: 400, render: nameCell,
                  edit: { type: 'text', save: async (d, val) => {
                      if (!val) throw new Error('Enter a name.');
                      const r = await C.q(sb.from(d._folder ? 'document_folders' : 'documents').update({ name: val }).eq('id', d.id).select('id'));
                      if (!(r.data || []).length) throw new Error(d._folder ? 'Only the person who made this folder, or a manager, can rename it.' : 'Only people who can edit this item can rename it.');
                  } } },
                ...(cols.full ? [{ key: 'visibility', title: 'Access', width: 110, render: d => (d._folder ? '' : accessBadge(d)) }] : []),
                { key: 'updated_at', title: 'Modified', width: 150, render: d => `<span class="muted" title="${esc(L.fmtDateTime(d.updated_at || d.created_at))}">${esc(L.fmtRelative(d.updated_at || d.created_at))}</span>` },
                { key: 'created_by', title: 'Owner', width: 180, render: d => C.personHtml(d.created_by, { link: false }) },
                { key: 'size_bytes', title: 'Size', width: 100, align: 'right', render: d => esc(sizeText(d)) },
                { key: 'mime_type', title: 'Type', width: 150, default: false, render: d => esc(typeText(d)) },
                { key: 'links', title: 'Attached to', width: 220, default: false, sortable: false, render: d => ((d.links || []).length ? chips(d.links, 2) : '') },
                { key: 'created_at', title: 'Created', width: 130, default: false, render: d => esc(L.fmtDate(d.created_at, { short: true })) },
                ...(cols.full ? [
                    { key: 'shared', title: 'Shared', width: 130, sortable: false, render: sharedCell },
                    { key: 'published_at', title: 'Published', width: 150, render: pubCell },
                ] : []),
            ],
            load: async ({ offset, limit, sort }) => {
                // Folders come first (page 1 onwards), then the documents of this folder.
                const folderRows = fm ? childFolders() : [];
                const fr = folderRows.slice(offset, offset + limit);
                const need = limit - fr.length;
                let docs = [];
                if (need > 0) {
                    const from = Math.max(0, offset - folderRows.length);
                    let b = scoped(sb.from('documents').select(cols.select));
                    b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc' }) : b.order('updated_at', { ascending: false });
                    docs = (await C.q(b.range(from, from + need - 1))).data || [];
                    await Promise.all([labelsFor(docs.flatMap(d => (d.links || []).slice(0, 2))), loadShares(docs)]);
                }
                return fr.concat(docs);
            },
            count: async () => (fm ? childFolders().length : 0) + ((await C.q(scoped(sb.from('documents').select('id', { count: 'exact', head: true })))).count || 0),
            onOpen: openItem,
            rowMenu: d => (d._folder ? folderMenu(d) : docMenu(d)),
            bulk: bulkActions(),
            empty: emptyState(),
        });
        host.addEventListener('click', async e => {
            const sw = e.target.closest('[data-pub]');
            if (sw) {
                e.preventDefault();
                const d = dv.grid && dv.grid.rows().find(r => r.id === sw.dataset.pub); if (!d || sw.disabled) return;
                sw.disabled = true;
                try {
                    if (d.published_token) { await unpublish(d); C.toast('Public link turned off', 'ok'); }
                    else { await publish(d); publishDoc(d, refreshDrive); }
                    if (dv.grid) dv.grid.refresh();
                } catch (err) { C.toast(err.message, 'bad'); sw.disabled = false; }
                return;
            }
            const a = e.target.closest('a[data-folder], a[data-doc]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            if (a.dataset.folder) return go(`/documents/?folder=${a.dataset.folder}`);
            const d = dv.grid && dv.grid.rows().find(r => r.id === a.dataset.doc); if (d) openItem(d);
        });
    }

    const thumbUrl = new Map();
    async function thumbs(list) {
        const imgs = list.filter(d => !thumbUrl.has(d.id) && d.storage_path && String(d.mime_type || '').startsWith('image/') && (d.size_bytes || 0) < 15 * 1048576);
        if (!imgs.length) return;
        try {
            const r = await sb.storage.from('documents').createSignedUrls(imgs.map(d => d.storage_path), 3600);
            (Array.isArray(r.data) ? r.data : []).forEach((x, i) => { if (x && x.signedUrl && imgs[i]) thumbUrl.set(imgs[i].id, x.signedUrl); });
        } catch (e) { /* the file icon shows instead */ }
    }
    async function mountCards(host, small) {
        const PAGE = small ? 90 : 48, fm = folderMode(), sort = cardSort();
        let offset = 0, rows = [], hasMore = false;
        const folderRows = fm ? childFolders() : [];
        host.innerHTML = `<div class="b24-area pad"><div data-empty hidden></div><div class="dv-cards${small ? ' small' : ''}" data-cards></div><div class="dv-more" data-more hidden><button type="button" class="ws-btn">Show more</button></div></div>`;
        const cardsEl = host.querySelector('[data-cards]'), moreEl = host.querySelector('[data-more]'), emptyEl = host.querySelector('[data-empty]');
        const card = d => `<article class="dv-card" data-id="${esc(d.id)}" tabindex="0" aria-label="${esc(d.name)}">
                <div class="pv">${!d._folder && thumbUrl.get(d.id) ? `<img src="${esc(thumbUrl.get(d.id))}" alt="" loading="lazy">` : ico(d, true)}</div>
                <div class="nm"><a href="${d._folder ? `/documents/?folder=${esc(d.id)}` : `/documents/?id=${esc(d.id)}`}" data-open>${esc(d.name)}</a><button type="button" class="g-rowmenu" data-card-menu aria-label="Actions for ${esc(d.name)}">☰</button></div>
                ${small ? '' : `<div class="mt">${d._folder ? 'Folder' : `${esc(L.fmtRelative(d.updated_at || d.created_at))}${sizeText(d) ? ' · ' + esc(sizeText(d)) : ''}`}</div>`}
                ${!d._folder && cols.full && vis(d) !== 'company' ? `<span class="acc" title="${esc(VIS[vis(d)].label)}">${C.icon(vis(d) === 'private' ? 'lock' : 'users', 'sm')}</span>` : ''}
            </article>`;
        async function page() {
            const b = scoped(sb.from('documents').select(cols.select)).order(sort.key, { ascending: sort.asc });
            const data = (await C.q(b.range(offset, offset + PAGE))).data || [];
            hasMore = data.length > PAGE;
            const got = data.slice(0, PAGE); offset += got.length; rows = rows.concat(got);
            await thumbs(got);
            return got;
        }
        const itemOf = id => folderRows.find(f => f.id === id) || rows.find(r => r.id === id);
        cardsEl.innerHTML = Array.from({ length: small ? 12 : 8 }, () => '<div class="dv-card"><div class="pv"><span class="ws-skel" style="width:60%;height:60%"></span></div><span class="ws-skel" style="height:12px;width:70%"></span></div>').join('');
        try {
            const got = await page();
            const items = folderRows.concat(got);
            if (!items.length) { cardsEl.innerHTML = ''; emptyEl.hidden = false; const e = emptyState(); C.empty(emptyEl, e.title, e.sub); }
            else cardsEl.innerHTML = items.map(card).join('');
            moreEl.hidden = !hasMore;
        } catch (e) { cardsEl.innerHTML = ''; emptyEl.hidden = false; return C.errorState(emptyEl, e, () => mountCards(host, small)); }
        moreEl.querySelector('button').addEventListener('click', async ev => {
            ev.currentTarget.disabled = true;
            try { const got = await page(); cardsEl.insertAdjacentHTML('beforeend', got.map(card).join('')); moreEl.hidden = !hasMore; }
            catch (e) { C.toast(e.message, 'bad'); }
            finally { ev.currentTarget.disabled = false; }
        });
        cardsEl.addEventListener('click', e => {
            const el = e.target.closest('.dv-card[data-id]'); if (!el) return;
            const d = itemOf(el.dataset.id); if (!d) return;
            const menuBtn = e.target.closest('[data-card-menu]');
            if (menuBtn) { e.preventDefault(); return C.menu(menuBtn, d._folder ? folderMenu(d) : docMenu(d)); }
            if (e.target.closest('a') && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
            e.preventDefault(); openItem(d);
        });
        cardsEl.addEventListener('keydown', e => {
            const el = e.target.closest('.dv-card[data-id]'); if (!el || e.target !== el || e.key !== 'Enter') return;
            const d = itemOf(el.dataset.id); if (d) openItem(d);
        });
        dv.cards = { rows: () => folderRows.concat(rows) };
    }

    /* ------------------------------------------------------- open an item */
    async function openDoc(id) {
        view.classList.remove('b24-legacy-panel');
        C.loading(view, 'Opening…');
        let d;
        try {
            await Promise.all([loadFolders(), loadMyShares()]);
            d = (await C.q(sb.from('documents').select(cols.full ? `${FULL}, content` : LEGACY).eq('id', id).maybeSingle())).data;
        } catch (e) { return C.errorState(view, e, () => openDoc(id)); }
        if (C.param('id') !== id) return;                          // navigated away meanwhile
        if (!d) {
            view.innerHTML = '<div class="b24-area pad"></div>';
            return C.empty(view.firstElementChild, 'Document not found', 'It may have been deleted, or it has not been shared with you.', '<a class="ws-btn" href="/documents/">All documents</a>');
        }
        if (isNative(d)) return showEditor(d);
        view.classList.add('b24-legacy-panel');
        return showRecord(d);
    }

    /* ------------------------------------------- native documents: the editor */
    function setStatus(text, bad) { const s = view.querySelector('[data-status]'); if (s) { s.textContent = text; s.classList.toggle('bad', !!bad); } }
    function scheduleSave(content) {
        dv.pending = content; setStatus('Unsaved changes…');
        clearTimeout(dv.timer); dv.timer = setTimeout(() => saveNow(), 900);
    }
    /** Saves only over the version this editor loaded (updated_at), so two people cannot silently overwrite each other. */
    async function saveNow(force) {
        const d = dv.doc, data = dv.pending; if (!d || !data) return;
        clearTimeout(dv.timer);
        if (dv.saving) { dv.timer = setTimeout(() => saveNow(force), 400); return; }
        dv.pending = null; dv.saving = true;
        let finished; dv.saveP = new Promise(res => { finished = res; });
        setStatus('Saving…');
        const json = JSON.parse(JSON.stringify(data));          // a snapshot: the editor keeps changing its own object
        let b = sb.from('documents').update({ content: json, updated_by: me.id, size_bytes: JSON.stringify(json).length }).eq('id', d.id);
        if (!force && dv.stamp) b = b.eq('updated_at', dv.stamp);
        const r = await b.select('updated_at');
        dv.saving = false;
        if (!r.error && (r.data || []).length) d._stamp = r.data[0].updated_at;
        finished();
        if (dv.doc !== d) return;
        if (r.error) { dv.pending = dv.pending || data; setStatus(`Not saved: ${C.friendly(r.error)}`, true); return; }
        if (!(r.data || []).length) {
            dv.pending = dv.pending || data;
            const fresh = (await sb.from('documents').select('updated_at, updated_by').eq('id', d.id).maybeSingle()).data;
            if (fresh && fresh.updated_at !== dv.stamp) return showConflict(fresh);
            setStatus('Not saved: you can only view this document', true);
            return;
        }
        dv.stamp = r.data[0].updated_at;
        if (dv.pending) { dv.timer = setTimeout(() => saveNow(), 600); return; }
        setStatus('All changes saved');
    }
    function showConflict(fresh) {
        const el = view.querySelector('[data-conflict]'); if (!el) return;
        setStatus('Not saved', true);
        el.hidden = false;
        el.innerHTML = `<div class="crm-notice">${C.icon('refresh')}<div><b>${esc(C.personName(fresh.updated_by) || 'Someone')} saved a newer version while you were editing.</b><br>Load theirs (your unsaved changes are dropped) or keep yours (it replaces theirs).</div><div class="acts"><button type="button" class="ws-btn" data-theirs>Load their version</button><button type="button" class="ws-btn primary" data-mine>Keep mine</button></div></div>`;
        el.querySelector('[data-mine]').addEventListener('click', () => { el.hidden = true; fitEditor(); dv.pending = dv.pending || (dv.editor && dv.editor.get()); saveNow(true); });
        el.querySelector('[data-theirs]').addEventListener('click', () => { el.hidden = true; fitEditor(); dv.pending = null; reloadContent(true); });
        fitEditor();
    }
    async function reloadContent(force) {
        const d = dv.doc; if (!d || !dv.editor) return;
        const r = (await sb.from('documents').select('content, updated_at, updated_by').eq('id', d.id).maybeSingle()).data;
        if (!r || dv.doc !== d || r.updated_at === dv.stamp) return;
        if (!force && (dv.pending || dv.saving || dv.editor.busy)) return;
        if (force) mountEditor(d, r.content);
        else if (!dv.editor.set(r.content)) return;
        dv.stamp = r.updated_at; d._stamp = r.updated_at;
        setStatus(r.updated_by && r.updated_by !== me.id ? `Updated by ${C.personName(r.updated_by)}` : 'All changes saved');
    }
    function onVisible() { if (document.visibilityState === 'visible' && dv.doc) reloadContent(false); }
    /** The editor takes exactly the room left on screen, so only its own panes scroll (never the page as well). */
    function fitEditor() {
        const el = view.querySelector('#ed'); if (!el) return;
        const scrollers = [document.scrollingElement];
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const oy = getComputedStyle(p).overflowY; if (oy === 'auto' || oy === 'scroll') scrollers.push(p); }
        el.style.height = window.innerHeight + 'px';
        for (let i = 0; i < 4; i++) {
            const extra = Math.max(...scrollers.map(s => s.scrollHeight - s.clientHeight));
            if (extra <= 1) break;
            const next = Math.max(360, el.offsetHeight - extra);
            if (next === el.offsetHeight) break;
            el.style.height = next + 'px';
        }
    }
    const onResize = C.debounce(fitEditor, 150);
    function mountEditor(d, content) {
        const host = view.querySelector('#ed'); if (!host) return;
        if (dv.editor) dv.editor.destroy();
        dv.editor = WSDocEditors.mount(host, { kind: d.doc_kind, content, canEdit: canEdit(d) && !d.archived_at, name: d.name, onChange: c => scheduleSave(c) });
    }
    function showEditor(d) {
        const editable = canEdit(d) && !d.archived_at;
        document.title = `${d.name} · Documents · WorkSuite`;
        WSShell.setCrumb(d.name);
        dv.doc = d; dv.stamp = d.updated_at; d._stamp = d.updated_at; dv.pending = null;
        const back = d.folder_id ? `/documents/?folder=${d.folder_id}` : '/documents/';
        const publishLabel = () => (d.published_token ? 'Public link on' : 'Public link');
        view.innerHTML = `
            <div class="b24-titlebar wb-titlebar dv-edbar">
                <a class="b24-btn-glass" href="${esc(back)}" data-nav>${C.icon('arrow')}<span>${esc(d.folder_id ? folderName(d.folder_id) : 'Documents')}</span></a>
                ${ico(d)}
                <h1 class="b24-title" data-name>${esc(d.name)}</h1>
                ${canEdit(d) ? `<button type="button" class="b24-btn-glass round" data-rename aria-label="Rename" title="Rename">${C.icon('edit')}</button>` : ''}
                <span class="wb-status" data-status>${d.archived_at ? 'In the Recycle bin' : editable ? 'All changes saved' : 'View only'}</span>
                <span class="grow"></span>
                <span class="wb-people" data-people></span>
                ${cols.full && mine(d) ? `<button type="button" class="b24-btn-glass" data-share>${C.icon('users')}<span>Access</span></button>` : ''}
                ${cols.full && canEdit(d) ? `<button type="button" class="b24-btn-glass" data-publish>${C.icon('globe')}<span data-publabel>${publishLabel()}</span></button>` : ''}
                <button type="button" class="b24-btn-glass" data-export>${C.icon('download')}<span>Download</span></button>
                <button type="button" class="b24-btn-glass round" data-more aria-label="More actions" title="More">${C.icon('more')}</button>
            </div>
            ${d.archived_at ? `<div class="crm-notice dv-banner">${C.icon('trash')}<div><b>This ${esc(D.KINDS[d.doc_kind].label.toLowerCase())} is in the Recycle bin.</b><br>Restore it to edit or share it again.</div>${canEdit(d) ? '<button type="button" class="ws-btn" data-restore style="margin-left:auto">Restore</button>' : ''}</div>` : ''}
            <div class="dv-conflict" data-conflict hidden></div>
            <div class="b24-area dv-editor" id="ed"></div>`;
        mountEditor(d, d.content);
        fitEditor();
        window.addEventListener('resize', onResize);
        view.querySelector('[data-nav]').addEventListener('click', e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(back); });
        const rn = view.querySelector('[data-rename]');
        if (rn) rn.addEventListener('click', () => renameDoc(d, () => { view.querySelector('[data-name]').textContent = d.name; WSShell.setCrumb(d.name); document.title = `${d.name} · Documents · WorkSuite`; }));
        const sh = view.querySelector('[data-share]'); if (sh) sh.addEventListener('click', () => shareDoc(d));
        const pb = view.querySelector('[data-publish]'); if (pb) pb.addEventListener('click', () => publishDoc(d, () => { pb.querySelector('[data-publabel]').textContent = publishLabel(); }));
        const rs = view.querySelector('[data-restore]'); if (rs) rs.addEventListener('click', () => restoreDoc(d, () => openDoc(d.id)));
        const ex = view.querySelector('[data-export]');
        ex.addEventListener('click', () => {
            const E = (label, fmt) => ({ label, icon: 'download', onClick: () => dv.editor.exportAs(fmt) });
            C.menu(ex, d.doc_kind === 'document' ? [E('Word document (.doc)', 'doc'), E('Web page (.html)', 'html'), E('PDF (print or save)', 'pdf')]
                : d.doc_kind === 'spreadsheet' ? [E('CSV, this sheet (.csv)', 'csv'), E('PDF, all sheets (print or save)', 'pdf')]
                : [E('PDF, one slide per page (print or save)', 'pdf')]);
        });
        const more = view.querySelector('[data-more]');
        more.addEventListener('click', () => {
            const items = [];
            if (d.doc_kind === 'spreadsheet' && editable) items.push({ label: 'Import a CSV as a new sheet', icon: 'upload', onClick: importCsv });
            if (d.doc_kind === 'presentation') items.push({ label: 'Present', icon: 'arrow', onClick: () => dv.editor.present() });
            if (items.length) items.push('sep');
            items.push({ label: 'Attach to record', icon: 'link', onClick: () => attachDoc(d) });
            if (canEdit(d)) items.push({ label: 'Move to folder', icon: 'folder', onClick: () => moveDoc(d) });
            items.push({ label: 'Make a copy', icon: 'plus', onClick: () => copyDoc(d) });
            if (canEdit(d) && !d.archived_at) items.push('sep', { label: 'Delete', icon: 'trash', danger: true, onClick: () => toTrash(d, () => go(back)) });
            if (d.archived_at && canDelete(d)) items.push('sep', { label: 'Delete for good', icon: 'trash', danger: true, onClick: () => deleteDoc(d, () => go('/documents/')) });
            C.menu(more, items);
        });
        function importCsv() {
            const input = h('<input type="file" accept=".csv,text/csv" hidden>');
            document.body.appendChild(input);
            input.addEventListener('change', async () => {
                const f = input.files[0]; input.remove(); if (!f) return;
                if (f.size > 5 * 1048576) return C.toast('Choose a CSV of 5 MB or less.', 'bad');
                try { dv.editor.importCsv(await f.text(), f.name); C.toast(`${f.name} added as a new sheet`, 'ok'); } catch (e) { C.toast(e.message, 'bad'); }
            });
            input.click();
        }
        // A colleague saved: take their version unless we are typing or have work to save (then the save shows the conflict).
        dv.unsub = C.subscribe('document', [{ event: 'UPDATE', table: 'documents', filter: `id=eq.${d.id}` }], payload => {
            const row = payload && payload.new;
            if (row && row.updated_at && row.updated_at === dv.stamp) return;
            reloadContent(false);
        });
        document.addEventListener('visibilitychange', onVisible);
        try {
            const ch = sb.channel(`doc-presence:${d.id}`, { config: { presence: { key: me.id } } });
            ch.on('presence', { event: 'sync' }, () => {
                const others = Object.keys(ch.presenceState()).filter(k => k !== me.id);
                const el = view.querySelector('[data-people]');
                if (el) el.innerHTML = others.length ? `${C.avatarsHtml(others, 5)}<span>${others.length === 1 ? esc(C.personName(others[0]).split(' ')[0]) + ' is here' : others.length + ' people here'}</span>` : '';
            }).subscribe(status => { if (status === 'SUBSCRIBED') ch.track({ at: Date.now() }); });
            dv.presence = ch;
        } catch (e) { /* presence is a nicety */ }
    }

    /* ------------------------------------------------------ files: details */
    async function showRecord(d) {
        document.title = `${d.name} · Documents · WorkSuite`;
        WSShell.setCrumb(d.name);
        await labelsFor(d.links || []);
        const mime = String(d.mime_type || '');
        const path = d.folder_id ? folderPath(d.folder_id) : [];
        const reload = () => openDoc(d.id);
        const back = d.folder_id ? `/documents/?folder=${d.folder_id}` : '/documents/';
        view.innerHTML = `
            <a class="crm-back" href="${esc(back)}" data-nav>${C.icon('arrow')}${esc(d.folder_id ? folderName(d.folder_id) : 'All documents')}</a>
            <div class="crm-record-head">
                ${ico(d, true)}
                <div class="titles">
                    <h1>${esc(d.name)}</h1>
                    <div class="meta">
                        <span>${esc(typeText(d))} · ${esc(L.fmtBytes(d.size_bytes))}</span>
                        ${d.archived_at ? C.badge('mute', 'In the Recycle bin') : ''}
                        ${cols.full ? accessBadge(d) : ''}
                        ${d.published_token ? C.badge('warn', 'Public link on') : ''}
                        <span>Uploaded by ${C.personHtml(d.created_by)} · ${esc(L.fmtDateTime(d.created_at))}</span>
                    </div>
                </div>
                <div class="actions">
                    <button type="button" class="ws-btn" id="open-btn">${C.icon('doc')}<span>Open</span></button>
                    <button type="button" class="ws-btn" id="dl-btn">${C.icon('download')}<span>Download</span></button>
                    ${d.archived_at ? (canEdit(d) ? `<button type="button" class="ws-btn primary" id="restore-btn">${C.icon('refresh')}<span>Restore</span></button>` : '') : `<button type="button" class="ws-btn primary" id="attach-btn">${C.icon('link')}<span>Attach to record</span></button>`}
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
                            <div><dt>Folder</dt><dd>${path.length ? path.map(f => `<a href="/documents/?folder=${esc(f.id)}" data-nav>${esc(f.name)}</a>`).join(' › ') : '<span class="muted">Documents (top level)</span>'}</dd></div>
                            ${cols.full ? `<div><dt>Access</dt><dd>${esc(VIS[vis(d)].label)}: ${esc(VIS[vis(d)].hint)}</dd></div>` : ''}
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
        view.querySelectorAll('[data-nav]').forEach(a => a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(a.getAttribute('href')); }));
        const pv = view.querySelector('#preview');
        try {
            if (mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('text/')) {
                const url = await C.signedUrl(d);
                pv.innerHTML = mime.startsWith('image/') ? `<div style="text-align:center"><img class="crm-preview" src="${esc(url)}" alt="${esc(d.name)}"></div>`
                    : mime.startsWith('video/') ? `<video class="crm-preview" src="${esc(url)}" controls style="width:100%"></video>`
                    : mime.startsWith('audio/') ? `<audio src="${esc(url)}" controls style="width:100%"></audio>`
                    : `<iframe class="crm-preview-frame" src="${esc(url)}" title="${esc(d.name)}"></iframe>`;
            } else pv.innerHTML = '<div class="ws-empty"><b>No preview for this type</b><div>Use Open or Download to view it.</div></div>';
        } catch (e) { pv.innerHTML = `<div class="ws-empty"><b>Preview unavailable</b><div>${esc(e.message)}</div></div>`; }
        const linksEl = view.querySelector('#links');
        const links = d.links || [];
        if (!links.length) C.empty(linksEl, 'Not attached to anything yet', 'Attach it to a project, task, contact, deal, lead or invoice.');
        else linksEl.innerHTML = `<ul class="crm-list compact">${links.map(l => `<li>${C.icon((C.ENTITY_META[l.entity_type] || {}).icon || 'link')}<div class="main"><b><a href="${esc(C.entityUrl(l.entity_type, l.entity_id))}">${esc(labelCache.get(`${l.entity_type}:${l.entity_id}`) || (C.ENTITY_META[l.entity_type] || {}).label || l.entity_type)}</a></b><span>${esc((C.ENTITY_META[l.entity_type] || {}).label || l.entity_type)}</span></div><div class="right"><button type="button" class="ws-btn sm" data-unlink="${esc(l.entity_type)}:${esc(l.entity_id)}" title="Detach" aria-label="Detach">${C.icon('x')}</button></div></li>`).join('')}</ul>`;
        linksEl.addEventListener('click', async e => {
            const b = e.target.closest('[data-unlink]'); if (!b) return;
            const [type, eid] = b.dataset.unlink.split(':');
            if (!await C.confirm({ title: 'Detach this document?', message: 'The file stays in Documents; only the link to the record is removed.', okText: 'Detach' })) return;
            try { await C.q(sb.from('document_links').delete().eq('document_id', d.id).eq('entity_type', type).eq('entity_id', eid)); C.toast('Detached', 'ok'); reload(); } catch (err) { C.toast(err.message, 'bad'); }
        });
        C.activityFeed(view.querySelector('#activity'), { entity_type: 'document', entity_id: d.id, withComments: false, limit: 40 });
        view.querySelector('#open-btn').addEventListener('click', () => C.openDocument(d));
        view.querySelector('#dl-btn').addEventListener('click', () => download(d));
        const at = view.querySelector('#attach-btn'); if (at) at.addEventListener('click', () => attachDoc(d, reload));
        const rb = view.querySelector('#restore-btn'); if (rb) rb.addEventListener('click', () => restoreDoc(d, reload));
        view.querySelector('#more-btn').addEventListener('click', e => {
            const items = d.archived_at ? docMenu(d, reload) : docMenu(d, reload).filter(x => x === 'sep' || !/^(Preview|Details|Download|Attach to record)$/.test(x.label));
            const clean = items.filter((x, i, a) => !(x === 'sep' && (i === 0 || a[i - 1] === 'sep' || i === a.length - 1)));
            if (!clean.length) clean.push({ label: 'Only the owner or a manager can change this file', icon: 'lock', onClick: () => {} });
            C.menu(e.currentTarget, clean.map(x => (x !== 'sep' && x.label === 'Delete' ? { ...x, onClick: () => toTrash(d, () => go(back)) } : x !== 'sep' && x.label === 'Delete for good' ? { ...x, onClick: () => deleteDoc(d, () => go('/documents/')) } : x)));
        });
    }

    route();
})();
