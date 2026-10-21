-- Итоги по броням: та же логика, что и bookingTotals() в packages/shared/src/pricing.ts.

create view booking_totals as
select t.*,
       round(t.living + t.services - t.discount + t.withheld, 2) as total,
       round(t.payments + t.withheld, 2) as paid,
       round(t.living + t.services - t.discount - t.payments, 2) as balance
  from (
    select b.id as booking_id,
           coalesce(s.living, 0)::numeric as living,
           case when coalesce(s.active, false) then coalesce(c.services, 0) else 0 end::numeric as services,
           case when coalesce(s.active, false) then b.discount else 0 end::numeric as discount,
           coalesce(d.withheld, 0)::numeric as withheld,
           coalesce(p.paid, 0)::numeric as payments,
           coalesce(d.held, 0)::numeric as deposit_held,
           coalesce(s.active, false) as active
      from bookings b
      left join lateral (
        select sum(case when st.status in ('tentative','confirmed','checked_in','checked_out')
                        then (select coalesce(sum((n->>'price')::numeric), 0) from jsonb_array_elements(st.nights) n)
                        else 0 end) as living,
               bool_or(st.status in ('tentative','confirmed','checked_in','checked_out')) as active
          from stays st where st.booking_id = b.id and st.deleted_at is null
      ) s on true
      left join lateral (
        select sum(qty * price) as services from charges where booking_id = b.id and deleted_at is null
      ) c on true
      left join lateral (
        select sum(amount) as paid from payments where booking_id = b.id and deleted_at is null
      ) p on true
      left join lateral (
        select sum(withheld_amount) as withheld,
               sum(case when returned_at is null then amount - withheld_amount else 0 end) as held
          from deposits where booking_id = b.id and deleted_at is null
      ) d on true
     where b.deleted_at is null
  ) t;

-- Ночи размещений развёрнуто: одна строка на ночь (для отчётов).
create view stay_nights as
select st.id as stay_id, st.booking_id, st.room_id, st.status, st.persons,
       (n->>'date')::date as date, (n->>'price')::numeric as price
  from stays st, jsonb_array_elements(st.nights) n
 where st.deleted_at is null;
