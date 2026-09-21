-- ============================================================================
-- Sales cloud: quotes, lost reasons, sales targets and web-to-lead forms.
--
-- Migration 10. Run AFTER supabase-employee-id-migration.sql (it needs the
-- b24 access matrix, deal products and invoices). Idempotent; adds only.
--
--   1. crm_lost_reasons + crm_deals.lost_reason     why a deal was lost
--   2. crm_sales_targets                            monthly quota per person / company
--   3. crm_quotes + crm_quote_items                 quotes on a deal, DB-owned totals,
--      crm_quote_from_deal() / crm_quote_to_invoice()
--   4. crm_web_forms + crm_web_form_submit()        public web-to-lead forms
--
-- Access:
--   A quote always belongs to a deal and follows it: whoever can read the deal
--   reads its quotes; whoever can edit the deal (ws_deal_editable) writes them.
--   Turning a quote into an invoice also needs "Invoices: add".
--   Lost reasons and web forms are CRM settings ("CRM settings: edit").
--   Sales targets are set by managers of the company; everyone in it reads them.
--   The two web-form functions are the only things here an anonymous visitor
--   may call; they rate-limit per visitor and per form.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Lost reasons
-- ---------------------------------------------------------------------------
create table if not exists public.crm_lost_reasons (
  id          uuid primary key default gen_random_uuid(),
  company     text,                                   -- null = every company
  label       text not null,
  sort        int not null default 0,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.crm_lost_reasons drop constraint if exists crm_lost_reasons_label_ck;
alter table public.crm_lost_reasons add constraint crm_lost_reasons_label_ck check (length(btrim(label)) between 1 and 80);
create unique index if not exists crm_lost_reasons_uidx on public.crm_lost_reasons (coalesce(company, '*'), lower(label));

insert into public.crm_lost_reasons (company, label, sort)
select null, v.label, v.sort
  from (values ('Price too high', 10), ('Chose a competitor', 20), ('No budget', 30), ('No response / went silent', 40),
               ('Timing / postponed', 50), ('Missing feature or product', 60), ('Not a fit', 70), ('Other', 99)) v(label, sort)
 where not exists (select 1 from public.crm_lost_reasons r where r.company is null and lower(r.label) = lower(v.label));

alter table public.crm_lost_reasons enable row level security;
drop policy if exists crm_lost_reasons_read on public.crm_lost_reasons;
create policy crm_lost_reasons_read on public.crm_lost_reasons for select to authenticated
  using (company is null or (select public.ws_same_company(company)));
drop policy if exists crm_lost_reasons_manage on public.crm_lost_reasons;
create policy crm_lost_reasons_manage on public.crm_lost_reasons for all to authenticated
  using ((select public.ws_is_admin())
         or (company = any((select public.ws_my_companies())::text[]) and public.ws_crm_rank((select public.ws_crm_levels('settings', 'edit')) ->> '*') > 0))
  with check ((select public.ws_is_admin())
         or (company = any((select public.ws_my_companies())::text[]) and public.ws_crm_rank((select public.ws_crm_levels('settings', 'edit')) ->> '*') > 0));

alter table public.crm_deals add column if not exists lost_reason text;
alter table public.crm_deals add column if not exists lost_reason_note text;
alter table public.crm_deals drop constraint if exists crm_deals_lost_reason_ck;
alter table public.crm_deals add constraint crm_deals_lost_reason_ck
  check ((lost_reason is null or length(lost_reason) <= 80) and (lost_reason_note is null or length(lost_reason_note) <= 2000));
create index if not exists crm_deals_lost_reason_idx on public.crm_deals (company, lost_reason) where status = 'lost';

-- A reason only means something on a lost deal: reopening or winning clears it.
-- Named to sort after crm_deals_stage_rules, which derives the status first.
create or replace function public.crm_deals_lost_reason()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from 'lost' then
    new.lost_reason := null;
    new.lost_reason_note := null;
  else
    new.lost_reason := nullif(btrim(new.lost_reason), '');
    new.lost_reason_note := nullif(btrim(new.lost_reason_note), '');
  end if;
  return new;
end;
$$;
drop trigger if exists crm_deals_zz_lost_reason on public.crm_deals;
create trigger crm_deals_zz_lost_reason before insert or update on public.crm_deals
  for each row execute procedure public.crm_deals_lost_reason();

-- ---------------------------------------------------------------------------
-- 2) Sales targets (quota): one amount per month, per person or company-wide
-- ---------------------------------------------------------------------------
create table if not exists public.crm_sales_targets (
  id           uuid primary key default gen_random_uuid(),
  company      text,
  owner_id     uuid references public.profiles(id) on delete cascade,   -- null = the whole company
  period_start date not null,                                          -- first day of the month
  amount       numeric(14,2) not null default 0,
  currency     text not null default 'INR',
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.crm_sales_targets drop constraint if exists crm_sales_targets_ck;
alter table public.crm_sales_targets add constraint crm_sales_targets_ck
  check (amount >= 0 and extract(day from period_start) = 1 and company is not null);
create unique index if not exists crm_sales_targets_uidx
  on public.crm_sales_targets (company, coalesce(owner_id::text, '*'), period_start);
drop trigger if exists crm_sales_targets_fill on public.crm_sales_targets;
create trigger crm_sales_targets_fill before insert on public.crm_sales_targets
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_sales_targets_touch on public.crm_sales_targets;
create trigger crm_sales_targets_touch before update on public.crm_sales_targets
  for each row execute procedure public.ws_touch_updated_at();

alter table public.crm_sales_targets enable row level security;
drop policy if exists crm_sales_targets_read on public.crm_sales_targets;
create policy crm_sales_targets_read on public.crm_sales_targets for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists crm_sales_targets_manage on public.crm_sales_targets;
create policy crm_sales_targets_manage on public.crm_sales_targets for all to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()))
  with check ((select public.ws_same_company(company)) and (select public.ws_is_manager()));

-- ---------------------------------------------------------------------------
-- 3) Quotes
--    Same money rules as invoices (supabase-invoices-migration.sql):
--      line_subtotal = round(quantity * unit_price, 2)
--      line_discount = round(line_subtotal * discount_pct / 100, 2)
--      line_tax      = round((line_subtotal - line_discount) * tax_rate / 100, 2)
--      line_total    = line_subtotal - line_discount + line_tax
--    Status: draft -> sent -> accepted | declined. "Expired" is derived by the
--    page (sent and past valid_until), never stored.
-- ---------------------------------------------------------------------------
create table if not exists public.crm_quote_counters (
  company  text not null,
  year     int  not null,
  last_no  int  not null default 0,
  primary key (company, year)
);
alter table public.crm_quote_counters enable row level security;   -- touched only through next_quote_number()

create table if not exists public.crm_quotes (
  id              uuid primary key default gen_random_uuid(),
  company         text,
  quote_number    text unique,
  deal_id         uuid not null references public.crm_deals(id) on delete cascade,
  contact_id      uuid references public.crm_contacts(id) on delete set null,
  company_id      uuid references public.crm_companies(id) on delete set null,
  subject         text,
  bill_to_name    text,
  bill_to_email   text,
  bill_to_address text,
  quote_date      date not null default ((now() at time zone 'Asia/Kolkata')::date),
  valid_until     date,
  status          text not null default 'draft',
  currency        text not null default 'INR',
  subtotal        numeric(14,2) not null default 0,
  discount_total  numeric(14,2) not null default 0,
  tax_total       numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  notes           text,
  terms           text,
  sent_at         timestamptz,
  accepted_at     timestamptz,
  declined_at     timestamptz,
  invoice_id      uuid references public.invoices(id) on delete set null,
  responsible_id  uuid references public.profiles(id) on delete set null,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.crm_quotes drop constraint if exists crm_quotes_status_ck;
alter table public.crm_quotes add constraint crm_quotes_status_ck check (status in ('draft', 'sent', 'accepted', 'declined'));
alter table public.crm_quotes drop constraint if exists crm_quotes_dates_ck;
alter table public.crm_quotes add constraint crm_quotes_dates_ck check (valid_until is null or valid_until >= quote_date);
create index if not exists crm_quotes_deal_idx    on public.crm_quotes (deal_id, created_at desc);
create index if not exists crm_quotes_company_idx on public.crm_quotes (company, status, quote_date desc);
create index if not exists crm_quotes_contact_idx on public.crm_quotes (contact_id) where contact_id is not null;

create table if not exists public.crm_quote_items (
  id             uuid primary key default gen_random_uuid(),
  quote_id       uuid not null references public.crm_quotes(id) on delete cascade,
  product_id     uuid references public.crm_products(id) on delete set null,
  position       int not null default 0,
  description    text not null,
  quantity       numeric(12,3) not null default 1,
  unit_price     numeric(14,2) not null default 0,
  discount_pct   numeric(5,2) not null default 0,
  tax_rate       numeric(5,2) not null default 0,
  line_subtotal  numeric(14,2) not null default 0,
  line_discount  numeric(14,2) not null default 0,
  line_tax       numeric(14,2) not null default 0,
  line_total     numeric(14,2) not null default 0,
  created_at     timestamptz not null default now()
);
alter table public.crm_quote_items drop constraint if exists crm_quote_items_values_ck;
alter table public.crm_quote_items add constraint crm_quote_items_values_ck
  check (quantity >= 0 and unit_price >= 0 and discount_pct between 0 and 100 and tax_rate between 0 and 100);
create index if not exists crm_quote_items_quote_idx on public.crm_quote_items (quote_id, position);

-- Q-<year>-<0001>, one sequence per company per year.
create or replace function public.next_quote_number(p_company text, p_date date default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date))::int;
  v_no int;
begin
  insert into public.crm_quote_counters (company, year, last_no)
  values (coalesce(p_company, '*'), v_year, 1)
  on conflict (company, year) do update set last_no = public.crm_quote_counters.last_no + 1
  returning last_no into v_no;
  return 'Q-' || v_year || '-' || lpad(v_no::text, 4, '0');
end;
$$;
revoke all on function public.next_quote_number(text, date) from public, anon, authenticated;

create or replace function public.crm_quote_items_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  if tg_op = 'UPDATE' and new.quote_id is distinct from old.quote_id then
    raise exception 'A line cannot move to another quote';
  end if;
  select status into v_status from public.crm_quotes where id = new.quote_id;
  if v_status is null then raise exception 'Quote not found'; end if;
  if v_status <> 'draft' then raise exception 'Quote lines can only be changed while the quote is a draft'; end if;
  new.description   := btrim(new.description);
  if new.description = '' then raise exception 'Every quote line needs a description'; end if;
  new.line_subtotal := round(new.quantity * new.unit_price, 2);
  new.line_discount := round(new.line_subtotal * new.discount_pct / 100, 2);
  new.line_tax      := round((new.line_subtotal - new.line_discount) * new.tax_rate / 100, 2);
  new.line_total    := new.line_subtotal - new.line_discount + new.line_tax;
  return new;
end;
$$;
drop trigger if exists crm_quote_items_compute on public.crm_quote_items;
create trigger crm_quote_items_compute before insert or update on public.crm_quote_items
  for each row execute procedure public.crm_quote_items_before_write();

create or replace function public.crm_quote_items_before_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  select status into v_status from public.crm_quotes where id = old.quote_id;
  -- A cascade from a deleted quote has no header any more; let it through.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Quote lines can only be removed while the quote is a draft';
  end if;
  return old;
end;
$$;
drop trigger if exists crm_quote_items_guard_delete on public.crm_quote_items;
create trigger crm_quote_items_guard_delete before delete on public.crm_quote_items
  for each row execute procedure public.crm_quote_items_before_delete();

create or replace function public.crm_quote_recalc(p_quote uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare s_sub numeric(14,2); s_disc numeric(14,2); s_tax numeric(14,2); s_tot numeric(14,2);
begin
  select coalesce(sum(line_subtotal), 0), coalesce(sum(line_discount), 0), coalesce(sum(line_tax), 0), coalesce(sum(line_total), 0)
    into s_sub, s_disc, s_tax, s_tot
    from public.crm_quote_items where quote_id = p_quote;
  perform set_config('ws.quote_recalc', '1', true);
  update public.crm_quotes set subtotal = s_sub, discount_total = s_disc, tax_total = s_tax, total = s_tot where id = p_quote;
  perform set_config('ws.quote_recalc', '', true);
end;
$$;
revoke all on function public.crm_quote_recalc(uuid) from public, anon, authenticated;

create or replace function public.crm_quote_items_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.crm_quote_recalc(coalesce(new.quote_id, old.quote_id));
  return null;
end;
$$;
drop trigger if exists crm_quote_items_recalc on public.crm_quote_items;
create trigger crm_quote_items_recalc after insert or update or delete on public.crm_quote_items
  for each row execute procedure public.crm_quote_items_after_change();

-- Header: number, company and deal on insert; money columns and status rules on update.
create or replace function public.crm_quotes_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare d record;
begin
  if tg_op = 'INSERT' then
    select company, owner_id into d from public.crm_deals where id = new.deal_id;
    if not found then raise exception 'Deal not found'; end if;
    new.company := d.company;                     -- a quote lives in its deal's company
    if new.created_by is null then new.created_by := auth.uid(); end if;
    new.responsible_id := coalesce(new.responsible_id, d.owner_id, new.created_by);
    if new.quote_number is null or btrim(new.quote_number) = '' then
      new.quote_number := public.next_quote_number(new.company, new.quote_date);
    end if;
    new.status := 'draft';
    new.subtotal := 0; new.discount_total := 0; new.tax_total := 0; new.total := 0;
    new.sent_at := null; new.accepted_at := null; new.declined_at := null; new.invoice_id := null;
    return new;
  end if;

  -- crm_quote_recalc() and crm_quote_to_invoice() flag their own writes.
  if current_setting('ws.quote_recalc', true) = '1' then return new; end if;

  new.subtotal := old.subtotal; new.discount_total := old.discount_total; new.tax_total := old.tax_total; new.total := old.total;
  new.quote_number := old.quote_number; new.company := old.company; new.deal_id := old.deal_id;
  new.created_by := old.created_by; new.invoice_id := old.invoice_id;
  new.sent_at := old.sent_at; new.accepted_at := old.accepted_at; new.declined_at := old.declined_at;

  if new.status is distinct from old.status then
    if old.status = 'accepted' and old.invoice_id is not null then
      raise exception 'This quote has been invoiced and can no longer change status';
    end if;
    if new.status in ('sent', 'accepted', 'declined') and old.status = 'draft'
       and not exists (select 1 from public.crm_quote_items where quote_id = new.id) then
      raise exception 'Add at least one line before sending the quote';
    end if;
    if new.status = 'sent' and old.status = 'draft' then
      new.sent_at := now();
    elsif new.status = 'draft' then
      new.sent_at := null; new.accepted_at := null; new.declined_at := null;
    elsif new.status = 'accepted' and old.status in ('draft', 'sent') then
      new.sent_at := coalesce(old.sent_at, now()); new.accepted_at := now();
    elsif new.status = 'declined' and old.status in ('draft', 'sent') then
      new.sent_at := coalesce(old.sent_at, now()); new.declined_at := now();
    else
      raise exception 'A quote cannot go from % to %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists crm_quotes_rules on public.crm_quotes;
create trigger crm_quotes_rules before insert or update on public.crm_quotes
  for each row execute procedure public.crm_quotes_before_write();
drop trigger if exists crm_quotes_touch on public.crm_quotes;
create trigger crm_quotes_touch before update on public.crm_quotes
  for each row execute procedure public.ws_touch_updated_at();

create or replace function public.crm_quotes_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('quote.created', 'quote', new.id, new.quote_number,
      jsonb_build_object('currency', new.currency), new.company, new.contact_id, null, new.deal_id);
  elsif new.status is distinct from old.status then
    perform public.crm_log('quote.' || new.status, 'quote', new.id, new.quote_number,
      jsonb_build_object('from', old.status, 'to', new.status, 'total', new.total, 'currency', new.currency),
      new.company, new.contact_id, null, new.deal_id);
  end if;
  return new;
end;
$$;
drop trigger if exists crm_quotes_log on public.crm_quotes;
create trigger crm_quotes_log after insert or update on public.crm_quotes
  for each row execute procedure public.crm_quotes_after_change();

create or replace function public.ws_quote_editable(p_quote uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.crm_quotes q where q.id = p_quote and public.ws_deal_editable(q.deal_id));
$$;
revoke all on function public.ws_quote_editable(uuid) from public, anon;
grant execute on function public.ws_quote_editable(uuid) to authenticated;

alter table public.crm_quotes      enable row level security;
alter table public.crm_quote_items enable row level security;
drop policy if exists crm_quotes_select on public.crm_quotes;
create policy crm_quotes_select on public.crm_quotes for select to authenticated
  using (exists (select 1 from public.crm_deals d where d.id = deal_id));
drop policy if exists crm_quotes_insert on public.crm_quotes;
create policy crm_quotes_insert on public.crm_quotes for insert to authenticated
  with check (created_by = auth.uid() and public.ws_deal_editable(deal_id));
drop policy if exists crm_quotes_update on public.crm_quotes;
create policy crm_quotes_update on public.crm_quotes for update to authenticated
  using (public.ws_deal_editable(deal_id)) with check (public.ws_deal_editable(deal_id));
drop policy if exists crm_quotes_delete on public.crm_quotes;
create policy crm_quotes_delete on public.crm_quotes for delete to authenticated
  using (public.ws_deal_editable(deal_id) and status = 'draft');
drop policy if exists crm_quote_items_select on public.crm_quote_items;
create policy crm_quote_items_select on public.crm_quote_items for select to authenticated
  using (exists (select 1 from public.crm_quotes q where q.id = quote_id));
drop policy if exists crm_quote_items_manage on public.crm_quote_items;
create policy crm_quote_items_manage on public.crm_quote_items for all to authenticated
  using (public.ws_quote_editable(quote_id)) with check (public.ws_quote_editable(quote_id));

/** A draft quote for a deal: its customer, currency and product lines (or one line for the amount). */
create or replace function public.crm_quote_from_deal(p_deal uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  d  public.crm_deals%rowtype;
  c  public.crm_contacts%rowtype;       -- rowtypes: fields read as null when there is no contact/company
  co public.crm_companies%rowtype;
  v_id uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if auth.uid() is null or not public.ws_deal_editable(p_deal) then
    raise exception 'You may not create quotes for this deal' using errcode = '42501';
  end if;
  select * into d from public.crm_deals where id = p_deal;
  if d.contact_id is not null then select * into c from public.crm_contacts where id = d.contact_id; end if;
  if d.company_id is not null then select * into co from public.crm_companies where id = d.company_id; end if;

  insert into public.crm_quotes (deal_id, contact_id, company_id, subject, bill_to_name, bill_to_email, bill_to_address,
                                 quote_date, valid_until, currency, responsible_id, created_by)
  values (d.id, d.contact_id, d.company_id, d.title,
          coalesce(co.title, nullif(c.organization, ''), c.full_name, d.organization, d.title),
          coalesce(co.email, c.email),
          nullif(concat_ws(', ', nullif(coalesce(co.address, c.address), ''), nullif(coalesce(co.city, c.city), ''),
                           nullif(coalesce(co.state, c.state), ''), nullif(coalesce(co.postal_code, c.postal_code), ''),
                           nullif(coalesce(co.country, c.country), '')), ''),
          v_today, v_today + 30, d.currency, d.owner_id, auth.uid())
  returning id into v_id;

  insert into public.crm_quote_items (quote_id, product_id, position, description, quantity, unit_price, discount_pct, tax_rate)
  select v_id, p.product_id, row_number() over (order by p.position, p.created_at), p.name, p.quantity, p.price, p.discount_pct, p.tax_rate
    from public.crm_deal_products p where p.deal_id = d.id;
  if not found and d.value > 0 then
    insert into public.crm_quote_items (quote_id, position, description, quantity, unit_price)
    values (v_id, 1, d.title, 1, d.value);
  end if;
  return v_id;
end;
$$;
revoke all on function public.crm_quote_from_deal(uuid) from public, anon;
grant execute on function public.crm_quote_from_deal(uuid) to authenticated;

/** A draft invoice from an accepted quote (once; a second call returns the same invoice). */
create or replace function public.crm_quote_to_invoice(p_quote uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.crm_quotes%rowtype;
  v_inv uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into q from public.crm_quotes where id = p_quote for update;
  if not found or auth.uid() is null or not public.ws_deal_editable(q.deal_id) then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.invoice_id is not null and exists (select 1 from public.invoices where id = q.invoice_id) then
    return q.invoice_id;
  end if;
  if q.status <> 'accepted' then
    raise exception 'Only an accepted quote can be turned into an invoice';
  end if;
  if not public.ws_crm_can_add('invoice', null) then
    raise exception 'You may not create invoices' using errcode = '42501';
  end if;

  insert into public.invoices (company, contact_id, company_id, deal_id, subject, bill_to_name, bill_to_address, bill_to_email,
                               invoice_date, due_date, status, currency, notes, terms, responsible_id, created_by)
  values (q.company, q.contact_id, q.company_id, q.deal_id, coalesce(q.subject, q.quote_number), q.bill_to_name, q.bill_to_address, q.bill_to_email,
          v_today, v_today + 15, 'draft', q.currency, q.notes, q.terms, coalesce(q.responsible_id, auth.uid()), auth.uid())
  returning id into v_inv;
  insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, discount_pct, tax_rate)
  select v_inv, position, description, quantity, unit_price, discount_pct, tax_rate
    from public.crm_quote_items where quote_id = q.id order by position;

  perform set_config('ws.quote_recalc', '1', true);
  update public.crm_quotes set invoice_id = v_inv where id = q.id;
  perform set_config('ws.quote_recalc', '', true);
  perform public.crm_log('quote.invoiced', 'quote', q.id, q.quote_number, jsonb_build_object('invoice_id', v_inv),
                         q.company, q.contact_id, null, q.deal_id);
  return v_inv;
end;
$$;
revoke all on function public.crm_quote_to_invoice(uuid) from public, anon;
grant execute on function public.crm_quote_to_invoice(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Web-to-lead forms
-- ---------------------------------------------------------------------------
create table if not exists public.crm_web_forms (
  id                 uuid primary key default gen_random_uuid(),
  company            text,
  name               text not null,
  public_token       text not null default replace(gen_random_uuid()::text, '-', ''),
  title              text,
  intro              text,
  fields             text[] not null default array['name', 'email', 'phone', 'organization', 'message'],
  required           text[] not null default array['name', 'email'],
  owner_id           uuid references public.profiles(id) on delete set null,
  source             text not null default 'Web form',
  success_message    text,
  redirect_url       text,
  active             boolean not null default true,
  submissions        int not null default 0,
  last_submission_at timestamptz,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.crm_web_forms drop constraint if exists crm_web_forms_ck;
alter table public.crm_web_forms add constraint crm_web_forms_ck check (
  company is not null
  and length(btrim(name)) between 1 and 120
  and length(public_token) >= 24
  and fields <@ array['name', 'email', 'phone', 'organization', 'message']
  and 'name' = any(fields)
  and required <@ fields
  and 'name' = any(required)
  and (redirect_url is null or redirect_url ~ '^https://[^\s<>"]+$'));
create unique index if not exists crm_web_forms_token_uidx on public.crm_web_forms (public_token);
create index if not exists crm_web_forms_company_idx on public.crm_web_forms (company);
drop trigger if exists crm_web_forms_fill on public.crm_web_forms;
create trigger crm_web_forms_fill before insert on public.crm_web_forms
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_web_forms_touch on public.crm_web_forms;
create trigger crm_web_forms_touch before update on public.crm_web_forms
  for each row execute procedure public.ws_touch_updated_at();

alter table public.crm_web_forms enable row level security;
drop policy if exists crm_web_forms_read on public.crm_web_forms;
create policy crm_web_forms_read on public.crm_web_forms for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists crm_web_forms_manage on public.crm_web_forms;
create policy crm_web_forms_manage on public.crm_web_forms for all to authenticated
  using ((select public.ws_is_admin())
         or (company = any((select public.ws_my_companies())::text[]) and public.ws_crm_rank((select public.ws_crm_levels('settings', 'edit')) ->> '*') > 0))
  with check ((select public.ws_is_admin())
         or (company = any((select public.ws_my_companies())::text[]) and public.ws_crm_rank((select public.ws_crm_levels('settings', 'edit')) ->> '*') > 0));

-- Submission bookkeeping for rate limits; nobody reads it through the API.
create table if not exists public.crm_web_form_hits (
  id       uuid primary key default gen_random_uuid(),
  form_id  uuid not null references public.crm_web_forms(id) on delete cascade,
  client   text not null,
  at       timestamptz not null default now()
);
create index if not exists crm_web_form_hits_idx on public.crm_web_form_hits (form_id, at);
alter table public.crm_web_form_hits enable row level security;

/** What the public form page shows. Anyone may call it. */
create or replace function public.crm_web_form_public(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('title', coalesce(nullif(f.title, ''), f.name), 'intro', f.intro, 'fields', to_jsonb(f.fields),
                            'required', to_jsonb(f.required), 'company', f.company)
    from public.crm_web_forms f
   where p_token is not null and length(p_token) >= 24 and f.public_token = p_token and f.active;
$$;
revoke all on function public.crm_web_form_public(text) from public;
grant execute on function public.crm_web_form_public(text) to anon, authenticated;

/** A visitor's submission becomes a lead owned by the form's responsible person. Anyone may call it. */
create or replace function public.crm_web_form_submit(p_token text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  f        public.crm_web_forms%rowtype;
  v_client text;
  v_ip     text;
  v_name   text; v_email text; v_phone text; v_org text; v_msg text;
  v_lead   uuid;
  v_done   jsonb;
begin
  select * into f from public.crm_web_forms
   where p_token is not null and length(p_token) >= 24 and public_token = p_token and active;
  if not found then raise exception 'This form is not available' using errcode = 'P0002'; end if;
  v_done := jsonb_build_object('ok', true,
    'message', coalesce(nullif(f.success_message, ''), 'Thank you. We will be in touch shortly.'), 'redirect_url', f.redirect_url);
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'Invalid submission' using errcode = '22023'; end if;
  -- Bots fill the hidden "website" field; they get the thank-you and nothing is stored.
  if coalesce(p_data ->> 'website', '') <> '' then return v_done; end if;

  -- Per-visitor and per-form limits. PostgREST passes the request headers.
  begin
    v_ip := btrim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for', ''), ',', 1));
  exception when others then v_ip := '';
  end;
  v_client := md5(coalesce(v_ip, '') || ':' || f.id::text);
  if (select count(*) from public.crm_web_form_hits h where h.form_id = f.id and h.client = v_client and h.at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many submissions from this device. Try again in a few minutes.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.crm_web_form_hits h where h.form_id = f.id and h.at > now() - interval '1 hour') >= 300 then
    raise exception 'This form is busy. Try again later.' using errcode = 'P0001';
  end if;

  v_name  := left(btrim(regexp_replace(coalesce(p_data ->> 'name', ''), '[[:cntrl:]]', ' ', 'g')), 200);
  v_email := case when 'email' = any(f.fields) then lower(left(btrim(coalesce(p_data ->> 'email', '')), 254)) end;
  v_phone := case when 'phone' = any(f.fields) then left(btrim(regexp_replace(coalesce(p_data ->> 'phone', ''), '[^0-9+() .-]', '', 'g')), 40) end;
  v_org   := case when 'organization' = any(f.fields) then left(btrim(regexp_replace(coalesce(p_data ->> 'organization', ''), '[[:cntrl:]]', ' ', 'g')), 200) end;
  v_msg   := case when 'message' = any(f.fields) then left(btrim(coalesce(p_data ->> 'message', '')), 4000) end;
  v_email := nullif(v_email, ''); v_phone := nullif(v_phone, ''); v_org := nullif(v_org, ''); v_msg := nullif(v_msg, '');

  if v_name = '' then raise exception 'Enter your name' using errcode = 'P0001'; end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address' using errcode = 'P0001';
  end if;
  if 'email' = any(f.required) and v_email is null then raise exception 'Enter your email address' using errcode = 'P0001'; end if;
  if 'phone' = any(f.required) and v_phone is null then raise exception 'Enter your phone number' using errcode = 'P0001'; end if;
  if 'organization' = any(f.required) and v_org is null then raise exception 'Enter your company' using errcode = 'P0001'; end if;
  if 'message' = any(f.required) and v_msg is null then raise exception 'Enter a message' using errcode = 'P0001'; end if;

  insert into public.crm_web_form_hits (form_id, client) values (f.id, v_client);
  -- Keep the bookkeeping small: a day of history is all the limits read.
  delete from public.crm_web_form_hits where at < now() - interval '1 day';

  insert into public.crm_leads (company, name, organization, email, phone, source, source_detail, owner_id, notes, created_by)
  values (f.company, v_name, v_org, v_email, v_phone, f.source, f.name, f.owner_id, v_msg, coalesce(f.owner_id, f.created_by))
  returning id into v_lead;
  update public.crm_web_forms set submissions = submissions + 1, last_submission_at = now() where id = f.id;
  return v_done;
end;
$$;
revoke all on function public.crm_web_form_submit(text, jsonb) from public;
grant execute on function public.crm_web_form_submit(text, jsonb) to anon, authenticated;

-- Realtime for the quote list.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crm_quotes') then
    alter publication supabase_realtime add table public.crm_quotes;
  end if;
end$$;

-- Done.
