/* ============================================================================
   WorkSuite — native document editors: text document, spreadsheet, presentation

       const ed = WSDocEditors.mount(container, { kind, content, canEdit, name, onChange(content) });
       ed.get()               current content (plain JSON, ready to save)
       ed.set(content)        a colleague saved: false (and nothing changes) while the person is typing
       ed.exportAs(format)    document: 'doc' | 'html' | 'pdf'; spreadsheet: 'csv' | 'pdf'; presentation: 'pdf'
       ed.importCsv(text, name)   spreadsheet: the CSV as a new sheet
       ed.present()           presentation: full-screen slide show
       ed.busy                true while typing or a change is in flight
       ed.destroy()

   Rendering and all content rules (sanitising, formulas, slide markup) live in
   documents/drive-logic.js, so the read-only and public views match exactly.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSDocEditors) return;
    const D = window.WSDrive;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = d => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    const P = {
        undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3', redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
        ul: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01', ol: 'M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5h3l-3 3.5h3',
        alignL: 'M4 6h16M4 10h10M4 14h16M4 18h10', alignC: 'M4 6h16M7 10h10M4 14h16M7 18h10', alignR: 'M4 6h16M10 10h10M4 14h16M10 18h10',
        link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
        table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14', hr: 'M4 12h16', clear: 'M5 5h11M11 5l-3 14M15 15l5 5M20 15l-5 5',
        plus: 'M12 5v14M5 12h14', copy: 'M8 8h11v11H8zM5 16V5h11', up: 'M12 19V5M6 11l6-6 6 6', down: 'M12 5v14M6 13l6 6 6-6',
        trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', play: 'M7 5l12 7-12 7z',
    };
    function injectCss() {
        if (document.getElementById('ws-drive-css')) return;
        const st = document.createElement('style'); st.id = 'ws-drive-css'; st.textContent = D.STATIC_CSS;
        document.head.appendChild(st);
    }
    function download(name, blob) {
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }
    /** Print (or "Save as PDF") just this content, from a hidden frame. */
    function printHtml(title, body, css) {
        const f = document.createElement('iframe');
        f.setAttribute('aria-hidden', 'true');
        f.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
        document.body.appendChild(f);
        const d = f.contentDocument;
        d.open();
        d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${D.STATIC_CSS}\nbody{margin:0;color:#1f2a36;-webkit-print-color-adjust:exact;print-color-adjust:exact}${css || ''}</style></head><body>${body}</body></html>`);
        d.close();
        setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { /* the browser refused */ } setTimeout(() => f.remove(), 1500); }, 300);
    }
    /** One text answer: the app's dialog when it is there, the browser's otherwise. */
    function ask(title, label, value) {
        const C = window.WSCrm;
        if (!C || !C.formModal) return Promise.resolve(window.prompt(label, value || ''));
        return new Promise(resolve => {
            let answered = false;
            Promise.resolve(C.formModal({
                title, submitLabel: 'OK', fields: [{ name: 'v', label, type: 'text', required: true, full: true }], values: { v: value || '' },
                onSubmit: async v => { answered = true; resolve(String(v.v || '').trim() || null); },
            })).then(() => { if (!answered) resolve(null); }, () => { if (!answered) resolve(null); });
        });
    }
    async function confirmIt(title, message, okText) {
        const C = window.WSCrm;
        if (C && C.confirm) return C.confirm({ title, message, okText: okText || 'OK', danger: true });
        return window.confirm(`${title}\n\n${message}`);
    }

    /* ================================================================ text document */
    function mountDocument(host, o) {
        const edit = !!o.canEdit;
        const BLOCKS = [['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['blockquote', 'Quote'], ['pre', 'Code']];
        const STATES = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight'];
        host.classList.add('de');
        host.innerHTML = `${edit ? `<div class="dx-bar" role="toolbar" aria-label="Formatting">
                <button type="button" data-cmd="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${ic(P.undo)}</button>
                <button type="button" data-cmd="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${ic(P.redo)}</button><span class="sep"></span>
                <select data-block aria-label="Paragraph style">${BLOCKS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><span class="sep"></span>
                <button type="button" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button>
                <button type="button" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic"><em>I</em></button>
                <button type="button" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline"><u>U</u></button>
                <button type="button" data-cmd="strikeThrough" title="Strikethrough" aria-label="Strikethrough"><s>S</s></button>
                <label class="dx-color" title="Text colour"><span class="a">A</span><input type="color" data-color value="#2067b0" aria-label="Text colour"></label>
                <label class="dx-color" title="Highlight"><span class="hl">ab</span><input type="color" data-hilite value="#fff3a0" aria-label="Highlight colour"></label><span class="sep"></span>
                <button type="button" data-cmd="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list">${ic(P.ul)}</button>
                <button type="button" data-cmd="insertOrderedList" title="Numbered list" aria-label="Numbered list">${ic(P.ol)}</button><span class="sep"></span>
                <button type="button" data-cmd="justifyLeft" title="Align left" aria-label="Align left">${ic(P.alignL)}</button>
                <button type="button" data-cmd="justifyCenter" title="Centre" aria-label="Centre">${ic(P.alignC)}</button>
                <button type="button" data-cmd="justifyRight" title="Align right" aria-label="Align right">${ic(P.alignR)}</button><span class="sep"></span>
                <button type="button" data-link title="Link (Ctrl+K)" aria-label="Link">${ic(P.link)}</button>
                <button type="button" data-table title="Insert a table" aria-label="Insert a table">${ic(P.table)}</button>
                <button type="button" data-cmd="insertHorizontalRule" title="Divider" aria-label="Divider">${ic(P.hr)}</button>
                <button type="button" data-cmd="removeFormat" title="Clear formatting" aria-label="Clear formatting">${ic(P.clear)}</button>
            </div>` : ''}
            <div class="de-scroll"><article class="de-page ds-doc" ${edit ? 'contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true"' : ''} aria-label="Document text"></article></div>
            <div class="dx-foot"><span data-words></span>${edit ? '' : '<span>View only</span>'}</div>`;
        const page = host.querySelector('.de-page'), bar = host.querySelector('.dx-bar');
        let last = 0, timer = null, saved = null;
        const get = () => ({ v: 1, html: D.sanitizeHtml(page.innerHTML) });
        function words() {
            const n = (page.innerText || '').trim().split(/\s+/).filter(Boolean).length;
            host.querySelector('[data-words]').textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;
        }
        function set(c) { page.innerHTML = D.normalise('document', c).html || '<p><br></p>'; if (!page.textContent.trim() && !page.querySelector('table,hr')) page.innerHTML = '<p><br></p>'; words(); }
        set(o.content);
        const onSel = () => {
            const s = window.getSelection();
            if (!s || !s.rangeCount || !page.contains(s.anchorNode)) return;
            saved = s.getRangeAt(0).cloneRange();
            if (!bar) return;
            STATES.forEach(cmd => { const b = bar.querySelector(`[data-cmd="${cmd}"]`); try { if (b) b.classList.toggle('on', document.queryCommandState(cmd)); } catch (e) { /* unsupported */ } });
            let v = 'p'; try { v = String(document.queryCommandValue('formatBlock') || 'p').toLowerCase().replace(/[<>]/g, ''); } catch (e) { /* unsupported */ }
            bar.querySelector('[data-block]').value = BLOCKS.some(b => b[0] === v) ? v : 'p';
        };
        document.addEventListener('selectionchange', onSel);
        function restore() {
            page.focus({ preventScroll: true });
            if (saved) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); }
        }
        function changed() {
            last = Date.now(); clearTimeout(timer);
            timer = setTimeout(() => { timer = null; words(); if (o.onChange) o.onChange(get()); }, 350);
        }
        function run(cmd, val) { restore(); try { document.execCommand(cmd, false, val); } catch (e) { /* unsupported */ } changed(); onSel(); }
        function colour(cmd, val) {
            restore();
            try { document.execCommand('styleWithCSS', false, true); document.execCommand(cmd, false, val); } catch (e) { /* unsupported */ }
            finally { try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* unsupported */ } }
            changed();
        }
        async function addLink() {
            const keep = saved && saved.cloneRange();
            let url = await ask('Insert a link', 'Web address', 'https://');
            if (!url) return;
            if (!/^(https?:|mailto:|tel:)/i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
            saved = keep; restore();
            const s = window.getSelection();
            if (!s.rangeCount || s.isCollapsed) run('insertHTML', `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
            else run('createLink', url);
        }
        if (edit) {
            try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* unsupported */ }
            page.addEventListener('input', changed);
            page.addEventListener('keydown', e => {
                last = Date.now();
                if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); addLink(); }
            });
            // Pasted and dropped markup is cleaned before it lands; saving cleans it again.
            page.addEventListener('paste', e => {
                const cd = e.clipboardData; if (!cd) return;
                e.preventDefault();
                let html = cd.getData('text/html');
                if (html) { const frag = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/.exec(html); if (frag) html = frag[1]; document.execCommand('insertHTML', false, D.sanitizeHtml(html)); }
                else document.execCommand('insertText', false, cd.getData('text/plain'));
                changed();
            });
            page.addEventListener('drop', e => {
                e.preventDefault();
                const t = e.dataTransfer && e.dataTransfer.getData('text/plain');
                if (t) { document.execCommand('insertText', false, t); changed(); }
            });
            bar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });   // keep the selection
            bar.addEventListener('click', e => {
                const b = e.target.closest('button'); if (!b) return;
                if (b.dataset.cmd) run(b.dataset.cmd);
                else if (b.hasAttribute('data-link')) addLink();
                else if (b.hasAttribute('data-table')) { const row = '<tr>' + '<td><br></td>'.repeat(3) + '</tr>'; run('insertHTML', `<table><tbody>${row.repeat(3)}</tbody></table><p><br></p>`); }
            });
            bar.querySelector('[data-block]').addEventListener('change', e => run('formatBlock', `<${e.target.value}>`));
            bar.querySelector('[data-color]').addEventListener('change', e => colour('foreColor', e.target.value));
            bar.querySelector('[data-hilite]').addEventListener('change', e => colour('hiliteColor', e.target.value));
        }
        const DOC_CSS = '@page{margin:18mm}.ds-doc{max-width:none}';
        return {
            get,
            set(c) { if (this.busy) return false; set(c); return true; },
            /** Report a change still waiting for the typing pause right away (before leaving the page). */
            flush() { if (timer) { clearTimeout(timer); timer = null; words(); if (o.onChange) o.onChange(get()); } },
            get busy() { return !!timer || Date.now() - last < 2500; },
            exportAs(fmt) {
                const html = get().html, name = o.name || 'Document';
                if (fmt === 'pdf') return printHtml(name, `<article class="ds-doc">${html}</article>`, DOC_CSS);
                if (fmt === 'html') return download(D.fileName(name, 'html'), new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>${D.STATIC_CSS}body{max-width:760px;margin:40px auto;padding:0 20px}</style></head><body><article class="ds-doc">${html}</article></body></html>`], { type: 'text/html;charset=utf-8' }));
                // Word opens this HTML flavour as a document and keeps the formatting.
                download(D.fileName(name, 'doc'), new Blob([`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(name)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px}</style></head><body>${html}</body></html>`], { type: 'application/msword' }));
            },
            focus() { page.focus(); },
            destroy() { document.removeEventListener('selectionchange', onSel); clearTimeout(timer); host.innerHTML = ''; host.classList.remove('de'); },
        };
    }

    /* ================================================================== spreadsheet */
    function mountSheet(host, o) {
        const edit = !!o.canEdit;
        let content = D.normalise('spreadsheet', o.content), si = 0, extraRows = 0, last = 0, editing = null, dragging = false;
        let sel = { c: 0, r: 0 }, anchor = { c: 0, r: 0 }, values = {}, dims = { cols: 0, rows: 0 }, tds = {}, painted = [];
        const undo = [], redo = [];
        const sheet = () => content.sheets[si];
        const DEFAULT_W = 100;
        host.classList.add('se');
        host.innerHTML = `
            <div class="dx-bar se-bar" role="toolbar" aria-label="Spreadsheet">
                ${edit ? `<button type="button" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${ic(P.undo)}</button>
                <button type="button" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo">${ic(P.redo)}</button><span class="sep"></span>
                <button type="button" data-act="bold" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button>
                <button type="button" data-act="l" title="Align left" aria-label="Align left">${ic(P.alignL)}</button>
                <button type="button" data-act="c" title="Centre" aria-label="Centre">${ic(P.alignC)}</button>
                <button type="button" data-act="r" title="Align right" aria-label="Align right">${ic(P.alignR)}</button><span class="sep"></span>
                <button type="button" data-act="sum" title="Sum the numbers above" aria-label="Sum the numbers above"><b>Σ</b></button><span class="sep"></span>` : ''}
                <span class="se-ref" data-ref>A1</span><span class="se-fx">fx</span>
                <input class="se-input" data-fx aria-label="Cell contents" autocomplete="off" spellcheck="false" ${edit ? '' : 'readonly'}>
            </div>
            <div class="se-scroll" tabindex="0" aria-label="Cells. Arrow keys move, Enter edits.">
                <table class="se-grid"></table>
                <input class="se-edit" data-edit hidden autocomplete="off" spellcheck="false" aria-label="Edit cell">
                <button type="button" class="se-more" data-more>Add 100 rows</button>
            </div>
            <div class="se-tabs" data-tabs></div>`;
        const scroll = host.querySelector('.se-scroll'), table = host.querySelector('.se-grid'), fx = host.querySelector('[data-fx]'), editor = host.querySelector('[data-edit]');
        const ref = () => D.refName(sel.c, sel.r);
        const rawOf = k => { const c = sheet().cells[k]; return c == null ? '' : typeof c === 'object' ? String(c.v == null ? '' : c.v) : String(c); };
        const fmtOf = k => { const c = sheet().cells[k]; return c && typeof c === 'object' ? c : {}; };
        const rng = () => ({ c1: Math.min(sel.c, anchor.c), c2: Math.max(sel.c, anchor.c), r1: Math.min(sel.r, anchor.r), r2: Math.max(sel.r, anchor.r) });
        function eachInRange(fn) { const r = rng(); for (let y = r.r1; y <= r.r2; y++) for (let x = r.c1; x <= r.c2; x++) fn(D.refName(x, y), x, y); }
        function setRaw(k, v) {
            const f = fmtOf(k), keep = f.b || f.a;
            if ((v === '' || v == null) && !keep) delete sheet().cells[k];
            else sheet().cells[k] = keep ? Object.assign({ v: v == null ? '' : v }, f.b ? { b: true } : {}, f.a ? { a: f.a } : {}) : v;
        }
        function setFmt(k, patch) {
            const cur = sheet().cells[k];
            const obj = Object.assign(cur && typeof cur === 'object' ? { ...cur } : { v: cur == null ? '' : cur }, patch);
            if (!obj.b) delete obj.b; if (!obj.a) delete obj.a;
            if (obj.b || obj.a) sheet().cells[k] = obj;
            else if (obj.v === '' || obj.v == null) delete sheet().cells[k];
            else sheet().cells[k] = obj.v;
        }
        const snapshot = () => { undo.push(JSON.stringify(content)); if (undo.length > 80) undo.shift(); redo.length = 0; };
        const widthOf = c => (sheet().widths || {})[c] || DEFAULT_W;
        const tableWidth = () => 46 + Array.from({ length: dims.cols }, (_, c) => widthOf(c)).reduce((a, b) => a + b, 0);
        function build() {
            const ext = D.extent(sheet().cells);
            dims = { cols: Math.max(26, ext.cols + 3), rows: Math.max(100, ext.rows + 30) + extraRows };
            let h = `<colgroup><col style="width:46px">${Array.from({ length: dims.cols }, (_, c) => `<col style="width:${widthOf(c)}px">`).join('')}</colgroup>`;
            h += `<thead><tr><th class="corner" data-all title="Select all"></th>${Array.from({ length: dims.cols }, (_, c) => `<th data-col="${c}">${D.colName(c)}${edit ? `<span class="rs" data-rs="${c}"></span>` : ''}</th>`).join('')}</tr></thead><tbody>`;
            for (let r = 0; r < dims.rows; r++) {
                h += `<tr><th data-row="${r}">${r + 1}</th>`;
                for (let c = 0; c < dims.cols; c++) h += `<td data-c="${c}" data-r="${r}"></td>`;
                h += '</tr>';
            }
            table.innerHTML = h + '</tbody>';
            table.style.width = tableWidth() + 'px';
            tds = {}; painted = [];
            table.querySelectorAll('td').forEach(td => { tds[D.refName(+td.dataset.c, +td.dataset.r)] = td; });
        }
        function recompute() {
            values = D.evaluateSheet(sheet().cells);
            for (const k in tds) {
                const td = tds[k], v = values[k], f = fmtOf(k), t = v == null ? '' : D.formatValue(v);
                if (td.textContent !== t) td.textContent = t;
                const cls = (typeof v === 'number' ? 'num' : '') + (typeof v === 'string' && v[0] === '#' && rawOf(k)[0] === '=' ? ' err' : '') + (f.b ? ' b' : '') + (f.a ? ' a-' + f.a : '');
                if (td.className !== cls) td.className = cls;
            }
            painted = [];
            paintSel();
        }
        function paintSel() {
            painted.forEach(td => td.classList.remove('sel', 'in')); painted = [];
            const r = rng(), big = (r.c2 - r.c1 + 1) * (r.r2 - r.r1 + 1) > 1;
            if (big) eachInRange(k => { const td = tds[k]; if (td) { td.classList.add('in'); painted.push(td); } });
            const a = tds[ref()]; if (a) { a.classList.add('sel'); painted.push(a); }
            host.querySelector('[data-ref]').textContent = big ? `${D.refName(r.c1, r.r1)}:${D.refName(r.c2, r.r2)}` : ref();
            if (document.activeElement !== fx) fx.value = rawOf(ref());
            const f = fmtOf(ref());
            host.querySelectorAll('[data-act="bold"]').forEach(b => b.classList.toggle('on', !!f.b));
            ['l', 'c', 'r'].forEach(x => host.querySelectorAll(`[data-act="${x}"]`).forEach(b => b.classList.toggle('on', f.a === x)));
        }
        function select(c, r, extend) {
            sel = { c: Math.max(0, Math.min(dims.cols - 1, c)), r: Math.max(0, Math.min(dims.rows - 1, r)) };
            if (!extend) anchor = { ...sel };
            paintSel();
            const td = tds[ref()];
            if (td) {
                // Keep the cell clear of the sticky headers.
                const top = td.offsetTop - 26, left = td.offsetLeft - 46;
                if (top < scroll.scrollTop) scroll.scrollTop = top;
                else if (td.offsetTop + td.offsetHeight > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = td.offsetTop + td.offsetHeight - scroll.clientHeight;
                if (left < scroll.scrollLeft) scroll.scrollLeft = left;
                else if (td.offsetLeft + td.offsetWidth > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = td.offsetLeft + td.offsetWidth - scroll.clientWidth;
            }
        }
        function changed() {
            last = Date.now();
            const ext = D.extent(sheet().cells);
            if (ext.cols + 1 > dims.cols || ext.rows + 1 > dims.rows) build();
            recompute();
            if (o.onChange) o.onChange(content);
        }
        function tabs() {
            host.querySelector('[data-tabs]').innerHTML = content.sheets.map((s, i) => `<button type="button" class="${i === si ? 'on' : ''}" data-si="${i}"${edit ? ' title="Double-click to rename"' : ''}>${esc(s.name)}</button>`).join('')
                + (edit ? `<button type="button" class="add" data-addsheet title="Add a sheet" aria-label="Add a sheet">${ic(P.plus)}</button>${content.sheets.length > 1 ? `<button type="button" class="del" data-delsheet title="Delete this sheet" aria-label="Delete this sheet">${ic(P.trash)}</button>` : ''}` : '');
        }
        function showSheet(i) { si = Math.max(0, Math.min(content.sheets.length - 1, i)); extraRows = 0; sel = { c: 0, r: 0 }; anchor = { ...sel }; build(); recompute(); tabs(); }
        function startEdit(initial) {
            if (!edit) return;
            const k = ref(), td = tds[k]; if (!td) return;
            editing = k;
            editor.hidden = false;
            editor.style.left = (table.offsetLeft + td.offsetLeft) + 'px';
            editor.style.top = (table.offsetTop + td.offsetTop) + 'px';
            editor.style.minWidth = td.offsetWidth + 'px';
            editor.style.height = td.offsetHeight + 'px';
            editor.value = initial != null ? initial : rawOf(k);
            fx.value = editor.value;
            editor.focus({ preventScroll: true });
            const n = editor.value.length; editor.setSelectionRange(n, n);
        }
        function commit(dc, dr, stay) {
            if (!editing) return;
            const k = editing, v = editor.value;
            editing = null; editor.hidden = true;
            if (v !== rawOf(k)) { snapshot(); setRaw(k, v.trim() === '' ? '' : v); changed(); }
            if (!stay) scroll.focus({ preventScroll: true });
            if (dc || dr) select(sel.c + dc, sel.r + dr);
        }
        function cancelEdit() { editing = null; editor.hidden = true; fx.value = rawOf(ref()); scroll.focus({ preventScroll: true }); }
        function clearRange() { snapshot(); eachInRange(k => setRaw(k, '')); changed(); }
        function toggleBold() { const on = !fmtOf(ref()).b; snapshot(); eachInRange(k => setFmt(k, { b: on })); changed(); }
        function align(a) { const next = fmtOf(ref()).a === a ? null : a; snapshot(); eachInRange(k => setFmt(k, { a: next })); changed(); }
        function autoSum() {
            let y = sel.r - 1;
            while (y >= 0 && typeof values[D.refName(sel.c, y)] === 'number') y--;
            if (y + 1 <= sel.r - 1) { snapshot(); setRaw(ref(), `=SUM(${D.refName(sel.c, y + 1)}:${D.refName(sel.c, sel.r - 1)})`); anchor = { ...sel }; changed(); }
            else startEdit('=SUM(');
        }
        function doUndo() { if (!undo.length) return; redo.push(JSON.stringify(content)); content = JSON.parse(undo.pop()); si = Math.min(si, content.sheets.length - 1); build(); recompute(); tabs(); last = Date.now(); if (o.onChange) o.onChange(content); }
        function doRedo() { if (!redo.length) return; undo.push(JSON.stringify(content)); content = JSON.parse(redo.pop()); si = Math.min(si, content.sheets.length - 1); build(); recompute(); tabs(); last = Date.now(); if (o.onChange) o.onChange(content); }

        editor.addEventListener('keydown', e => {
            last = Date.now();
            if (e.key === 'Enter') { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1); }
            else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? -1 : 1, 0); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); commit(0, e.key === 'ArrowUp' ? -1 : 1); }
        });
        editor.addEventListener('input', () => { fx.value = editor.value; last = Date.now(); });
        editor.addEventListener('blur', () => { if (editing) commit(0, 0, true); });
        function applyFx() {
            if (!edit) return;
            const k = ref();
            if (fx.value !== rawOf(k)) { snapshot(); setRaw(k, fx.value.trim() === '' ? '' : fx.value); anchor = { ...sel }; changed(); }
        }
        fx.addEventListener('keydown', e => {
            last = Date.now();
            if (e.key === 'Enter') { e.preventDefault(); applyFx(); select(sel.c, sel.r + 1); scroll.focus({ preventScroll: true }); }
            else if (e.key === 'Escape') { e.preventDefault(); fx.value = rawOf(ref()); scroll.focus({ preventScroll: true }); }
        });
        fx.addEventListener('change', applyFx);
        scroll.addEventListener('keydown', e => {
            if (editing || e.target !== scroll) return;
            const k = e.key, mod = e.ctrlKey || e.metaKey;
            const mv = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[k];
            if (mv) { e.preventDefault(); return select(sel.c + mv[0], sel.r + mv[1], e.shiftKey); }
            if (k === 'Tab') { e.preventDefault(); return select(sel.c + (e.shiftKey ? -1 : 1), sel.r); }
            if (k === 'Home') { e.preventDefault(); return select(0, mod ? 0 : sel.r); }
            if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); return select(sel.c, sel.r + (k === 'PageDown' ? 20 : -20), e.shiftKey); }
            if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); anchor = { c: 0, r: 0 }; sel = { c: dims.cols - 1, r: dims.rows - 1 }; return paintSel(); }
            if (!edit) return;
            if (k === 'Enter' || k === 'F2') { e.preventDefault(); return startEdit(); }
            if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); return clearRange(); }
            if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); return e.shiftKey ? doRedo() : doUndo(); }
            if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); return doRedo(); }
            if (mod && (k === 'b' || k === 'B')) { e.preventDefault(); return toggleBold(); }
            if (!mod && !e.altKey && k.length === 1) { e.preventDefault(); startEdit(k); }
        });
        // Copy / cut / paste as tab-separated text, so ranges move to and from Excel or Google Sheets.
        const inGrid = () => document.activeElement === scroll && !editing;
        const onCopy = e => {
            if (!inGrid()) return;
            const r = rng(), rows = [];
            for (let y = r.r1; y <= r.r2; y++) { const row = []; for (let x = r.c1; x <= r.c2; x++) row.push(rawOf(D.refName(x, y))); rows.push(row.join('\t')); }
            e.clipboardData.setData('text/plain', rows.join('\n')); e.preventDefault();
        };
        const onCut = e => { if (!inGrid() || !edit) return; onCopy(e); clearRange(); };
        const onPaste = e => {
            if (!inGrid() || !edit) return;
            const t = e.clipboardData && e.clipboardData.getData('text/plain'); if (!t) return;
            e.preventDefault(); snapshot();
            const r = rng();
            t.replace(/\r/g, '').replace(/\n$/, '').split('\n').slice(0, 5000).forEach((line, y) => line.split('\t').slice(0, 200).forEach((v, x) => setRaw(D.refName(r.c1 + x, r.r1 + y), v)));
            changed();
        };
        document.addEventListener('copy', onCopy); document.addEventListener('cut', onCut); document.addEventListener('paste', onPaste);
        table.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            const rs = e.target.closest('[data-rs]'); if (rs) return startResize(e, +rs.dataset.rs);
            if (editing) commit(0, 0, true);
            const td = e.target.closest('td'), th = e.target.closest('th');
            e.preventDefault(); scroll.focus({ preventScroll: true });
            if (td) { select(+td.dataset.c, +td.dataset.r, e.shiftKey); dragging = true; }
            else if (th && th.dataset.col != null) { anchor = { c: +th.dataset.col, r: 0 }; sel = { c: +th.dataset.col, r: dims.rows - 1 }; paintSel(); }
            else if (th && th.dataset.row != null) { anchor = { c: 0, r: +th.dataset.row }; sel = { c: dims.cols - 1, r: +th.dataset.row }; paintSel(); }
            else if (th && th.hasAttribute('data-all')) { anchor = { c: 0, r: 0 }; sel = { c: dims.cols - 1, r: dims.rows - 1 }; paintSel(); }
        });
        table.addEventListener('mouseover', e => { if (!dragging) return; const td = e.target.closest('td'); if (td) select(+td.dataset.c, +td.dataset.r, true); });
        const onUp = () => { dragging = false; };
        document.addEventListener('mouseup', onUp);
        table.addEventListener('dblclick', e => { const td = e.target.closest('td'); if (td && edit) { select(+td.dataset.c, +td.dataset.r); startEdit(); } });
        function startResize(e, c) {
            e.preventDefault(); e.stopPropagation();
            const col = table.querySelectorAll('col')[c + 1], x0 = e.clientX, w0 = widthOf(c);
            const move = ev => { const w = Math.max(40, Math.min(600, Math.round(w0 + ev.clientX - x0))); col.style.width = w + 'px'; sheet().widths[c] = w; table.style.width = tableWidth() + 'px'; };
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); last = Date.now(); if (o.onChange) o.onChange(content); };
            document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
        }
        host.querySelector('[data-more]').addEventListener('click', () => { extraRows += 100; build(); recompute(); });
        host.querySelector('.se-bar').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
        host.querySelector('.se-bar').addEventListener('click', e => {
            const b = e.target.closest('[data-act]'); if (!b) return;
            const a = b.dataset.act;
            if (a === 'undo') doUndo(); else if (a === 'redo') doRedo(); else if (a === 'bold') toggleBold(); else if (a === 'sum') autoSum(); else align(a);
            if (!editing) scroll.focus({ preventScroll: true });
        });
        const tabsEl = host.querySelector('[data-tabs]');
        tabsEl.addEventListener('click', async e => {
            const b = e.target.closest('button'); if (!b) return;
            if (editing) commit(0, 0, true);
            if (b.dataset.si != null) return showSheet(+b.dataset.si);
            if (b.hasAttribute('data-addsheet')) {
                if (content.sheets.length >= 20) return;
                snapshot();
                let n = content.sheets.length + 1; while (content.sheets.some(s => s.name === `Sheet ${n}`)) n++;
                content.sheets.push({ name: `Sheet ${n}`, cells: {}, widths: {} });
                showSheet(content.sheets.length - 1); last = Date.now(); if (o.onChange) o.onChange(content);
            } else if (b.hasAttribute('data-delsheet')) {
                if (!await confirmIt(`Delete "${sheet().name}"?`, 'Everything on this sheet is removed. Undo (Ctrl+Z) brings it back until you leave the page.', 'Delete sheet')) return;
                snapshot(); content.sheets.splice(si, 1); showSheet(si - 1); last = Date.now(); if (o.onChange) o.onChange(content);
            }
        });
        tabsEl.addEventListener('dblclick', async e => {
            const b = e.target.closest('[data-si]'); if (!b || !edit) return;
            const i = +b.dataset.si, name = await ask('Rename sheet', 'Sheet name', content.sheets[i].name);
            if (!name) return;
            snapshot(); content.sheets[i].name = name.slice(0, 60); tabs(); last = Date.now(); if (o.onChange) o.onChange(content);
        });
        build(); recompute(); tabs();
        return {
            get: () => content,
            set(c) { if (this.busy) return false; content = D.normalise('spreadsheet', c); si = Math.min(si, content.sheets.length - 1); build(); recompute(); tabs(); return true; },
            get busy() { return !!editing || document.activeElement === fx || Date.now() - last < 2500; },
            exportAs(fmt) {
                const name = o.name || 'Spreadsheet';
                if (fmt === 'pdf') return printHtml(name, content.sheets.map(s => `${content.sheets.length > 1 ? `<h2 class="ds-sheet-name">${esc(s.name)}</h2>` : ''}${D.sheetTableHtml(s)}`).join(''), '@page{size:landscape;margin:12mm}.ds-sheet td{max-width:none}');
                download(D.fileName(content.sheets.length > 1 ? `${name} - ${sheet().name}` : name, 'csv'), new Blob(['﻿' + D.sheetToCsv(sheet())], { type: 'text/csv;charset=utf-8' }));
            },
            importCsv(text, name) {
                const rows = window.WSCrmLogic ? window.WSCrmLogic.csvParse(String(text || '')) : String(text || '').split(/\r?\n/).map(l => l.split(','));
                if (content.sheets.length >= 20) throw new Error('A spreadsheet holds up to 20 sheets.');
                snapshot();
                content.sheets.push({ name: String(name || `Import ${content.sheets.length + 1}`).replace(/\.csv$/i, '').slice(0, 60), cells: D.csvToCells(rows), widths: {} });
                showSheet(content.sheets.length - 1); last = Date.now(); if (o.onChange) o.onChange(content);
            },
            focus() { scroll.focus(); },
            destroy() { document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut); document.removeEventListener('paste', onPaste); document.removeEventListener('mouseup', onUp); host.innerHTML = ''; host.classList.remove('se'); },
        };
    }

    /* ================================================================ presentation */
    function mountSlides(host, o) {
        const edit = !!o.canEdit;
        let content = D.normalise('presentation', o.content), cur = 0, last = 0, show = null;
        host.classList.add('pe');
        host.innerHTML = `
            <div class="dx-bar pe-bar" role="toolbar" aria-label="Slides">
                ${edit ? `<button type="button" class="txt" data-add title="New slide after this one">${ic(P.plus)}<span>New slide</span></button>
                <button type="button" data-dup title="Duplicate slide" aria-label="Duplicate slide">${ic(P.copy)}</button>
                <button type="button" data-up title="Move slide up" aria-label="Move slide up">${ic(P.up)}</button>
                <button type="button" data-down title="Move slide down" aria-label="Move slide down">${ic(P.down)}</button>
                <button type="button" data-del title="Delete slide" aria-label="Delete slide">${ic(P.trash)}</button><span class="sep"></span>
                <select data-layout aria-label="Layout">${Object.entries(D.LAYOUTS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
                <span class="pe-bgs" role="group" aria-label="Background">${D.SLIDE_BGS.map(c => `<button type="button" data-bg="${c}" style="background:${c}" title="Background" aria-label="Background ${c}"></button>`).join('')}</span>` : ''}
                <span class="grow"></span>
                <button type="button" class="txt primary" data-present>${ic(P.play)}<span>Present</span></button>
            </div>
            <div class="pe-main">
                <ol class="pe-list" data-list aria-label="Slides"></ol>
                <div class="pe-work">
                    <div class="pe-stage" data-stage></div>
                    ${edit ? '<textarea class="pe-notes" data-notes rows="3" placeholder="Speaker notes" aria-label="Speaker notes"></textarea>' : ''}
                </div>
            </div>`;
        const listEl = host.querySelector('[data-list]'), stage = host.querySelector('[data-stage]'), notes = host.querySelector('[data-notes]');
        const slide = () => content.slides[cur];
        const emit = () => { last = Date.now(); if (o.onChange) o.onChange(content); };
        function list() {
            listEl.innerHTML = content.slides.map((s, i) => `<li class="${i === cur ? 'on' : ''}" data-i="${i}"><span class="n">${i + 1}</span><button type="button" class="pe-thumb" aria-label="Slide ${i + 1}${s.title ? ': ' + esc(s.title) : ''}">${D.slideHtml(s)}</button></li>`).join('');
        }
        function thumb(i) { const b = listEl.querySelector(`li[data-i="${i}"] .pe-thumb`); if (b) b.innerHTML = D.slideHtml(content.slides[i]); }
        function paintStage() {
            stage.innerHTML = D.slideHtml(slide(), { editable: edit });
            if (notes) notes.value = slide().notes || '';
            const lay = host.querySelector('[data-layout]'); if (lay) lay.value = slide().layout;
            host.querySelectorAll('[data-bg]').forEach(b => b.classList.toggle('on', b.dataset.bg === slide().bg));
            if (!edit) return;
            stage.querySelectorAll('[data-f]').forEach(el => {
                el.addEventListener('input', () => { slide()[el.dataset.f] = el.innerText.replace(/\n$/, '').slice(0, el.dataset.f === 'title' ? 500 : 5000); thumb(cur); emit(); });
                el.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData && e.clipboardData.getData('text/plain')) || ''); });
                el.addEventListener('drop', e => e.preventDefault());
                el.addEventListener('keydown', e => { last = Date.now(); if (e.key === 'Enter' && el.dataset.f === 'title') e.preventDefault(); });
            });
        }
        function go(i) { cur = Math.max(0, Math.min(content.slides.length - 1, i)); list(); paintStage(); const li = listEl.querySelector('li.on'); if (li) li.scrollIntoView({ block: 'nearest' }); }
        const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        listEl.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) go(+li.dataset.i); });
        listEl.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); go(cur + (e.key === 'ArrowDown' ? 1 : -1)); const b = listEl.querySelector('li.on .pe-thumb'); if (b) b.focus(); }
        });
        if (notes) notes.addEventListener('input', () => { slide().notes = notes.value.slice(0, 5000); emit(); });
        const bar = host.querySelector('.pe-bar');
        bar.addEventListener('click', async e => {
            const b = e.target.closest('button'); if (!b) return;
            if (b.hasAttribute('data-present')) return present(cur);
            if (b.hasAttribute('data-add')) { content.slides.splice(cur + 1, 0, { id: newId(), layout: 'content', title: '', body: '', notes: '', bg: slide().bg }); go(cur + 1); emit(); const t = stage.querySelector('[data-f="title"]'); if (t) t.focus(); }
            else if (b.hasAttribute('data-dup')) { content.slides.splice(cur + 1, 0, { ...slide(), id: newId() }); go(cur + 1); emit(); }
            else if (b.hasAttribute('data-up') && cur > 0) { const s = content.slides.splice(cur, 1)[0]; content.slides.splice(cur - 1, 0, s); go(cur - 1); emit(); }
            else if (b.hasAttribute('data-down') && cur < content.slides.length - 1) { const s = content.slides.splice(cur, 1)[0]; content.slides.splice(cur + 1, 0, s); go(cur + 1); emit(); }
            else if (b.hasAttribute('data-del')) {
                if (content.slides.length === 1) { Object.assign(slide(), { title: '', body: '', notes: '' }); go(0); return emit(); }
                if ((slide().title || slide().body) && !await confirmIt('Delete this slide?', 'The slide and its notes are removed.', 'Delete slide')) return;
                content.slides.splice(cur, 1); go(cur); emit();
            } else if (b.dataset.bg) { slide().bg = b.dataset.bg; paintStage(); thumb(cur); emit(); }
        });
        const lay = host.querySelector('[data-layout]');
        if (lay) lay.addEventListener('change', () => { slide().layout = lay.value; paintStage(); thumb(cur); emit(); });

        function present(start) {
            if (show) return;
            const ov = document.createElement('div');
            ov.className = 'pe-show'; ov.tabIndex = -1;
            ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Slide show');
            ov.innerHTML = `<div class="pe-show-stage" data-sstage></div><div class="pe-show-bar"><button type="button" data-prev aria-label="Previous slide">‹</button><span data-count></span><button type="button" data-next aria-label="Next slide">›</button><button type="button" data-exit>Exit</button></div>`;
            document.body.appendChild(ov);
            let i = start || 0, closed = false;
            const stg = ov.querySelector('[data-sstage]');
            const fit = () => { const w = Math.min(window.innerWidth, window.innerHeight * 16 / 9); stg.style.width = w + 'px'; };
            const paint = () => { i = Math.max(0, Math.min(content.slides.length - 1, i)); stg.innerHTML = D.slideHtml(content.slides[i]); ov.querySelector('[data-count]').textContent = `${i + 1} / ${content.slides.length}`; };
            const key = e => {
                if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); i++; paint(); }
                else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); i--; paint(); }
                else if (e.key === 'Home') { e.preventDefault(); i = 0; paint(); }
                else if (e.key === 'End') { e.preventDefault(); i = content.slides.length - 1; paint(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            };
            const fsc = () => { if (!document.fullscreenElement) close(); };
            function close() {
                if (closed) return; closed = true; show = null;
                document.removeEventListener('keydown', key, true); window.removeEventListener('resize', fit); document.removeEventListener('fullscreenchange', fsc);
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                ov.remove(); go(i);
            }
            ov.addEventListener('click', e => {
                if (e.target.closest('[data-exit]')) return close();
                if (e.target.closest('[data-prev]')) { i--; return paint(); }
                i++; paint();
            });
            document.addEventListener('keydown', key, true); window.addEventListener('resize', fit);
            if (ov.requestFullscreen) ov.requestFullscreen().then(() => document.addEventListener('fullscreenchange', fsc)).catch(() => {});
            fit(); paint(); ov.focus();
            show = { close };
        }
        go(0);
        return {
            get: () => content,
            set(c) { if (this.busy) return false; content = D.normalise('presentation', c); go(cur); return true; },
            get busy() { return !!show || Date.now() - last < 2500 || host.contains(document.activeElement) && document.activeElement.matches('[data-f], textarea'); },
            exportAs() { printHtml(o.name || 'Presentation', content.slides.map(s => `<div class="pg">${D.slideHtml(s)}</div>`).join(''), '@page{size:A4 landscape;margin:8mm}.pg{break-after:page;page-break-after:always}.pg:last-child{break-after:auto}.pg .ds-slide{box-shadow:none;border:1px solid #dfe3e8}'); },
            present: () => present(cur),
            focus() { const t = stage.querySelector('[data-f]'); if (t) t.focus(); },
            destroy() { if (show) show.close(); host.innerHTML = ''; host.classList.remove('pe'); },
        };
    }

    function mount(host, o) {
        injectCss();
        if (o.kind === 'spreadsheet') return mountSheet(host, o);
        if (o.kind === 'presentation') return mountSlides(host, o);
        return mountDocument(host, o);
    }
    window.WSDocEditors = { mount, printHtml, download };
})();
