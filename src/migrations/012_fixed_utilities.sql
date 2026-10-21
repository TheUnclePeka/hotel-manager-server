-- Фиксированные коммунальные услуги: количество периодов × цена, без разницы показаний.
create or replace view meter_usage as
select r.id as reading_id, r.meter_id, r.date, r.value,
       prev.date as prev_date, prev.value as prev_value,
       case when m.kind in ('waste', 'internet') then r.value when r.is_reset or prev.value is null then null else r.value - prev.value end as usage,
       coalesce(r.price, m.tariff) as price
  from meter_readings r
  join meters m on m.id = r.meter_id
  left join lateral (
    select p.date, p.value from meter_readings p
     where p.meter_id = r.meter_id and p.deleted_at is null
       and (p.date, p.created_at) < (r.date, r.created_at)
     order by p.date desc, p.created_at desc limit 1
  ) prev on true
 where r.deleted_at is null;

