-- Персонал и зарплата, скидка постоянным гостям, описания категорий номеров, налог ИП.

alter table room_categories add column description text;
alter table bookings add column loyalty_decision text;

create table staff (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  position text,
  phone text,
  pay_type text not null,
  rate numeric(12,2) not null default 0,
  notes text,
  is_active boolean not null default true,
  sort_order int
);

create table staff_accruals (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  staff_id uuid not null references staff(id) on delete cascade,
  date date not null,
  kind text not null,
  qty numeric(12,2) not null default 1,
  rate numeric(12,2) not null default 0,
  amount numeric(12,2) not null,
  comment text
);
create index staff_accruals_staff_idx on staff_accruals (staff_id, date);

create table staff_payments (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  staff_id uuid not null references staff(id) on delete cascade,
  date date not null,
  kind text not null,
  amount numeric(12,2) not null,
  method_id uuid references payment_methods(id),
  comment text,
  create_expense boolean
);
create index staff_payments_staff_idx on staff_payments (staff_id, date);

alter table expenses add column staff_payment_id uuid references staff_payments(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['staff', 'staff_accruals', 'staff_payments'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function touch_row()', t || '_touch', t);
    execute format('create index %I on %I (version)', t || '_version_idx', t);
  end loop;
end $$;

insert into settings (key, value) values
  ('incomeTax', '{"regime":"usn6","usn6Rate":6,"usn15Rate":15,"npdRate":4,"hasEmployees":false,"contributionsCategory":"Страховые взносы"}'),
  ('loyalty', '{"enabled":true,"levels":[{"visit":2,"percent":5},{"visit":4,"percent":10}]}')
  on conflict (key) do nothing;
