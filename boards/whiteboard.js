/* ============================================================================
   WorkSuite — whiteboard editor (SVG)

       const wb = WSWhiteboard.mount(container, { data, canEdit, onChange(data) });
       wb.setData(data)       replace the drawing (a colleague saved), keeping the view
       wb.getData()           { v: 1, elements: [...] }
       wb.exportPng(name) / wb.exportSvg(name) / wb.thumbnail() -> data: URL
       wb.fit() / wb.destroy()

   Elements: { id, type: path | rect | ellipse | line | arrow | text | note,
               x, y, w, h, points (path, line, arrow), color, fill, size, text, fontSize }
   Tools: select (V), hand (H), pen (P), rectangle (R), ellipse (O), line (L),
          arrow (A), text (T), sticky note (N), eraser (E). Space + drag pans,
          the wheel pans, Ctrl/Cmd + wheel zooms. Ctrl/Cmd+Z / Shift+Ctrl/Cmd+Z,
          Delete, Ctrl/Cmd+D duplicates, Escape deselects.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSWhiteboard) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const COLORS = ['#1f2a36', '#2067b0', '#11a9d9', '#4caf50', '#ffa900', '#ff5752', '#9b7cf5', '#f76fa6'];
    const NOTES = ['#fff3a0', '#ffd8a8', '#c8f1c5', '#cbe6ff', '#f1d3ff'];
    const TOOLS = [
        ['select', 'Select', 'V', 'M4 3l7 17 2-7 7-2z'], ['pan', 'Hand', 'H', 'M8 12V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-13 3l-2-4a1.5 1.5 0 0 1 2.5-1.5z'],
        ['pen', 'Pen', 'P', 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3'], ['rect', 'Rectangle', 'R', 'M4 6h16v12H4z'], ['ellipse', 'Ellipse', 'O', 'M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z'],
        ['line', 'Line', 'L', 'M5 19L19 5'], ['arrow', 'Arrow', 'A', 'M5 19L19 5M11 5h8v8'], ['text', 'Text', 'T', 'M5 6V4h14v2M12 4v16M9 20h6'],
        ['note', 'Sticky note', 'N', 'M5 4h14v10l-6 6H5zM13 20v-6h6'], ['eraser', 'Eraser', 'E', 'M16 4l5 5-10 10H6l-3-3zM11 19h10'],
    ];

    function bboxOf(el) {
        if (el.points && el.points.length) {
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            el.points.forEach(([x, y]) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); });
            return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
        return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
    }
    function distToSeg(px, py, [ax, ay], [bx, by]) {
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }
    function hit(el, x, y, tol) {
        if (el.points && el.points.length > 1) {
            const lim = (el.size || 2) / 2 + tol;
            for (let i = 1; i < el.points.length; i++) if (distToSeg(x, y, el.points[i - 1], el.points[i]) <= lim) return true;
            return false;
        }
        const b = bboxOf(el);
        if (el.type === 'rect' && !el.fill) {                     // an outline is only hit near its edges
            const inner = x > b.x + tol && x < b.x + b.w - tol && y > b.y + tol && y < b.y + b.h - tol;
            return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol && !inner;
        }
        return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    }
    function arrowHead(el) {
        const p = el.points, [ax, ay] = p[p.length - 2] || p[0], [bx, by] = p[p.length - 1];
        const ang = Math.atan2(by - ay, bx - ax), len = 10 + (el.size || 2) * 2;
        const l = [bx - len * Math.cos(ang - 0.45), by - len * Math.sin(ang - 0.45)], r = [bx - len * Math.cos(ang + 0.45), by - len * Math.sin(ang + 0.45)];
        return `${bx},${by} ${l[0]},${l[1]} ${r[0]},${r[1]}`;
    }
    const pathD = pts => pts.length === 1 ? `M${pts[0][0]} ${pts[0][1]}l0.01 0` : 'M' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L');
    /** SVG for one element. forExport: text as <text> (a canvas may not draw foreignObject). */
    function svgOf(el, forExport) {
        const s = el.size || 2, c = el.color || '#1f2a36';
        switch (el.type) {
            case 'path': return `<path d="${pathD(el.points)}" stroke="${c}" stroke-width="${s}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'line': return `<path d="${pathD(el.points)}" stroke="${c}" stroke-width="${s}" fill="none" stroke-linecap="round"/>`;
            case 'arrow': return `<path d="${pathD(el.points)}" stroke="${c}" stroke-width="${s}" fill="none" stroke-linecap="round"/><polygon points="${arrowHead(el)}" fill="${c}"/>`;
            case 'rect': { const b = bboxOf(el); return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" stroke="${c}" stroke-width="${s}" fill="${el.fill || 'none'}"/>`; }
            case 'ellipse': { const b = bboxOf(el); return `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" stroke="${c}" stroke-width="${s}" fill="${el.fill || 'none'}"/>`; }
            case 'text':
            case 'note': {
                const b = bboxOf(el), fs = el.fontSize || (el.type === 'note' ? 16 : 20), pad = el.type === 'note' ? 12 : 2;
                const bg = el.type === 'note' ? `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${el.fill || NOTES[0]}" stroke="rgba(0,0,0,.08)"/>` : '';
                if (forExport) {
                    const perLine = Math.max(4, Math.floor((b.w - pad * 2) / (fs * 0.55)));
                    const lines = []; String(el.text || '').split('\n').forEach(par => { let cur = ''; par.split(' ').forEach(w => { if ((cur + ' ' + w).trim().length > perLine) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }); lines.push(cur); });
                    return bg + `<text x="${b.x + pad}" y="${b.y + pad + fs}" font-family="Inter, Arial, sans-serif" font-size="${fs}" fill="${c}">${lines.map((ln, i) => `<tspan x="${b.x + pad}" dy="${i ? fs * 1.3 : 0}">${esc(ln)}</tspan>`).join('')}</text>`;
                }
                return bg + `<foreignObject x="${b.x}" y="${b.y}" width="${Math.max(20, b.w)}" height="${Math.max(20, b.h)}"><div xmlns="http://www.w3.org/1999/xhtml" class="wb-txt${el.type === 'note' ? ' note' : ''}" style="color:${c};font-size:${fs}px;padding:${pad}px">${esc(el.text || '').replace(/\n/g, '<br>')}</div></foreignObject>`;
            }
        }
        return '';
    }
    function contentBox(els) {
        if (!els.length) return { x: 0, y: 0, w: 800, h: 500 };
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        els.forEach(el => { const b = bboxOf(el); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); });
        return { x: x1 - 24, y: y1 - 24, w: x2 - x1 + 48, h: y2 - y1 + 48 };
    }
    function exportSvgString(els, maxW) {
        const box = contentBox(els);
        const scale = maxW ? Math.min(1, maxW / box.w) : 1;
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(box.w * scale)}" height="${Math.round(box.h * scale)}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#ffffff"/>${els.map(el => svgOf(el, true)).join('')}</svg>`;
    }
    function download(name, blob) {
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    const HEX6 = /^#[0-9a-f]{6}$/i;
    const EL_TYPES = new Set(['path', 'rect', 'ellipse', 'line', 'arrow', 'text', 'note']);
    const num = (v, d) => { const n = Number(v); return isFinite(n) ? Math.max(-1e6, Math.min(1e6, n)) : d; };
    /** Drawings come from the database: keep only well-formed elements, hex colours and real numbers,
        so nothing stored through the API can break out of the SVG markup. */
    function clean(list) {
        return (Array.isArray(list) ? list : []).slice(0, 5000).map(el => {
            if (!el || typeof el !== 'object' || !EL_TYPES.has(el.type)) return null;
            const out = { id: String(el.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || uid(), type: el.type,
                          color: HEX6.test(el.color || '') ? el.color : '#1f2a36', size: Math.max(1, Math.min(40, num(el.size, 2))) };
            if (HEX6.test(el.fill || '')) out.fill = el.fill;
            if (el.type === 'path' || el.type === 'line' || el.type === 'arrow') {
                out.points = (Array.isArray(el.points) ? el.points : []).slice(0, 20000).filter(Array.isArray).map(p => [num(p[0], 0), num(p[1], 0)]);
                if (!out.points.length) return null;
            } else { out.x = num(el.x, 0); out.y = num(el.y, 0); out.w = num(el.w, 0); out.h = num(el.h, 0); }
            if (el.type === 'text' || el.type === 'note') { out.text = String(el.text == null ? '' : el.text).slice(0, 10000); out.fontSize = Math.max(8, Math.min(96, num(el.fontSize, el.type === 'note' ? 16 : 20))); }
            return out;
        }).filter(Boolean);
    }

    function mount(container, opts) {
        let els = clean(opts.data && opts.data.elements);
        const canEdit = opts.canEdit !== false;
        let v = { x: 40, y: 40, z: 1 };
        let tool = canEdit ? 'pen' : 'pan', color = COLORS[0], size = 3, noteFill = NOTES[0];
        let selected = new Set(), drag = null, editing = null, spaceDown = false;
        const undo = [], redo = [];
        container.classList.add('wb');
        container.innerHTML = `
            <div class="wb-tools" role="toolbar" aria-label="Whiteboard tools">
                ${TOOLS.filter(t => canEdit || t[0] === 'pan' || t[0] === 'select').map(([k, label, key, d]) => `<button type="button" data-tool="${k}" title="${label} (${key})" aria-label="${label}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg></button>`).join('')}
                ${canEdit ? `<span class="sep"></span>${COLORS.map(c => `<button type="button" class="sw" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('')}
                <select data-size aria-label="Line width"><option value="2">Thin</option><option value="3" selected>Medium</option><option value="6">Thick</option><option value="10">Marker</option></select>
                <span class="sep"></span><span class="notes">${NOTES.map(c => `<button type="button" class="sw note" data-note="${c}" style="--c:${c}" aria-label="Note colour"></button>`).join('')}</span>
                <span class="sep"></span><button type="button" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button><button type="button" data-act="redo" title="Redo (Shift+Ctrl+Z)" aria-label="Redo">↷</button><button type="button" data-act="delete" title="Delete (Del)" aria-label="Delete selected"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>` : ''}
                <span class="grow"></span>
                <button type="button" data-act="zoomout" aria-label="Zoom out">−</button><span class="zoom" data-zoom>100%</span><button type="button" data-act="zoomin" aria-label="Zoom in">+</button><button type="button" data-act="fit" title="Show everything">Fit</button>
            </div>
            <div class="wb-stage" tabindex="0" aria-label="Whiteboard">
                <svg class="wb-svg" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="wb-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="rgba(0,0,0,.12)"/></pattern></defs>
                    <rect class="wb-bg" width="100%" height="100%" fill="url(#wb-grid)"/><g class="wb-world"><g class="wb-layer"></g><g class="wb-sel"></g></g></svg>
                <textarea class="wb-edit" hidden aria-label="Text"></textarea>
            </div>`;
        const stage = container.querySelector('.wb-stage'), svg = container.querySelector('.wb-svg'), world = container.querySelector('.wb-world');
        const layer = container.querySelector('.wb-layer'), selLayer = container.querySelector('.wb-sel'), ta = container.querySelector('.wb-edit');
        const grid = container.querySelector('#wb-grid');

        function applyView() {
            world.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.z})`);
            grid.setAttribute('patternTransform', `translate(${v.x} ${v.y}) scale(${v.z})`);
            container.querySelector('[data-zoom]').textContent = Math.round(v.z * 100) + '%';
            if (editing) placeEditor();
        }
        function render() {
            layer.innerHTML = els.map(el => `<g data-id="${esc(el.id)}">${svgOf(el, false)}</g>`).join('');
            renderSel();
        }
        function renderSel() {
            const list = els.filter(el => selected.has(el.id));
            if (!list.length) { selLayer.innerHTML = ''; return; }
            const b = contentBox(list), one = list.length === 1 && ['rect', 'ellipse', 'text', 'note'].includes(list[0].type);
            const pad = 24 - 6;
            selLayer.innerHTML = `<rect x="${b.x + pad}" y="${b.y + pad}" width="${b.w - pad * 2}" height="${b.h - pad * 2}" fill="none" stroke="#11a9d9" stroke-width="${1.5 / v.z}" stroke-dasharray="${6 / v.z} ${4 / v.z}"/>` +
                (one && canEdit ? `<rect class="wb-handle" data-handle="se" x="${b.x + b.w - pad - 6 / v.z}" y="${b.y + b.h - pad - 6 / v.z}" width="${12 / v.z}" height="${12 / v.z}" fill="#fff" stroke="#11a9d9" stroke-width="${1.5 / v.z}"/>` : '');
        }
        function setTool(t) {
            tool = t; container.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
            stage.dataset.tool = t;
            if (t !== 'select') { selected.clear(); renderSel(); }
        }
        function snapshot() { return JSON.stringify(els); }
        function commit(before) {
            if (before !== undefined && before !== snapshot()) { undo.push(before); if (undo.length > 100) undo.shift(); redo.length = 0; }
            render();
            if (opts.onChange) opts.onChange(api.getData());
        }
        const toScene = e => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left - v.x) / v.z, (e.clientY - r.top - v.y) / v.z]; };
        function topHit(x, y) { const tol = 6 / v.z; for (let i = els.length - 1; i >= 0; i--) if (hit(els[i], x, y, tol)) return els[i]; return null; }
        function zoomAt(f, cx, cy) {
            const r = svg.getBoundingClientRect(); const px = cx - r.left, py = cy - r.top;
            const nz = Math.max(0.1, Math.min(6, v.z * f));
            v.x = px - (px - v.x) * (nz / v.z); v.y = py - (py - v.y) * (nz / v.z); v.z = nz; applyView(); renderSel();
        }
        function fit() {
            const r = svg.getBoundingClientRect();
            if (!els.length || !r.width) { v = { x: 40, y: 40, z: 1 }; return applyView(); }
            const b = contentBox(els);
            const z = Math.max(0.1, Math.min(2, Math.min(r.width / b.w, r.height / b.h)));
            v = { z, x: (r.width - b.w * z) / 2 - b.x * z, y: (r.height - b.h * z) / 2 - b.y * z };
            applyView(); renderSel();
        }

        /* ---- text editing ---- */
        function placeEditor() {
            const el = els.find(x => x.id === editing); if (!el) return;
            const b = bboxOf(el), fs = (el.fontSize || (el.type === 'note' ? 16 : 20)) * v.z, pad = (el.type === 'note' ? 12 : 2) * v.z;
            Object.assign(ta.style, { left: (v.x + b.x * v.z) + 'px', top: (v.y + b.y * v.z) + 'px', width: Math.max(80, b.w * v.z) + 'px', height: Math.max(36, b.h * v.z) + 'px',
                fontSize: fs + 'px', padding: pad + 'px', color: el.color, background: el.type === 'note' ? (el.fill || NOTES[0]) : 'rgba(255,255,255,.9)' });
        }
        function startEdit(el, before) {
            editing = el.id; ta.value = el.text || ''; ta.hidden = false; placeEditor(); ta.focus(); ta.select();
            ta.dataset.before = before !== undefined ? before : snapshot();
        }
        function endEdit() {
            if (!editing) return;
            const el = els.find(x => x.id === editing), before = ta.dataset.before;
            editing = null; ta.hidden = true;
            if (!el) return;
            el.text = ta.value;
            if (!el.text.trim() && el.type === 'text') els = els.filter(x => x !== el);
            else if (el.type === 'text') { const lines = el.text.split('\n'); el.w = Math.max(el.w, Math.min(600, Math.max(...lines.map(l => l.length)) * (el.fontSize || 20) * 0.58 + 8)); el.h = Math.max(el.h, lines.length * (el.fontSize || 20) * 1.35 + 8); }
            commit(before);
        }
        ta.addEventListener('blur', endEdit);
        ta.addEventListener('keydown', e => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); ta.blur(); } e.stopPropagation(); });

        /* ---- pointer ---- */
        stage.addEventListener('pointerdown', e => {
            if (editing) return;
            stage.focus({ preventScroll: true });
            const [x, y] = toScene(e);
            if (e.button === 1 || tool === 'pan' || spaceDown) { drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y }; stage.setPointerCapture(e.pointerId); return; }
            if (!canEdit && tool !== 'select') return;
            const before = snapshot();
            const base = { id: uid(), color, size };
            if (tool === 'pen') { const el = { ...base, type: 'path', points: [[x, y]] }; els.push(el); drag = { kind: 'draw', el, before }; }
            else if (['rect', 'ellipse'].includes(tool)) { const el = { ...base, type: tool, x, y, w: 0, h: 0 }; els.push(el); drag = { kind: 'box', el, sx: x, sy: y, before }; }
            else if (['line', 'arrow'].includes(tool)) { const el = { ...base, type: tool, points: [[x, y], [x, y]] }; els.push(el); drag = { kind: 'seg', el, before }; }
            else if (tool === 'text') { const el = { ...base, type: 'text', x, y: y - 12, w: 220, h: 36, fontSize: 20, text: '' }; els.push(el); render(); startEdit(el, before); return; }
            else if (tool === 'note') { const el = { ...base, color: '#1f2a36', type: 'note', x: x - 90, y: y - 70, w: 180, h: 140, fill: noteFill, fontSize: 16, text: '' }; els.push(el); render(); startEdit(el, before); return; }
            else if (tool === 'eraser') { drag = { kind: 'erase', before }; eraseAt(x, y); }
            else if (tool === 'select') {
                const handle = e.target.closest('[data-handle]');
                if (handle && selected.size === 1) { const el = els.find(z => selected.has(z.id)); drag = { kind: 'resize', el, sx: x, sy: y, w0: el.w, h0: el.h, before }; }
                else {
                    const h = topHit(x, y);
                    if (h) {
                        if (e.shiftKey) { selected.has(h.id) ? selected.delete(h.id) : selected.add(h.id); }
                        else if (!selected.has(h.id)) { selected.clear(); selected.add(h.id); }
                        drag = canEdit ? { kind: 'move', sx: x, sy: y, last: [x, y], moved: false, before } : null;
                    } else { if (!e.shiftKey) selected.clear(); drag = { kind: 'marquee', sx: x, sy: y }; }
                    renderSel();
                }
            }
            if (drag) stage.setPointerCapture(e.pointerId);
            render();
        });
        stage.addEventListener('pointermove', e => {
            if (!drag) return;
            const [x, y] = toScene(e);
            if (drag.kind === 'pan') { v.x = drag.vx + e.clientX - drag.sx; v.y = drag.vy + e.clientY - drag.sy; applyView(); return; }
            if (drag.kind === 'draw') { const last = drag.el.points[drag.el.points.length - 1]; if (Math.hypot(x - last[0], y - last[1]) > 1.5 / v.z) drag.el.points.push([x, y]); }
            else if (drag.kind === 'box') { let w = x - drag.sx, h = y - drag.sy; if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; } Object.assign(drag.el, { x: drag.sx, y: drag.sy, w, h }); }
            else if (drag.kind === 'seg') drag.el.points[1] = [x, y];
            else if (drag.kind === 'erase') eraseAt(x, y);
            else if (drag.kind === 'resize') { drag.el.w = Math.max(20, drag.w0 + x - drag.sx); drag.el.h = Math.max(20, drag.h0 + y - drag.sy); }
            else if (drag.kind === 'move') {
                const dx = x - drag.last[0], dy = y - drag.last[1]; drag.last = [x, y]; drag.moved = true;
                els.forEach(el => { if (!selected.has(el.id)) return; if (el.points) el.points = el.points.map(([px, py]) => [px + dx, py + dy]); else { el.x += dx; el.y += dy; } });
            } else if (drag.kind === 'marquee') {
                const b = { x: Math.min(drag.sx, x), y: Math.min(drag.sy, y), w: Math.abs(x - drag.sx), h: Math.abs(y - drag.sy) };
                selected = new Set(els.filter(el => { const k = bboxOf(el); return k.x >= b.x && k.y >= b.y && k.x + k.w <= b.x + b.w && k.y + k.h <= b.y + b.h; }).map(el => el.id));
                render();
                selLayer.insertAdjacentHTML('beforeend', `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="rgba(17,169,217,.08)" stroke="#11a9d9" stroke-width="${1 / v.z}"/>`);
                return;
            }
            render();
        });
        const finish = () => {
            if (!drag) return;
            const d = drag; drag = null;
            if (d.kind === 'pan' || d.kind === 'marquee') { renderSel(); return; }
            if (d.kind === 'box' && (Math.abs(d.el.w) < 3 || Math.abs(d.el.h) < 3)) els = els.filter(x => x !== d.el);
            if (d.kind === 'seg') { const [[ax, ay], [bx, by]] = d.el.points; if (Math.hypot(bx - ax, by - ay) < 3) els = els.filter(x => x !== d.el); }
            if (d.kind === 'box') { const b = bboxOf(d.el); Object.assign(d.el, b); }
            if (d.kind === 'move' && !d.moved) { renderSel(); return; }
            commit(d.before);
        };
        stage.addEventListener('pointerup', finish);
        stage.addEventListener('pointercancel', finish);
        function eraseAt(x, y) { const h = topHit(x, y); if (h) { els = els.filter(el => el !== h); render(); } }
        stage.addEventListener('dblclick', e => {
            if (!canEdit) return;
            const [x, y] = toScene(e); const h = topHit(x, y);
            if (h && (h.type === 'text' || h.type === 'note')) { selected.clear(); startEdit(h); }
            else if (!h && tool === 'select') { const before = snapshot(); const el = { id: uid(), type: 'text', x, y: y - 12, w: 220, h: 36, fontSize: 20, text: '', color }; els.push(el); render(); startEdit(el, before); }
        });
        stage.addEventListener('wheel', e => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
            else { v.x -= e.deltaX; v.y -= e.deltaY; applyView(); }
        }, { passive: false });

        /* ---- keyboard ---- */
        stage.addEventListener('keydown', e => {
            if (editing) return;
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === ' ') { spaceDown = true; stage.classList.add('panning'); e.preventDefault(); return; }
            if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? api.redo() : api.undo(); }
            if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return api.redo(); }
            if (mod && e.key.toLowerCase() === 'd' && canEdit && selected.size) {
                e.preventDefault(); const before = snapshot();
                const copies = els.filter(el => selected.has(el.id)).map(el => { const c = JSON.parse(JSON.stringify(el)); c.id = uid(); if (c.points) c.points = c.points.map(([x, y]) => [x + 20, y + 20]); else { c.x += 20; c.y += 20; } return c; });
                els.push(...copies); selected = new Set(copies.map(c => c.id)); return commit(before);
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit && selected.size) { e.preventDefault(); const before = snapshot(); els = els.filter(el => !selected.has(el.id)); selected.clear(); return commit(before); }
            if (e.key === 'Escape') { selected.clear(); renderSel(); return; }
            if (!mod && !e.altKey) { const t = TOOLS.find(x => x[2].toLowerCase() === e.key.toLowerCase()); if (t && (canEdit || t[0] === 'pan' || t[0] === 'select')) setTool(t[0]); }
        });
        stage.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; stage.classList.remove('panning'); } });

        /* ---- toolbar ---- */
        container.querySelector('.wb-tools').addEventListener('click', e => {
            const t = e.target.closest('[data-tool]'); if (t) return setTool(t.dataset.tool);
            const c = e.target.closest('[data-color]');
            if (c) {
                color = c.dataset.color; container.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b === c));
                if (selected.size) { const before = snapshot(); els.forEach(el => { if (selected.has(el.id)) el.color = color; }); commit(before); }
                return;
            }
            const n = e.target.closest('[data-note]');
            if (n) { noteFill = n.dataset.note; container.querySelectorAll('[data-note]').forEach(b => b.classList.toggle('on', b === n)); if (selected.size) { const before = snapshot(); els.forEach(el => { if (selected.has(el.id) && el.type === 'note') el.fill = noteFill; }); commit(before); } else setTool('note'); return; }
            const a = e.target.closest('[data-act]'); if (!a) return;
            const r = svg.getBoundingClientRect();
            if (a.dataset.act === 'undo') api.undo();
            if (a.dataset.act === 'redo') api.redo();
            if (a.dataset.act === 'delete' && selected.size) { const before = snapshot(); els = els.filter(el => !selected.has(el.id)); selected.clear(); commit(before); }
            if (a.dataset.act === 'zoomin') zoomAt(1.2, r.left + r.width / 2, r.top + r.height / 2);
            if (a.dataset.act === 'zoomout') zoomAt(1 / 1.2, r.left + r.width / 2, r.top + r.height / 2);
            if (a.dataset.act === 'fit') fit();
        });
        const sizeSel = container.querySelector('[data-size]');
        if (sizeSel) sizeSel.addEventListener('change', () => { size = Number(sizeSel.value); if (selected.size) { const before = snapshot(); els.forEach(el => { if (selected.has(el.id) && el.type !== 'note' && el.type !== 'text') el.size = size; }); commit(before); } });

        const api = {
            getData: () => ({ v: 1, elements: JSON.parse(JSON.stringify(els)) }),
            setData(data) {
                if (drag || editing) return false;             // never pull the drawing from under the pen
                els = clean(data && data.elements);
                selected = new Set([...selected].filter(id => els.some(el => el.id === id)));
                render(); return true;
            },
            undo() { if (!undo.length) return; redo.push(snapshot()); els = JSON.parse(undo.pop()); selected.clear(); render(); if (opts.onChange) opts.onChange(api.getData()); },
            redo() { if (!redo.length) return; undo.push(snapshot()); els = JSON.parse(redo.pop()); selected.clear(); render(); if (opts.onChange) opts.onChange(api.getData()); },
            fit,
            get busy() { return !!(drag || editing); },
            exportSvg(name) { download((name || 'board') + '.svg', new Blob([exportSvgString(els)], { type: 'image/svg+xml' })); },
            exportPng(name) {
                const s = exportSvgString(els), img = new Image(), box = contentBox(els);
                img.onload = () => {
                    const cv = document.createElement('canvas'), k = 2; cv.width = box.w * k; cv.height = box.h * k;
                    const g = cv.getContext('2d'); g.scale(k, k); g.drawImage(img, 0, 0, box.w, box.h);
                    cv.toBlob(b => download((name || 'board') + '.png', b), 'image/png');
                };
                img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
            },
            /** A small preview for the boards list. */
            thumbnail() { if (!els.length) return null; const s = exportSvgString(els, 320); return s.length < 300000 ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s) : null; },
            destroy() { container.innerHTML = ''; container.classList.remove('wb'); },
        };
        setTool(tool);
        const sw = container.querySelector('[data-color]'); if (sw) sw.classList.add('on');
        const nw = container.querySelector('[data-note]'); if (nw) nw.classList.add('on');
        render();
        requestAnimationFrame(fit);
        return api;
    }

    window.WSWhiteboard = { mount };
})();
