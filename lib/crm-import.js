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
};

const LEAD_FIELDS = {
  externalId:   ['id', 'lead id', 'bitrix id', 'external id'],
  name:         ['lead name', 'name', 'title', 'full name', 'contact'],
  status:       ['status', 'stage', 'lead status'],
  responsible:  ['responsible', 'responsible person', 'owner', 'owner_email', 'owner email', 'assigned to', 'assigned_to'],
  organization: ['company', 'company name', 'organization', 'organisation', 'account'],
  email:        ['e-mail', 'email', 'work e-mail', 'home e-mail', 'contact: work e-mail'],
  phone:        ['phone', 'mobile', 'work phone', 'contact: mobile'],
  value:        ['income', 'estimated value', 'value', 'amount', 'opportunity amount'],
  currency:     ['currency'],
  source:       ['source'],
  sourceDetail: ['source information', 'source detail'],
  comment:      ['comment', 'notes', 'description'],
  jobTitle:     ['job title', 'position'],
};

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
function percent(v) {
  const n = money(v);
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Reads one row by any of a field's known header names. */
function reader(row) {
  const byKey = new Map();
  Object.keys(row || {}).forEach(k => byKey.set(norm(k), row[k]));
  return (field, defs) => {
    for (const name of defs[field] || []) {
      const v = byKey.get(name);
      if (clean(v)) return clean(v);
    }
    return null;
  };
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

/** Matches the person named in the file: employee code first, then email, then name. */
function peopleIndex(profiles) {
  const byCode = new Map(), byEmail = new Map(), byName = new Map();
  (profiles || []).forEach(p => {
    if (p.employee_code) byCode.set(norm(p.employee_code), p);
    if (p.email) byEmail.set(norm(p.email), p);
    if (p.full_name) byName.set(norm(p.full_name), p);
  });
  return who => {
    const s = norm(who);
    if (!s) return null;
    return byCode.get(s) || byEmail.get(s) || byName.get(s) || null;
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

/**
 * mapLeads(rows, ctx) -> { rows, skipped, warnings }
 * ctx: { statuses, profiles, defaultCurrency, company, source }
 */
function mapLeads(rows, ctx = {}) {
  const findPerson = peopleIndex(ctx.profiles);
  const allowed = (ctx.statuses && ctx.statuses.length ? ctx.statuses : ['new', 'contacted', 'qualified', 'unqualified', 'converted']);
  const defCurrency = ctx.defaultCurrency || 'INR';
  const out = { rows: [], skipped: [], warnings: [] };
  const warn = new Set();

  (rows || []).forEach((r, i) => {
    const at = i + 2;
    const get = reader(r);
    const name = get('name', LEAD_FIELDS);
    if (!name) { out.skipped.push({ row: at, why: 'no name' }); return; }

    const wanted = get('status', LEAD_FIELDS);
    let status = wanted ? (LEAD_STATUS[norm(wanted)] || norm(wanted)) : 'new';
    if (!allowed.includes(status)) {
      if (wanted) warn.add(`Status "${wanted}" is not one of ours — "new" was used.`);
      status = allowed.includes('new') ? 'new' : allowed[0];
    }
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
      notes: stripTags(get('comment', LEAD_FIELDS)),
      company: ctx.company || (person && person.company) || null,
      owner_id: person ? person.id : null,
      _row: at,
    });
  });
  out.warnings = [...warn];
  return out;
}

module.exports = {
  mapDeals, mapLeads, scanDeals, wonLost,
  // exported for the tests and for the endpoint's own checks
  isoDate, money, currencyCode, stripTags, splitName, percent, norm,
  DEAL_FIELDS, LEAD_FIELDS,
};
