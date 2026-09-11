// Fictional workspace data for the browser smoke test: enough rows for every
// page to render its populated state. Shapes follow the real tables.
'use strict';

const NOVA = 'Nova Sportsmart Private Limited';
const ME = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

const ist = n => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + n * 86400000));
const at = (days, hhmm = '10:00') => new Date(`${ist(days)}T${hhmm}:00+05:30`).toISOString();
const now = new Date().toISOString();
const base = { created_at: at(-10), updated_at: at(-1) };

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'maya@nova.test',
    user_metadata: { full_name: 'Maya Manager', company: NOVA }, app_metadata: { provider: 'email' }, created_at: at(-100) };
  return { access_token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: ME, role: 'authenticated', exp, email: user.email })}.smoke`,
    token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'smoke-refresh', user };
}

function db() {
  const stages = [
    ['S1', 'New Opportunity', 1, 10, false, false, 'pending'], ['S2', 'Qualification', 2, 25, false, false, 'late'],
    ['S3', 'Proposal', 3, 50, false, false, 'leave'], ['S4', 'Negotiation', 4, 75, false, false, 'holiday'],
    ['S5', 'Won', 5, 100, true, false, 'present'], ['S6', 'Lost', 6, 0, false, true, 'absent'],
  ].map(([id, name, position, probability, is_won, is_lost, color]) => ({ id, pipeline_id: 'PIPE1', name, position, probability, is_won, is_lost, color, created_at: at(-50) }));
  const person = (id, full_name, email, extra) => ({ id, full_name, email, avatar_url: null, company: NOVA, company2: null, email_verified: true,
    status: 'active', app_role: 'employee', manager_id: ME, department: 'Sales', job_title: 'Sales Executive', employee_code: null, phone: '+91 90000 0000' + id[0],
    joining_date: ist(-400), is_wfh: false, shift_id: 1, shift2_id: null, last_seen_at: now, created_at: at(-400), ...extra });
  return {
    profiles: [
      // A photo, so the home page's one-time "add your profile photo" prompt stays closed.
      person(ME, 'Maya Manager', 'maya@nova.test', { app_role: 'manager', manager_id: null, job_title: 'Sales Manager', employee_code: 'NS001', avatar_url: '/icon-192.png' }),
      person(U2, 'Anil Kumar', 'anil@nova.test', { employee_code: 'NS002', is_wfh: true }),
      person(U3, 'Chitra Rao', 'chitra@nova.test', { employee_code: 'NS003', department: 'Operations', job_title: 'Coordinator', last_seen_at: at(-3) }),
    ],
    shifts: [{ id: 1, name: 'General', start_time: '09:30:00', end_time: '18:30:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6], is_default: true }],
    company_policies: [{ company: NOVA, week_offs: [7] }],
    leave_types: [{ id: 1, code: 'CL', name: 'Casual Leave', is_paid: true, active: true, sort_order: 1 }],
    holidays: [{ id: 1, holiday_date: ist(6), name: 'Company offsite', company: NOVA, is_optional: false }],
    leave_requests: [{ id: 1, user_id: U2, leave_type_id: 1, start_date: ist(2), end_date: ist(3), day_part: 'full', status: 'approved', reason: 'Family event', created_at: at(-5) }],
    attendance_logs: [{ id: 1, user_id: ME, employee_code: 'NS001', direction: 'IN', event_type: null, source: 'biometric', log_datetime: at(0, '09:28'), log_date: ist(0), log_time: '09:28:00', device_sn: 'R1', email_status: 'sent' }],
    crm_lead_statuses: [
      { key: 'new', label: 'New', sort_order: 1, is_closed: false, is_converted: false, color: 'pending' },
      { key: 'contacted', label: 'Contacted', sort_order: 2, is_closed: false, is_converted: false, color: 'late' },
      { key: 'qualified', label: 'Qualified', sort_order: 3, is_closed: false, is_converted: false, color: 'present' },
      { key: 'unqualified', label: 'Unqualified', sort_order: 4, is_closed: true, is_converted: false, color: 'weekoff' },
      { key: 'converted', label: 'Converted', sort_order: 5, is_closed: true, is_converted: true, color: 'leave' },
    ],
    task_statuses: [
      { key: 'todo', label: 'To Do', sort_order: 1, is_done: false, color: 'weekoff' }, { key: 'in_progress', label: 'In Progress', sort_order: 2, is_done: false, color: 'pending' },
      { key: 'blocked', label: 'Blocked', sort_order: 3, is_done: false, color: 'absent' }, { key: 'review', label: 'Review', sort_order: 4, is_done: false, color: 'late' },
      { key: 'completed', label: 'Completed', sort_order: 5, is_done: true, color: 'present' },
    ],
    crm_pipelines: [{ id: 'PIPE1', company: null, name: 'Sales', is_default: true, created_at: at(-50) }],
    crm_pipeline_stages: stages,
    crm_contacts: [
      { id: 'C1', company: NOVA, first_name: 'Ravi', last_name: 'Shah', full_name: 'Ravi Shah', organization: 'Acme Sports Academy', job_title: 'Procurement Head', email: 'ravi@acme.test', phone: '+91 98765 43210', city: 'Hyderabad', country: 'India', source: 'Referral', owner_id: ME, status: 'active', tags: ['vip', 'schools'], notes: 'Prefers calls after 4 pm.', created_by: ME, ...base },
      { id: 'C2', company: NOVA, first_name: 'Priya', last_name: 'Nair', full_name: 'Priya Nair', organization: 'Bluewave Fitness', job_title: 'Owner', email: 'priya@bluewave.test', phone: '+91 91234 56789', source: 'Website', owner_id: U2, status: 'active', tags: [], created_by: U2, ...base },
      { id: 'C3', company: NOVA, first_name: 'Deepak', last_name: 'Menon', full_name: 'Deepak Menon', organization: 'Riverside School', email: 'deepak@riverside.test', owner_id: null, status: 'inactive', tags: ['schools'], created_by: ME, ...base },
    ],
    crm_leads: [
      { id: 'L1', company: NOVA, name: 'Sunrise Academy', organization: 'Sunrise Trust', email: 'buy@sunrise.test', phone: '+91 90000 11111', source: 'Website', owner_id: ME, status: 'new', estimated_value: 120000, currency: 'INR', priority: 'high', next_follow_up_at: at(0, '09:00'), tags: [], created_by: ME, ...base },
      { id: 'L2', company: NOVA, name: 'Metro Runners Club', organization: 'Metro Runners', email: 'hello@metro.test', source: 'Event', owner_id: U2, status: 'contacted', estimated_value: 45000, currency: 'INR', priority: 'normal', next_follow_up_at: at(2), tags: ['event'], created_by: U2, ...base },
      { id: 'L3', company: NOVA, name: 'Ravi Shah', organization: 'Acme Sports Academy', email: 'ravi@acme.test', status: 'converted', owner_id: ME, estimated_value: 250000, currency: 'INR', priority: 'normal', converted_at: at(-8), converted_by: ME, converted_contact_id: 'C1', converted_deal_id: 'D1', tags: [], created_by: ME, ...base },
    ],
    crm_deals: [
      { id: 'D1', company: NOVA, title: 'Acme academy kit supply', contact_id: 'C1', organization: 'Acme Sports Academy', owner_id: ME, pipeline_id: 'PIPE1', stage_id: 'S3', value: 250000, currency: 'INR', probability: 50, expected_close_date: ist(12), status: 'open', source: 'Referral', description: 'Jerseys and training kit for 200 students.', lead_id: 'L3', tags: ['schools'], position: 1000, created_by: ME, ...base },
      { id: 'D2', company: NOVA, title: 'Bluewave gym equipment', contact_id: 'C2', organization: 'Bluewave Fitness', owner_id: U2, pipeline_id: 'PIPE1', stage_id: 'S1', value: 90000, currency: 'INR', probability: 10, expected_close_date: ist(-2), status: 'open', tags: [], position: 1000, created_by: U2, ...base },
      { id: 'D3', company: NOVA, title: 'Riverside sports day', contact_id: 'C3', organization: 'Riverside School', owner_id: ME, pipeline_id: 'PIPE1', stage_id: 'S5', value: 60000, currency: 'INR', probability: 100, actual_close_date: ist(-1), status: 'won', tags: [], position: 1000, created_by: ME, ...base },
    ],
    projects: [{ id: 'P1', company: NOVA, name: 'Acme kit delivery', description: 'Measure, produce and deliver 200 kits.', owner_id: ME, manager_id: ME, status: 'active', priority: 'high', start_date: ist(-5), due_date: ist(20), contact_id: 'C1', deal_id: 'D1', board_id: 'B1', tags: ['delivery'], created_by: ME, ...base }],
    project_members: [{ project_id: 'P1', user_id: U2, role: 'member', added_by: ME, created_at: at(-5) }],
    boards: [{ id: 'B1', company: NOVA, name: 'Acme kit delivery', description: null, kind: 'project', project_id: 'P1', created_by: ME, ...base }],
    board_columns: ['todo', 'in_progress', 'blocked', 'review', 'completed'].map((k, i) => ({ id: 'BC' + (i + 1), board_id: 'B1', name: ['To Do', 'In Progress', 'Blocked', 'Review', 'Completed'][i], position: i + 1, maps_to_status: k, color: ['weekoff', 'pending', 'absent', 'late', 'present'][i], wip_limit: null })),
    tasks: [
      { id: 'T1', company: NOVA, title: 'Send revised proposal to Acme', description: 'Include the bulk discount.', status: 'in_progress', priority: 'high', assignee_id: ME, deal_id: 'D1', contact_id: 'C1', due_date: ist(0), position: 1000, tags: [], created_by: ME, ...base },
      { id: 'T2', company: NOVA, title: 'Chase Bluewave for measurements', status: 'todo', priority: 'urgent', assignee_id: ME, deal_id: 'D2', due_date: ist(-2), position: 2000, tags: [], created_by: U2, ...base },
      { id: 'T3', company: NOVA, title: 'Measure sizes at Acme', status: 'in_progress', priority: 'normal', assignee_id: U2, project_id: 'P1', board_id: 'B1', board_column_id: 'BC2', due_date: ist(4), position: 1000, tags: ['onsite'], created_by: ME, ...base },
      { id: 'T4', company: NOVA, title: 'Order fabric', status: 'completed', priority: 'normal', assignee_id: U3, project_id: 'P1', board_id: 'B1', board_column_id: 'BC5', due_date: ist(-3), completed_at: at(-3), position: 1000, tags: [], created_by: ME, ...base },
    ],
    task_assignees: [], task_watchers: [],
    document_folders: [{ id: 'F1', company: NOVA, name: 'Proposals', parent_id: null, created_by: ME, created_at: at(-9) }],
    documents: [{ id: 'DOC1', company: NOVA, name: 'Acme proposal.pdf', original_name: 'Acme proposal.pdf', bucket: 'documents', storage_path: `${ME}/doc1-acme-proposal.pdf`, mime_type: 'application/pdf', size_bytes: 184320, sha256: null, folder_id: null, description: 'Signed copy', created_by: ME, ...base }],
    document_links: [{ document_id: 'DOC1', entity_type: 'project', entity_id: 'P1', created_by: ME, created_at: at(-4) }, { document_id: 'DOC1', entity_type: 'deal', entity_id: 'D1', created_by: ME, created_at: at(-4) }],
    calendar_events: [
      { id: 'E1', company: NOVA, title: 'Kick-off call with Acme', description: null, starts_at: at(1, '11:00'), ends_at: at(1, '12:00'), all_day: false, owner_id: ME, location: null, meeting_link: 'https://meet.example.test/acme', contact_id: 'C1', deal_id: 'D1', event_type: 'call', reminder_minutes: 30, visibility: 'company', status: 'scheduled', created_by: ME, ...base },
      { id: 'E2', company: NOVA, title: 'Weekly sales review', starts_at: at(0, '16:00'), ends_at: at(0, '16:30'), all_day: false, owner_id: ME, event_type: 'meeting', reminder_minutes: null, visibility: 'company', status: 'scheduled', created_by: ME, ...base },
    ],
    event_participants: [{ event_id: 'E1', user_id: U2, response: 'accepted', created_at: at(-2) }],
    invoices: [{ id: 'I1', company: NOVA, invoice_number: 'INV-2026-0001', contact_id: 'C1', deal_id: 'D1', project_id: null, bill_to_name: 'Acme Sports Academy', bill_to_email: 'accounts@acme.test', bill_to_address: '12 Stadium Road, Hyderabad', invoice_date: ist(-3), due_date: ist(12), status: 'partially_paid', currency: 'INR', subtotal: 2000, discount_total: 500, tax_total: 180, total: 1680, amount_paid: 680, balance: 1000, notes: 'Thank you for your business.', terms: 'Payment within 15 days.', sent_at: at(-3), created_by: ME, ...base }],
    invoice_items: [
      { id: 'II1', invoice_id: 'I1', position: 1, description: 'Training jerseys', quantity: 2, unit_price: 500, discount_pct: 0, tax_rate: 18, line_subtotal: 1000, line_discount: 0, line_tax: 180, line_total: 1180 },
      { id: 'II2', invoice_id: 'I1', position: 2, description: 'Setup and fitting', quantity: 1, unit_price: 1000, discount_pct: 50, tax_rate: 0, line_subtotal: 1000, line_discount: 500, line_tax: 0, line_total: 500 },
    ],
    invoice_payments: [{ id: 'IP1', invoice_id: 'I1', amount: 680, paid_on: ist(-1), method: 'UPI', reference: 'UTR123', created_by: ME, created_at: at(-1) }],
    notifications: [
      { id: 'N1', user_id: ME, actor_id: U2, kind: 'task.assigned', title: 'Task assigned to you', body: 'Chase Bluewave for measurements', url: '/tasks/?id=T2', entity_type: 'task', entity_id: 'T2', read_at: null, created_at: at(0, '09:05') },
      { id: 'N2', user_id: ME, actor_id: null, kind: 'task.digest', title: '1 task due today, 1 overdue', body: 'Open My Tasks to plan the day.', url: '/tasks/?view=mine', read_at: null, created_at: at(0, '09:00') },
    ],
    crm_activities: [
      { id: 'A1', company: NOVA, actor_id: ME, action: 'deal.stage_changed', entity_type: 'deal', entity_id: 'D1', entity_label: 'Acme academy kit supply', meta: { from: 'Qualification', to: 'Proposal' }, contact_id: 'C1', deal_id: 'D1', created_at: at(-2) },
      { id: 'A2', company: NOVA, actor_id: ME, action: 'lead.converted', entity_type: 'lead', entity_id: 'L3', entity_label: 'Ravi Shah', meta: {}, contact_id: 'C1', lead_id: 'L3', deal_id: 'D1', created_at: at(-8) },
      { id: 'A3', company: NOVA, actor_id: U2, action: 'task.created', entity_type: 'task', entity_id: 'T2', entity_label: 'Chase Bluewave for measurements', meta: {}, deal_id: 'D2', created_at: at(-1) },
    ],
    comments: [{ id: 'CM1', company: NOVA, entity_type: 'contact', entity_id: 'C1', author_id: U2, body: 'Spoke to @Maya Manager about the discount.', mentions: [ME], created_at: at(-1), updated_at: at(-1) }],
    messages: [
      { id: 1, sender_id: U2, recipient_id: ME, conversation_id: null, body: 'Measurements are in the shared folder.', created_at: at(0, '09:40'), read_at: null },
      { id: 2, sender_id: ME, recipient_id: U2, conversation_id: null, body: 'Thanks, reviewing now.', created_at: at(0, '09:45'), read_at: at(0, '09:46') },
      { id: 3, sender_id: U3, recipient_id: null, conversation_id: 'G1', body: 'Fabric ordered for the Acme kits.', created_at: at(0, '10:00'), read_at: null, mentions: [] },
    ],
    message_reactions: [],
    conversations: [{ id: 'G1', company: NOVA, name: 'Acme delivery team', description: 'Kit delivery chatter', kind: 'group', project_id: null, created_by: ME, archived_at: null, ...base }],
    conversation_members: [ME, U2, U3].map((u, i) => ({ conversation_id: 'G1', user_id: u, role: i ? 'member' : 'admin', added_by: ME, last_read_at: at(-1), muted: false, created_at: at(-9) })),
    test_results: [], quiz_results: [], wfh_recordings: [], push_subscriptions: [], salaries: [],
  };
}

const RPC = {
  ws_unread_counts: () => [{ direct_unread: 1, group_unread: 1, total: 2 }],
  crm_log: () => null,
  crm_convert_lead: () => ({ contact_id: 'C1', deal_id: 'D1', existing_contact: true }),
  invoice_duplicate: () => 'I1',
};

module.exports = { ME, NOVA, session, db, RPC };
