/* ============================================================================
   WorkSuite — one Kanban implementation for every board

   Used by Deals (columns = pipeline stages), Boards, Tasks (columns = task
   statuses) and the project board. Pointer drag-and-drop with a keyboard
   fallback (space to pick up, arrows to move, enter to drop, escape to cancel).

       const board = WSKanban.mount(container, {
           columns: [{ id, name, color, count?, sum?, wipLimit?, collapsed? }],
           cards:   [{ id, columnId, position, ...anything }],
           renderCard(card) -> html string (inner of .kb-card),
           onMove({ card, fromColumnId, toColumnId, position, before, after }) -> Promise (throw to revert),
           onCardClick(card, event), onAddCard(columnId), onColumnMenu(column, anchorEl),
           canDrag(card) -> bool, emptyText
       });
       board.update({ columns, cards })   // re-render with new data
       board.destroy()
   Positions are fractional (WSCrmLogic.positionBetween) so a move touches
   one row.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSKanban) return;
    const L = window.WSCrmLogic;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function mount(container, opts) {
        const st = { columns: opts.columns || [], cards: opts.cards || [], drag: null, kb: null, collapsed: new Set() };
        container.classList.add('kb-board');
        container.setAttribute('role', 'list');

        function cardsIn(colId) { return st.cards.filter(c => c.columnId === colId).sort((a, b) => (a.position || 0) - (b.position || 0)); }
        function render() {
            container.innerHTML = st.columns.map(col => {
                const cards = cardsIn(col.id);
                const over = col.wipLimit && cards.length > col.wipLimit;
                const collapsed = st.collapsed.has(col.id);
                return `<section class="kb-col${collapsed ? ' collapsed' : ''}" data-col="${esc(col.id)}" role="listitem" aria-label="${esc(col.name)}">
                    <header class="kb-col-head"${col.hex && /^#[0-9a-f]{3,8}$/i.test(col.hex) ? ` style="--kb-color:${col.hex}"` : ''}>
                        ${col.color ? `<span class="crm-dot ${esc(col.color)}"></span>` : ''}
                        <span class="nm" title="${esc(col.name)}">${esc(col.name)}</span>
                        <span class="n${over ? ' over' : ''}" title="${over ? 'Over the WIP limit' : ''}">${cards.length}${col.wipLimit ? '/' + col.wipLimit : ''}</span>
                        ${col.sum != null ? `<span class="sum">${esc(col.sum)}</span>` : ''}
                        <button type="button" class="more" data-colmenu aria-label="Column options">⋯</button>
                    </header>
                    <div class="kb-cards" data-cards="${esc(col.id)}">
                        ${cards.length ? cards.map(c => cardHtml(c)).join('') : `<div class="kb-empty">${esc(opts.emptyText || 'Nothing here')}</div>`}
                    </div>
                    ${opts.onAddCard ? `<button type="button" class="ws-btn sm ghost kb-add" data-add="${esc(col.id)}"><span class="ic ic-plus"></span><span>Add</span></button>` : ''}
                </section>`;
            }).join('');
        }
        function cardHtml(c) {
            const draggable = !opts.canDrag || opts.canDrag(c);
            return `<article class="kb-card" data-card="${esc(c.id)}" tabindex="0" ${draggable ? 'draggable="true"' : 'data-locked="1"'} aria-grabbed="false" role="button">${opts.renderCard(c)}${draggable ? '<span class="grip" aria-hidden="true">⋮⋮</span>' : ''}</article>`;
        }
        function cardEl(id) { return container.querySelector(`.kb-card[data-card="${CSS.escape(String(id))}"]`); }
        function card(id) { return st.cards.find(c => String(c.id) === String(id)); }

        /* ---- pointer drag (HTML5 DnD; works with mouse and most touch via pointer fallback below) ---- */
        let placeholder = null;
        function ensurePlaceholder() { if (!placeholder) { placeholder = document.createElement('div'); placeholder.className = 'kb-placeholder'; } return placeholder; }
        function positionPlaceholder(listEl, clientY) {
            const cards = Array.from(listEl.querySelectorAll('.kb-card:not(.dragging)'));
            const ph = ensurePlaceholder();
            const after = cards.find(el => clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
            const emptyEl = listEl.querySelector('.kb-empty'); if (emptyEl) emptyEl.remove();
            if (after) listEl.insertBefore(ph, after); else listEl.appendChild(ph);
        }
        async function drop(cardId, listEl) {
            const c = card(cardId); if (!c) return cleanup();
            const toCol = listEl.dataset.cards;
            const ph = placeholder;
            const siblings = Array.from(listEl.children).filter(el => el !== ph && el.classList.contains('kb-card') && el.dataset.card !== String(cardId));
            const idx = Array.from(listEl.children).indexOf(ph);
            const beforeEl = siblings.filter(el => Array.from(listEl.children).indexOf(el) < idx).pop();
            const afterEl = siblings.find(el => Array.from(listEl.children).indexOf(el) > idx);
            const before = beforeEl ? card(beforeEl.dataset.card) : null, after = afterEl ? card(afterEl.dataset.card) : null;
            const position = L.positionBetween(before ? before.position : null, after ? after.position : null);
            const from = c.columnId;
            if (from === toCol && before === null && after === null && cardsIn(toCol).length === 1) return cleanup();
            const snapshot = { columnId: c.columnId, position: c.position };
            c.columnId = toCol; c.position = position;
            cleanup(); render();
            try { if (opts.onMove) await opts.onMove({ card: c, fromColumnId: from, toColumnId: toCol, position, before, after }); }
            catch (e) { c.columnId = snapshot.columnId; c.position = snapshot.position; render(); if (window.WSShell) WSShell.toast(e.message || 'Could not move the card', 'bad'); }
        }
        function cleanup() {
            if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
            container.querySelectorAll('.kb-col.over').forEach(el => el.classList.remove('over'));
            container.querySelectorAll('.kb-card.dragging').forEach(el => el.classList.remove('dragging'));
            st.drag = null;
        }
        container.addEventListener('dragstart', e => {
            const el = e.target.closest('.kb-card[draggable="true"]'); if (!el) return;
            st.drag = { id: el.dataset.card };
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', el.dataset.card); } catch (err) { /* IE */ }
        });
        container.addEventListener('dragover', e => {
            if (!st.drag) return;
            const list = e.target.closest('.kb-cards'); if (!list) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            container.querySelectorAll('.kb-col.over').forEach(el => el.classList.remove('over'));
            list.closest('.kb-col').classList.add('over');
            positionPlaceholder(list, e.clientY);
        });
        container.addEventListener('drop', e => { if (!st.drag) return; const list = e.target.closest('.kb-cards'); if (!list || !placeholder) return cleanup(); e.preventDefault(); drop(st.drag.id, list); });
        container.addEventListener('dragend', () => { if (st.drag) cleanup(); });

        /* ---- touch: long-press then move (HTML5 DnD is unreliable on phones) ---- */
        let touch = null;
        container.addEventListener('touchstart', e => {
            const el = e.target.closest('.kb-card[draggable="true"]'); if (!el || e.touches.length !== 1) return;
            const t = e.touches[0];
            touch = { el, id: el.dataset.card, x: t.clientX, y: t.clientY, timer: setTimeout(() => { touch.active = true; st.drag = { id: touch.id }; el.classList.add('dragging'); if (navigator.vibrate) navigator.vibrate(10); }, 320) };
        }, { passive: true });
        container.addEventListener('touchmove', e => {
            if (!touch) return;
            const t = e.touches[0];
            if (!touch.active) { if (Math.abs(t.clientX - touch.x) > 8 || Math.abs(t.clientY - touch.y) > 8) { clearTimeout(touch.timer); touch = null; } return; }
            e.preventDefault();
            const under = document.elementFromPoint(t.clientX, t.clientY);
            const list = under && under.closest('.kb-cards');
            if (list) { container.querySelectorAll('.kb-col.over').forEach(el => el.classList.remove('over')); list.closest('.kb-col').classList.add('over'); positionPlaceholder(list, t.clientY); }
            // edge auto-scroll
            const r = container.getBoundingClientRect();
            if (t.clientX > r.right - 40) container.scrollLeft += 8; else if (t.clientX < r.left + 40) container.scrollLeft -= 8;
        }, { passive: false });
        container.addEventListener('touchend', () => {
            if (!touch) return;
            clearTimeout(touch.timer);
            if (touch.active && placeholder && placeholder.parentNode) drop(touch.id, placeholder.parentNode); else cleanup();
            touch = null;
        });

        /* ---- keyboard: space picks up, arrows move, enter drops ---- */
        container.addEventListener('keydown', async e => {
            const el = e.target.closest('.kb-card'); if (!el) return;
            const id = el.dataset.card; const c = card(id); if (!c) return;
            if (e.key === ' ' && !st.kb && el.getAttribute('draggable') === 'true') { e.preventDefault(); st.kb = { id, columnId: c.columnId, index: cardsIn(c.columnId).findIndex(x => x.id === c.id) }; el.setAttribute('aria-grabbed', 'true'); return; }
            if (e.key === 'Enter' && !st.kb) { e.preventDefault(); if (opts.onCardClick) opts.onCardClick(c, e); return; }
            if (!st.kb || st.kb.id !== id) return;
            const colIdx = st.columns.findIndex(x => x.id === st.kb.columnId);
            if (e.key === 'Escape') { e.preventDefault(); st.kb = null; render(); const back = cardEl(id); if (back) back.focus(); return; }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const next = st.columns[colIdx + (e.key === 'ArrowRight' ? 1 : -1)]; if (!next) return;
                st.kb.columnId = next.id; st.kb.index = cardsIn(next.id).filter(x => x.id !== c.id).length;
                previewKb(c); return;
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const n = cardsIn(st.kb.columnId).filter(x => x.id !== c.id).length;
                st.kb.index = Math.max(0, Math.min(n, st.kb.index + (e.key === 'ArrowDown' ? 1 : -1)));
                previewKb(c); return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const others = cardsIn(st.kb.columnId).filter(x => x.id !== c.id);
                const before = others[st.kb.index - 1] || null, after = others[st.kb.index] || null;
                const position = L.positionBetween(before ? before.position : null, after ? after.position : null);
                const from = c.columnId, to = st.kb.columnId;
                const snapshot = { columnId: c.columnId, position: c.position };
                c.columnId = to; c.position = position; st.kb = null; render();
                const back = cardEl(id); if (back) back.focus();
                try { if (opts.onMove && (from !== to || snapshot.position !== position)) await opts.onMove({ card: c, fromColumnId: from, toColumnId: to, position, before, after }); }
                catch (err) { c.columnId = snapshot.columnId; c.position = snapshot.position; render(); if (window.WSShell) WSShell.toast(err.message || 'Could not move the card', 'bad'); }
            }
        });
        function previewKb(c) {
            const el = cardEl(c.id); if (!el) return;
            const list = container.querySelector(`.kb-cards[data-cards="${CSS.escape(String(st.kb.columnId))}"]`); if (!list) return;
            const others = Array.from(list.querySelectorAll('.kb-card')).filter(x => x.dataset.card !== String(c.id));
            const emptyEl = list.querySelector('.kb-empty'); if (emptyEl) emptyEl.remove();
            if (others[st.kb.index]) list.insertBefore(el, others[st.kb.index]); else list.appendChild(el);
            el.focus(); el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }

        /* ---- clicks ---- */
        container.addEventListener('click', e => {
            const add = e.target.closest('[data-add]'); if (add) { opts.onAddCard && opts.onAddCard(add.dataset.add); return; }
            const cm = e.target.closest('[data-colmenu]');
            if (cm) {
                const col = st.columns.find(x => String(x.id) === cm.closest('.kb-col').dataset.col);
                if (opts.onColumnMenu) return opts.onColumnMenu(col, cm, { toggleCollapse: () => api.toggleCollapse(col.id), collapsed: st.collapsed.has(col.id) });
                return api.toggleCollapse(col.id);
            }
            const el = e.target.closest('.kb-card');
            if (el && opts.onCardClick && !st.drag) { const c = card(el.dataset.card); if (c) opts.onCardClick(c, e); }
        });

        /* ---- size: in the Bitrix24 layout the board takes the rest of the screen and only the
               columns scroll (no second scrollbar on the page); on phones the columns grow and
               only the page scrolls ---- */
        let fitTimer = null;
        function fit() {
            if (!document.body.classList.contains('ws-b24') || !container.isConnected) return;
            if (window.matchMedia('(max-width: 640px)').matches) { container.classList.remove('kb-fit'); container.style.height = ''; return; }
            const scrollers = [document.scrollingElement];
            for (let p = container.parentElement; p && p !== document.body; p = p.parentElement) { const oy = getComputedStyle(p).overflowY; if (oy === 'auto' || oy === 'scroll') scrollers.push(p); }
            container.classList.add('kb-fit');
            container.style.height = window.innerHeight + 'px';
            for (let i = 0; i < 4; i++) {
                const extra = Math.max(...scrollers.map(s => s.scrollHeight - s.clientHeight));
                if (extra <= 1) break;
                const next = Math.max(320, container.offsetHeight - extra);
                if (next === container.offsetHeight) break;
                container.style.height = next + 'px';
            }
        }
        const onResize = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 150); };
        window.addEventListener('resize', onResize);

        const api = {
            update(next) { if (next.columns) st.columns = next.columns; if (next.cards) st.cards = next.cards; st.kb = null; render(); fit(); },
            toggleCollapse(colId) { if (st.collapsed.has(colId)) st.collapsed.delete(colId); else st.collapsed.add(colId); render(); },
            cards: () => st.cards, columns: () => st.columns,
            destroy() { window.removeEventListener('resize', onResize); clearTimeout(fitTimer); container.style.height = ''; container.classList.remove('kb-fit'); container.innerHTML = ''; container.classList.remove('kb-board'); },
        };
        render();
        fit();
        requestAnimationFrame(fit);                 // again once fonts and the rest of the page have laid out
        return api;
    }

    window.WSKanban = { mount };
})();
