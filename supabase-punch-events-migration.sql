-- ============================================================
-- Name the event on punches already in the table
--
-- The reader only ever sent a timestamp and sometimes a direction, so every
-- biometric row landed with event_type null and the screens could only say
-- "IN" / "OUT". New punches are now labelled as they arrive; this fills in
-- the history so the calendar and the punch list read the same way for
-- yesterday as for today.
--
-- The rule is the exact one, not the punch-time guess: within one person's
-- IST day the first IN is the Login, the last OUT is the Logout, and
-- everything between is a break. Whole days are visible here, so there is no
-- need for the shift-end heuristic the live path uses.
--
-- Only touches rows where event_type IS NULL, so selfie punches - which
-- always carried a real event - are left exactly as they are. Re-running it
-- is a no-op.
--
-- To undo:  update public.attendance_logs set event_type = null
--             where source = 'biometric';
--
-- Run ONCE in Supabase -> SQL Editor.
-- ============================================================

with ranked as (
  select
    id,
    direction,
    log_datetime,
    -- how many INs have been seen up to and including this row, that day
    sum(case when direction = 'IN' then 1 else 0 end) over (
      partition by user_id, log_date
      order by log_datetime
      rows between unbounded preceding and current row
    ) as ins_so_far,
    -- the day's final OUT, so it can be told apart from a break
    max(case when direction = 'OUT' then log_datetime end) over (
      partition by user_id, log_date
    ) as last_out
  from public.attendance_logs
  where event_type is null
    and user_id is not null
    and direction in ('IN', 'OUT')
)
update public.attendance_logs a
   set event_type = case
         when r.direction = 'IN'  and r.ins_so_far = 1        then 'LOGIN'
         when r.direction = 'IN'                              then 'BREAK_IN'
         when r.direction = 'OUT' and r.log_datetime = r.last_out then 'LOGOUT'
         when r.direction = 'OUT'                             then 'BREAK_OUT'
       end
  from ranked r
 where a.id = r.id;
