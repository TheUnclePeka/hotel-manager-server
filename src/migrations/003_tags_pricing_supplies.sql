-- Метки броней, цены по дням недели и особым датам, минимальный срок, расходники.

alter table room_categories add column weekend_price numeric(12,2);
alter table seasons add column weekend_prices jsonb not null default '{}';
alter table seasons add column min_stay int;
alter table bookings add column tag_ids jsonb not null default '[]';

create table price_rules (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  date_from date not null,
  date_to date not null,
  prices jsonb not null default '{}',
  min_stay int,
  check (date_to >= date_from)
);

create table booking_tags (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  color text not null,
  sort_order int
);

create table supplies (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  unit text not null,
  category text,
  min_qty numeric(12,2) not null default 0,
  notes text,
  is_active boolean not null default true
);

create table supply_moves (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  supply_id uuid not null references supplies(id) on delete cascade,
  date date not null,
  kind text not null,
  qty numeric(12,2) not null,
  price numeric(12,2),
  supplier_id uuid references suppliers(id),
  room_id uuid references rooms(id),
  comment text,
  create_expense boolean
);
create index supply_moves_supply_idx on supply_moves (supply_id, date);

alter table expenses add column supply_move_id uuid references supply_moves(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['price_rules', 'booking_tags', 'supplies', 'supply_moves'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function touch_row()', t || '_touch', t);
    execute format('create index %I on %I (version)', t || '_version_idx', t);
  end loop;
end $$;

-- Остаток расходника: инвентаризация задаёт остаток, приход и списание после неё — прибавляют и вычитают.
create view supply_stock as
select s.id as supply_id,
       coalesce((
         select sum(case m.kind when 'in' then m.qty when 'out' then -m.qty else 0 end)
           from supply_moves m
          where m.supply_id = s.id and m.deleted_at is null
            and (lc.created_at is null or (m.date, m.created_at) > (lc.date, lc.created_at))
       ), 0) + coalesce(lc.qty, 0) as qty
  from supplies s
  left join lateral (
    select qty, date, created_at from supply_moves
     where supply_id = s.id and kind = 'count' and deleted_at is null
     order by date desc, created_at desc limit 1
  ) lc on true;

-- Начальные метки броней.
insert into booking_tags (name, color, sort_order) values
  ('Постоянный гость', 'teal', 1),
  ('С животными', 'orange', 2),
  ('Поздний заезд', 'indigo', 3),
  ('Ждём предоплату', 'yellow', 4),
  ('VIP', 'grape', 5);

insert into settings (key, value) values ('pricing', '{"weekendDays":[4,5],"holidaysAsWeekend":false}')
  on conflict (key) do nothing;
