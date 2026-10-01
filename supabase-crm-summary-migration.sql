-- ============================================================================
-- CRM totals computed by the database (migration 19). Run AFTER
-- supabase-document-links-migration.sql (18). Idempotent; adds functions only.
--
-- The CRM dashboard and the forecast used to download deals and add them up
-- in the browser: PostgREST stops at 1,000 rows (the forecast at 10,000), so
-- totals silently went short as the CRM grew (PERF-01), and the dashboard
-- added rupees to dollars and labelled the sum with the first deal's
-- currency (BUG-04).
--
-- These functions do the adding up in the database, per currency, never
-- converting one into another. They are SECURITY INVOKER: they run with the
-- caller's own Row Level Security, so a person's totals only ever include the
-- deals and leads they are allowed to see — the same rows the lists show.
-- ============================================================================

/**
 * Deal totals per currency, and open deals per stage and currency.
 * p_from / p_to bound won and lost deals by their close date (null: all time).
 * { currencies: [{ currency, open_count, open_value, weighted_value, won_count,
 *   won_value, lost_count, lost_value }], stages: [{ stage_id, currency, count,
 *   value }], open_count, won_count, lost_count }
 */
create or replace function public.crm_deal_summary(
  p_owner uuid default null, p_company text default null,
  p_from date default null, p_to date default null, p_pipeline uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with d as (
    select coalesce(nullif(currency, ''), 'INR') as currency, value, probability, status, stage_id, actual_close_date
      from public.crm_deals
     where archived_at is null
       and (p_owner is null or owner_id = p_owner)
       and (p_company is null or company = p_company)
       and (p_pipeline is null or pipeline_id = p_pipeline)
  ), closed as (
    select * from d
     where status in ('won', 'lost')
       and (p_from is null or actual_close_date >= p_from)
       and (p_to is null or actual_close_date <= p_to)
  ), per_currency as (
    select c.currency,
           count(*) filter (where o.status = 'open')                                                   as open_count,
           coalesce(sum(o.value) filter (where o.status = 'open'), 0)                                   as open_value,
           coalesce(sum(o.value * least(100, greatest(0, coalesce(o.probability, 0))) / 100.0)
                    filter (where o.status = 'open'), 0)                                               as weighted_value
      from (select distinct currency from d) c
      left join d o on o.currency = c.currency
     group by c.currency
  ), per_closed as (
    select currency,
           count(*) filter (where status = 'won')                   as won_count,
           coalesce(sum(value) filter (where status = 'won'), 0)    as won_value,
           count(*) filter (where status = 'lost')                  as lost_count,
           coalesce(sum(value) filter (where status = 'lost'), 0)   as lost_value
      from closed group by currency
  )
  select jsonb_build_object(
    'currencies', coalesce((
      select jsonb_agg(jsonb_build_object(
               'currency', p.currency, 'open_count', p.open_count, 'open_value', round(p.open_value, 2),
               'weighted_value', round(p.weighted_value, 2),
               'won_count', coalesce(c.won_count, 0), 'won_value', round(coalesce(c.won_value, 0), 2),
               'lost_count', coalesce(c.lost_count, 0), 'lost_value', round(coalesce(c.lost_value, 0), 2))
             order by p.open_count desc, p.open_value desc, p.currency)
        from per_currency p left join per_closed c on c.currency = p.currency
       where p.open_count > 0 or c.currency is not null), '[]'::jsonb),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('stage_id', stage_id, 'currency', currency, 'count', n, 'value', round(v, 2)))
        from (select stage_id, currency, count(*) n, coalesce(sum(value), 0) v from d where status = 'open' group by stage_id, currency) s), '[]'::jsonb),
    'open_count', (select count(*) from d where status = 'open'),
    'won_count',  (select count(*) from closed where status = 'won'),
    'lost_count', (select count(*) from closed where status = 'lost'));
$$;

/**
 * Lead counts: every non-archived lead by status, and the leads created in
 * [p_from, p_to) with how many of them were converted.
 */
create or replace function public.crm_lead_summary(
  p_owner uuid default null, p_company text default null,
  p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with l as (
    select status, converted_at, created_at from public.crm_leads
     where archived_at is null
       and (p_owner is null or owner_id = p_owner)
       and (p_company is null or company = p_company)
  ), created as (
    select * from l where (p_from is null or created_at >= p_from) and (p_to is null or created_at < p_to)
  )
  select jsonb_build_object(
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from l group by status) s), '{}'::jsonb),
    'total', (select count(*) from l),
    'created', (select count(*) from created),
    'created_converted', (select count(*) from created where status = 'converted' or converted_at is not null));
$$;

/**
 * The sales forecast in one currency (crm/forecast). Months are 'YYYY-MM'
 * keys, oldest first. Same categories as ui/crm-logic.js forecast():
 *   closed    won deals closed that month
 *   commit    open deals expected that month at >= p_commit probability
 *   best_case every open deal expected that month
 *   pipeline  probability-weighted open value expected that month
 * Open deals with no expected date, or one before the first month, are
 * `overdue`. `people` is the first month by owner; `win_loss` covers deals
 * closed since p_since.
 */
create or replace function public.crm_forecast_summary(
  p_months text[], p_since date, p_currency text default 'INR',
  p_owner uuid default null, p_pipeline uuid default null, p_commit int default 70)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with d as (
    select owner_id, value, least(100, greatest(0, coalesce(probability, 0))) as p, status,
           expected_close_date, actual_close_date, created_at, lost_reason,
           to_char(expected_close_date, 'YYYY-MM') as exp_m, to_char(actual_close_date, 'YYYY-MM') as act_m
      from public.crm_deals
     where archived_at is null and coalesce(nullif(currency, ''), 'INR') = p_currency
       and (p_owner is null or owner_id = p_owner)
       and (p_pipeline is null or pipeline_id = p_pipeline)
  ), months as (
    select m, ord from unnest(p_months) with ordinality as t(m, ord)
  ), per_month as (
    select months.m, months.ord,
           coalesce(sum(d.value) filter (where d.status = 'won' and d.act_m = months.m), 0)                    as closed,
           count(*) filter (where d.status = 'won' and d.act_m = months.m)                                     as won_count,
           coalesce(sum(d.value) filter (where d.status = 'open' and d.exp_m = months.m and d.p >= p_commit), 0) as commit_v,
           coalesce(sum(d.value) filter (where d.status = 'open' and d.exp_m = months.m), 0)                   as best_case,
           coalesce(sum(d.value * d.p / 100.0) filter (where d.status = 'open' and d.exp_m = months.m), 0)    as pipeline,
           count(*) filter (where d.status = 'open' and d.exp_m = months.m)                                    as open_count
      from months left join d on true
     group by months.m, months.ord
  ), wl as (
    select * from d where status in ('won', 'lost') and actual_close_date >= p_since
  )
  select jsonb_build_object(
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'closed', round(closed, 2), 'commit', round(commit_v, 2),
                          'bestCase', round(best_case, 2), 'pipeline', round(pipeline, 2), 'won_count', won_count, 'open_count', open_count) order by ord)
                        from per_month), '[]'::jsonb),
    'overdue', (select jsonb_build_object('count', count(*), 'value', round(coalesce(sum(value), 0), 2)) from d
                 where status = 'open' and (expected_close_date is null or exp_m < p_months[1])),
    'people', coalesce((select jsonb_agg(jsonb_build_object('owner_id', owner_id, 'closed', round(closed, 2), 'commit', round(commit_v, 2), 'pipeline', round(pipeline, 2)))
                         from (select owner_id,
                                      coalesce(sum(value) filter (where status = 'won' and act_m = p_months[1]), 0) as closed,
                                      coalesce(sum(value) filter (where status = 'open' and exp_m = p_months[1] and p >= p_commit), 0) as commit_v,
                                      coalesce(sum(value * p / 100.0) filter (where status = 'open' and exp_m = p_months[1]), 0) as pipeline
                                 from d where owner_id is not null group by owner_id) x
                        where closed <> 0 or commit_v <> 0 or pipeline <> 0), '[]'::jsonb),
    'win_loss', jsonb_build_object(
      'won', (select count(*) from wl where status = 'won'),
      'lost', (select count(*) from wl where status = 'lost'),
      'won_value', (select round(coalesce(sum(value), 0), 2) from wl where status = 'won'),
      'lost_value', (select round(coalesce(sum(value), 0), 2) from wl where status = 'lost'),
      'avg_cycle_days', (select round(avg(actual_close_date - (created_at at time zone 'Asia/Kolkata')::date))::int from wl
                          where status = 'won' and created_at is not null and actual_close_date >= (created_at at time zone 'Asia/Kolkata')::date),
      'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'count', n, 'value', round(v, 2)) order by n desc, v desc, reason)
                           from (select coalesce(nullif(btrim(lost_reason), ''), 'No reason given') reason, count(*) n, coalesce(sum(value), 0) v
                                   from wl where status = 'lost' group by 1) r), '[]'::jsonb)));
$$;

revoke execute on function public.crm_deal_summary(uuid, text, date, date, uuid),
  public.crm_lead_summary(uuid, text, timestamptz, timestamptz),
  public.crm_forecast_summary(text[], date, text, uuid, uuid, int) from public, anon;
grant execute on function public.crm_deal_summary(uuid, text, date, date, uuid),
  public.crm_lead_summary(uuid, text, timestamptz, timestamptz),
  public.crm_forecast_summary(text[], date, text, uuid, uuid, int) to authenticated, service_role;

select public.ws_apply_session_gate();

-- Done.
