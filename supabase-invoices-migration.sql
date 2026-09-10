-- ============================================================================
-- Invoices: header, line items, payments, and deterministic totals.
--
-- Run THIRD of the CRM set (after foundation + work). Idempotent; adds only.
--
-- Money rules, all enforced in the database so a client cannot post its own
-- arithmetic:
--   line_subtotal = round(quantity * unit_price, 2)
--   line_discount = round(line_subtotal * discount_pct / 100, 2)
--   line_tax      = round((line_subtotal - line_discount) * tax_rate / 100, 2)
--   line_total    = line_subtotal - line_discount + line_tax
--   invoice.subtotal / discount_total / tax_total / total = sums of the lines
--   amount_paid   = sum(payments), balance = total - amount_paid
-- ui/crm-logic.js carries the same formulas for previews and is unit-tested
-- against the same rounding.
--
-- Access: managers/admins of the company administer invoices; the person who
-- created an invoice can still read it. Ordinary employees do not see them.
-- ============================================================================

create table if not exists public.invoice_counters (
  company  text not null,
  year     int  not null,
  last_no  int  not null default 0,
  primary key (company, year)
);
alter table public.invoice_counters enable row level security;   -- touched only through next_invoice_number()

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  company         text,
  invoice_number  text unique,
  contact_id      uuid references public.crm_contacts(id) on delete set null,
  deal_id         uuid references public.crm_deals(id) on delete set null,
  project_id      uuid references public.projects(id) on delete set null,
  bill_to_name    text,                          -- snapshot of the customer at issue time
  bill_to_address text,
  bill_to_email   text,
  invoice_date    date not null default current_date,
  due_date        date,
  status          text not null default 'draft',
  currency        text not null default 'INR',
  subtotal        numeric(14,2) not null default 0,
  discount_total  numeric(14,2) not null default 0,
  tax_total       numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  amount_paid     numeric(14,2) not null default 0,
  balance         numeric(14,2) not null default 0,
  notes           text,
  terms           text,
  sent_at         timestamptz,
  paid_at         timestamptz,
  cancelled_at    timestamptz,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.invoices drop constraint if exists invoices_status_ck;
alter table public.invoices add constraint invoices_status_ck
  check (status in ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled'));
alter table public.invoices drop constraint if exists invoices_dates_ck;
alter table public.invoices add constraint invoices_dates_ck
  check (due_date is null or due_date >= invoice_date);

create index if not exists invoices_company_idx on public.invoices (company, status, invoice_date desc);
create index if not exists invoices_contact_idx on public.invoices (contact_id) where contact_id is not null;
create index if not exists invoices_deal_idx    on public.invoices (deal_id) where deal_id is not null;
create index if not exists invoices_due_idx     on public.invoices (due_date) where status in ('sent', 'partially_paid', 'overdue');
create index if not exists invoices_number_idx  on public.invoices (lower(invoice_number));

create table if not exists public.invoice_items (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references public.invoices(id) on delete cascade,
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
alter table public.invoice_items drop constraint if exists invoice_items_qty_ck;
alter table public.invoice_items add constraint invoice_items_qty_ck check (quantity >= 0);
alter table public.invoice_items drop constraint if exists invoice_items_price_ck;
alter table public.invoice_items add constraint invoice_items_price_ck check (unit_price >= 0);
alter table public.invoice_items drop constraint if exists invoice_items_discount_ck;
alter table public.invoice_items add constraint invoice_items_discount_ck check (discount_pct between 0 and 100);
alter table public.invoice_items drop constraint if exists invoice_items_tax_ck;
alter table public.invoice_items add constraint invoice_items_tax_ck check (tax_rate between 0 and 100);
create index if not exists invoice_items_invoice_idx on public.invoice_items (invoice_id, position);

create table if not exists public.invoice_payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  amount      numeric(14,2) not null,
  paid_on     date not null default current_date,
  method      text,                               -- bank transfer, UPI, cash, cheque, card, other
  reference   text,
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.invoice_payments drop constraint if exists invoice_payments_amount_ck;
alter table public.invoice_payments add constraint invoice_payments_amount_ck check (amount > 0);
create index if not exists invoice_payments_invoice_idx on public.invoice_payments (invoice_id, paid_on);

-- ---------------------------------------------------------------------------
-- Numbering: INV-<year>-<0001>, one sequence per company per year.
-- ---------------------------------------------------------------------------
create or replace function public.next_invoice_number(p_company text, p_date date default current_date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from coalesce(p_date, current_date))::int;
  v_no int;
begin
  insert into public.invoice_counters (company, year, last_no)
  values (coalesce(p_company, '*'), v_year, 1)
  on conflict (company, year) do update set last_no = public.invoice_counters.last_no + 1
  returning last_no into v_no;
  return 'INV-' || v_year || '-' || lpad(v_no::text, 4, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Line arithmetic and header totals
-- ---------------------------------------------------------------------------
create or replace function public.invoice_items_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  select status into v_status from public.invoices where id = new.invoice_id;
  if v_status is null then raise exception 'Invoice not found'; end if;
  if v_status <> 'draft' then
    raise exception 'Line items can only be changed while the invoice is a draft';
  end if;
  new.line_subtotal := round(new.quantity * new.unit_price, 2);
  new.line_discount := round(new.line_subtotal * new.discount_pct / 100, 2);
  new.line_tax      := round((new.line_subtotal - new.line_discount) * new.tax_rate / 100, 2);
  new.line_total    := new.line_subtotal - new.line_discount + new.line_tax;
  return new;
end;
$$;
drop trigger if exists invoice_items_compute on public.invoice_items;
create trigger invoice_items_compute before insert or update on public.invoice_items
  for each row execute procedure public.invoice_items_before_write();

create or replace function public.invoice_items_before_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  select status into v_status from public.invoices where id = old.invoice_id;
  -- A cascade from a deleted invoice has no header row any more; let it through.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Line items can only be removed while the invoice is a draft';
  end if;
  return old;
end;
$$;
drop trigger if exists invoice_items_guard_delete on public.invoice_items;
create trigger invoice_items_guard_delete before delete on public.invoice_items
  for each row execute procedure public.invoice_items_before_delete();

/** Recompute header totals, paid amount, balance and derived status. */
create or replace function public.invoice_recalc(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  s_sub numeric(14,2); s_disc numeric(14,2); s_tax numeric(14,2); s_tot numeric(14,2); s_paid numeric(14,2);
  v_status text;
begin
  select * into inv from public.invoices where id = p_invoice for update;
  if inv is null then return; end if;
  select coalesce(sum(line_subtotal), 0), coalesce(sum(line_discount), 0), coalesce(sum(line_tax), 0), coalesce(sum(line_total), 0)
    into s_sub, s_disc, s_tax, s_tot
    from public.invoice_items where invoice_id = p_invoice;
  select coalesce(sum(amount), 0) into s_paid from public.invoice_payments where invoice_id = p_invoice;

  v_status := inv.status;
  if v_status not in ('draft', 'cancelled') then
    if s_tot > 0 and s_paid >= s_tot then v_status := 'paid';
    elsif s_paid > 0 then v_status := 'partially_paid';
    elsif inv.due_date is not null and inv.due_date < current_date then v_status := 'overdue';
    else v_status := 'sent';
    end if;
  end if;

  perform set_config('ws.invoice_recalc', '1', true);
  update public.invoices
     set subtotal = s_sub, discount_total = s_disc, tax_total = s_tax, total = s_tot,
         amount_paid = s_paid, balance = s_tot - s_paid, status = v_status,
         paid_at = case when v_status = 'paid' then coalesce(paid_at, now()) else null end
   where id = p_invoice;
  perform set_config('ws.invoice_recalc', '', true);
end;
$$;

create or replace function public.invoice_children_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.invoice_recalc(coalesce(new.invoice_id, old.invoice_id));
  return null;
end;
$$;
drop trigger if exists invoice_items_recalc on public.invoice_items;
create trigger invoice_items_recalc after insert or update or delete on public.invoice_items
  for each row execute procedure public.invoice_children_after_change();
drop trigger if exists invoice_payments_recalc on public.invoice_payments;
create trigger invoice_payments_recalc after insert or update or delete on public.invoice_payments
  for each row execute procedure public.invoice_children_after_change();

-- Payments only against an issued invoice, never more than the balance.
create or replace function public.invoice_payments_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare inv record;
begin
  select status, balance into inv from public.invoices where id = new.invoice_id for update;
  if inv is null then raise exception 'Invoice not found'; end if;
  if inv.status not in ('sent', 'partially_paid', 'overdue') then
    raise exception 'Payments can only be recorded against a sent invoice';
  end if;
  if new.amount > inv.balance then
    raise exception 'Payment of % exceeds the outstanding balance of %', new.amount, inv.balance;
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end;
$$;
drop trigger if exists invoice_payments_guard on public.invoice_payments;
create trigger invoice_payments_guard before insert on public.invoice_payments
  for each row execute procedure public.invoice_payments_before_insert();

-- Header: number on insert, status transitions, totals are never client-set.
create or replace function public.invoices_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.created_by is null then new.created_by := auth.uid(); end if;
    if new.company is null then new.company := public.ws_company(); end if;
    if new.invoice_number is null or btrim(new.invoice_number) = '' then
      new.invoice_number := public.next_invoice_number(new.company, new.invoice_date);
    end if;
    if new.status not in ('draft', 'sent') then new.status := 'draft'; end if;
    -- Totals come from the lines; a fresh invoice has none yet.
    new.subtotal := 0; new.discount_total := 0; new.tax_total := 0; new.total := 0;
    new.amount_paid := 0; new.balance := 0;
    if new.status = 'sent' then new.sent_at := coalesce(new.sent_at, now()); end if;
    return new;
  end if;

  -- invoice_recalc() writes the money columns and the derived status itself;
  -- it flags the transaction so this guard steps aside for that one update.
  if current_setting('ws.invoice_recalc', true) = '1' then return new; end if;

  -- Money columns are owned by invoice_recalc(); ignore client values.
  new.subtotal := old.subtotal; new.discount_total := old.discount_total; new.tax_total := old.tax_total;
  new.total := old.total; new.amount_paid := old.amount_paid; new.balance := old.balance;
  new.invoice_number := old.invoice_number;
  new.created_by := old.created_by;

  if new.status is distinct from old.status then
    if old.status = 'cancelled' then
      raise exception 'A cancelled invoice cannot be reopened; duplicate it instead';
    end if;
    if old.status = 'paid' and new.status <> 'cancelled' then
      raise exception 'A paid invoice can only be cancelled';
    end if;
    if new.status = 'sent' and old.status = 'draft' then
      if not exists (select 1 from public.invoice_items where invoice_id = new.id) then
        raise exception 'Add at least one line before marking the invoice as sent';
      end if;
      new.sent_at := coalesce(new.sent_at, now());
    elsif new.status = 'draft' and old.status in ('sent', 'overdue') and old.amount_paid = 0 then
      -- Pull back an unsent-in-error invoice with no payments.
      new.sent_at := null;
    elsif new.status = 'cancelled' then
      new.cancelled_at := now();
    elsif new.status in ('paid', 'partially_paid', 'overdue') then
      -- Derived states are computed from payments and dates, never set by hand.
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists invoices_rules on public.invoices;
create trigger invoices_rules before insert or update on public.invoices
  for each row execute procedure public.invoices_before_write();

drop trigger if exists invoices_touch on public.invoices;
create trigger invoices_touch before update on public.invoices
  for each row execute procedure public.ws_touch_updated_at();

-- After a status change to sent/draft/cancelled the derived state may need a
-- second look (e.g. sent with a past due date is overdue at once).
create or replace function public.invoices_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('invoice.created', 'invoice', new.id, new.invoice_number,
      jsonb_build_object('status', new.status, 'currency', new.currency), new.company, new.contact_id, null, new.deal_id, new.project_id);
    return new;
  end if;
  if new.status is distinct from old.status then
    perform public.crm_log('invoice.status_changed', 'invoice', new.id, new.invoice_number,
      jsonb_build_object('from', old.status, 'to', new.status, 'total', new.total, 'balance', new.balance),
      new.company, new.contact_id, null, new.deal_id, new.project_id);
    if new.status = 'sent' and old.status = 'draft' then
      -- Sent from draft: recompute so a past due date reads as overdue immediately.
      perform public.invoice_recalc(new.id);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists invoices_log on public.invoices;
create trigger invoices_log after insert or update on public.invoices
  for each row execute procedure public.invoices_after_change();

create or replace function public.invoice_payments_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare inv record;
begin
  select id, invoice_number, company, contact_id, deal_id, project_id, currency into inv from public.invoices where id = new.invoice_id;
  perform public.crm_log('invoice.payment_recorded', 'invoice', inv.id, inv.invoice_number,
    jsonb_build_object('amount', new.amount, 'currency', inv.currency, 'method', new.method),
    inv.company, inv.contact_id, null, inv.deal_id, inv.project_id);
  return new;
end;
$$;
drop trigger if exists invoice_payments_log on public.invoice_payments;
create trigger invoice_payments_log after insert on public.invoice_payments
  for each row execute procedure public.invoice_payments_after_insert();

-- Duplicate an invoice as a fresh draft (same customer and lines, new number).
create or replace function public.invoice_duplicate(p_invoice uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  src public.invoices%rowtype;
  v_new uuid;
begin
  select * into src from public.invoices where id = p_invoice;
  if src is null then raise exception 'Invoice not found'; end if;
  if not (public.ws_same_company(src.company) and public.ws_is_manager()) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.invoices (company, contact_id, deal_id, project_id, bill_to_name, bill_to_address, bill_to_email,
                               invoice_date, due_date, status, currency, notes, terms, created_by)
  values (src.company, src.contact_id, src.deal_id, src.project_id, src.bill_to_name, src.bill_to_address, src.bill_to_email,
          current_date, case when src.due_date is null then null else current_date + (src.due_date - src.invoice_date) end,
          'draft', src.currency, src.notes, src.terms, auth.uid())
  returning id into v_new;
  insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, discount_pct, tax_rate)
  select v_new, position, description, quantity, unit_price, discount_pct, tax_rate
    from public.invoice_items where invoice_id = p_invoice order by position;
  return v_new;
end;
$$;
grant execute on function public.invoice_duplicate(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: finance is manager/admin territory
-- ---------------------------------------------------------------------------
alter table public.invoices         enable row level security;
alter table public.invoice_items    enable row level security;
alter table public.invoice_payments enable row level security;

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated
  using ((select public.ws_same_company(company)) and (created_by = auth.uid() or (select public.ws_is_manager())));
drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices for insert to authenticated
  with check ((select public.ws_same_company(company)) and (select public.ws_is_manager()) and created_by = auth.uid());
drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices for update to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()))
  with check ((select public.ws_same_company(company)));
drop policy if exists invoices_delete on public.invoices;
create policy invoices_delete on public.invoices for delete to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()) and status = 'draft');

drop policy if exists invoice_items_select on public.invoice_items;
create policy invoice_items_select on public.invoice_items for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.ws_same_company(i.company)
                   and (i.created_by = auth.uid() or public.ws_is_manager())));
drop policy if exists invoice_items_manage on public.invoice_items;
create policy invoice_items_manage on public.invoice_items for all to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.ws_same_company(i.company) and public.ws_is_manager()))
  with check (exists (select 1 from public.invoices i where i.id = invoice_id and public.ws_same_company(i.company) and public.ws_is_manager()));

drop policy if exists invoice_payments_select on public.invoice_payments;
create policy invoice_payments_select on public.invoice_payments for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.ws_same_company(i.company)
                   and (i.created_by = auth.uid() or public.ws_is_manager())));
drop policy if exists invoice_payments_insert on public.invoice_payments;
create policy invoice_payments_insert on public.invoice_payments for insert to authenticated
  with check (exists (select 1 from public.invoices i where i.id = invoice_id and public.ws_same_company(i.company) and public.ws_is_manager()));
drop policy if exists invoice_payments_delete on public.invoice_payments;
create policy invoice_payments_delete on public.invoice_payments for delete to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and public.ws_same_company(i.company) and public.ws_is_manager()));

-- Done. Next: supabase-messenger-migration.sql
