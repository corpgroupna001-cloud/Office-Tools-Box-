/* ============================================================================
   Company structure — the org chart as in Bitrix24: a light canvas you drag
   and zoom, the group on top, one branch open per level, and a panel on the
   right with the chosen department's supervisors and employees. Managers of a
   company (and admins, for the whole group) add, rename, move and remove
   departments, choose heads and deputies and put people in them. Before
   supabase-b24-migration.sql has run (or before any department exists), a
   read-only chart is drawn from the company and department on each profile.

   URLs: /employees/structure/            /employees/structure/?dept=<uuid>  (opens the path to that department)
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'structure', crumb: 'Company structure' });
    const sb = ctx.sb, me = ctx.user;
    const myCompanies = [me.company, me.company2].filter(Boolean);
    const ROLE_ORDER = { head: 0, deputy: 1, member: 2 };
    const AV_COLORS = ['#2fc6f6', '#9dcf00', '#ffa900', '#9b7cf5', '#f7657a', '#55d0e0', '#2067b0', '#e89b06'];
    const CW = 200, GX = 22, GY = 78, H_CARD = 150, H_DEP = 50, PANEL_W = 420, ZMIN = 0.3, ZMAX = 1.6;
    let depts = [], members = [], people = [], mode = 'live', zoom = 1, query = '';
    let byId = new Map(), kidsOf = new Map(), memOf = new Map(), pById = new Map(), totals = new Map(), mine = new Set();
    let path = [], sel = null, panelOpen = false, listView = false, panelQ = '', hits = [], hitAt = 0;
    const pan = { x: 0, y: 0 }, pos = new Map();
    let shown = new Set();

    const person = id => pById.get(id);
    const nameOf = p => (p ? p.full_name || (p.email || '').split('@')[0] || 'Unknown' : 'Unknown');
    const empId = p => String((p && p.employee_id) || '').trim();
    /** "GL-PIS-CSM-IC-001 · Kemi Ade", or the name alone without an Employee ID. */
    const labelOf = p => (empId(p) ? `${empId(p)} · ${nameOf(p)}` : nameOf(p));
    /** Employee ID in bold, then the name (HTML). */
    const whoHtml = p => (empId(p) ? `<b class="emp-id">${esc(empId(p))}</b> ${esc(nameOf(p))}` : esc(nameOf(p)));
    const avColor = id => AV_COLORS[[...String(id || '')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % AV_COLORS.length];
    const avatar = (p, cls) => `<span class="os-av${cls ? ' ' + cls : ''}" style="--av:${avColor(p && p.id)}" title="${esc(labelOf(p))}">${p && p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(L.initials(nameOf(p)))}</span>`;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
    const kids = id => kidsOf.get(id) || [];
    const membersOf = id => memOf.get(id) || [];
    const headOf = id => membersOf(id).find(m => m.role === 'head');
    const deputyOf = id => membersOf(id).find(m => m.role === 'deputy');
    const positionOf = m => { const p = person(m.user_id); return m.position || (p && p.job_title) || 'Position not specified'; };
    const canManage = d => mode === 'live' && !!d && (ctx.isAdmin || (ctx.isManager && !!d.company && myCompanies.includes(d.company)));
    const roots = () => depts.filter(d => !d.parent_id || !byId.has(d.parent_id));
    function subtreeIds(id, depth) { const out = [id]; if ((depth || 0) < 30) kids(id).forEach(k => out.push(...subtreeIds(k.id, (depth || 0) + 1))); return out; }
    function totalIn(id) { if (!totals.has(id)) totals.set(id, new Set(subtreeIds(id).flatMap(x => membersOf(x).map(m => m.user_id))).size); return totals.get(id); }
    function ancestors(id) { const out = []; let cur = byId.get(id), g = 0; while (cur && cur.parent_id && byId.has(cur.parent_id) && g++ < 30) { out.push(cur.parent_id); cur = byId.get(cur.parent_id); } return out; }
    /** Departments in the order the chart reads: depth first, siblings by sort. */
    function treeOrder() { const out = []; const walk = (d, n) => { out.push([d, n]); if (n < 30) kids(d.id).forEach(k => walk(k, n + 1)); }; roots().forEach(r => walk(r, 0)); return out; }

    /* ------------------------------------------------------------- data */
    async function load() {
        const [d, m, p] = await Promise.all([
            sb.from('departments').select('id, name, parent_id, company, sort').order('sort').order('name').limit(2000),
            sb.from('department_members').select('department_id, user_id, role, position').limit(20000),
            // employee_id arrives with supabase-employee-id-migration.sql; without it the chart reads the rest.
            sb.from('profiles').select('id, full_name, email, avatar_url, company, company2, department, job_title, status, last_seen_at, employee_id').order('full_name').limit(3000)
                .then(r => (r.error ? sb.from('profiles').select('id, full_name, email, avatar_url, company, company2, department, job_title, status, last_seen_at').order('full_name').limit(3000) : r)),
        ]);
        if (p.error) throw p.error;
        people = (p.data || []).filter(x => (x.status || 'active') !== 'inactive');
        if (d.error && !C.isMissingSchema(d.error)) throw d.error;
        mode = d.error ? 'legacy' : (d.data || []).length ? 'live' : 'empty';
        if (mode === 'live') { depts = d.data; members = m.error ? [] : (m.data || []); }
        else derive();
        index();
    }
    /** group > company > department, from the profiles (read-only). */
    function derive() {
        depts = [{ id: 'root', name: 'Corporate Group', parent_id: null, company: null }]; members = [];
        [...new Set(people.map(p => p.company).filter(Boolean))].sort().forEach(c => {
            const cid = 'co:' + c;
            depts.push({ id: cid, name: c, parent_id: 'root', company: c });
            const inCo = people.filter(p => p.company === c);
            [...new Set(inCo.map(p => (p.department || '').trim()).filter(Boolean))].sort().forEach(n => depts.push({ id: `d:${c}:${n}`, name: n, parent_id: cid, company: c }));
            inCo.forEach(p => members.push({ department_id: (p.department || '').trim() ? `d:${c}:${p.department.trim()}` : cid, user_id: p.id, role: 'member', position: null }));
        });
    }
    /** Lookups by id, so 150+ departments and thousands of people stay quick. */
    function index() {
        pById = new Map(people.map(p => [p.id, p])); byId = new Map(depts.map(d => [d.id, d])); totals = new Map();
        kidsOf = new Map(); memOf = new Map();
        depts.forEach(d => { if (d.parent_id && byId.has(d.parent_id)) { if (!kidsOf.has(d.parent_id)) kidsOf.set(d.parent_id, []); kidsOf.get(d.parent_id).push(d); } });
        kidsOf.forEach(list => list.sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name)));
        members.forEach(m => { if (!pById.has(m.user_id)) return; if (!memOf.has(m.department_id)) memOf.set(m.department_id, []); memOf.get(m.department_id).push(m); });
        memOf.forEach(list => list.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || nameOf(person(a.user_id)).localeCompare(nameOf(person(b.user_id)))));
        mine = new Set(members.filter(m => m.user_id === me.id).map(m => m.department_id));
    }
    async function refresh() {
        try { await load(); } catch (e) { return C.toast(C.friendly(e), 'bad'); }
        const cut = path.findIndex(id => !byId.has(id));
        if (cut >= 0) path = path.slice(0, cut);
        if (!byId.has(sel)) { sel = path[path.length - 1] || (roots()[0] || {}).id || null; }
        if (query) findHits();
        render();
    }

    /* ------------------------------------------------------------ layout */
    const cardH = d => H_CARD + (deputyOf(d.id) ? H_DEP : 0);
    /** Row 0 holds the roots; each open department puts its children in the row below, centred under it. */
    function layout() {
        pos.clear();
        const rows = [roots()];
        for (let k = 0; k < path.length && k < 30; k++) { const ks = kids(path[k]); if (!ks.length || !rows[k].some(d => d.id === path[k])) { path = path.slice(0, k); break; } rows.push(ks); }
        let y = 0;
        rows.forEach((row, k) => {
            const w = row.length * CW + (row.length - 1) * GX;
            const parent = k ? pos.get(path[k - 1]) : null;
            const x0 = (parent ? parent.x + CW / 2 : 0) - w / 2;
            row.forEach((d, i) => pos.set(d.id, { x: x0 + i * (CW + GX), y, h: cardH(d), depth: k }));
            y += Math.max(...row.map(cardH)) + GY;
        });
        return rows;
    }

    /* ------------------------------------------------------------ render */
    function cardHtml(d, k) {
        const p = pos.get(d.id), ks = kids(d.id), mem = membersOf(d.id), head = headOf(d.id), hp = head && person(head.user_id);
        const dep = deputyOf(d.id), dp = dep && person(dep.user_id), manage = canManage(d), open = path[k] === d.id;
        const others = mem.filter(m => m.role !== 'head').length, total = totalIn(d.id);
        const cls = `os-slot${open ? ' x' : ''}${d.id === sel ? ' sel' : ''}${hits.includes(d.id) ? ' hit' : ''}${hits[hitAt] === d.id ? ' hit-on' : ''}${shown.has(d.id) ? '' : ' enter'}`;
        return `<div class="${cls}" data-slot="${esc(d.id)}" style="left:${p.x}px;top:${p.y}px;height:${p.h}px"${manage && d.parent_id ? ' draggable="true"' : ''}>
            ${mine.has(d.id) ? '<span class="os-mine">Your department</span>' : ''}
            <div class="os-card" data-dept="${esc(d.id)}" role="button" tabindex="0" aria-pressed="${d.id === sel}" aria-label="${esc(d.name)}: ${plural(total, 'person', 'people')}">
                <div class="os-hd"><span class="os-grip" aria-hidden="true"></span><b class="os-nm" title="${esc(d.name)}">${esc(d.name)}</b>${manage ? '<button type="button" class="os-dots" data-dept-menu aria-label="Department actions">···</button>' : ''}</div>
                <div class="os-sup">${hp ? `${avatar(hp)}<span class="t"><span class="l1"><b title="${esc(labelOf(hp))}">${esc(empId(hp) || nameOf(hp))}</b><span class="os-cnt" title="${plural(total, 'person', 'people')} in all"><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><circle cx="6" cy="4" r="2.3" fill="currentColor"/><path d="M1.6 11c.4-2.6 2.2-4 4.4-4s4 1.4 4.4 4z" fill="currentColor"/></svg>${total}</span></span><span class="l2">${esc(positionOf(head))}</span></span>`
                    : `<span class="os-av none" aria-hidden="true"></span><span class="t"><span class="l1 muted">${k === 0 && !d.company ? 'The whole group' : 'No supervisor'}</span><span class="l2">${plural(total, 'person', 'people')} in all</span></span>`}</div>
                <div class="os-emp"><span>Employees</span><span class="os-pill">${plural(others, 'employee')}</span></div>
                ${dp ? `<div class="os-dep"><span class="lb">Deputy supervisors</span><span class="pp">${avatar(dp, 'xs')}<b title="${esc(labelOf(dp))}">${esc(empId(dp) || nameOf(dp))}</b></span></div>` : ''}
                <button type="button" class="os-ft${ks.length ? '' : ' none'}" data-toggle aria-expanded="${open}"${ks.length ? '' : ' disabled'}>${ks.length ? `${plural(ks.length, 'department')}<span class="car" aria-hidden="true"></span>` : 'no subdepartments'}</button>
            </div>
            ${manage && mode === 'live' ? `<button type="button" class="os-plus" data-plus aria-label="Add a sub-department to ${esc(d.name)}">+</button>` : ''}
        </div>`;
    }
    /** Orthogonal lines from each open department to its children; the open (or chosen) child's line in blue. */
    function linesHtml(rows) {
        let grey = '', blue = '';
        for (let k = 1; k < rows.length; k++) {
            const par = pos.get(path[k - 1]); if (!par) continue;
            const px = par.x + CW / 2, py = par.y + par.h, busY = py + GY / 2, r = 8;
            const active = rows[k].find(d => d.id === path[k]) || rows[k].find(d => d.id === (query && hits[hitAt])) || rows[k].find(d => d.id === sel);
            rows[k].forEach(d => {
                const c = pos.get(d.id), cx = c.x + CW / 2, ty = c.y - (active === d ? 4 : 0), s = Math.sign(cx - px);
                const dd = Math.abs(cx - px) < 1 ? `M${px} ${py}V${ty}` : `M${px} ${py}V${busY - r}Q${px} ${busY} ${px + s * r} ${busY}H${cx - s * r}Q${cx} ${busY} ${cx} ${busY + r}V${ty}`;
                if (active === d) blue = `<path d="${dd}" class="on" marker-end="url(#os-arr)"/>`; else grey += `<path d="${dd}"/>`;
            });
        }
        return `<svg class="os-lines" width="1" height="1" aria-hidden="true"><defs><marker id="os-arr" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto"><path d="M0 0.5L10 5L0 9.5z" fill="#2fc6f6"/></marker></defs>${grey}${blue}</svg>`;
    }
    function renderChart() {
        const world = view.querySelector('[data-world]'); if (!world) return;
        const rows = layout();
        if (!rows[0].length) { world.innerHTML = ''; C.empty(world, 'No company structure yet', 'People will appear here once they have a company.'); return; }
        world.innerHTML = linesHtml(rows) + rows.map((row, k) => row.map(d => cardHtml(d, k)).join('')).join('');
        shown = new Set(pos.keys());
    }
    function renderList() {
        const el = view.querySelector('[data-list]');
        el.hidden = !listView;
        view.querySelector('[data-listview]').setAttribute('aria-pressed', String(listView));
        if (!listView) return;
        const q = query.toLowerCase();
        el.innerHTML = `<div class="os-list-in" role="tree" aria-label="Departments">${treeOrder().map(([d, n]) => {
            const hp = headOf(d.id) && person(headOf(d.id).user_id), t = totalIn(d.id);
            return `<button type="button" class="os-lrow${d.id === sel ? ' sel' : ''}${q ? (hits.includes(d.id) ? ' hit' : ' dim') : ''}" role="treeitem" aria-level="${n + 1}" data-list-dept="${esc(d.id)}" style="--d:${n}"><span class="os-lic" aria-hidden="true"></span><b>${esc(d.name)}</b>${mine.has(d.id) ? '<span class="os-mine in">Your department</span>' : ''}<span class="who">${hp ? esc(empId(hp) || nameOf(hp)) : ''}</span><span class="os-pill">${plural(t, 'person', 'people')}</span></button>`;
        }).join('')}</div>`;
    }
    function renderPanel() {
        const el = view.querySelector('[data-panel]'), canvas = view.querySelector('[data-wrap]');
        const d = byId.get(sel);
        const open = panelOpen && !!d;
        el.classList.toggle('open', open); el.setAttribute('aria-hidden', String(!open)); canvas.classList.toggle('panel-open', open);
        el.inert = !open;
        const crumb = view.querySelector('[data-crumb]');
        crumb.hidden = !d;
        if (d) { crumb.querySelector('.nm').textContent = d.name; crumb.querySelector('.nm').title = d.name; crumb.querySelector('[data-up]').disabled = !d.parent_id || !byId.has(d.parent_id); }
        if (!open) return;
        const manage = canManage(d), list = membersOf(d.id), q = panelQ.toLowerCase();
        const match = m => { const p = person(m.user_id); return !q || [nameOf(p), empId(p), positionOf(m), p.email].some(v => v && String(v).toLowerCase().includes(q)); };
        const sups = list.filter(m => m.role !== 'member'), emps = list.filter(m => m.role === 'member');
        const row = m => { const p = person(m.user_id); return `<div class="os-prow" data-person="${esc(p.id)}" role="button" tabindex="0" aria-label="Open the profile of ${esc(labelOf(p))}">${avatar(p, 'md')}<span class="t"><span class="l1"><b>${esc(empId(p) || nameOf(p))}</b>${m.role === 'head' ? '<span class="os-tag sup">Supervisor</span>' : m.role === 'deputy' ? '<span class="os-tag dep">Deputy</span>' : ''}</span><span class="l2">${empId(p) ? esc(nameOf(p)) + ' · ' : ''}${esc(positionOf(m))}</span></span>${manage ? `<button type="button" class="os-dots" data-member="${esc(m.user_id)}" aria-label="Actions for ${esc(nameOf(p))}">···</button>` : ''}</div>`; };
        const section = (title, rows, act) => `<section class="os-sec"><div class="os-sech"><h3>${title} <span>${rows.length}</span></h3>${manage ? `<button type="button" class="os-act" data-${act}>Actions <span aria-hidden="true">▾</span></button>` : ''}</div>${rows.filter(match).map(row).join('') || `<div class="os-none">${q ? 'Nobody matches' : act === 'sup-actions' ? 'No supervisor chosen' : 'No employees'}</div>`}</section>`;
        el.innerHTML = `<div class="os-ph"><h2 title="${esc(d.name)}">${esc(d.name)}</h2>${manage ? '<button type="button" class="os-ib" data-panel-menu aria-label="Department actions">···</button>' : ''}<button type="button" class="os-ib" data-close-panel aria-label="Close the panel" title="Collapse"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M12 4h4v4M16 4l-5 5M8 16H4v-4M4 16l5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
            <div class="os-tabs" role="tablist"><button type="button" role="tab" aria-selected="true" class="on">Total employees <b>${list.length}</b></button><button type="button" role="tab" aria-selected="false" disabled title="Chats and channels of this department (not set up)">Communications <b>0</b></button></div>
            <div class="os-pbody">
            ${list.length ? `<label class="os-psearch"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><input type="search" data-pq placeholder="Find by name or position" aria-label="Find by name or position" value="${esc(panelQ)}" autocomplete="off"></label>
                ${section('Supervisors', sups, 'sup-actions')}${section('Employees', emps, 'emp-actions')}`
            : `<div class="os-emptyst"><svg viewBox="0 0 120 96" width="120" height="96" aria-hidden="true"><circle cx="60" cy="48" r="44" fill="var(--os-ill-bg)"/><circle cx="44" cy="40" r="11" fill="var(--os-ill-a)"/><path d="M26 70c2-12 10-18 18-18s16 6 18 18z" fill="var(--os-ill-a)"/><circle cx="74" cy="36" r="13" fill="var(--os-ill-b)"/><path d="M53 70c2-14 11-21 21-21s19 7 21 21z" fill="var(--os-ill-b)"/><circle cx="92" cy="66" r="11" fill="#2fc6f6"/><path d="M92 60v12M86 66h12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>
                <h3>Add employees</h3><p>Transfer employees from other departments, or invite new users to this department.</p>${manage ? '<button type="button" class="os-blue" data-add-emp>Add</button>' : ''}</div>`}
            ${kids(d.id).length ? `<section class="os-sec"><div class="os-sech"><h3>Departments <span>${kids(d.id).length}</span></h3></div>${kids(d.id).map(k => `<button type="button" class="os-srow" data-list-dept="${esc(k.id)}"><span class="os-lic" aria-hidden="true"></span><b>${esc(k.name)}</b><span class="os-pill">${plural(totalIn(k.id), 'person', 'people')}</span></button>`).join('')}</section>` : ''}
            ${mode !== 'live' ? '<p class="os-legacy">Drawn from the department on each profile. Departments can be edited once the latest database update is in.</p>' : ''}
            </div>`;
    }
    function render() {
        renderChart(); renderList(); renderPanel(); applyZoom();
        const hn = view.querySelector('[data-hits]');
        hn.textContent = query ? (hits.length ? `${hitAt + 1}/${hits.length}` : 'Nothing found') : '';
        const un = view.querySelector('[data-unassigned-n]');
        if (un) { const inAny = new Set(members.map(m => m.user_id)); un.textContent = people.filter(p => !inAny.has(p.id)).length; }
    }

    /* -------------------------------------------------- canvas: pan & zoom */
    const canvasEl = () => view.querySelector('[data-wrap]');
    const phone = () => canvasEl().clientWidth < 700;
    const visW = () => canvasEl().clientWidth - (panelOpen && !phone() ? PANEL_W : 0);
    function applyZoom(smooth) {
        const world = view.querySelector('[data-world]'); if (!world) return;
        if (smooth) { world.classList.add('anim'); clearTimeout(applyZoom.t); applyZoom.t = setTimeout(() => world.classList.remove('anim'), 320); }
        world.style.transform = `translate(${Math.round(pan.x)}px, ${Math.round(pan.y)}px) scale(${zoom})`;
        view.querySelector('[data-zoom-v]').textContent = `${Math.round(zoom * 100)}%`;
    }
    function setZoom(z, cx, cy) {
        const c = canvasEl(); z = Math.max(ZMIN, Math.min(ZMAX, z));
        if (cx === undefined) { cx = visW() / 2; cy = c.clientHeight / 2; }
        const wx = (cx - pan.x) / zoom, wy = (cy - pan.y) / zoom;
        zoom = z; pan.x = cx - wx * zoom; pan.y = cy - wy * zoom;
        applyZoom();
    }
    /** Bring a department to the middle of the free part of the canvas (or near the top: { top: true }). */
    function centreOn(id, o) {
        const p = pos.get(id); if (!p) return;
        o = o || {};
        const c = canvasEl();
        pan.x = visW() / 2 - (p.x + CW / 2) * zoom;
        pan.y = o.top ? 76 - p.y * zoom : c.clientHeight * 0.56 - (p.y + p.h / 2) * zoom;
        applyZoom(o.smooth !== false);
    }
    /** After opening a department: keep it in view and pull its children up if they fall off the bottom. */
    function revealKids(id) {
        const p = pos.get(id), c = canvasEl(); if (!p) return;
        const ks = kids(id).map(k => pos.get(k.id)).filter(Boolean);
        const bottom = ks.length ? Math.max(...ks.map(k => k.y + k.h)) : p.y + p.h;
        pan.x = visW() / 2 - (p.x + CW / 2) * zoom;
        const need = c.clientHeight - 64 - bottom * zoom;
        if (pan.y > need) pan.y = Math.max(need, 76 - p.y * zoom);
        applyZoom(true);
    }
    function ensureVisible(id) {
        const p = pos.get(id), c = canvasEl(); if (!p) return;
        const sx = pan.x + p.x * zoom, sy = pan.y + p.y * zoom;
        if (sx < 12 || sx + CW * zoom > visW() - 12 || sy < 64 || sy + p.h * zoom > c.clientHeight - 56) centreOn(id);
    }

    /* ----------------------------------------------------- choosing & opening */
    /** Open the path down to a department so its card is on the chart. */
    function openPathTo(id) { if (!pos.has(id)) path = ancestors(id).reverse(); }
    function select(id, o) {
        o = o || {};
        if (!byId.has(id)) return;
        sel = id;
        if (o.open !== undefined) panelOpen = o.open;
        if (o.reveal) openPathTo(id);
        if (o.open) panelQ = '';
        render();
        if (o.reveal) centreOn(id); else ensureVisible(id);
    }
    function toggle(d) {
        const p = pos.get(d.id); if (!p || !kids(d.id).length) return;
        const k = p.depth;
        if (path[k] === d.id) { path = path.slice(0, k); render(); return; }
        path = path.slice(0, k).concat(d.id);                // one open branch per level
        render(); revealKids(d.id);
    }
    function findHits() {
        const q = query.toLowerCase();
        hits = !q ? [] : treeOrder().map(([d]) => d).filter(d => d.name.toLowerCase().includes(q) || membersOf(d.id).some(m => { const p = person(m.user_id); return [nameOf(p), p.employee_id, p.job_title, p.email, m.position].some(v => v && String(v).toLowerCase().includes(q)); })).map(d => d.id);
        hitAt = 0;
    }
    function goHit(i) {
        if (!hits.length) return render();
        hitAt = (i + hits.length) % hits.length;
        path = ancestors(hits[hitAt]).reverse();
        render(); centreOn(hits[hitAt]);
        const row = listView && view.querySelector(`[data-list] [data-list-dept="${CSS.escape(hits[hitAt])}"]`); if (row) row.scrollIntoView({ block: 'center' });
    }
    function findMe() {
        const ids = [...mine].filter(id => byId.has(id)).sort((a, b) => ancestors(b).length - ancestors(a).length);
        if (!ids.length) return C.toast('You are not in a department yet', 'info');
        const next = ids[(ids.indexOf(sel) + 1) % ids.length];
        path = ancestors(next).reverse();
        select(next, {}); centreOn(next);
    }
    function openPerson(id) {
        const url = `/employees/?id=${encodeURIComponent(id)}`;
        if (window.WSShell && WSShell.openSlider) WSShell.openSlider(url); else location.href = url;
    }
    /** C.menu places its list under the anchor; a fixed stand-in keeps it full size and unclipped on the zoomed canvas. */
    const proxy = document.createElement('div');
    proxy.className = 'os-menu-proxy'; proxy.innerHTML = '<button type="button" tabindex="-1" aria-hidden="true"></button>';
    document.body.appendChild(proxy);
    function menuAt(btn, items) {
        if (!items.length) return;
        const r = btn.getBoundingClientRect();
        Object.assign(proxy.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        C.menu(proxy.querySelector('button'), items);
    }

    /* ----------------------------------------------------------- editing */
    const companyOptions = () => [...new Set([...(window.WSCompanies ? WSCompanies.companies : []), ...people.map(p => p.company).filter(Boolean)])].sort().map(c => ({ value: c, label: c }));
    const peopleIn = company => people.filter(p => !company || p.company === company || p.company2 === company);
    async function addDept(parent) {
        const top = !parent || !parent.company;              // under the group: a company's own node
        await C.formModal({
            title: parent ? `New department in ${parent.name}` : 'New department', submitLabel: 'Create',
            fields: [
                ...(top ? [{ name: 'company', label: 'Company', type: 'select', required: true, full: true, options: companyOptions() }] : []),
                { name: 'name', label: 'Name', type: 'text', required: true, full: true, placeholder: 'e.g. Sales' },
                { name: 'head', label: 'Head of department', type: 'select', full: true, options: [{ value: '', label: 'Choose later' }, ...peopleIn(parent && parent.company).map(p => ({ value: p.id, label: labelOf(p) }))] },
            ],
            values: top && myCompanies[0] ? { company: myCompanies[0] } : {},
            onSubmit: async v => {
                const company = top ? v.company : parent.company;
                const parentId = parent ? parent.id : (depts.find(d => !d.parent_id && !d.company) || {}).id || null;
                const { data } = await C.q(sb.from('departments').insert({ name: v.name.trim(), parent_id: parentId, company, created_by: me.id }).select('id').single());
                if (v.head) await C.q(sb.from('department_members').upsert({ department_id: data.id, user_id: v.head, role: 'head' }, { onConflict: 'department_id,user_id' }));
                C.toast('Department created', 'ok');
                if (parentId) { path = ancestors(parentId).reverse().concat(parentId); }
                await refresh();
                if (data && byId.has(data.id)) { sel = data.id; render(); ensureVisible(data.id); }
            },
        });
    }
    async function renameDept(d) {
        await C.formModal({ title: 'Edit department', submitLabel: 'Save', fields: [{ name: 'name', label: 'Name', type: 'text', required: true, full: true }], values: { name: d.name },
            onSubmit: async v => { await C.q(sb.from('departments').update({ name: v.name.trim() }).eq('id', d.id)); C.toast('Renamed', 'ok'); refresh(); } });
    }
    async function moveDept(d) {
        const inside = new Set(subtreeIds(d.id));
        const opts = depts.filter(x => !inside.has(x.id) && (x.company === d.company || (!x.company && ctx.isAdmin)) && (canManage(x) || !x.company))
            .map(x => ({ value: x.id, label: `${'— '.repeat(ancestors(x.id).length)}${x.name}` }));
        if (!opts.length) return C.alert({ title: 'Nowhere to move it', message: 'There is no other department in this company to move it under.' });
        await C.formModal({ title: `Move ${d.name}`, submitLabel: 'Move', fields: [{ name: 'parent_id', label: 'Put it under', type: 'select', required: true, full: true, options: opts }], values: { parent_id: d.parent_id || '' },
            onSubmit: async v => { await C.q(sb.from('departments').update({ parent_id: v.parent_id }).eq('id', d.id)); C.toast('Moved', 'ok'); path = ancestors(v.parent_id).reverse().concat(v.parent_id); refresh(); } });
    }
    async function deleteDept(d) {
        if (kids(d.id).length) return C.alert({ title: 'It still has sub-departments', message: `Move or delete the departments inside "${d.name}" first.` });
        const n = membersOf(d.id).length;
        if (!await C.confirm({ title: `Delete ${d.name}?`, message: n ? `${n} ${n === 1 ? 'person is' : 'people are'} taken out of it; their profiles are not changed.` : 'It is empty, so nothing else changes.', okText: 'Delete', danger: true })) return;
        try { await C.q(sb.from('departments').delete().eq('id', d.id)); C.toast('Department deleted', 'ok'); if (sel === d.id) sel = d.parent_id; refresh(); } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function setRole(d, userId, role) {
        try {
            if (role === 'head') await C.q(sb.from('department_members').update({ role: 'member' }).eq('department_id', d.id).eq('role', 'head'));
            await C.q(sb.from('department_members').upsert({ department_id: d.id, user_id: userId, role }, { onConflict: 'department_id,user_id' }));
            C.toast(role === 'head' ? `${nameOf(person(userId))} now heads ${d.name}` : 'Updated', 'ok');
            await refresh();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    /** Choose the head (or a deputy) from the company's people. */
    async function chooseHead(d, role) {
        role = role || 'head';
        const cur = role === 'head' ? headOf(d.id) : deputyOf(d.id);
        await C.formModal({ title: `${role === 'head' ? 'Head' : 'Deputy'} of ${d.name}`, submitLabel: 'Save', fields: [{ name: 'user', label: 'Person', type: 'select', required: true, full: true, options: peopleIn(d.company).map(p => ({ value: p.id, label: labelOf(p) })) }], values: { user: cur ? cur.user_id : '' },
            onSubmit: async v => { await setRole(d, v.user, role); } });
    }
    async function setPosition(d, userId) {
        const m = members.find(x => x.department_id === d.id && x.user_id === userId);
        await C.formModal({ title: `${nameOf(person(userId))} in ${d.name}`, submitLabel: 'Save', fields: [{ name: 'position', label: 'Position in this department', type: 'text', full: true, placeholder: 'e.g. Team lead' }], values: { position: (m && m.position) || '' },
            onSubmit: async v => { await C.q(sb.from('department_members').update({ position: v.position.trim() || null }).eq('department_id', d.id).eq('user_id', userId)); C.toast('Saved', 'ok'); refresh(); } });
    }
    async function removeMember(d, userId) {
        try { await C.q(sb.from('department_members').delete().eq('department_id', d.id).eq('user_id', userId)); C.toast(`${nameOf(person(userId))} taken out of ${d.name}`, 'ok'); refresh(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    /** Put people in a department; `move` takes them out of their other departments in the same company. */
    async function placePeople(d, ids, move) {
        const already = new Set(membersOf(d.id).map(m => m.user_id));
        ids = (ids || []).filter(id => !already.has(id));
        if (!ids.length) throw new Error('Choose people who are not in this department yet.');
        if (move) {
            const same = depts.filter(x => x.id !== d.id && x.company === d.company).map(x => x.id);
            if (same.length) await C.q(sb.from('department_members').delete().in('user_id', ids).in('department_id', same));
        }
        await C.q(sb.from('department_members').upsert(ids.map(id => ({ department_id: d.id, user_id: id, role: 'member' })), { onConflict: 'department_id,user_id', ignoreDuplicates: true }));
        C.toast(`${ids.length} added to ${d.name}`, 'ok'); refresh();
    }
    async function addPeople(d, anchor) {
        const already = new Set(membersOf(d.id).map(m => m.user_id));
        if (anchor && C.pickPeople) {
            return C.pickPeople(anchor, { multiple: true, selected: [], title: `Add employees to ${d.name}`, onPick: async ids => {
                ids = (ids || []).filter(id => !already.has(id)); if (!ids.length) return;
                const elsewhere = new Set(members.filter(m => ids.includes(m.user_id) && m.department_id !== d.id && d.company && (byId.get(m.department_id) || {}).company === d.company).map(m => m.user_id));
                const move = elsewhere.size ? await C.confirm({ title: 'Transfer them to this department?', message: `${plural(elsewhere.size, 'person is', 'people are')} already in another department of ${d.company}. Transfer takes them out of it; Keep in both leaves them there too.`, okText: 'Transfer', cancelText: 'Keep in both' }) : false;
                try { await placePeople(d, ids, move); } catch (e) { C.toast(e.message, 'bad'); }
            } });
        }
        await C.formModal({
            title: `Add people to ${d.name}`, submitLabel: 'Add', size: 'wide',
            fields: [
                { name: 'people', label: 'People', type: 'peoples', required: true, full: true },
                { name: 'move', label: `Take them out of their other departments${d.company ? ` in ${d.company}` : ''}`, type: 'check', full: true },
            ],
            values: { move: true },
            onSubmit: async v => placePeople(d, v.people, v.move),
        });
    }
    function deptMenu(d, anchor) {
        if (!canManage(d)) return [];
        return [
            { label: 'Add sub-department', icon: 'plus', onClick: () => addDept(d) },
            { label: 'Edit', icon: 'edit', onClick: () => renameDept(d) },
            ...(d.parent_id ? [{ label: 'Move', icon: 'arrow', onClick: () => moveDept(d) }] : []),
            { label: 'Add employees', icon: 'user', onClick: () => addPeople(d, anchor) },
            'sep',
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteDept(d) },
        ];
    }
    function supMenu(d) {
        const head = headOf(d.id), dep = deputyOf(d.id);
        return [
            { label: head ? 'Change head' : 'Choose the head', icon: 'star', onClick: () => chooseHead(d, 'head') },
            { label: dep ? 'Change deputy' : 'Add a deputy', icon: 'user', onClick: () => chooseHead(d, 'deputy') },
            ...(head || dep ? ['sep'] : []),
            head && { label: `Remove head (${empId(person(head.user_id)) || nameOf(person(head.user_id))})`, icon: 'x', danger: true, onClick: () => setRole(d, head.user_id, 'member') },
            dep && { label: `Remove deputy (${empId(person(dep.user_id)) || nameOf(person(dep.user_id))})`, icon: 'x', danger: true, onClick: () => setRole(d, dep.user_id, 'member') },
        ].filter(Boolean);
    }
    function memberMenu(d, userId) {
        const m = members.find(x => x.department_id === d.id && x.user_id === userId) || {};
        return [
            { label: 'Open profile', icon: 'user', onClick: () => openPerson(userId) },
            m.role !== 'head' && { label: 'Make head of department', icon: 'star', onClick: () => setRole(d, userId, 'head') },
            m.role !== 'deputy' && { label: 'Make deputy', icon: 'user', onClick: () => setRole(d, userId, 'deputy') },
            m.role !== 'member' && { label: 'Make a member', icon: 'user', onClick: () => setRole(d, userId, 'member') },
            { label: 'Position in this department…', icon: 'edit', onClick: () => setPosition(d, userId) },
            'sep',
            { label: 'Take out of this department', icon: 'x', danger: true, onClick: () => removeMember(d, userId) },
        ].filter(Boolean);
    }
    /* Bring the chart up to date with what the app already knows: a node per
       company, a node per department named on profiles, and everyone who is
       not placed yet put where their profile says. People and departments
       arranged by hand are left exactly as they are. */
    async function syncFromProfiles() {
        const companies = [...new Set(people.map(p => p.company).filter(Boolean))].sort()
            .filter(c => ctx.isAdmin || myCompanies.includes(c));
        if (!companies.length) return C.alert({ title: 'Nothing to bring in', message: 'No one has a company on their profile yet.' });
        if (!await C.confirm({
            title: 'Update from employee data?',
            message: 'Adds a department for every company and every department named on a profile, and puts people who are not in a department into theirs. Nothing you arranged by hand is moved.',
            okText: 'Update',
        })) return;
        let newDepts = 0, placed = 0;
        try {
            let root = depts.find(d => !d.parent_id && !d.company);
            if (!root) root = (await C.q(sb.from('departments').insert({ name: 'Corporate Group', company: null, sort: 0, created_by: me.id }).select('*').single())).data;
            for (const c of companies) {
                let co = depts.find(d => d.company === c && (d.parent_id === root.id || !d.parent_id));
                if (!co) { co = (await C.q(sb.from('departments').insert({ name: c, parent_id: root.id, company: c, created_by: me.id }).select('*').single())).data; depts.push(co); newDepts++; }
                const inCo = people.filter(p => p.company === c || p.company2 === c);
                const names = [...new Set(inCo.map(p => (p.department || '').trim()).filter(Boolean))].sort();
                const byName = {};
                for (const n of names) {
                    let d = depts.find(x => x.company === c && x.name.toLowerCase() === n.toLowerCase() && x.id !== co.id);
                    if (!d) { d = (await C.q(sb.from('departments').insert({ name: n, parent_id: co.id, company: c, created_by: me.id }).select('*').single())).data; depts.push(d); newDepts++; }
                    byName[n.toLowerCase()] = d.id;
                }
                // Only people who are in no department of this company at all.
                const coIds = new Set(depts.filter(x => x.company === c).map(x => x.id));
                const placedHere = new Set(members.filter(m => coIds.has(m.department_id)).map(m => m.user_id));
                const rows = inCo.filter(p => !placedHere.has(p.id))
                    .map(p => ({ department_id: byName[(p.department || '').trim().toLowerCase()] || co.id, user_id: p.id, role: 'member' }));
                for (let i = 0; i < rows.length; i += 200) {
                    await C.q(sb.from('department_members').upsert(rows.slice(i, i + 200), { onConflict: 'department_id,user_id', ignoreDuplicates: true }));
                }
                placed += rows.length;
            }
            C.toast(`${newDepts ? newDepts + ' department' + (newDepts === 1 ? '' : 's') + ' added' : 'No new departments'}${placed ? `, ${placed} ${placed === 1 ? 'person' : 'people'} placed` : ''}`, 'ok');
            await refresh();
        } catch (e) { C.toast(e.message, 'bad'); refresh(); }
    }
    /** Drag a department (by its card) onto another to put it inside it. */
    function wireDrag(wrapEl) {
        let dragId = null;
        const clear = () => wrapEl.querySelectorAll('.dragging, .drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
        wrapEl.addEventListener('dragstart', e => {
            const node = e.target.closest && e.target.closest('.os-slot[data-slot]');
            if (!node) return;
            const d = byId.get(node.dataset.slot);
            if (!d || !d.parent_id || !canManage(d)) return e.preventDefault();
            dragId = d.id;
            node.classList.add('dragging');
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id); }
        });
        wrapEl.addEventListener('dragend', () => { dragId = null; clear(); });
        const target = e => {
            if (!dragId) return null;
            const node = e.target.closest && e.target.closest('.os-slot[data-slot]');
            if (!node || node.dataset.slot === dragId) return null;
            const d = byId.get(node.dataset.slot);
            if (!d || subtreeIds(dragId).includes(d.id)) return null;           // never inside itself
            const moving = byId.get(dragId);
            const ok = ctx.isAdmin || (d.company && d.company === moving.company && canManage(d));
            return ok ? node : null;
        };
        wrapEl.addEventListener('dragover', e => {
            const node = target(e);
            if (!node) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            wrapEl.querySelectorAll('.drop-target').forEach(el => { if (el !== node) el.classList.remove('drop-target'); });
            node.classList.add('drop-target');
        });
        wrapEl.addEventListener('drop', async e => {
            const node = target(e);
            if (!node) return;
            e.preventDefault();
            const moving = byId.get(dragId), onto = byId.get(node.dataset.slot);
            dragId = null; clear();
            if (!moving || !onto) return;
            try {
                await C.q(sb.from('departments').update({ parent_id: onto.id, company: onto.company || moving.company }).eq('id', moving.id));
                C.toast(`${moving.name} moved into ${onto.name}`, 'ok');
                path = ancestors(onto.id).reverse().concat(onto.id);
                await refresh();
            } catch (err) { C.toast(err.message, 'bad'); refresh(); }
        });
    }
    async function seedFromProfiles() {
        if (!await C.confirm({ title: 'Set up the company structure?', message: 'WorkSuite creates the group, one department per company and one per department named on profiles, and puts everyone in theirs. You can change all of it afterwards.', okText: 'Set it up' })) return;
        try {
            const root = (await C.q(sb.from('departments').insert({ name: 'Corporate Group', company: null, sort: 0, created_by: me.id }).select('id').single())).data;
            for (const c of [...new Set(people.map(p => p.company).filter(Boolean))].sort()) {
                const co = (await C.q(sb.from('departments').insert({ name: c, parent_id: root.id, company: c, created_by: me.id }).select('id').single())).data;
                const byName = {};
                for (const n of [...new Set(people.filter(p => p.company === c).map(p => (p.department || '').trim()).filter(Boolean))].sort()) {
                    byName[n] = (await C.q(sb.from('departments').insert({ name: n, parent_id: co.id, company: c, created_by: me.id }).select('id').single())).data.id;
                }
                const rows = people.filter(p => p.company === c).map(p => ({ department_id: byName[(p.department || '').trim()] || co.id, user_id: p.id, role: 'member' }));
                for (let i = 0; i < rows.length; i += 200) await C.q(sb.from('department_members').upsert(rows.slice(i, i + 200), { onConflict: 'department_id,user_id', ignoreDuplicates: true }));
            }
            C.toast('Company structure created', 'ok');
            location.reload();
        } catch (e) { C.toast(e.message, 'bad'); refresh(); }
    }
    function showUnassigned() {
        const inAny = new Set(members.map(m => m.user_id));
        const list = people.filter(p => !inAny.has(p.id));
        const body = document.createElement('div');
        body.innerHTML = `<p style="margin:0 0 10px">These people are not in any department yet. Open a department and choose <b>Add employees</b> to place them.</p><ul class="crm-list compact">${list.map(p => `<li>${avatar(p)}<div class="main"><b><a href="/employees/?id=${esc(p.id)}">${whoHtml(p)}</a></b><span>${esc([p.job_title, p.company].filter(Boolean).join(' · ') || p.email || '')}</span></div></li>`).join('')}</ul>`;
        C.modal({ title: `Not in a department (${list.length})`, body, actions: [{ label: 'Close', close: true }] });
    }
    /** The chart takes the room left on screen, so the page itself does not scroll. */
    function fitHeight() {
        const wrap = canvasEl(); if (!wrap) return;
        const scrollers = [document.scrollingElement];
        for (let p = wrap.parentElement; p && p !== document.body; p = p.parentElement) { const oy = getComputedStyle(p).overflowY; if (oy === 'auto' || oy === 'scroll') scrollers.push(p); }
        wrap.style.height = window.innerHeight + 'px';
        for (let i = 0; i < 4; i++) {
            const extra = Math.max(...scrollers.map(s => s.scrollHeight - s.clientHeight));
            if (extra <= 1) break;
            const next = Math.max(420, wrap.offsetHeight - extra);
            if (next === wrap.offsetHeight) break;
            wrap.style.height = next + 'px';
        }
    }

    /* ---------------------------------------------------------------- page */
    document.title = 'Company structure · WorkSuite';
    C.loading(view, 'Loading the company structure…');
    try { await load(); } catch (e) { return C.errorState(view, C.friendly(e), () => location.reload()); }
    const canAddTop = mode === 'live' && (ctx.isAdmin || (ctx.isManager && myCompanies.length));
    const canSync = canAddTop;                           // same people may bring the chart up to date
    const ICON = {
        list: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M4 6h12M4 10h12M4 14h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        search: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        up: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 10l5-5 5 5M5 15l5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };
    view.classList.add('os-page');
    view.innerHTML = `
        ${mode === 'legacy' ? `<div class="crm-notice org-note">${C.icon('lock')}<div><b>This chart is drawn from the company and department on each profile.</b><br>To edit departments, heads and who is in them, an administrator needs to run <code>supabase-b24-migration.sql</code> in Supabase → SQL Editor.</div></div>` : ''}
        ${mode === 'empty' ? `<div class="crm-notice org-note">${C.icon('users')}<div><b>The company structure has not been set up yet.</b><br>This chart is drawn from the company and department on each profile.${ctx.isAdmin ? '' : ' An administrator can turn it into an editable structure.'}</div>${ctx.isAdmin ? '<button type="button" class="ws-btn primary" data-seed style="margin-left:auto">Set it up</button>' : ''}</div>` : ''}
        <div class="os-canvas" data-wrap>
            <div class="os-world" data-world></div>
            <div class="os-list" data-list hidden></div>
            <div class="os-tb os-float" role="toolbar" aria-label="Company structure">
                <h1 class="os-title">Company structure</h1>
                ${canAddTop ? '<button type="button" class="os-add" data-create>Add</button>' : ''}
                <button type="button" class="os-ib" data-listview aria-pressed="false" aria-label="List view" title="List view">${ICON.list}</button>
                <div class="os-find" data-find><button type="button" class="os-ib" data-search-btn aria-expanded="false" aria-label="Search" title="Search">${ICON.search}</button><input type="search" data-q placeholder="Department or employee" aria-label="Find a person or department" autocomplete="off"><span class="os-hitn" data-hits aria-live="polite"></span></div>
                ${canSync || mode === 'live' ? '<button type="button" class="os-ib" data-more aria-label="More actions" title="More">···</button>' : ''}
            </div>
            <div class="os-float os-bl"><button type="button" class="os-fm" data-findme>Find me</button><span class="sep" aria-hidden="true"></span><div class="os-zoom" role="group" aria-label="Zoom"><button type="button" data-zoom="-1" aria-label="Zoom out">−</button><span data-zoom-v>100%</span><button type="button" data-zoom="1" aria-label="Zoom in">+</button></div></div>
            <div class="os-float os-br" data-crumb hidden><span class="nm"></span><button type="button" data-up aria-label="Select the parent department" title="Parent department">${ICON.up}</button></div>
            <aside class="os-panel" data-panel aria-hidden="true" aria-label="Department"></aside>
        </div>`;
    const wrap = canvasEl();
    fitHeight();
    // First view: the group open to show its companies; ?dept= opens the path to that department.
    const focus = C.param('dept');
    const r0 = roots()[0];
    if (phone()) zoom = 0.8;
    if (focus && byId.has(focus)) { path = ancestors(focus).reverse(); sel = focus; panelOpen = !phone(); }
    else if (r0) { path = [r0.id]; sel = r0.id; }
    render();
    if (focus && byId.has(focus)) centreOn(focus, { smooth: false });
    else if (r0) centreOn(r0.id, { top: true, smooth: false });
    window.addEventListener('resize', C.debounce(() => { fitHeight(); ensureVisible(sel); }, 150));
    wireDrag(wrap);

    const tb = view.querySelector('.os-tb'), qEl = view.querySelector('[data-q]');
    function openSearch(on) {
        tb.classList.toggle('searching', on);
        view.querySelector('[data-search-btn]').setAttribute('aria-expanded', String(on));
        if (on) qEl.focus();
        else if (query) { qEl.value = ''; query = ''; hits = []; render(); }
    }
    qEl.addEventListener('input', C.debounce(() => { query = qEl.value.trim(); findHits(); goHit(0); }, 220));
    qEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); if (hits.length) goHit(hitAt + (e.shiftKey ? -1 : 1)); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); openSearch(false); view.querySelector('[data-search-btn]').focus(); }
    });
    const seed = view.querySelector('[data-seed]'); if (seed) seed.addEventListener('click', seedFromProfiles);

    wrap.addEventListener('click', e => {
        const t = e.target;
        if (t.closest('[data-create]')) { const d = byId.get(sel); return addDept(canManage(d) ? d : ctx.isAdmin ? null : (depts.find(x => canManage(x) && x.company && myCompanies.includes(x.company) && !(byId.get(x.parent_id) || {}).company) || null)); }
        if (t.closest('[data-listview]')) { listView = !listView; return render(); }
        if (t.closest('[data-search-btn]')) return openSearch(!tb.classList.contains('searching'));
        const more = t.closest('[data-more]');
        if (more) {
            const n = people.filter(p => !new Set(members.map(m => m.user_id)).has(p.id)).length;
            return menuAt(more, [
                canSync && { label: 'Update from employee data', icon: 'refresh', onClick: syncFromProfiles },
                mode === 'live' && { label: `Not in a department (${n})`, icon: 'users', onClick: showUnassigned },
                { label: 'Reset the view', icon: 'arrow', onClick: () => { const r = roots()[0]; if (!r) return; path = [r.id]; zoom = phone() ? 0.8 : 1; render(); centreOn(r.id, { top: true }); } },
            ].filter(Boolean));
        }
        if (t.closest('[data-findme]')) return findMe();
        const zb = t.closest('[data-zoom]'); if (zb) return setZoom(Math.round((zoom + Number(zb.dataset.zoom) * 0.1) * 10) / 10);
        if (t.closest('[data-up]')) { const d = byId.get(sel); if (d && d.parent_id) select(d.parent_id, { reveal: true }); return; }
        // the panel
        if (t.closest('[data-close-panel]')) { panelOpen = false; return render(); }
        const d0 = byId.get(sel);
        if (t.closest('[data-panel-menu]')) return menuAt(t.closest('[data-panel-menu]'), deptMenu(d0, t.closest('[data-panel-menu]')));
        if (t.closest('[data-sup-actions]')) return menuAt(t.closest('[data-sup-actions]'), supMenu(d0));
        if (t.closest('[data-emp-actions]')) { const a = t.closest('[data-emp-actions]'); return menuAt(a, [{ label: 'Add employees', icon: 'plus', onClick: () => addPeople(d0, a) }]); }
        if (t.closest('[data-add-emp]')) return addPeople(d0, t.closest('[data-add-emp]'));
        const mb = t.closest('[data-member]'); if (mb) return menuAt(mb, memberMenu(d0, mb.dataset.member));
        const pr = t.closest('[data-person]'); if (pr) return openPerson(pr.dataset.person);
        const lr = t.closest('[data-list-dept]'); if (lr) return select(lr.dataset.listDept, { open: true, reveal: true });
        // the chart
        const slot = t.closest('.os-slot[data-slot]'); if (!slot) return;
        const d = byId.get(slot.dataset.slot); if (!d) return;
        if (t.closest('[data-plus]')) return addDept(d);
        if (t.closest('[data-dept-menu]')) return menuAt(t.closest('[data-dept-menu]'), deptMenu(d, t.closest('[data-dept-menu]')));
        if (t.closest('[data-toggle]')) return toggle(d);
        if (panMoved || !t.closest('.os-card')) return;
        select(d.id, { open: true });
    });
    wrap.addEventListener('input', e => {
        if (!e.target.matches('[data-pq]')) return;
        panelQ = e.target.value; const at = e.target.selectionStart;
        renderPanel();
        const again = view.querySelector('[data-pq]'); if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (err) { /* type=search */ } }
    });
    wrap.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest('.os-card[data-dept]'), pr = e.target.closest('.os-prow[data-person]');
        if (card && e.target === card) { e.preventDefault(); select(card.dataset.dept, { open: true }); const again = wrap.querySelector(`.os-card[data-dept="${CSS.escape(card.dataset.dept)}"]`); if (again) again.focus({ preventScroll: true }); }
        else if (pr && e.target === pr) { e.preventDefault(); openPerson(pr.dataset.person); }
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (document.querySelector('.crm-modal, #ws-dialog-overlay.show, .crm-menu.open, .crm-pp')) return;
        if (tb.classList.contains('searching')) return openSearch(false);
        if (panelOpen) { panelOpen = false; render(); const c = wrap.querySelector(`.os-card[data-dept="${CSS.escape(sel || '')}"]`); if (c) c.focus({ preventScroll: true }); }
    });
    // Drag the background (or, by touch, anywhere) to move around; ctrl/cmd + wheel or a pinch to zoom.
    let panMoved = false;
    const ptrs = new Map();
    let pinch = null;
    wrap.addEventListener('pointerdown', e => {
        if (e.target.closest('.os-float, .os-panel, .os-list, button, a, input, .crm-menu')) return;
        if (e.pointerType === 'mouse' && (e.button !== 0 || e.target.closest('.os-slot'))) return;
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom }; }
        const x0 = e.clientX, y0 = e.clientY, p0 = { ...pan };
        panMoved = false;
        const move = ev => {
            if (!ptrs.has(ev.pointerId)) return;
            ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            if (pinch && ptrs.size === 2) {
                const [a, b] = [...ptrs.values()], r = wrap.getBoundingClientRect();
                panMoved = true;
                return setZoom(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
            }
            if (!panMoved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
            panMoved = true; wrap.classList.add('panning');
            pan.x = p0.x + ev.clientX - x0; pan.y = p0.y + ev.clientY - y0; applyZoom();
        };
        const up = ev => {
            ptrs.delete(ev.pointerId); if (ptrs.size < 2) pinch = null;
            if (ptrs.size) return;
            document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
            wrap.classList.remove('panning'); setTimeout(() => { panMoved = false; }, 0);
        };
        if (ptrs.size === 1) { document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up); }
    });
    wrap.addEventListener('wheel', e => {
        if (e.target.closest('.os-panel, .os-list, .crm-menu')) return;
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) return setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
        pan.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; pan.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY; applyZoom();
    }, { passive: false });
})();
