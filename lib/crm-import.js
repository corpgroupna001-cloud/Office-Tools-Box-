// ============================================================
// CRM import — turning a spreadsheet of deals or leads into rows
// WorkSuite can store.
//
// Written for a Bitrix24 CSV export as it actually comes out: its own
// column names ("Deal Name", "Income", "Assumed close date"), currency
// as words ("US Dollar"), dates as 12.09.2026, the responsible person
// as an employee code, and comments wrapped in [p] tags. Plainer
// headers (title, value, owner_email) work just as well.
//
// Nothing in the file is lost: each record keeps its whole row
// (source_row), and exportCells() turns a record back into the file's own
// columns, so the admin console shows and exports it in that format.
//
// Everything here is pure: it reads rows and reference data and returns
// what to write. The caller (api/admin.js) does the database work, so
// this can be tested on its own.
// ============================================================

/** Header names, however the export spells them. */
const DEAL_FIELDS = {
  externalId:   ['id', 'deal id', 'bitrix id', 'external id'],
  title:        ['deal name', 'title', 'deal', 'name', 'opportunity'],
  value:        ['income', 'value', 'amount', 'opportunity amount', 'sum'],
  currency:     ['currency'],
  pipeline:     ['pipeline', 'funnel', 'category'],
  stage:        ['stage', 'deal stage'],
  responsible:  ['responsible', 'responsible person', 'owner', 'owner_email', 'owner email', 'assigned to', 'assigned_to'],
  organization: ['company', 'company: company name', 'company name', 'organization', 'organisation', 'account'],
  contactName:  ['contact', 'contact name'],
  contactFirst: ['contact: first name', 'first name', 'first_name'],
  contactLast:  ['contact: last name', 'last name', 'last_name'],
  contactEmail: ['contact: work e-mail', 'contact: home e-mail', 'contact: other e-mail', 'contact: newsletters email', 'email', 'e-mail', 'contact email'],
  contactPhone: ['contact: mobile', 'contact: work phone', 'contact: home phone', 'mobile', 'phone', 'contact phone'],
  jobTitle:     ['job title', 'contact: position', 'position'],
  source:       ['source'],
  sourceDetail: ['source information', 'source detail'],
  probability:  ['probability'],
  comment:      ['comment', 'description', 'notes'],
  startDate:    ['start date', 'begin date'],
  closeDate:    ['assumed close date', 'close date', 'expected close date', 'expected_close_date'],
  type:         ['type', 'deal type'],
  created:      ['created', 'created on', 'date created', 'created_at'],
};

const LEAD_FIELDS = {
  externalId:   ['id', 'lead id', 'bitrix id', 'external id'],
  name:         ['lead name', 'name', 'title', 'full name', 'contact'],
  status:       ['status', 'stage', 'lead status'],
  responsible:  ['responsible', 'responsible person', 'owner', 'owner_email', 'owner email', 'assigned to', 'assigned_to'],
  organization: ['company', 'company name', 'organization', 'organisation', 'account'],
  email:        ['e-mail', 'email', 'work e-mail', 'home e-mail', 'contact: work e-mail'],
  phone:        ['phone', 'mobile', 'work phone', 'contact: mobile'],
  value:        ['income', 'total', 'estimated value', 'value', 'amount', 'opportunity amount'],
  currency:     ['currency'],
  source:       ['source'],
  sourceDetail: ['source information', 'source detail', 'referrer'],
  comment:      ['comment', 'notes', 'description'],
  jobTitle:     ['job title', 'position'],
  firstName:    ['first name', 'first_name'],
  lastName:     ['last name', 'last_name'],
  created:      ['created', 'created on', 'date created', 'created_at'],
};

/** What a lead's own columns say about the person, kept in its notes: label → headers. */
const LEAD_DETAILS = [
  ['Position', ['job title', 'position']],
  ['Work experience', ['work experience']],
  ['Nationality', ['nationality']],
  ['Visa', ['visa']],
  ['Entry to the USA', ['entry of usa (year)']],
  ['Relocation', ['relocation']],
  ['Highest education', ['highest education']],
  ['Field of education', ['field of education']],
  ['Year of graduation', ['year of graduation']],
  ['Communication skills', ['commnuication skills', 'communication skills']],
  ['Technical skills', ['technical skills']],
];

/** "US Dollar" and friends; a plain three-letter code is taken as given. */
const CURRENCY = {
  'us dollar': 'USD', 'u.s. dollar': 'USD', dollar: 'USD', 'american dollar': 'USD',
  'indian rupee': 'INR', rupee: 'INR', rupees: 'INR',
  euro: 'EUR', 'pound sterling': 'GBP', 'british pound': 'GBP', pound: 'GBP',
  'uae dirham': 'AED', dirham: 'AED', 'canadian dollar': 'CAD', 'australian dollar': 'AUD',
  'singapore dollar': 'SGD', 'swiss franc': 'CHF', yen: 'JPY', 'japanese yen': 'JPY',
};

/** Bitrix lead statuses → the ones WorkSuite keeps. */
const LEAD_STATUS = {
  new: 'new', 'in process': 'contacted', contacted: 'contacted', processing: 'contacted',
  processed: 'qualified', qualified: 'qualified', 'good quality': 'qualified',
  junk: 'unqualified', 'junk lead': 'unqualified', unqualified: 'unqualified', 'low quality': 'unqualified',
  converted: 'converted', 'deal created': 'converted', recycled: 'contacted',
};

const norm = s => String(s == null ? '' : s).replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
/** A header as a key: "Deal Name", "deal_name" and "deal name" are the same column. */
const headerKey = s => norm(String(s == null ? '' : s).replace(/_/g, ' '));
const clean = v => {
  const s = String(v == null ? '' : v).trim();
  return s && s !== '-' ? s : null;
};
/** Bitrix wraps comments in [p]…[/p] and uses [br] for line breaks. */
function stripTags(v) {
  const s = clean(v);
  if (!s) return null;
  return s.replace(/\[br\s*\/?\]/gi, '\n').replace(/\[\/?[a-z][^\]]*\]/gi, '').replace(/[ \t]+\n/g, '\n').trim() || null;
}
function money(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9.,-]/g, '');
  if (!s) return null;
  // 1.234,56 (comma decimals) versus 1,234.56
  const t = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(t);
  return isFinite(n) ? n : null;
}
function currencyCode(v, fallback) {
  const s = norm(v);
  if (!s) return fallback;
  if (CURRENCY[s]) return CURRENCY[s];
  if (/^[a-z]{3}$/.test(s)) return s.toUpperCase();
  return fallback;
}
/** 12.09.2026, 12.09.2026 03:11:57 am, 2026-09-12, 12/09/2026 → 2026-09-12 */
function isoDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);         // day first, as the export writes it
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const t = new Date(s);
  return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}
/**
 * 12.09.2026 12:41:48 am → 2026-09-12T00:41:48+05:30. The export writes the
 * portal's wall clock with no zone; the portal runs on India time. A value
 * that already carries a zone, or a bare 2026-09-12, is read as it is.
 */
function isoDateTime(v) {
  const s = clean(v);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i);
  if (m) {
    const day = isoDate(s);
    if (!day) return null;
    let h = Number(m[4] || 0);
    const ap = (m[7] || '').toLowerCase().replace(/\./g, '');
    if (h > 23 || (ap && (h < 1 || h > 12))) return null;
    if (ap === 'am' && h === 12) h = 0;
    if (ap === 'pm' && h !== 12) h += 12;
    const pad = n => String(n).padStart(2, '0');
    return `${day}T${pad(h)}:${m[5] || '00'}:${m[6] || '00'}+05:30`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00+05:30`;
  const t = new Date(s);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

/** A row's filled-in cells under the file's own column names: what source_row keeps. */
function sourceRow(row) {
  const out = {};
  Object.keys(row || {}).forEach(k => {
    const key = String(k).replace(/^\uFEFF/, '').trim();
    const v = row[k] == null ? '' : String(row[k]);
    if (key && v.trim() !== '') out[key] = v;
  });
  return Object.keys(out).length ? out : null;
}

/** The columns of every file so far, in order: what is already known, then what is new. */
function mergeHeaders(known, incoming) {
  const out = [], seen = new Set();
  [].concat(known || [], incoming || []).forEach(h => {
    const name = String(h == null ? '' : h).replace(/^\uFEFF/, '').trim();
    if (name && !seen.has(headerKey(name))) { seen.add(headerKey(name)); out.push(name); }
  });
  return out;
}

function percent(v) {
  const n = money(v);
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Reads one row by any of a field's known header names. */
function reader(row) {
  const byKey = new Map();
  // The admin page sends headers as deal_name; the export writes Deal Name.
  Object.keys(row || {}).forEach(k => byKey.set(headerKey(k), row[k]));
  const any = names => {
    for (const name of names || []) {
      const v = byKey.get(headerKey(name));
      if (clean(v)) return clean(v);
    }
    return null;
  };
  const get = (field, defs) => any(defs[field]);
  get.any = any;
  return get;
}

/** Which pipelines and stages a file mentions, so missing ones can be made first. */
function scanDeals(rows) {
  const pipelines = new Map();                        // name → Set(stage names)
  (rows || []).forEach(r => {
    const get = reader(r);
    const p = get('pipeline', DEAL_FIELDS), s = get('stage', DEAL_FIELDS);
    if (!p && !s) return;
    const key = p || '';
    if (!pipelines.has(key)) pipelines.set(key, new Set());
    if (s) pipelines.get(key).add(s);
  });
  return [...pipelines.entries()].map(([name, stages]) => ({ name, stages: [...stages] }));
}

const wonLost = name => {
  const s = norm(name);
  return { is_won: /\bwon\b|\bsuccess\b/.test(s), is_lost: /\blost\b|\bfail|\bjunk\b/.test(s) };
};

/** Matches the person named in the file: Employee ID first, then biometric ID, email and name. */
function peopleIndex(profiles) {
  const byId = new Map(), byCode = new Map(), byEmail = new Map(), byName = new Map();
  (profiles || []).forEach(p => {
    if (p.employee_id) byId.set(norm(p.employee_id), p);
    if (p.employee_code) byCode.set(norm(p.employee_code), p);
    if (p.email) byEmail.set(norm(p.email), p);
    if (p.full_name) byName.set(norm(p.full_name), p);
  });
  return who => {
    const s = norm(who);
    if (!s) return null;
    return byId.get(s) || byCode.get(s) || byEmail.get(s) || byName.get(s) || null;
  };
}

/**
 * mapDeals(rows, ctx) -> { rows, contacts, skipped, warnings }
 * ctx: { pipelines, stages, profiles, defaultCurrency, company, source }
 */
function mapDeals(rows, ctx = {}) {
  const pipelines = ctx.pipelines || [], stages = ctx.stages || [];
  const findPerson = peopleIndex(ctx.profiles);
  const defCurrency = ctx.defaultCurrency || 'INR';
  const byPipeName = new Map(pipelines.map(p => [norm(p.name), p]));
  const defPipeline = pipelines.find(p => p.is_default) || pipelines[0] || null;
  const stagesOf = id => stages.filter(s => s.pipeline_id === id)
    .slice().sort((a, b) => (a.position || 0) - (b.position || 0));

  const out = { rows: [], contacts: [], skipped: [], warnings: [] };
  const warn = new Set();                     // the same remark about 5,000 rows is still one remark
  const unknownCurrency = new Set();

  (rows || []).forEach((r, i) => {
    const at = i + 2;                                  // the line in the file, header counted
    const get = reader(r);
    const title = get('title', DEAL_FIELDS);
    if (!title) { out.skipped.push({ row: at, why: 'no deal name' }); return; }

    const pipeName = get('pipeline', DEAL_FIELDS);
    const pipeline = (pipeName && byPipeName.get(norm(pipeName))) || defPipeline;
    if (!pipeline) { out.skipped.push({ row: at, why: 'no pipeline to put it in' }); return; }
    if (pipeName && !byPipeName.has(norm(pipeName))) {
      warn.add(`Pipeline "${pipeName}" does not exist — those deals went to "${pipeline.name}".`);
    }

    const inPipe = stagesOf(pipeline.id);
    if (!inPipe.length) { out.skipped.push({ row: at, why: `pipeline "${pipeline.name}" has no stages` }); return; }
    const stageName = get('stage', DEAL_FIELDS);
    const stage = (stageName && inPipe.find(s => norm(s.name) === norm(stageName))) || inPipe[0];
    if (stageName && norm(stage.name) !== norm(stageName)) {
      warn.add(`Stage "${stageName}" is not in "${pipeline.name}" — those deals went to "${stage.name}".`);
    }

    const cur = get('currency', DEAL_FIELDS);
    const currency = currencyCode(cur, defCurrency);
    if (cur && currencyCode(cur, null) === null) unknownCurrency.add(cur);

    const person = findPerson(get('responsible', DEAL_FIELDS));
    const email = get('contactEmail', DEAL_FIELDS), phone = get('contactPhone', DEAL_FIELDS);
    const first = get('contactFirst', DEAL_FIELDS), last = get('contactLast', DEAL_FIELDS);
    const shown = get('contactName', DEAL_FIELDS);
    const hasContact = !!(email || phone || first || last || shown);
    // The export often puts the whole name in "Contact: First name" and leaves
    // the last name empty, so a lone field is split rather than taken as a
    // first name. Both columns filled in are trusted as they are.
    const nameParts = (first && last) ? { first_name: first, last_name: last }
      : first ? splitName(first)
        : last ? { first_name: null, last_name: last }
          : splitName(shown);

    const note = [stripTags(get('comment', DEAL_FIELDS)), get('type', DEAL_FIELDS) ? `Type: ${get('type', DEAL_FIELDS)}` : null]
      .filter(Boolean).join('\n\n') || null;

    const id = get('externalId', DEAL_FIELDS);
    out.rows.push({
      external_ref: id ? `${ctx.source || 'import'}:deal:${id}` : null,
      title,
      organization: get('organization', DEAL_FIELDS),
      value: money(get('value', DEAL_FIELDS)) || 0,
      currency,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      probability: percent(get('probability', DEAL_FIELDS)) != null ? percent(get('probability', DEAL_FIELDS)) : (stage.probability || 0),
      status: stage.is_won ? 'won' : stage.is_lost ? 'lost' : 'open',
      expected_close_date: isoDate(get('closeDate', DEAL_FIELDS)),
      source: get('source', DEAL_FIELDS),
      description: note,
      source_row: sourceRow(r),
      // Every row in a request carries the same keys, so a file without dates still says when.
      created_at: isoDateTime(get('created', DEAL_FIELDS)) || ctx.now || new Date().toISOString(),
      company: ctx.company || (person && person.company) || null,
      owner_id: person ? person.id : null,
      _contact: hasContact ? {
        ...nameParts,
        email, phone,
        job_title: get('jobTitle', DEAL_FIELDS),
        organization: get('organization', DEAL_FIELDS),
        source: get('source', DEAL_FIELDS),
        owner_id: person ? person.id : null,
        company: ctx.company || (person && person.company) || null,
      } : null,
      _row: at,
    });
  });

  if (unknownCurrency.size) {
    warn.add(`Currency ${[...unknownCurrency].slice(0, 3).map(c => `"${c}"`).join(', ')} was not recognised — ${defCurrency} was used.`);
  }
  out.warnings = [...warn];
  out.contacts = out.rows.map(r => r._contact).filter(Boolean);
  return out;
}

function splitName(shown) {
  const s = clean(shown);
  if (!s) return { first_name: null, last_name: null };
  const bits = s.split(/\s+/);
  return bits.length === 1 ? { first_name: bits[0], last_name: null } : { first_name: bits.slice(0, -1).join(' '), last_name: bits[bits.length - 1] };
}

/** Which lead stages a file names. */
function scanLeads(rows) {
  const seen = new Map();
  (rows || []).forEach(r => {
    const s = reader(r)('status', LEAD_FIELDS);
    if (s && !seen.has(norm(s))) seen.set(norm(s), s);
  });
  return [...seen.values()];
}

/** A lead stage name as a status key: "Need to Explain" → need_to_explain. */
const statusKey = name => norm(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * The status a stage name lands in: one we hold by key or label, then the
 * usual Bitrix synonyms ("Junk" → unqualified). null when neither fits.
 * statuses: [{ key, label }] or plain keys.
 */
function leadStatusFor(name, statuses) {
  const list = (statuses || []).map(s => typeof s === 'string' ? { key: s, label: s } : s);
  const n = norm(name);
  if (!n) return null;
  const own = list.find(s => norm(s.key) === n || norm(s.label) === n || s.key === statusKey(name));
  if (own) return own.key;
  const syn = LEAD_STATUS[n];
  return syn && list.some(s => s.key === syn) ? syn : null;
}

/**
 * mapLeads(rows, ctx) -> { rows, skipped, warnings }
 * ctx: { statuses, profiles, defaultCurrency, company, source }
 */
function mapLeads(rows, ctx = {}) {
  const findPerson = peopleIndex(ctx.profiles);
  const statuses = (ctx.statuses && ctx.statuses.length ? ctx.statuses : ['new', 'contacted', 'qualified', 'unqualified', 'converted']);
  const keys = statuses.map(s => typeof s === 'string' ? s : s.key);
  const defCurrency = ctx.defaultCurrency || 'INR';
  const out = { rows: [], skipped: [], warnings: [] };
  const warn = new Set();

  (rows || []).forEach((r, i) => {
    const at = i + 2;
    const get = reader(r);
    const name = get('name', LEAD_FIELDS);
    if (!name) { out.skipped.push({ row: at, why: 'no name' }); return; }

    const wanted = get('status', LEAD_FIELDS);
    let status = wanted ? leadStatusFor(wanted, statuses) : null;
    if (!status) {
      if (wanted) warn.add(`Status "${wanted}" is not one of ours — "new" was used.`);
      status = keys.includes('new') ? 'new' : keys[0];
    }
    const fullName = [get('firstName', LEAD_FIELDS), get('lastName', LEAD_FIELDS)].filter(Boolean).join(' ');
    const details = [fullName ? `Name: ${fullName}` : null]
      .concat(LEAD_DETAILS.map(([label, names]) => { const v = get.any(names); return v ? `${label}: ${v}` : null; }))
      .filter(Boolean).join('\n');
    const person = findPerson(get('responsible', LEAD_FIELDS));
    const id = get('externalId', LEAD_FIELDS);
    out.rows.push({
      external_ref: id ? `${ctx.source || 'import'}:lead:${id}` : null,
      name,
      organization: get('organization', LEAD_FIELDS),
      email: get('email', LEAD_FIELDS),
      phone: get('phone', LEAD_FIELDS),
      source: get('source', LEAD_FIELDS),
      source_detail: get('sourceDetail', LEAD_FIELDS),
      status,
      estimated_value: money(get('value', LEAD_FIELDS)),
      currency: currencyCode(get('currency', LEAD_FIELDS), defCurrency),
      notes: [stripTags(get('comment', LEAD_FIELDS)), details].filter(Boolean).join('\n\n') || null,
      source_row: sourceRow(r),
      created_at: isoDateTime(get('created', LEAD_FIELDS)) || ctx.now || new Date().toISOString(),
      company: ctx.company || (person && person.company) || null,
      owner_id: person ? person.id : null,
      _row: at,
    });
  });
  out.warnings = [...warn];
  return out;
}

/* ======================= back out, in the file's format ======================= */

/** The columns shown and exported before any file has been imported. */
const DEFAULT_HEADERS = {
  deals: ['ID', 'Pipeline', 'Stage', 'Responsible', 'Deal Name', 'Type', 'Source', 'Income', 'Currency',
    'Company', 'Contact', 'Created', 'Assumed close date', 'Comment'],
  leads: ['ID', 'Stage', 'Lead Name', 'Created', 'Source', 'Work E-mail', 'Mobile', 'Responsible',
    'Company Name', 'Comment', 'Total', 'Currency'],
};

const CURRENCY_WORD = {
  USD: 'US Dollar', INR: 'Indian Rupee', EUR: 'Euro', GBP: 'Pound Sterling', AED: 'UAE Dirham',
  CAD: 'Canadian Dollar', AUD: 'Australian Dollar', SGD: 'Singapore Dollar', CHF: 'Swiss Franc', JPY: 'Japanese Yen',
};

const pad2 = n => String(n).padStart(2, '0');
/** 2026-09-19 → 19.09.2026 */
function exportDate(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}
/** A stored timestamp → 12.09.2026 12:41:48 am, on India time as the export writes it. */
function exportDateTime(v) {
  const t = new Date(v);
  if (!v || isNaN(t.getTime())) return '';
  const ist = new Date(t.getTime() + 330 * 60000);
  const h = ist.getUTCHours();
  return `${pad2(ist.getUTCDate())}.${pad2(ist.getUTCMonth() + 1)}.${ist.getUTCFullYear()} ` +
    `${pad2(h % 12 || 12)}:${pad2(ist.getUTCMinutes())}:${pad2(ist.getUTCSeconds())} ${h < 12 ? 'am' : 'pm'}`;
}
const exportMoney = v => (v == null || v === '' || !isFinite(Number(v))) ? '' : Number(v).toFixed(2);

/**
 * The columns WorkSuite itself keeps, per kind. Each says what the record
 * holds (show) and whether the file's cell still says the same thing (same).
 * When it does, the cell is written back exactly as the file had it; when
 * the record has changed since — a deal moved stage — the record wins.
 * Columns marked fallback are the file's cell for a record that came from
 * a file — blank stays blank — and the record's own value only for records
 * made in WorkSuite.
 */
function coreColumns(kind, ctx) {
  const pipelines = ctx.pipelines || new Map(), stages = ctx.stages || new Map();
  const statuses = ctx.statuses || new Map(), people = ctx.people || new Map();
  const findPerson = peopleIndex([...people.values()]);
  const owner = r => {
    const p = r.owner_id && people.get(r.owner_id);
    return p ? (p.employee_id || p.employee_code || p.full_name || p.email || '') : '';
  };
  const ownerSame = (r, cell) => ((findPerson(cell) || {}).id || null) === (r.owner_id || null);
  const sourceId = r => { const m = String(r.external_ref || '').match(/:(?:deal|lead):(.+)$/); return m ? m[1] : r.id; };
  const currency = {
    show: r => CURRENCY_WORD[r.currency] || r.currency || '',
    same: (r, cell) => currencyCode(cell, null) === r.currency,
  };
  const created = { fallback: true, show: r => exportDateTime(r.created_at) };

  if (kind === 'leads') {
    return {
      'id': { fallback: true, show: sourceId },
      'lead name': { show: r => r.name || '', same: (r, cell) => cell === r.name },
      'stage': { show: r => (statuses.get(r.status) || {}).label || r.status || '', same: (r, cell) => leadStatusFor(cell, [...statuses.values()]) === r.status },
      'total': { show: r => exportMoney(r.estimated_value), same: (r, cell) => money(cell) === (r.estimated_value == null ? null : Number(r.estimated_value)) },
      'currency': currency,
      'responsible': { show: owner, same: ownerSame },
      'created': created,
      'source': { fallback: true, show: r => r.source || '' },
      'work e-mail': { fallback: true, show: r => r.email || '' },
      'mobile': { fallback: true, show: r => r.phone || '' },
      'company name': { fallback: true, show: r => r.organization || '' },
      'comment': { fallback: true, show: r => r.notes || '' },
    };
  }
  return {
    'id': { fallback: true, show: sourceId },
    'deal name': { show: r => r.title || '', same: (r, cell) => cell === r.title },
    'pipeline': { show: r => (pipelines.get(r.pipeline_id) || {}).name || '', same: (r, cell) => norm(cell) === norm((pipelines.get(r.pipeline_id) || {}).name) },
    'stage': { show: r => (stages.get(r.stage_id) || {}).name || '', same: (r, cell) => norm(cell) === norm((stages.get(r.stage_id) || {}).name) },
    'income': { show: r => exportMoney(r.value), same: (r, cell) => (money(cell) || 0) === Number(r.value || 0) },
    'currency': currency,
    'responsible': { show: owner, same: ownerSame },
    'assumed close date': { show: r => exportDate(r.expected_close_date), same: (r, cell) => isoDate(cell) === (r.expected_close_date || null) },
    'created': created,
    'source': { fallback: true, show: r => r.source || '' },
    'company': { fallback: true, show: r => r.organization || '' },
    'contact': { fallback: true, show: r => (r.contact && r.contact.full_name) || '' },
    'probability': { fallback: true, show: r => r.probability == null ? '' : String(r.probability) },
    'comment': { fallback: true, show: r => r.description || '' },
  };
}

/**
 * exportCells(kind, records, headers, ctx) -> [[cell, …], …], one row per record
 * in the order of headers. ctx: { pipelines, stages, statuses, people } as
 * Maps by id (statuses by key).
 */
function exportCells(kind, records, headers, ctx = {}) {
  const core = coreColumns(kind, ctx);
  const cols = (headers || []).map(h => ({ name: h, key: headerKey(h), col: core[headerKey(h)] }));
  return (records || []).map(r => {
    const src = {};
    const fromFile = !!(r.source_row && typeof r.source_row === 'object');
    Object.keys(r.source_row || {}).forEach(k => { src[headerKey(k)] = r.source_row[k]; });
    return cols.map(({ key, col }) => {
      const cell = src[key];
      const has = cell != null && String(cell).trim() !== '';
      if (!col) return has ? String(cell) : '';
      if (col.fallback) return has ? String(cell) : fromFile ? '' : col.show(r);
      return has && col.same(r, String(cell)) ? String(cell) : col.show(r);
    });
  });
}

module.exports = {
  mapDeals, mapLeads, scanDeals, scanLeads, leadStatusFor, statusKey, wonLost,
  sourceRow, mergeHeaders, exportCells, DEFAULT_HEADERS,
  // exported for the tests and for the endpoint's own checks
  isoDate, isoDateTime, exportDate, exportDateTime, money, currencyCode, stripTags, splitName, percent, norm, headerKey,
  DEAL_FIELDS, LEAD_FIELDS,
};
