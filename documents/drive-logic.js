/* ============================================================================
   WorkSuite — Documents drive: pure helpers (browser + node tests)

       WSDrive.sanitizeHtml(html)          allow-listed rich text for documents
       WSDrive.evaluateSheet(cells)        { A1: '=SUM(B1:B3)' } -> { A1: 6, ... }
       WSDrive.colName(0) -> 'A'   WSDrive.parseRef('B12') -> { c: 1, r: 11 }
       WSDrive.sheetToCsv(sheet)           the values as CSV (formulas evaluated)
       WSDrive.KINDS                        document / spreadsheet / presentation
   ============================================================================ */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WSDrive = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const KINDS = {
        document: { label: 'Document', ext: 'doc', mime: 'application/vnd.worksuite.document', blank: () => ({ v: 1, html: '<p></p>' }) },
        spreadsheet: { label: 'Spreadsheet', ext: 'xls', mime: 'application/vnd.worksuite.spreadsheet', blank: () => ({ v: 1, sheets: [{ name: 'Sheet 1', cells: {}, widths: {} }] }) },
        presentation: { label: 'Presentation', ext: 'ppt', mime: 'application/vnd.worksuite.presentation', blank: () => ({ v: 1, slides: [{ id: 's1', layout: 'title', title: '', body: '', notes: '', bg: '#ffffff' }] }) },
    };

    /* ---------- rich text ---------- */
    const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'div', 'hr', 'code', 'pre', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
    const VOID = new Set(['br', 'hr']);
    const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'textarea', 'title', 'svg', 'math']);
    const escText = s => String(s).replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    function decodeEntities(s) {
        return String(s)
            .replace(/&#x([0-9a-f]+);?/gi, (m, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
            .replace(/&#([0-9]+);?/g, (m, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
            .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n').replace(/&amp;/gi, '&');
    }
    function safeHref(v) {
        const plain = decodeEntities(v).replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
        return /^(https?:|mailto:|tel:|\/(?!\/)|#)/i.test(plain) ? plain : null;
    }
    const ALIGN = /^\s*text-align\s*:\s*(left|center|right|justify)\s*;?\s*$/i;
    const COLOR = /^\s*(color|background-color)\s*:\s*(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))\s*;?\s*$/i;
    function safeStyle(v) {
        const parts = String(v).split(';').map(x => x.trim()).filter(Boolean).filter(p => ALIGN.test(p) || COLOR.test(p));
        return parts.length ? parts.join('; ') : null;
    }
    /**
     * Rebuilds the markup from allow-listed tags only. Anything else that looks
     * like a tag is dropped (script/style with their content); every other "<"
     * is escaped, so the output can go into innerHTML.
     */
    function sanitizeHtml(html) {
        const src = String(html == null ? '' : html).slice(0, 2000000);
        const out = []; const open = [];
        const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
        let last = 0, m, skipUntil = null;
        while ((m = re.exec(src))) {
            const text = src.slice(last, m.index);
            last = re.lastIndex;
            if (skipUntil) { if (m[1] === '/' && m[2].toLowerCase() === skipUntil) skipUntil = null; continue; }
            if (text) out.push(escText(text));
            if (m[0].startsWith('<!--')) continue;
            const closing = m[1] === '/', tag = m[2].toLowerCase();
            if (DROP_WITH_CONTENT.has(tag)) { if (!closing) skipUntil = tag; continue; }
            if (!ALLOWED.has(tag)) continue;
            if (closing) {
                const at = open.lastIndexOf(tag);
                if (at === -1) continue;
                while (open.length > at) out.push(`</${open.pop()}>`);
                continue;
            }
            const attrs = [];
            const are = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
            let a;
            while ((a = are.exec(m[3] || ''))) {
                const name = a[1].toLowerCase(), val = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '';
                if (name === 'href' && tag === 'a') { const h = safeHref(val); if (h) attrs.push(`href="${escAttr(h)}"`, 'target="_blank"', 'rel="noopener noreferrer"'); }
                else if (name === 'style') { const s = safeStyle(decodeEntities(val)); if (s) attrs.push(`style="${escAttr(s)}"`); }
                else if ((name === 'colspan' || name === 'rowspan') && /^\d{1,2}$/.test(val)) attrs.push(`${name}="${val}"`);
            }
            out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
            if (!VOID.has(tag)) open.push(tag);
        }
        if (!skipUntil) { const rest = src.slice(last); if (rest) out.push(escText(rest)); }
        while (open.length) out.push(`</${open.pop()}>`);
        return out.join('');
    }
    /** Plain text of sanitised markup (search, previews). */
    function htmlToText(html) {
        return decodeEntities(String(html || '').replace(/<(br|\/p|\/div|\/li|\/h[1-3]|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'))
            .replace(/\n{3,}/g, '\n\n').trim();
    }

    /* ---------- spreadsheet ---------- */
    function colName(i) { let s = ''; i = Math.floor(i); do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0); return s; }
    function colIndex(name) { let n = 0; for (const ch of String(name).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
    function parseRef(ref) {
        const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,5})$/.exec(String(ref || '').trim());
        return m ? { c: colIndex(m[1]), r: Number(m[2]) - 1 } : null;
    }
    const refName = (c, r) => colName(c) + (r + 1);

    class SheetError extends Error { constructor(code) { super(code); this.code = code; } }
    const FUNCS = {
        SUM: a => a.reduce((s, x) => s + x, 0),
        AVERAGE: a => { if (!a.length) throw new SheetError('#DIV/0!'); return a.reduce((s, x) => s + x, 0) / a.length; },
        AVG: a => FUNCS.AVERAGE(a),
        MIN: a => (a.length ? Math.min(...a) : 0),
        MAX: a => (a.length ? Math.max(...a) : 0),
        COUNT: a => a.length,
        ABS: a => Math.abs(a[0] || 0),
        ROUND: a => { const p = Math.pow(10, Math.trunc(a[1] || 0)); return Math.round((a[0] || 0) * p) / p; },
    };
    function tokenize(src) {
        const toks = []; let i = 0;
        while (i < src.length) {
            const ch = src[i];
            if (/\s/.test(ch)) { i++; continue; }
            const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
            if (num) { toks.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
            const id = /^\$?[A-Za-z]+\$?\d*/.exec(src.slice(i));
            if (id) { toks.push({ t: 'id', v: id[0].replace(/\$/g, '').toUpperCase() }); i += id[0].length; continue; }
            if ('+-*/^(),:%'.includes(ch)) { toks.push({ t: ch }); i++; continue; }
            throw new SheetError('#ERROR!');
        }
        return toks;
    }
    /** Evaluates every cell. Numbers stay numbers; errors come back as '#...' strings. */
    function evaluateSheet(cells) {
        cells = cells || {};
        const values = {}, state = {};
        function raw(ref) { const c = cells[ref]; return c && typeof c === 'object' ? c.v : c; }
        function valueOf(ref) {
            if (state[ref] === 'done') return values[ref];
            if (state[ref] === 'busy') throw new SheetError('#CYCLE!');
            const r = raw(ref);
            if (typeof r !== 'string' || !r.startsWith('=')) {
                const s = r == null ? '' : String(r).trim();
                values[ref] = s !== '' && isFinite(Number(s)) ? Number(s) : (r == null ? '' : r);
                state[ref] = 'done'; return values[ref];
            }
            state[ref] = 'busy';
            let v;
            try { v = formula(r.slice(1)); if (typeof v === 'number' && !isFinite(v)) throw new SheetError('#DIV/0!'); }
            catch (e) { v = e instanceof SheetError ? e.code : '#ERROR!'; }
            values[ref] = v; state[ref] = 'done';
            return v;
        }
        function num(v) {
            if (typeof v === 'string' && v.startsWith('#')) throw new SheetError(v);
            if (v === '' || v == null) return 0;
            const n = Number(v); if (!isFinite(n)) throw new SheetError('#VALUE!');
            return n;
        }
        function formula(src) {
            const toks = tokenize(src); let p = 0;
            const peek = () => toks[p], take = t => { if (!toks[p] || toks[p].t !== t) throw new SheetError('#ERROR!'); return toks[p++]; };
            function range(a, b) {
                const s = parseRef(a), e = parseRef(b); if (!s || !e) throw new SheetError('#REF!');
                const out = [];
                for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
                    if (out.length > 100000) throw new SheetError('#REF!');
                    const v = valueOf(refName(c, r));
                    if (typeof v === 'string' && v.startsWith('#')) throw new SheetError(v);
                    if (v !== '' && v != null && isFinite(Number(v))) out.push(Number(v));
                }
                return out;
            }
            function args() {
                const list = []; take('(');
                if (peek() && peek().t === ')') { p++; return list; }
                for (;;) {
                    const t = peek(), n = toks[p + 1], n2 = toks[p + 2];
                    if (t && t.t === 'id' && n && n.t === ':' && n2 && n2.t === 'id') { p += 3; list.push(...range(t.v, n2.v)); }
                    else list.push(expr());
                    if (peek() && peek().t === ',') { p++; continue; }
                    take(')'); return list;
                }
            }
            function atom() {
                const t = toks[p++];
                if (!t) throw new SheetError('#ERROR!');
                if (t.t === 'num') return t.v;
                if (t.t === '(') { const v = expr(); take(')'); return v; }
                if (t.t === '-') return -factor();
                if (t.t === '+') return factor();
                if (t.t === 'id') {
                    if (peek() && peek().t === '(') { const f = FUNCS[t.v]; if (!f) throw new SheetError('#NAME?'); return f(args()); }
                    if (!parseRef(t.v)) throw new SheetError('#NAME?');
                    return num(valueOf(t.v));
                }
                throw new SheetError('#ERROR!');
            }
            function factor() {
                let v = atom();
                while (peek() && peek().t === '%') { p++; v /= 100; }
                if (peek() && peek().t === '^') { p++; v = Math.pow(v, factor()); }
                return v;
            }
            function term() {
                let v = factor();
                while (peek() && (peek().t === '*' || peek().t === '/')) {
                    const op = toks[p++].t, r = factor();
                    if (op === '/' && r === 0) throw new SheetError('#DIV/0!');
                    v = op === '*' ? v * r : v / r;
                }
                return v;
            }
            function expr() {
                let v = term();
                while (peek() && (peek().t === '+' || peek().t === '-')) { const op = toks[p++].t; const r = term(); v = op === '+' ? v + r : v - r; }
                return v;
            }
            const v = expr();
            if (p !== toks.length) throw new SheetError('#ERROR!');
            return v;
        }
        Object.keys(cells).forEach(ref => { if (parseRef(ref)) valueOf(ref); });
        return values;
    }
    function formatValue(v) {
        if (typeof v !== 'number') return v == null ? '' : String(v);
        if (Number.isInteger(v)) return String(v);
        return String(Math.round(v * 1e10) / 1e10);
    }
    /** Used range: { cols, rows } covering every filled cell. */
    function extent(cells) {
        let cols = 0, rows = 0;
        Object.keys(cells || {}).forEach(k => { const p = parseRef(k); const c = cells[k]; const v = c && typeof c === 'object' ? c.v : c; if (p && v !== '' && v != null) { cols = Math.max(cols, p.c + 1); rows = Math.max(rows, p.r + 1); } });
        return { cols, rows };
    }
    // A text cell starting with = + - @ would run as a formula in Excel, so it gets a leading apostrophe; numbers are safe.
    const csvCell = v => {
        const s = String(v == null ? '' : v), risky = /^[=+\-@]/.test(s) && !isFinite(Number(s));
        return /[",\n\r]/.test(s) || risky ? `"${(risky ? "'" : '') + s.replace(/"/g, '""')}"` : s;
    };
    function sheetToCsv(sheet) {
        const cells = (sheet && sheet.cells) || {};
        const vals = evaluateSheet(cells), ext = extent(cells);
        const lines = [];
        for (let r = 0; r < ext.rows; r++) { const row = []; for (let c = 0; c < ext.cols; c++) row.push(csvCell(formatValue(vals[refName(c, r)]))); lines.push(row.join(',')); }
        return lines.join('\r\n');
    }
    /** A CSV (rows of strings) into cells, numbers kept as typed. */
    function csvToCells(rows) {
        const cells = {};
        (rows || []).slice(0, 5000).forEach((row, r) => (row || []).slice(0, 200).forEach((v, c) => { if (v !== '' && v != null) cells[refName(c, r)] = String(v); }));
        return cells;
    }

    /* ---------- content rules and read-only views ---------- */
    const LAYOUTS = { title: 'Title slide', content: 'Title and bullets', text: 'Title and text', section: 'Section header', blank: 'Text only' };
    const SLIDE_BGS = ['#ffffff', '#f4f6f8', '#fff5d6', '#e5f3ff', '#1f2a36', '#2067b0', '#11a9d9', '#3a9d45'];
    const HEX6 = /^#[0-9a-f]{6}$/i;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    /** Dark text on light backgrounds, white on dark ones. */
    function textColorFor(bg) {
        const m = HEX6.exec(bg || ''); if (!m) return '#1f2a36';
        const n = parseInt(bg.slice(1), 16);
        return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.6 ? '#ffffff' : '#1f2a36';
    }
    /** Content as stored, reduced to what the editors understand: anything else is dropped. */
    function normalise(kind, c) {
        c = c && typeof c === 'object' ? c : {};
        if (kind === 'document') return { v: 1, html: sanitizeHtml(typeof c.html === 'string' ? c.html : '') };
        if (kind === 'spreadsheet') {
            const sheets = (Array.isArray(c.sheets) ? c.sheets : []).slice(0, 20).map((s, i) => {
                s = s && typeof s === 'object' ? s : {};
                const cells = {}, widths = {};
                Object.entries(s.cells && typeof s.cells === 'object' ? s.cells : {}).forEach(([k, v]) => {
                    const p = parseRef(k); if (!p || p.c > 701 || p.r > 99999) return;
                    const key = refName(p.c, p.r);
                    if (v && typeof v === 'object') {
                        const val = v.v == null ? '' : String(v.v).slice(0, 5000), cell = { v: val };
                        if (v.b) cell.b = true;
                        if (['l', 'c', 'r'].includes(v.a)) cell.a = v.a;
                        if (cell.b || cell.a) cells[key] = cell; else if (val !== '') cells[key] = val;
                    } else if (v != null && v !== '') cells[key] = String(v).slice(0, 5000);
                });
                Object.entries(s.widths && typeof s.widths === 'object' ? s.widths : {}).forEach(([k, w]) => { const n = Number(w); if (/^\d{1,3}$/.test(k) && n >= 40 && n <= 600) widths[k] = Math.round(n); });
                return { name: String(s.name || `Sheet ${i + 1}`).slice(0, 60), cells, widths };
            });
            return { v: 1, sheets: sheets.length ? sheets : KINDS.spreadsheet.blank().sheets };
        }
        if (kind === 'presentation') {
            const slides = (Array.isArray(c.slides) ? c.slides : []).slice(0, 300).map((s, i) => {
                s = s && typeof s === 'object' ? s : {};
                return {
                    id: /^[a-z0-9-]{1,40}$/i.test(s.id || '') ? s.id : `s${i}-${Math.random().toString(36).slice(2, 7)}`,
                    layout: LAYOUTS[s.layout] ? s.layout : 'content',
                    title: String(s.title || '').slice(0, 500), body: String(s.body || '').slice(0, 5000), notes: String(s.notes || '').slice(0, 5000),
                    bg: HEX6.test(s.bg || '') ? s.bg : '#ffffff',
                };
            });
            return { v: 1, slides: slides.length ? slides : KINDS.presentation.blank().slides };
        }
        return c;
    }
    /** One slide. editable: the fields become contenteditable (the editor); otherwise bullets are real lists. */
    function slideHtml(s, o) {
        s = s || {}; const ed = !!(o && o.editable);
        const layout = LAYOUTS[s.layout] ? s.layout : 'content', bg = HEX6.test(s.bg || '') ? s.bg : '#ffffff';
        const field = (f, cls, ph, inner) => `<div class="${cls}" data-f="${f}"${ed ? ` contenteditable="true" spellcheck="true" data-ph="${esc(ph)}"` : ''}>${inner}</div>`;
        const lines = String(s.body || '').split('\n').filter(l => l.trim());
        const body = ed || layout !== 'content' ? esc(s.body || '') : (lines.length ? `<ul>${lines.map(l => `<li>${esc(l.replace(/^\s*[-•*]\s*/, ''))}</li>`).join('')}</ul>` : '');
        const title = layout === 'blank' ? '' : field('title', 'ds-title', 'Click to add a title', esc(s.title || ''));
        return `<div class="ds-slide L-${layout}" style="background:${bg};color:${textColorFor(bg)}">${title}${field('body', 'ds-body', layout === 'title' || layout === 'section' ? 'Click to add a subtitle' : 'Click to add text', body)}</div>`;
    }
    /** The used range of a sheet as a plain table of values. */
    function sheetTableHtml(sheet) {
        const cells = (sheet && sheet.cells) || {}, vals = evaluateSheet(cells), ext = extent(cells);
        if (!ext.rows) return '<p class="ds-empty">This sheet is empty.</p>';
        let h = `<table class="ds-sheet"><thead><tr><th></th>${Array.from({ length: ext.cols }, (_, c) => `<th>${colName(c)}</th>`).join('')}</tr></thead><tbody>`;
        for (let r = 0; r < ext.rows; r++) {
            h += `<tr><th>${r + 1}</th>`;
            for (let c = 0; c < ext.cols; c++) {
                const ref = refName(c, r), v = vals[ref], cell = cells[ref], f = cell && typeof cell === 'object' ? cell : {};
                const cls = [typeof v === 'number' ? 'num' : '', f.b ? 'b' : '', ['l', 'c', 'r'].includes(f.a) ? 'a-' + f.a : ''].filter(Boolean).join(' ');
                h += `<td${cls ? ` class="${cls}"` : ''}>${esc(formatValue(v))}</td>`;
            }
            h += '</tr>';
        }
        return h + '</tbody></table>';
    }
    /** Read-only HTML for any native document (the public page, previews, printing). */
    function renderStatic(kind, content) {
        const c = normalise(kind, content);
        if (kind === 'document') return `<article class="ds-doc">${c.html}</article>`;
        if (kind === 'spreadsheet') return c.sheets.map(s => `<section class="ds-sheet-wrap">${c.sheets.length > 1 ? `<h2 class="ds-sheet-name">${esc(s.name)}</h2>` : ''}<div class="ds-scroll">${sheetTableHtml(s)}</div></section>`).join('');
        if (kind === 'presentation') return `<div class="ds-slides">${c.slides.map(s => slideHtml(s)).join('')}</div>`;
        return '';
    }
    /** Styles for the read-only views and the editors' content (shared by the app, print and the public page). */
    const STATIC_CSS = [
        '.ds-doc{font:15px/1.6 Inter,system-ui,-apple-system,Arial,sans-serif;color:#1f2a36;overflow-wrap:anywhere}',
        '.ds-doc h1{font-size:28px;line-height:1.25;margin:.7em 0 .4em}.ds-doc h2{font-size:22px;line-height:1.3;margin:.7em 0 .4em}.ds-doc h3{font-size:18px;margin:.7em 0 .4em}',
        '.ds-doc>:first-child{margin-top:0}.ds-doc p{margin:0 0 .7em}.ds-doc ul,.ds-doc ol{margin:0 0 .8em;padding-left:1.6em}',
        '.ds-doc blockquote{margin:0 0 .8em;padding:.2em 0 .2em 1em;border-left:3px solid #c9d3dc;color:#525c69}',
        '.ds-doc pre{background:#f4f6f8;padding:10px 12px;border-radius:6px;white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}',
        '.ds-doc table{border-collapse:collapse;margin:0 0 .9em;min-width:40%}.ds-doc td,.ds-doc th{border:1px solid #c9d3dc;padding:6px 8px;min-width:56px;vertical-align:top}',
        '.ds-doc a{color:#2067b0}.ds-doc hr{border:0;border-top:1px solid #dfe3e8;margin:1.2em 0}',
        '.ds-sheet{border-collapse:collapse;font:13px/1.4 Inter,system-ui,Arial,sans-serif;color:#1f2a36;background:#fff}',
        '.ds-sheet th{background:#f4f6f8;color:#828b95;font-weight:500;padding:4px 8px;border:1px solid #dfe3e8;text-align:center}',
        '.ds-sheet td{border:1px solid #dfe3e8;padding:4px 8px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}',
        '.ds-sheet td.num{text-align:right;font-variant-numeric:tabular-nums}.ds-sheet td.b{font-weight:700}.ds-sheet td.a-l{text-align:left}.ds-sheet td.a-c{text-align:center}.ds-sheet td.a-r{text-align:right}',
        '.ds-scroll{overflow:auto;max-width:100%}.ds-sheet-name{font:600 15px Inter,system-ui,sans-serif;margin:18px 0 8px}.ds-empty{color:#828b95}',
        '.ds-slides{display:grid;gap:18px}',
        '.ds-slide{position:relative;width:100%;aspect-ratio:16/9;container-type:inline-size;box-sizing:border-box;padding:6% 7%;display:flex;flex-direction:column;gap:3%;overflow:hidden;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.18);font-family:Inter,system-ui,Arial,sans-serif;text-align:left}',
        '.ds-title{font-size:5cqw;font-weight:700;line-height:1.15;white-space:pre-wrap;overflow-wrap:anywhere;outline:none}',
        '.ds-body{font-size:2.7cqw;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;outline:none;flex:1;min-height:0}',
        '.ds-body ul{margin:0;padding-left:1.2em;white-space:normal}.ds-body li{margin:.25em 0}',
        '.ds-slide.L-title{justify-content:center;text-align:center}.ds-slide.L-title .ds-title{font-size:6.4cqw}.ds-slide.L-title .ds-body{flex:0 0 auto;font-size:3.2cqw;opacity:.8}',
        '.ds-slide.L-section{justify-content:center}.ds-slide.L-section .ds-title{font-size:6cqw}.ds-slide.L-section .ds-body{flex:0 0 auto;font-size:3cqw;opacity:.8}',
        '.ds-slide.L-blank .ds-body{font-size:3.4cqw}',
        '.ds-slide [contenteditable]:empty::before{content:attr(data-ph);opacity:.45;pointer-events:none}',
        '.ds-slide [contenteditable]{cursor:text;border-radius:3px}.ds-slide [contenteditable]:hover{box-shadow:0 0 0 1px rgba(128,128,128,.45)}.ds-slide [contenteditable]:focus{box-shadow:0 0 0 2px rgba(32,103,176,.55)}',
    ].join('\n');

    /** A link token nobody can guess (32 url-safe characters). */
    function newToken() {
        const bytes = new Uint8Array(24);
        (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(bytes);
        let s = ''; bytes.forEach(b => { s += b.toString(16).padStart(2, '0'); });
        return s.slice(0, 32) + Date.now().toString(36).slice(-4);
    }
    /** Nice file name for a download: keeps letters, digits, spaces, dots, dashes. */
    function fileName(name, ext) {
        const base = String(name || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
        return ext && !base.toLowerCase().endsWith('.' + ext) ? `${base}.${ext}` : base;
    }

    return {
        KINDS, LAYOUTS, SLIDE_BGS, STATIC_CSS, sanitizeHtml, htmlToText, colName, colIndex, parseRef, refName, evaluateSheet, formatValue, extent,
        sheetToCsv, csvToCells, newToken, fileName, textColorFor, normalise, slideHtml, sheetTableHtml, renderStatic,
    };
});
