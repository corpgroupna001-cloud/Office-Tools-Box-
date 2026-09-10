/* ============================================================================
   WorkSuite — CRM / work business logic (pure, no DOM, no Supabase)

   Shared by the browser (window.WSCrmLogic) and Node (require) in the same
   UMD shape as company-config.js, so the rules used to render a page are the
   rules the unit tests exercise. Nothing in here touches the network.

   Conventions
     - Calendar dates are 'YYYY-MM-DD' strings in IST (the app's timezone).
     - Instants are ISO strings / Date objects (UTC inside).
     - Money is rounded half-up to 2 decimals, matching the Postgres round().
   ============================================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WSCrmLogic = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const IST = 'Asia/Kolkata';
  const IST_OFFSET = '+05:30';
  const DAY_MS = 86400000;

  /* ---------------------------------------------------------------- dates */
  const _fmtIso = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });
  const _fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });

  /** 'YYYY-MM-DD' of an instant, as seen on an Indian wall clock. */
  function istDate(d) {
    const date = d instanceof Date ? d : new Date(d || Date.now());
    if (isNaN(date)) return null;
    return _fmtIso.format(date);
  }
  /** 'HH:MM' (24h) of an instant in IST. */
  function istTime(d) {
    const date = d instanceof Date ? d : new Date(d || Date.now());
    if (isNaN(date)) return null;
    return _fmtTime.format(date).replace(/^24/, '00');
  }
  function todayIST(now) { return istDate(now || new Date()); }

  /** Days since epoch for a 'YYYY-MM-DD' string (timezone-free arithmetic). */
  function dayNumber(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
  }
  function fromDayNumber(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }
  function addDays(s, n) { const d = dayNumber(s); return d == null ? null : fromDayNumber(d + n); }
  function daysBetween(a, b) { const x = dayNumber(a), y = dayNumber(b); return x == null || y == null ? null : y - x; }
  /** ISO weekday 1 = Monday … 7 = Sunday for a 'YYYY-MM-DD'. */
  function isoWeekday(s) { const n = dayNumber(s); return n == null ? null : ((n + 3) % 7) + 1; } // 1970-01-01 was a Thursday (4)

  /** The instant at which an IST wall-clock date/time happens, as ISO. */
  function isoAtIST(dateStr, timeStr) {
    if (!dateStr) return null;
    const t = timeStr && /^\d{2}:\d{2}/.test(timeStr) ? timeStr.slice(0, 5) : '00:00';
    const d = new Date(`${dateStr}T${t}:00${IST_OFFSET}`);
    return isNaN(d) ? null : d.toISOString();
  }
  /** End of an IST day (23:59:59.999) as ISO. */
  function isoEndOfIST(dateStr) {
    const d = new Date(`${dateStr}T23:59:59.999${IST_OFFSET}`);
    return isNaN(d) ? null : d.toISOString();
  }

  /**
   * Date-range presets used by dashboards and lists, inclusive on both ends.
   *   today | week (Mon–Sun) | month | quarter | year | last7 | last30 | custom
   */
  function dateRange(preset, now, custom) {
    const today = todayIST(now);
    const n = dayNumber(today);
    switch (preset) {
      case 'today': return { from: today, to: today };
      case 'week': {
        const start = n - (isoWeekday(today) - 1);
        return { from: fromDayNumber(start), to: fromDayNumber(start + 6) };
      }
      case 'month': {
        const [y, m] = today.split('-').map(Number);
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(last).padStart(2, '0')}` };
      }
      case 'quarter': {
        const [y, m] = today.split('-').map(Number);
        const q0 = Math.floor((m - 1) / 3) * 3 + 1;           // 1, 4, 7, 10
        const lastM = q0 + 2;
        const last = new Date(Date.UTC(y, lastM, 0)).getUTCDate();
        return { from: `${y}-${String(q0).padStart(2, '0')}-01`, to: `${y}-${String(lastM).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
      }
      case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
      case 'last7': return { from: fromDayNumber(n - 6), to: today };
      case 'last30': return { from: fromDayNumber(n - 29), to: today };
      case 'custom': {
        const from = custom && custom.from, to = custom && custom.to;
        if (dayNumber(from) == null || dayNumber(to) == null) return null;
        return dayNumber(from) <= dayNumber(to) ? { from, to } : { from: to, to: from };
      }
      default: return null;
    }
  }
  /** ISO bounds [fromIso, toIso) for a date range, for timestamptz filters. */
  function rangeToIso(range) {
    if (!range) return null;
    return { from: isoAtIST(range.from, '00:00'), to: isoAtIST(addDays(range.to, 1), '00:00') };
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const _parts = new Intl.DateTimeFormat('en-US', { timeZone: IST, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  /** { yyyy, mm, dd, hh, min, ampm } of an instant in IST; assembled by hand so ICU versions cannot change the output. */
  function istFields(d) {
    const o = {};
    _parts.formatToParts(d).forEach(p => { o[p.type] = p.value; });
    return { yyyy: o.year, mm: Number(o.month), dd: String(o.day).padStart(2, '0'), hh: o.hour, min: o.minute, ampm: String(o.dayPeriod || '').toLowerCase() };
  }
  function toInstant(v) {
    if (!v) return null;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T12:00:00${IST_OFFSET}`) : new Date(v);
    return isNaN(d) ? null : d;
  }
  /** '05 Sep 2026' for a date string or instant; '' for nothing. */
  function fmtDate(v, opts) {
    const d = toInstant(v); if (!d) return '';
    const f = istFields(d);
    return opts && opts.short ? `${f.dd} ${MONTHS[f.mm - 1]}` : `${f.dd} ${MONTHS[f.mm - 1]} ${f.yyyy}`;
  }
  function fmtTime(v) { const d = toInstant(v); if (!d) return ''; const f = istFields(d); return `${f.hh}:${f.min} ${f.ampm}`; }
  function fmtDateTime(v) { const d = toInstant(v); if (!d) return ''; return `${fmtDate(d)}, ${fmtTime(d)}`; }

  /** 'just now', '5m ago', '3h ago', 'yesterday', '4d ago', else a date. */
  function fmtRelative(v, now) {
    if (!v) return '';
    const d = new Date(v); if (isNaN(d)) return '';
    const diff = ((now ? new Date(now) : new Date()) - d) / 1000;
    if (diff < 45) return 'just now';
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    const days = daysBetween(istDate(d), istDate(now || new Date()));
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return fmtDate(d);
  }

  /* ---------------------------------------------------------------- money */
  /** Half-up rounding to 2 places without binary drift (0.125 -> 0.13). */
  function round2(n) {
    const x = Number(n) || 0;
    return Math.round((Math.abs(x) + Number.EPSILON) * 100) / 100 * Math.sign(x || 1);
  }
  function money(n, currency, opts) {
    const cur = currency || 'INR';
    const v = Number(n) || 0;
    try {
      return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', {
        style: 'currency', currency: cur, maximumFractionDigits: opts && opts.whole ? 0 : 2, minimumFractionDigits: opts && opts.whole ? 0 : 2,
      }).format(v);
    } catch (e) { return `${cur} ${v.toFixed(2)}`; }
  }
  /** Compact money for tiles: ₹1.2L / ₹3.4Cr / $12.5k. */
  function moneyShort(n, currency) {
    const cur = currency || 'INR';
    const v = Number(n) || 0;
    const a = Math.abs(v);
    const sym = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur + ' ';
    const s = v < 0 ? '-' : '';
    const one = x => String(x.toFixed(1)).replace(/\.0$/, '');
    if (cur === 'INR') {
      if (a >= 1e7) return `${s}${sym}${one(a / 1e7)}Cr`;
      if (a >= 1e5) return `${s}${sym}${one(a / 1e5)}L`;
    } else if (a >= 1e6) return `${s}${sym}${one(a / 1e6)}M`;
    if (a >= 1e3) return `${s}${sym}${one(a / 1e3)}k`;
    return `${s}${sym}${a.toFixed(0)}`;
  }

  /* ------------------------------------------------------------- invoices */
  /** One line's numbers, exactly as the invoice_items trigger computes them. */
  function invoiceLine(item) {
    const qty = Math.max(0, Number(item.quantity) || 0);
    const price = Math.max(0, Number(item.unit_price) || 0);
    const disc = Math.min(100, Math.max(0, Number(item.discount_pct) || 0));
    const tax = Math.min(100, Math.max(0, Number(item.tax_rate) || 0));
    const line_subtotal = round2(qty * price);
    const line_discount = round2(line_subtotal * disc / 100);
    const line_tax = round2((line_subtotal - line_discount) * tax / 100);
    const line_total = round2(line_subtotal - line_discount + line_tax);
    return { line_subtotal, line_discount, line_tax, line_total };
  }
  /** Header totals from lines and payments, as invoice_recalc() does. */
  function invoiceTotals(items, payments) {
    const lines = (items || []).map(invoiceLine);
    const sum = k => round2(lines.reduce((a, l) => a + l[k], 0));
    const subtotal = sum('line_subtotal');
    const discount_total = sum('line_discount');
    const tax_total = sum('line_tax');
    const total = sum('line_total');
    const amount_paid = round2((payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0));
    return { subtotal, discount_total, tax_total, total, amount_paid, balance: round2(total - amount_paid) };
  }
  /** The status a reader should see right now (overdue is time-dependent). */
  function invoiceStatus(inv, today) {
    if (!inv) return 'draft';
    if (inv.status === 'draft' || inv.status === 'cancelled') return inv.status;
    const total = Number(inv.total) || 0, paid = Number(inv.amount_paid) || 0;
    if (total > 0 && paid >= total) return 'paid';
    if (paid > 0) return 'partially_paid';
    const t = today || todayIST();
    if (inv.due_date && dayNumber(inv.due_date) < dayNumber(t)) return 'overdue';
    return 'sent';
  }
  const INVOICE_STATUS = {
    draft: { label: 'Draft', color: 'weekoff' },
    sent: { label: 'Sent', color: 'pending' },
    partially_paid: { label: 'Partially paid', color: 'late' },
    paid: { label: 'Paid', color: 'present' },
    overdue: { label: 'Overdue', color: 'absent' },
    cancelled: { label: 'Cancelled', color: 'mute' },
  };
  /** Which invoice actions make sense from a status. */
  function invoiceActions(status) {
    const s = status || 'draft';
    return {
      edit: s === 'draft',
      send: s === 'draft',
      pay: ['sent', 'partially_paid', 'overdue'].includes(s),
      cancel: s !== 'cancelled' && s !== 'paid',
      cancelPaid: s === 'paid',
      duplicate: true,
      print: s !== 'draft' || true,
      revertToDraft: s === 'sent' || s === 'overdue',
    };
  }

  /* ---------------------------------------------------------------- deals */
  /** Pipeline numbers from real deals: counts, open value, weighted value, win rate. */
  function pipelineMetrics(deals) {
    const m = { open_count: 0, won_count: 0, lost_count: 0, pipeline_value: 0, weighted_value: 0, won_value: 0, lost_value: 0, win_rate: null, by_stage: {} };
    (deals || []).forEach(d => {
      if (d.archived_at) return;
      const v = Number(d.value) || 0;
      if (d.status === 'won') { m.won_count++; m.won_value += v; }
      else if (d.status === 'lost') { m.lost_count++; m.lost_value += v; }
      else {
        m.open_count++; m.pipeline_value += v;
        m.weighted_value += v * (Math.min(100, Math.max(0, Number(d.probability) || 0)) / 100);
        const k = d.stage_id || 'none';
        m.by_stage[k] = m.by_stage[k] || { count: 0, value: 0 };
        m.by_stage[k].count++; m.by_stage[k].value += v;
      }
    });
    const closed = m.won_count + m.lost_count;
    m.win_rate = closed ? Math.round((m.won_count / closed) * 100) : null;
    m.pipeline_value = round2(m.pipeline_value); m.weighted_value = round2(m.weighted_value);
    m.won_value = round2(m.won_value); m.lost_value = round2(m.lost_value);
    return m;
  }
  /** Sort stages by position; find the first open stage of a pipeline. */
  function stagesOf(stages, pipelineId) {
    return (stages || []).filter(s => !pipelineId || s.pipeline_id === pipelineId).slice().sort((a, b) => a.position - b.position);
  }
  function firstOpenStage(stages, pipelineId) {
    return stagesOf(stages, pipelineId).find(s => !s.is_won && !s.is_lost) || null;
  }
  /** Position for a card dropped between two neighbours (fractional ordering). */
  function positionBetween(before, after) {
    const a = before == null ? null : Number(before), b = after == null ? null : Number(after);
    if (a == null && b == null) return 1000;
    if (a == null) return b - 1000;
    if (b == null) return a + 1000;
    return (a + b) / 2;
  }

  /* ---------------------------------------------------------------- leads */
  function leadMetrics(leads, statuses) {
    const closedKeys = new Set((statuses || []).filter(s => s.is_closed).map(s => s.key));
    const m = { total: 0, open: 0, qualified: 0, converted: 0, unqualified: 0, conversion_rate: null, by_status: {} };
    (leads || []).forEach(l => {
      if (l.archived_at) return;
      m.total++;
      m.by_status[l.status] = (m.by_status[l.status] || 0) + 1;
      if (l.status === 'converted' || l.converted_at) m.converted++;
      else if (l.status === 'qualified') { m.qualified++; m.open++; }
      else if (l.status === 'unqualified') m.unqualified++;
      else if (!closedKeys.has(l.status)) m.open++;
    });
    m.conversion_rate = m.total ? Math.round((m.converted / m.total) * 100) : null;
    return m;
  }
  function normalizeEmail(e) { return String(e || '').trim().toLowerCase() || null; }
  /** Digits only, keeping a leading +; drops an Indian trunk 0 or +91 for matching. */
  function normalizePhone(p) {
    let s = String(p || '').replace(/[^\d+]/g, '');
    if (!s) return null;
    s = s.replace(/^\+?91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
    return s.replace(/^\+/, '') || null;
  }
  /** Contacts that look like the same person (email or phone match). */
  function findDuplicateContacts(candidate, contacts, excludeId) {
    const emails = [candidate.email, candidate.email2].map(normalizeEmail).filter(Boolean);
    const phones = [candidate.phone, candidate.phone2].map(normalizePhone).filter(Boolean);
    if (!emails.length && !phones.length) return [];
    return (contacts || []).filter(c => {
      if (excludeId && c.id === excludeId) return false;
      if (c.status === 'archived') return false;
      const ce = [c.email, c.email2].map(normalizeEmail).filter(Boolean);
      const cp = [c.phone, c.phone2].map(normalizePhone).filter(Boolean);
      return ce.some(e => emails.includes(e)) || cp.some(p => phones.includes(p));
    });
  }
  function splitName(full) {
    const s = String(full || '').trim().replace(/\s+/g, ' ');
    if (!s) return { first_name: '', last_name: '' };
    const i = s.indexOf(' ');
    return i < 0 ? { first_name: s, last_name: '' } : { first_name: s.slice(0, i), last_name: s.slice(i + 1) };
  }
  /** What "Convert lead" will do, so the dialog can say it before it happens. */
  function planLeadConversion(lead, contacts, opts) {
    const dupes = findDuplicateContacts({ email: lead.email, phone: lead.phone }, contacts);
    const linkTo = (opts && opts.contactId) || (dupes[0] && dupes[0].id) || null;
    const name = splitName(lead.name);
    return {
      contact: linkTo ? { action: 'link', id: linkTo } : { action: 'create', ...name, organization: lead.organization || null, email: lead.email || null, phone: lead.phone || null },
      deal: opts && opts.createDeal === false ? null : {
        action: 'create',
        title: (opts && opts.dealTitle) || `${lead.name} deal`,
        value: opts && opts.dealValue != null ? Number(opts.dealValue) : (Number(lead.estimated_value) || 0),
      },
      duplicates: dupes,
    };
  }

  /* ---------------------------------------------------------------- tasks */
  /** completed | overdue | today | soon (≤3 days) | upcoming | none */
  function taskDueState(task, today) {
    if (!task) return 'none';
    if (task.completed_at) return 'completed';
    if (!task.due_date) return 'none';
    const diff = daysBetween(today || todayIST(), task.due_date);
    if (diff == null) return 'none';
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff <= 3) return 'soon';
    return 'upcoming';
  }
  function taskCounts(tasks, today) {
    const c = { total: 0, open: 0, completed: 0, overdue: 0, due_today: 0, due_soon: 0, blocked: 0 };
    (tasks || []).forEach(t => {
      if (t.archived_at) return;
      c.total++;
      const st = taskDueState(t, today);
      if (st === 'completed') { c.completed++; return; }
      c.open++;
      if (t.status === 'blocked') c.blocked++;
      if (st === 'overdue') c.overdue++;
      else if (st === 'today') c.due_today++;
      else if (st === 'soon') c.due_soon++;
    });
    return c;
  }
  /** The number on the Tasks nav badge: overdue + due today, open only. */
  function taskBadgeCount(tasks, today) { const c = taskCounts(tasks, today); return c.overdue + c.due_today; }
  /** Project progress derived from its tasks (subtasks count too). */
  function projectProgress(tasks) {
    const live = (tasks || []).filter(t => !t.archived_at);
    const done = live.filter(t => !!t.completed_at).length;
    return { total: live.length, done, pct: live.length ? Math.round((done / live.length) * 100) : 0 };
  }
  const PRIORITY = {
    low: { label: 'Low', color: 'weekoff', rank: 0 },
    normal: { label: 'Normal', color: 'pending', rank: 1 },
    high: { label: 'High', color: 'late', rank: 2 },
    urgent: { label: 'Urgent', color: 'absent', rank: 3 },
  };
  const PROJECT_STATUS = {
    planning: { label: 'Planning', color: 'weekoff' },
    active: { label: 'Active', color: 'present' },
    on_hold: { label: 'On hold', color: 'late' },
    completed: { label: 'Completed', color: 'pending' },
    cancelled: { label: 'Cancelled', color: 'mute' },
  };
  const DEAL_STATUS = {
    open: { label: 'Open', color: 'pending' },
    won: { label: 'Won', color: 'present' },
    lost: { label: 'Lost', color: 'absent' },
  };
  const EVENT_TYPE = {
    meeting: { label: 'Meeting', color: 'pending' },
    call: { label: 'Call', color: 'leave' },
    follow_up: { label: 'Follow-up', color: 'late' },
    deadline: { label: 'Deadline', color: 'absent' },
    reminder: { label: 'Reminder', color: 'holiday' },
    other: { label: 'Other', color: 'weekoff' },
  };

  /* ---------------------------------------------------------- permissions */
  /**
   * user = { id, role }  role: employee | manager | admin
   * record = { owner_id, created_by, assignee_id, manager_id, member_ids?, assignee_ids? }
   */
  function isManager(user) { return !!user && (user.role === 'manager' || user.role === 'admin'); }
  function isAdmin(user) { return !!user && user.role === 'admin'; }
  function canEdit(record, user) {
    if (!record || !user) return false;
    if (isManager(user)) return true;
    const me = user.id;
    if (!me) return false;
    if (record.owner_id === me || record.created_by === me || record.assignee_id === me || record.manager_id === me) return true;
    if (Array.isArray(record.member_ids) && record.member_ids.includes(me)) return true;
    if (Array.isArray(record.assignee_ids) && record.assignee_ids.includes(me)) return true;
    return false;
  }
  function canDelete(record, user) {
    if (!record || !user) return false;
    return isManager(user) || record.created_by === user.id;
  }
  function canFinance(user) { return isManager(user); }
  /** Which employee records a viewer may see private HR data for. */
  function canSeePrivate(viewer, target) {
    if (!viewer || !target) return false;
    if (viewer.id === target.id) return true;
    if (isAdmin(viewer)) return true;
    if (target.manager_id === viewer.id) return true;
    if (!isManager(viewer)) return false;
    {
      const mine = [viewer.company, viewer.company2].filter(Boolean);
      return mine.includes(target.company) || !!(target.company2 && mine.includes(target.company2));
    }
    return false;
  }

  /* --------------------------------------------------------------- search */
  /** Same scoring the command palette uses: exact > prefix > substring > subsequence. */
  function fuzzyScore(query, text) {
    if (!query) return 1;
    const q = String(query).toLowerCase(), t = String(text || '').toLowerCase();
    if (!t) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (t.includes(q)) return 50;
    let qi = 0, streak = 0, best = 0;
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] === q[qi]) { qi++; streak++; best = Math.max(best, streak); } else streak = 0;
    }
    return qi === q.length ? 10 + best : 0;
  }
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function parseTags(s) {
    if (Array.isArray(s)) return s.map(x => String(x).trim()).filter(Boolean);
    return String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  }
  /** Turn a file name into something safe for a storage path. */
  function safeFileName(name) {
    const base = String(name || 'file').replace(/^.*[\\/]/, '');
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+/, '');
    return (cleaned || 'file').slice(0, 120);
  }
  /** Client-side allow-list for uploads; the sniffed type wins over the declared one. */
  const ALLOWED_DOC_TYPES = {
    'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'],
    'image/svg+xml': ['svg'], 'text/plain': ['txt', 'md', 'log'], 'text/csv': ['csv'],
    'application/msword': ['doc'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.ms-excel': ['xls'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'application/vnd.ms-powerpoint': ['ppt'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
    'application/zip': ['zip'], 'application/x-zip-compressed': ['zip'], 'application/json': ['json'],
    'video/mp4': ['mp4'], 'audio/mpeg': ['mp3'], 'audio/wav': ['wav'], 'video/webm': ['webm'],
  };
  const MAX_DOC_BYTES = 50 * 1024 * 1024;
  /** Sniff a type from the first bytes (magic numbers) for the formats that matter. */
  function sniffMime(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const hex = Array.from(b.slice(0, 12)).map(x => x.toString(16).padStart(2, '0')).join('');
    if (hex.startsWith('25504446')) return 'application/pdf';
    if (hex.startsWith('89504e47')) return 'image/png';
    if (hex.startsWith('ffd8ff')) return 'image/jpeg';
    if (hex.startsWith('47494638')) return 'image/gif';
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
    if (hex.startsWith('504b0304')) return 'application/zip';        // docx/xlsx/pptx are zips too
    if (hex.startsWith('d0cf11e0')) return 'application/msword';     // legacy Office container
    if (hex.startsWith('1a45dfa3')) return 'video/webm';
    if (hex.slice(8, 16) === '66747970') return 'video/mp4';
    return null;
  }
  /** Reject a file before uploading. Returns { ok, reason, mime }. */
  function validateUpload(file, sniffed) {
    const size = Number(file.size) || 0;
    if (size <= 0) return { ok: false, reason: 'The file is empty.' };
    if (size > MAX_DOC_BYTES) return { ok: false, reason: 'Files must be 50 MB or smaller.' };
    const ext = String(file.name || '').toLowerCase().split('.').pop();
    const declared = String(file.type || '').toLowerCase();
    const zipLike = ['docx', 'xlsx', 'pptx', 'zip'];
    const officeLike = ['doc', 'xls', 'ppt'];
    const byExt = Object.entries(ALLOWED_DOC_TYPES).find(([, exts]) => exts.includes(ext));
    let mime = declared;
    if (sniffed) {
      // Office files are zip / OLE containers: the extension decides which one.
      if (sniffed === 'application/zip' && zipLike.includes(ext)) mime = (declared && ALLOWED_DOC_TYPES[declared]) ? declared : (byExt ? byExt[0] : sniffed);
      else if (sniffed === 'application/msword' && officeLike.includes(ext)) mime = (declared && ALLOWED_DOC_TYPES[declared]) ? declared : (byExt ? byExt[0] : sniffed);
      else mime = sniffed;
    } else if (!ALLOWED_DOC_TYPES[mime] && byExt) {
      mime = byExt[0];          // e.g. .md declared as text/markdown, .csv as application/vnd.ms-excel
    }
    if (!ALLOWED_DOC_TYPES[mime]) return { ok: false, reason: `"${ext || 'this'}" files are not allowed.` };
    if (ext && !ALLOWED_DOC_TYPES[mime].includes(ext)) {
      return { ok: false, reason: `The file content does not match its .${ext} extension.` };
    }
    return { ok: true, mime };
  }
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
    return `${(v / 1073741824).toFixed(2)} GB`;
  }

  /* ------------------------------------------------------------ activity */
  const ACTIVITY_LABELS = {
    'lead.created': 'created the lead', 'lead.assigned': 'assigned the lead', 'lead.status_changed': 'changed lead status',
    'lead.converted': 'converted the lead', 'contact.created': 'added the contact', 'contact.updated': 'updated the contact',
    'contact.assigned': 'assigned the contact', 'contact.status_changed': 'changed contact status',
    'deal.created': 'created the deal', 'deal.assigned': 'assigned the deal', 'deal.stage_changed': 'moved the deal',
    'deal.won': 'won the deal', 'deal.lost': 'lost the deal', 'deal.value_changed': 'changed the deal value',
    'task.created': 'created the task', 'task.assigned': 'assigned the task', 'task.completed': 'completed the task',
    'task.reopened': 'reopened the task', 'task.status_changed': 'changed task status', 'task.due_changed': 'changed the due date',
    'task.archived': 'archived the task', 'project.created': 'created the project', 'project.status_changed': 'changed project status',
    'project.member_added': 'added a member', 'project.archived': 'archived the project',
    'document.uploaded': 'uploaded a document', 'document.attached': 'attached a document',
    'event.scheduled': 'scheduled a meeting', 'event.rescheduled': 'rescheduled a meeting', 'event.cancelled': 'cancelled a meeting',
    'invoice.created': 'created an invoice', 'invoice.status_changed': 'changed invoice status', 'invoice.payment_recorded': 'recorded a payment',
    'note.added': 'added a note', 'call.logged': 'logged a call', 'email.logged': 'logged an email', 'meeting.logged': 'logged a meeting',
  };
  /** A sentence for one activity row, with the meaningful bit of meta. */
  function describeActivity(a) {
    const verb = ACTIVITY_LABELS[a.action] || a.action.replace(/[._]/g, ' ');
    const m = a.meta || {};
    let detail = '';
    if (a.action === 'deal.stage_changed' && m.from && m.to) detail = `${m.from} → ${m.to}`;
    else if (/status_changed$/.test(a.action) && m.from && m.to) detail = `${String(m.from).replace(/_/g, ' ')} → ${String(m.to).replace(/_/g, ' ')}`;
    else if (a.action === 'deal.value_changed') detail = `${money(m.from, m.currency)} → ${money(m.to, m.currency)}`;
    else if (a.action === 'invoice.payment_recorded') detail = money(m.amount, m.currency) + (m.method ? ` via ${m.method}` : '');
    else if (a.action === 'task.due_changed') detail = `${fmtDate(m.from) || 'none'} → ${fmtDate(m.to) || 'none'}`;
    else if (a.action === 'event.rescheduled') detail = `${fmtDateTime(m.from)} → ${fmtDateTime(m.to)}`;
    else if (a.action === 'note.added' && a.entity_label) detail = a.entity_label;
    return { verb, detail };
  }

  return {
    IST, IST_OFFSET,
    istDate, istTime, todayIST, dayNumber, fromDayNumber, addDays, daysBetween, isoWeekday, isoAtIST, isoEndOfIST,
    dateRange, rangeToIso, fmtDate, fmtDateTime, fmtTime, fmtRelative,
    round2, money, moneyShort,
    invoiceLine, invoiceTotals, invoiceStatus, invoiceActions, INVOICE_STATUS,
    pipelineMetrics, stagesOf, firstOpenStage, positionBetween,
    leadMetrics, normalizeEmail, normalizePhone, findDuplicateContacts, splitName, planLeadConversion,
    taskDueState, taskCounts, taskBadgeCount, projectProgress, PRIORITY, PROJECT_STATUS, DEAL_STATUS, EVENT_TYPE,
    isManager, isAdmin, canEdit, canDelete, canFinance, canSeePrivate,
    fuzzyScore, initials, parseTags, safeFileName, ALLOWED_DOC_TYPES, MAX_DOC_BYTES, sniffMime, validateUpload, fmtBytes,
    ACTIVITY_LABELS, describeActivity,
  };
}));
