/* Shared by the browser and server: an assigned shift overrides company defaults. */
(function (root, factory) {
  const config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.WSCompanies = config;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const defaults = {
    'Jobways Point LLP': { start_time: '18:00:00', end_time: '03:00:00', working_days: [1,2,3,4,5] },
    'Genie Lamp Private Limited': { start_time: '18:00:00', end_time: '03:00:00', working_days: [1,2,3,4,5] },
    'Nova Sportsmart Private Limited': { start_time: '09:00:00', end_time: '18:00:00', working_days: [1,2,3,4,5,6] }
  };
  const companies = [...Object.keys(defaults), 'Protathlitis Sportsmart LLP', 'Navyug Raise A Player Foundation'];
  function resolveShift(profile, shifts, fallback) {
    const rows = shifts instanceof Map ? [...shifts.values()] : (shifts || []);
    const assigned = profile && profile.shift_id != null && rows.find(s => String(s.id) === String(profile.shift_id));
    if (assigned) return assigned;
    const general = fallback || rows.find(s => s.is_default) || null;
    const company = profile && defaults[profile.company];
    if (!company) return general;
    return { grace_minutes: general ? general.grace_minutes || 0 : 0,
      early_out_grace_minutes: general ? general.early_out_grace_minutes || 0 : 0,
      ...company, working_days: [...company.working_days], name: profile.company + ' · default',
      id: null, is_default: false, company_default: true };
  }
  return { defaults, companies, resolveShift };
}));
