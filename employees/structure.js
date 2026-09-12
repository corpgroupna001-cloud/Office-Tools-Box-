/* ============================================================================
   Company structure — the org chart: the group, its companies and their
   departments, each with its head and people. Managers of a company (and
   admins, for the whole group) add, rename, move and remove departments,
   choose heads and deputies and put people in them. Before
   supabase-b24-migration.sql has run (or before any department exists), a
   read-only chart is drawn from the company and department on each profile.

   URLs: /employees/structure/            /employees/structure/?dept=<uuid>  (centres that department)
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'structure', crumb: 'Company structure' });
    const sb = ctx.sb, me = ctx.user;
    const myCompanies = [me.company, me.company2].filter(Boolean);
    const ROLE = { head: 'Head', deputy: 'Deputy', member: 'Member' };
    const ROLE_ORDER = { head: 0, deputy: 1, member: 2 };
    const LEVEL_COLORS = ['#1f2a36', '#2067b0', '#2fc6f6', '#9dcf00', '#ffa900', '#9b7cf5'];
    const ZOOMS = [0.4, 0.5, 0.65, 0.8, 0.9, 1, 1.15, 1.3, 1.5];
    let depts = [], members = [], people = [], mode = 'live', zoom = 1, query = '';
    let collapsed = new Set();
    try { collapsed = new Set(JSON.parse(localStorage.getItem('ws-org-collapsed') || '[]')); } catch (e) { /* private mode */ }
    const saveCollapsed = () => { try { localStorage.setItem('ws-org-collapsed', JSON.stringify([...collapsed])); } catch (e) { /* private mode */ } };

    const person = id => people.find(p => p.id === id);
    const nameOf = p => (p ? p.full_name || (p.email || '').split('@')[0] || 'Unknown' : 'Unknown');
    const avatar = p => `<span class="ws-avatar" title="${esc(nameOf(p))}">${p && p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(L.initials(nameOf(p)))}</span>`;
    const kids = id => depts.filter(d => (d.parent_id || null) === id).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
    const membersOf = id => members.filter(m => m.department_id === id && person(m.user_id))
        .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || nameOf(person(a.user_id)).localeCompare(nameOf(person(b.user_id))));
    const headOf = id => membersOf(id).find(m => m.role === 'head');
    const canManage = d => mode === 'live' && (ctx.isAdmin || (ctx.isManager && !!d.company && myCompanies.includes(d.company)));
    function subtreeIds(id, depth) { const out = [id]; if ((depth || 0) < 30) kids(id).forEach(k => out.push(...subtreeIds(k.id, (depth || 0) + 1))); return out; }
    const totalIn = id => new Set(subtreeIds(id).flatMap(x => membersOf(x).map(m => m.user_id))).size;
    function ancestors(id) { const out = []; let cur = depts.find(d => d.id === id), g = 0; while (cur && cur.parent_id && g++ < 30) { out.push(cur.parent_id); cur = depts.find(d => d.id === cur.parent_id); } return out; }

    /* ------------------------------------------------------------- data */
    async function load() {
        const [d, m, p] = await Promise.all([
            sb.from('departments').select('id, name, parent_id, company, sort').order('sort').order('name').limit(2000),
            sb.from('department_members').select('department_id, user_id, role, position').limit(20000),
            sb.from('profiles').select('id, full_name, email, avatar_url, company, company2, department, job_title, status, last_seen_at').order('full_name').limit(3000),
        ]);
        if (p.error) throw p.error;
        people = (p.data || []).filter(x => (x.status || 'active') !== 'inactive');
        if (d.error && !C.isMissingSchema(d.error)) throw d.error;
        mode = d.error ? 'legacy' : (d.data || []).length ? 'live' : 'empty';
        if (mode === 'live') { depts = d.data; members = m.error ? [] : (m.data || []); return; }
        derive();
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
    async function refresh() {
        try { await load(); } catch (e) { return C.toast(C.friendly(e), 'bad'); }
        render();
    }

    /* ------------------------------------------------------------ render */
    function nodeHtml(d, depth) {
        const ks = kids(d.id), mem = membersOf(d.id), head = headOf(d.id), hp = head && person(head.user_id);
        const shut = collapsed.has(d.id) && ks.length > 0 && !query;
        const color = LEVEL_COLORS[Math.min(depth, 1)] && depth < 2 ? LEVEL_COLORS[depth] : LEVEL_COLORS[2 + ((depth - 2) % 4)];
        const total = totalIn(d.id), others = mem.filter(m => m.role !== 'head');
        return `<li><div class="org-node${depth === 0 ? ' root' : ''}" data-dept="${esc(d.id)}"${canManage(d) && d.parent_id ? ' draggable="true"' : ''} style="--c:${color}" tabindex="0" role="button" aria-label="${esc(d.name)}: ${total} ${total === 1 ? 'person' : 'people'}">
                <div class="hd"><b class="nm">${esc(d.name)}</b>${canManage(d) ? '<button type="button" class="g-rowmenu" data-dept-menu aria-label="Department actions">☰</button>' : ''}</div>
                <div class="head">${hp ? `${avatar(hp)}<span><b>${esc(nameOf(hp))}</b><span>${esc(head.position || 'Head of department')}</span></span>` : `<span class="muted">${depth === 0 ? (d.company ? '' : 'The whole group') : 'No head chosen'}</span>`}</div>
                <div class="ft"><span class="avs">${others.slice(0, 5).map(m => avatar(person(m.user_id))).join('')}${others.length > 5 ? `<span class="more">+${others.length - 5}</span>` : ''}</span><span class="n">${total === mem.length ? `${total} ${total === 1 ? 'person' : 'people'}` : mem.length ? `${mem.length} here · ${total} in all` : `${total} in all`}</span></div>
                ${ks.length ? `<button type="button" class="org-toggle" data-toggle aria-label="${shut ? 'Show' : 'Hide'} ${ks.length} sub-department${ks.length === 1 ? '' : 's'}">${shut ? '+' + ks.length : '−'}</button>` : ''}
            </div>${ks.length && !shut && depth < 30 ? `<ul>${ks.map(k => nodeHtml(k, depth + 1)).join('')}</ul>` : ''}</li>`;
    }
    function render() {
        const org = view.querySelector('[data-org]'); if (!org) return;
        const roots = depts.filter(d => !d.parent_id || !depts.some(x => x.id === d.parent_id));
        org.innerHTML = roots.length ? `<ul class="org-tree">${roots.map(r => nodeHtml(r, 0)).join('')}</ul>` : '';
        if (!roots.length) C.empty(org, 'No company structure yet', 'People will appear here once they have a company.');
        // Search: light up the departments that match, or that hold someone who matches.
        const hitsEl = view.querySelector('[data-hits]');
        if (query) {
            const q = query.toLowerCase();
            const hits = depts.filter(d => d.name.toLowerCase().includes(q) || membersOf(d.id).some(m => { const p = person(m.user_id); return [nameOf(p), p.job_title, p.email].some(v => v && String(v).toLowerCase().includes(q)); }));
            hits.forEach(d => { const el = org.querySelector(`[data-dept="${CSS.escape(d.id)}"]`); if (el) el.classList.add('hit'); });
            hitsEl.textContent = hits.length ? `${hits.length} department${hits.length === 1 ? '' : 's'} found` : 'Nothing found';
            const first = hits[0] && org.querySelector(`[data-dept="${CSS.escape(hits[0].id)}"]`);
            if (first) first.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        } else hitsEl.textContent = '';
        const un = view.querySelector('[data-unassigned]');
        if (un) {
            const inAny = new Set(members.map(m => m.user_id));
            const n = people.filter(p => !inAny.has(p.id)).length;
            un.hidden = mode !== 'live' || !n;
            un.querySelector('b').textContent = n;
        }
        applyZoom();
    }
    function applyZoom() {
        const org = view.querySelector('[data-org]'); if (!org) return;
        org.style.zoom = zoom;
        view.querySelector('[data-zoom-v]').textContent = `${Math.round(zoom * 100)}%`;
    }
    function fitZoom() {
        const wrap = view.querySelector('[data-wrap]'), org = view.querySelector('[data-org]');
        org.style.zoom = 1;
        const w = org.scrollWidth, avail = wrap.clientWidth - 8;
        zoom = Math.max(ZOOMS[0], Math.min(1, avail / Math.max(1, w)));
        applyZoom();
        wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2;
    }
    /** The chart takes the room left on screen, so only it scrolls (not the page as well). */
    function fitHeight() {
        const wrap = view.querySelector('[data-wrap]'); if (!wrap) return;
        const scrollers = [document.scrollingElement];
        for (let p = wrap.parentElement; p && p !== document.body; p = p.parentElement) { const oy = getComputedStyle(p).overflowY; if (oy === 'auto' || oy === 'scroll') scrollers.push(p); }
        wrap.style.height = window.innerHeight + 'px';
        for (let i = 0; i < 4; i++) {
            const extra = Math.max(...scrollers.map(s => s.scrollHeight - s.clientHeight));
            if (extra <= 1) break;
            const next = Math.max(380, wrap.offsetHeight - extra);
            if (next === wrap.offsetHeight) break;
            wrap.style.height = next + 'px';
        }
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
                { name: 'head', label: 'Head of department', type: 'select', full: true, options: [{ value: '', label: 'Choose later' }, ...peopleIn(parent && parent.company).map(p => ({ value: p.id, label: nameOf(p) }))] },
            ],
            values: top && myCompanies[0] ? { company: myCompanies[0] } : {},
            onSubmit: async v => {
                const company = top ? v.company : parent.company;
                const parentId = parent ? parent.id : (depts.find(d => !d.parent_id && !d.company) || {}).id || null;
                const { data } = await C.q(sb.from('departments').insert({ name: v.name.trim(), parent_id: parentId, company, created_by: me.id }).select('id').single());
                if (v.head) await C.q(sb.from('department_members').upsert({ department_id: data.id, user_id: v.head, role: 'head' }, { onConflict: 'department_id,user_id' }));
                C.toast('Department created', 'ok'); refresh();
            },
        });
    }
    async function renameDept(d) {
        await C.formModal({ title: 'Rename department', submitLabel: 'Save', fields: [{ name: 'name', label: 'Name', type: 'text', required: true, full: true }], values: { name: d.name },
            onSubmit: async v => { await C.q(sb.from('departments').update({ name: v.name.trim() }).eq('id', d.id)); C.toast('Renamed', 'ok'); refresh(); } });
    }
    async function moveDept(d) {
        const inside = new Set(subtreeIds(d.id));
        const opts = depts.filter(x => !inside.has(x.id) && (x.company === d.company || (!x.company && ctx.isAdmin)) && (canManage(x) || !x.company))
            .map(x => ({ value: x.id, label: `${'— '.repeat(ancestors(x.id).length)}${x.name}` }));
        if (!opts.length) return C.alert({ title: 'Nowhere to move it', message: 'There is no other department in this company to move it under.' });
        await C.formModal({ title: `Move ${d.name}`, submitLabel: 'Move', fields: [{ name: 'parent_id', label: 'Put it under', type: 'select', required: true, full: true, options: opts }], values: { parent_id: d.parent_id || '' },
            onSubmit: async v => { await C.q(sb.from('departments').update({ parent_id: v.parent_id }).eq('id', d.id)); C.toast('Moved', 'ok'); refresh(); } });
    }
    async function deleteDept(d) {
        if (kids(d.id).length) return C.alert({ title: 'It still has sub-departments', message: `Move or delete the departments inside "${d.name}" first.` });
        const n = membersOf(d.id).length;
        if (!await C.confirm({ title: `Delete ${d.name}?`, message: n ? `${n} ${n === 1 ? 'person is' : 'people are'} taken out of it; their profiles are not changed.` : 'It is empty, so nothing else changes.', okText: 'Delete', danger: true })) return;
        try { await C.q(sb.from('departments').delete().eq('id', d.id)); C.toast('Department deleted', 'ok'); refresh(); } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function setRole(d, userId, role) {
        try {
            if (role === 'head') await C.q(sb.from('department_members').update({ role: 'member' }).eq('department_id', d.id).eq('role', 'head'));
            await C.q(sb.from('department_members').upsert({ department_id: d.id, user_id: userId, role }, { onConflict: 'department_id,user_id' }));
            C.toast(role === 'head' ? `${nameOf(person(userId))} now heads ${d.name}` : 'Updated', 'ok');
            await refresh();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function chooseHead(d) {
        const cur = headOf(d.id);
        await C.formModal({ title: `Head of ${d.name}`, submitLabel: 'Save', fields: [{ name: 'user', label: 'Person', type: 'select', required: true, full: true, options: peopleIn(d.company).map(p => ({ value: p.id, label: nameOf(p) })) }], values: { user: cur ? cur.user_id : '' },
            onSubmit: async v => { await setRole(d, v.user, 'head'); } });
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
    async function addPeople(d) {
        const already = new Set(membersOf(d.id).map(m => m.user_id));
        await C.formModal({
            title: `Add people to ${d.name}`, submitLabel: 'Add', size: 'wide',
            fields: [
                { name: 'people', label: 'People', type: 'peoples', required: true, full: true },
                { name: 'move', label: `Take them out of their other departments${d.company ? ` in ${d.company}` : ''}`, type: 'check', full: true },
            ],
            values: { move: true },
            onSubmit: async v => {
                const ids = (v.people || []).filter(id => !already.has(id));
                if (!ids.length) throw new Error('Choose people who are not in this department yet.');
                if (v.move) {
                    const same = depts.filter(x => x.id !== d.id && x.company === d.company).map(x => x.id);
                    if (same.length) await C.q(sb.from('department_members').delete().in('user_id', ids).in('department_id', same));
                }
                await C.q(sb.from('department_members').upsert(ids.map(id => ({ department_id: d.id, user_id: id, role: 'member' })), { onConflict: 'department_id,user_id', ignoreDuplicates: true }));
                C.toast(`${ids.length} added to ${d.name}`, 'ok'); refresh();
            },
        });
    }
    function deptMenu(d) {
        return [
            { label: 'Open', icon: 'users', onClick: () => openDept(d) },
            'sep',
            { label: 'Add sub-department', icon: 'plus', onClick: () => addDept(d) },
            { label: 'Add people', icon: 'user', onClick: () => addPeople(d) },
            { label: 'Choose the head', icon: 'star', onClick: () => chooseHead(d) },
            { label: 'Rename', icon: 'edit', onClick: () => renameDept(d) },
            ...(d.parent_id ? [{ label: 'Move…', icon: 'arrow', onClick: () => moveDept(d) }] : []),
            'sep',
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteDept(d) },
        ];
    }
    function memberMenu(d, userId) {
        const m = members.find(x => x.department_id === d.id && x.user_id === userId) || {};
        return [
            m.role !== 'head' && { label: 'Make head of department', icon: 'star', onClick: () => setRole(d, userId, 'head') },
            m.role !== 'deputy' && { label: 'Make deputy', icon: 'user', onClick: () => setRole(d, userId, 'deputy') },
            m.role !== 'member' && { label: 'Make a member', icon: 'user', onClick: () => setRole(d, userId, 'member') },
            { label: 'Position in this department…', icon: 'edit', onClick: () => setPosition(d, userId) },
            'sep',
            { label: 'Take out of this department', icon: 'x', danger: true, onClick: () => removeMember(d, userId) },
        ].filter(Boolean);
    }
    function openDept(d) {
        const list = membersOf(d.id), ks = kids(d.id), manage = canManage(d), total = totalIn(d.id);
        const body = document.createElement('div');
        body.innerHTML = `
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">${d.company ? C.badge('info', d.company) : C.badge('mute', 'Whole group')}<span class="muted" style="font-size:13px">${list.length} ${list.length === 1 ? 'person' : 'people'} here${total !== list.length ? `, ${total} with sub-departments` : ''}</span></div>
            ${list.length ? `<ul class="crm-list compact">${list.map(m => { const p = person(m.user_id); return `<li>${avatar(p)}<div class="main"><b><a href="/employees/?id=${esc(p.id)}">${esc(nameOf(p))}</a></b><span>${esc(m.position || p.job_title || p.email || '')}</span></div><div class="right">${m.role !== 'member' ? C.badge(m.role === 'head' ? 'pending' : 'info', ROLE[m.role]) : ''}${manage ? `<button type="button" class="ws-btn sm icon ghost" data-member="${esc(m.user_id)}" aria-label="Actions for ${esc(nameOf(p))}">${C.icon('more', 'sm')}</button>` : ''}</div></li>`; }).join('')}</ul>`
                : '<div class="muted" style="font-size:13px">No one is in this department yet.</div>'}
            ${ks.length ? `<div class="crm-section-title" style="margin-top:16px"><h3>Sub-departments</h3></div><ul class="crm-list compact">${ks.map(k => `<li><span class="dv-ico k-folder" aria-hidden="true"></span><div class="main"><b><a href="#" data-sub="${esc(k.id)}">${esc(k.name)}</a></b><span>${totalIn(k.id)} ${totalIn(k.id) === 1 ? 'person' : 'people'}</span></div></li>`).join('')}</ul>` : ''}
            ${mode !== 'live' ? '<p class="muted" style="font-size:12.5px;margin:14px 0 0">Drawn from the department on each profile. Departments can be edited once the latest database update is in.</p>' : ''}`;
        const actions = manage ? [{ label: 'Add sub-department', onClick: api => { api.close(); addDept(d); } }, { label: 'Add people', primary: true, onClick: api => { api.close(); addPeople(d); } }] : [];
        actions.push({ label: 'Close', close: true });
        const m = C.modal({ title: d.name, size: 'wide', body, actions });
        body.addEventListener('click', e => {
            const sub = e.target.closest('[data-sub]');
            if (sub) { e.preventDefault(); const k = depts.find(x => x.id === sub.dataset.sub); if (m && m.close) m.close(); if (k) openDept(k); return; }
            const mb = e.target.closest('[data-member]');
            if (mb) C.menu(mb, memberMenu(d, mb.dataset.member).map(it => (it === 'sep' ? it : { ...it, onClick: () => { if (m && m.close) m.close(); it.onClick(); } })));
        });
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
            await refresh(); fitZoom();
        } catch (e) { C.toast(e.message, 'bad'); refresh(); }
    }
    /** Drag a department onto another to put it inside it. */
    function wireDrag(wrapEl) {
        let dragId = null;
        wrapEl.addEventListener('dragstart', e => {
            const node = e.target.closest('.org-node[data-dept]');
            if (!node) return;
            const d = depts.find(x => x.id === node.dataset.dept);
            if (!d || !d.parent_id || !canManage(d)) return e.preventDefault();
            dragId = d.id;
            node.classList.add('dragging');
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id); }
        });
        wrapEl.addEventListener('dragend', () => {
            dragId = null;
            wrapEl.querySelectorAll('.dragging, .drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
        });
        const target = e => {
            if (!dragId) return null;
            const node = e.target.closest('.org-node[data-dept]');
            if (!node || node.dataset.dept === dragId) return null;
            const d = depts.find(x => x.id === node.dataset.dept);
            if (!d || subtreeIds(dragId).includes(d.id)) return null;           // never inside itself
            const moving = depts.find(x => x.id === dragId);
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
            const moving = depts.find(x => x.id === dragId), onto = depts.find(x => x.id === node.dataset.dept);
            dragId = null;
            wrapEl.querySelectorAll('.dragging, .drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
            if (!moving || !onto) return;
            try {
                await C.q(sb.from('departments').update({ parent_id: onto.id, company: onto.company || moving.company }).eq('id', moving.id));
                C.toast(`${moving.name} moved into ${onto.name}`, 'ok');
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
            await refresh(); fitZoom();
        } catch (e) { C.toast(e.message, 'bad'); refresh(); }
    }
    function showUnassigned() {
        const inAny = new Set(members.map(m => m.user_id));
        const list = people.filter(p => !inAny.has(p.id));
        const body = document.createElement('div');
        body.innerHTML = `<p style="margin:0 0 10px">These people are not in any department yet. Open a department and choose <b>Add people</b> to place them.</p><ul class="crm-list compact">${list.map(p => `<li>${avatar(p)}<div class="main"><b><a href="/employees/?id=${esc(p.id)}">${esc(nameOf(p))}</a></b><span>${esc([p.job_title, p.company].filter(Boolean).join(' · ') || p.email || '')}</span></div></li>`).join('')}</ul>`;
        C.modal({ title: `Not in a department (${list.length})`, body, actions: [{ label: 'Close', close: true }] });
    }

    /* ---------------------------------------------------------------- page */
    document.title = 'Company structure · WorkSuite';
    C.loading(view, 'Loading the company structure…');
    try { await load(); } catch (e) { return C.errorState(view, C.friendly(e), () => location.reload()); }
    const canAddTop = mode === 'live' && (ctx.isAdmin || (ctx.isManager && myCompanies.length));
    const canSync = canAddTop;                           // same people may bring the chart up to date
    view.innerHTML = B.titleBar({ title: 'Company structure', createLabel: canAddTop ? 'Add department' : '' })
        + `<div class="b24-toolbar org-toolbar">
            <label class="org-search">${C.icon('search', 'sm')}<input type="search" data-q placeholder="Find a person or department" aria-label="Find a person or department"></label>
            <span class="org-hits" data-hits aria-live="polite"></span>
            <span class="grow"></span>
            <button type="button" class="emp-online-chip" data-unassigned hidden>Not in a department: <b>0</b></button>
            ${canSync ? `<button type="button" class="ws-btn sm" data-sync>${C.icon('refresh')}<span>Update from employee data</span></button>` : ''}
            <div class="org-zoom" role="group" aria-label="Zoom"><button type="button" data-zoom="-1" aria-label="Zoom out">−</button><span data-zoom-v>100%</span><button type="button" data-zoom="1" aria-label="Zoom in">+</button><button type="button" data-zoom="0" title="Fit to the screen" aria-label="Fit to the screen">⤢</button></div>
        </div>
        ${mode === 'legacy' ? `<div class="crm-notice org-note">${C.icon('lock')}<div><b>This chart is drawn from the company and department on each profile.</b><br>To edit departments, heads and who is in them, an administrator needs to run <code>supabase-b24-migration.sql</code> in Supabase → SQL Editor.</div></div>` : ''}
        ${mode === 'empty' ? `<div class="crm-notice org-note">${C.icon('users')}<div><b>The company structure has not been set up yet.</b><br>This chart is drawn from the company and department on each profile.${ctx.isAdmin ? '' : ' An administrator can turn it into an editable structure.'}</div>${ctx.isAdmin ? '<button type="button" class="ws-btn primary" data-seed style="margin-left:auto">Set it up</button>' : ''}</div>` : ''}
        <div class="org-wrap" data-wrap><div class="org" data-org></div></div>`;
    render();
    fitHeight();
    fitZoom();
    window.addEventListener('resize', C.debounce(fitHeight, 150));
    const wrap = view.querySelector('[data-wrap]');
    const create = view.querySelector('[data-create]');
    if (create) create.addEventListener('click', () => {
        const top = depts.filter(d => canManage(d) && d.company && myCompanies.includes(d.company) && (!d.parent_id || !depts.find(x => x.id === d.parent_id && x.company)));
        addDept(ctx.isAdmin ? null : (top[0] || null));
    });
    const seed = view.querySelector('[data-seed]'); if (seed) seed.addEventListener('click', seedFromProfiles);
    const syncBtn = view.querySelector('[data-sync]'); if (syncBtn) syncBtn.addEventListener('click', syncFromProfiles);
    wireDrag(view.querySelector('[data-wrap]'));
    view.querySelector('[data-unassigned]').addEventListener('click', showUnassigned);
    view.querySelector('[data-q]').addEventListener('input', C.debounce(e => { query = e.target.value.trim(); render(); }, 250));
    view.querySelector('.org-zoom').addEventListener('click', e => {
        const b = e.target.closest('[data-zoom]'); if (!b) return;
        const dir = Number(b.dataset.zoom);
        if (!dir) return fitZoom();
        const i = ZOOMS.findIndex(z => z >= zoom - 0.001);
        zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))];
        applyZoom();
    });
    wrap.addEventListener('click', e => {
        const tg = e.target.closest('[data-toggle]');
        const node = e.target.closest('.org-node[data-dept]');
        if (!node) return;
        const d = depts.find(x => x.id === node.dataset.dept); if (!d) return;
        if (tg) { e.stopPropagation(); if (collapsed.has(d.id)) collapsed.delete(d.id); else collapsed.add(d.id); saveCollapsed(); return render(); }
        const mb = e.target.closest('[data-dept-menu]');
        if (mb) { e.stopPropagation(); return C.menu(mb, deptMenu(d)); }
        if (panMoved) return;
        openDept(d);
    });
    wrap.addEventListener('keydown', e => {
        const node = e.target.closest('.org-node[data-dept]');
        if (node && e.target === node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); const d = depts.find(x => x.id === node.dataset.dept); if (d) openDept(d); }
    });
    // Drag the background to move around a large chart.
    let panMoved = false;
    wrap.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest('button, a, input')) return;
        const x0 = e.clientX, y0 = e.clientY, l0 = wrap.scrollLeft, t0 = wrap.scrollTop;
        panMoved = false;
        const move = ev => {
            if (!panMoved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
            panMoved = true; wrap.classList.add('panning');
            wrap.scrollLeft = l0 - (ev.clientX - x0); wrap.scrollTop = t0 - (ev.clientY - y0);
        };
        const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); wrap.classList.remove('panning'); setTimeout(() => { panMoved = false; }, 0); };
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
    const focus = C.param('dept');
    if (focus) {
        ancestors(focus).forEach(id => collapsed.delete(id));
        render();
        const el = view.querySelector(`[data-dept="${CSS.escape(focus)}"]`);
        if (el) { zoom = 1; applyZoom(); el.classList.add('hit'); el.scrollIntoView({ block: 'center', inline: 'center' }); }
    }
})();
