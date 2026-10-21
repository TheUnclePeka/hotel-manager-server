-- Счётчики коммунальных услуг и туристический налог.

alter table bookings add column tourist_tax_exempt boolean not null default false;

create table meters (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  kind text not null,
  unit text not null,
  tariff numeric(12,4),
  room_id uuid references rooms(id),
  remind_day int,
  notes text,
  is_active boolean not null default true,
  sort_order int
);

create table meter_readings (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  meter_id uuid not null references meters(id) on delete cascade,
  date date not null,
  value numeric(16,3) not null,
  price numeric(12,4),
  is_reset boolean not null default false,
  comment text,
  create_expense boolean
);
create index meter_readings_meter_idx on meter_readings (meter_id, date);

alter table expenses add column meter_reading_id uuid references meter_readings(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['meters', 'meter_readings'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function touch_row()', t || '_touch', t);
    execute format('create index %I on %I (version)', t || '_version_idx', t);
  end loop;
end $$;

-- Расход по каждому показанию: разница с предыдущим показанием того же счётчика.
-- При замене счётчика (is_reset) расход не считается.
create view meter_usage as
select r.id as reading_id, r.meter_id, r.date, r.value,
       prev.date as prev_date, prev.value as prev_value,
       case when r.is_reset or prev.value is null then null else r.value - prev.value end as usage,
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

insert into settings (key, value) values
  ('touristTax', '{"enabled":false,"rates":{"2025":1,"2026":2,"2027":3,"2028":4,"2029":5},"minPerNight":100,"mode":"included"}')
  on conflict (key) do nothing;
