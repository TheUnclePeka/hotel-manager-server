-- HotelManager: начальная схема базы данных.
-- Все синхронизируемые таблицы имеют общие поля: id, version, created_at, updated_at, deleted_at.
-- version берётся из общей последовательности sync_version при каждом изменении строки.

create extension if not exists btree_gist;

create sequence sync_version;
create sequence booking_number_seq;
create sequence inv_number_seq;

create function touch_row() returns trigger language plpgsql as $$
begin
  new.version := nextval('sync_version');
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

-- Макрос для общих полей не поддерживается SQL, поэтому они повторяются в каждой таблице.

create table floors (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  number int not null,
  name text,
  sort_order int
);

create table room_categories (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  places int not null,
  base_price numeric(12,2) not null default 0,
  sort_order int
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  floor_id uuid references floors(id),
  category_id uuid not null references room_categories(id),
  places int not null,
  notes text,
  is_service boolean not null default false,
  is_active boolean not null default true,
  sort_order int
);

create table room_closures (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  room_id uuid not null references rooms(id) on delete cascade,
  date_from date not null,
  date_to date not null,
  reason text not null,
  comment text,
  check (date_to > date_from)
);

create table seasons (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  date_from date not null,
  date_to date not null,
  prices jsonb not null default '{}',
  check (date_to >= date_from)
);

create table booking_sources (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  is_active boolean not null default true,
  sort_order int
);

create table payment_methods (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  is_active boolean not null default true,
  sort_order int
);

create table services (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  price numeric(12,2) not null default 0,
  unit text,
  is_active boolean not null default true,
  sort_order int
);

create table guests (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  last_name text not null default '',
  first_name text,
  middle_name text,
  birth_date date,
  gender text,
  phone text,
  extra_phones text,
  email text,
  notes text,
  blacklisted boolean not null default false,
  blacklist_reason text,
  exa_id text
);
create index guests_last_name_idx on guests (lower(last_name));
create index guests_exa_idx on guests (exa_id) where exa_id is not null;

create table guest_docs (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  guest_id uuid not null unique references guests(id) on delete cascade,
  doc_series text,
  doc_number text,
  doc_issued_by text,
  doc_issue_date date,
  doc_dept_code text,
  birth_place text,
  citizenship text,
  reg_country text,
  reg_region text,
  reg_city text,
  reg_address text,
  reg_index text,
  fact_address text,
  migration_enabled boolean not null default false,
  migration_required boolean not null default false,
  migration_done boolean not null default false,
  migration_date date
);

create table files (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  owner_type text not null,
  owner_id uuid not null,
  kind text not null,
  file_name text not null,
  mime text not null,
  size int not null default 0
);
create index files_owner_idx on files (owner_type, owner_id);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  number int unique,
  temp_number text,
  guest_id uuid references guests(id),
  source_id uuid references booking_sources(id),
  discount numeric(12,2) not null default 0,
  notes text,
  exa_key text
);
create index bookings_guest_idx on bookings (guest_id);

create table stays (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  booking_id uuid not null references bookings(id) on delete cascade,
  room_id uuid not null references rooms(id),
  check_in date not null,
  check_out date not null,
  persons int not null default 1,
  status text not null,
  nights jsonb not null default '[]',
  relocated_from uuid references rooms(id),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  cancelled_at timestamptz,
  check (check_out > check_in),
  -- Защита от двойного бронирования на уровне базы данных.
  constraint stays_no_overlap exclude using gist (
    room_id with =,
    daterange(check_in, check_out) with &&
  ) where (deleted_at is null and status in ('tentative', 'confirmed', 'checked_in', 'checked_out'))
);
create index stays_booking_idx on stays (booking_id);
create index stays_dates_idx on stays (check_in, check_out);

create table charges (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  booking_id uuid not null references bookings(id) on delete cascade,
  service_id uuid references services(id),
  name text not null,
  qty numeric(12,2) not null default 1,
  price numeric(12,2) not null default 0,
  date date not null
);
create index charges_booking_idx on charges (booking_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  booking_id uuid not null references bookings(id) on delete cascade,
  date date not null,
  amount numeric(12,2) not null,
  method_id uuid references payment_methods(id),
  comment text
);
create index payments_booking_idx on payments (booking_id);
create index payments_date_idx on payments (date);

create table deposits (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  booking_id uuid not null references bookings(id) on delete cascade,
  amount numeric(12,2) not null,
  date date not null,
  method_id uuid references payment_methods(id),
  returned_at date,
  withheld_amount numeric(12,2) not null default 0,
  withheld_reason text
);
create index deposits_booking_idx on deposits (booking_id);

create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  is_active boolean not null default true,
  sort_order int
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  contact text,
  phone text,
  email text,
  notes text
);

create table asset_categories (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  sort_order int
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  kind text not null,
  sort_order int
);

create table purchases (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  date date not null,
  supplier_id uuid references suppliers(id),
  comment text,
  items jsonb not null default '[]',
  posted_at timestamptz
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  inv_number text,
  name text not null,
  category_id uuid references asset_categories(id),
  room_id uuid references rooms(id),
  location_id uuid references locations(id),
  cost numeric(12,2) not null default 0,
  purchase_date date,
  supplier_id uuid references suppliers(id),
  warranty_until date,
  condition text not null default 'good',
  notes text,
  written_off_at date,
  write_off_reason text,
  purchase_id uuid references purchases(id)
);
create unique index assets_inv_number_idx on assets (inv_number) where deleted_at is null and inv_number is not null;

create table asset_moves (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  asset_id uuid not null references assets(id) on delete cascade,
  date date not null,
  from_room_id uuid references rooms(id),
  from_location_id uuid references locations(id),
  to_room_id uuid references rooms(id),
  to_location_id uuid references locations(id),
  comment text
);
create index asset_moves_asset_idx on asset_moves (asset_id);

create table asset_repairs (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  asset_id uuid not null references assets(id) on delete cascade,
  date date not null,
  description text not null,
  contractor text,
  cost numeric(12,2) not null default 0,
  create_expense boolean
);
create index asset_repairs_asset_idx on asset_repairs (asset_id);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  date date not null,
  category_id uuid references expense_categories(id),
  amount numeric(12,2) not null,
  method_id uuid references payment_methods(id),
  supplier_id uuid references suppliers(id),
  comment text,
  purchase_id uuid references purchases(id) on delete set null,
  repair_id uuid references asset_repairs(id) on delete set null
);
create index expenses_date_idx on expenses (date);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  text text not null,
  due_at timestamptz not null,
  booking_id uuid references bookings(id) on delete set null,
  guest_id uuid references guests(id) on delete set null,
  asset_id uuid references assets(id) on delete set null,
  done boolean not null default false,
  done_at timestamptz
);

create table message_templates (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null,
  subject text,
  body text not null,
  sort_order int
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  guest_id uuid references guests(id) on delete set null,
  booking_id uuid references bookings(id) on delete set null,
  channel text not null,
  "to" text not null,
  subject text,
  body text not null,
  status text not null,
  error text,
  sent_at timestamptz
);
create index messages_queue_idx on messages (status) where status = 'queued';

create table settings (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  key text not null unique,
  value jsonb
);

create table conflicts (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  kind text not null,
  entity text not null,
  entity_id uuid,
  message text not null,
  data jsonb,
  resolved_at timestamptz
);

-- Триггеры версий для всех синхронизируемых таблиц.
do $$
declare t text;
begin
  foreach t in array array[
    'floors','room_categories','rooms','room_closures','seasons','booking_sources','payment_methods',
    'services','guests','guest_docs','files','bookings','stays','charges','payments','deposits',
    'expense_categories','suppliers','asset_categories','locations','purchases','assets','asset_moves',
    'asset_repairs','expenses','reminders','message_templates','messages','settings','conflicts'
  ] loop
    execute format('create trigger %I before insert or update on %I for each row execute function touch_row()', t || '_touch', t);
    execute format('create index %I on %I (version)', t || '_version_idx', t);
  end loop;
end $$;

-- Служебные таблицы (не синхронизируются).

create table auth (
  id int primary key default 1 check (id = 1),
  login text not null,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  platform text not null,
  token_hash text not null unique,
  fcm_token text,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table sync_ops (
  op_id uuid primary key,
  device_id uuid,
  entity text not null,
  kind text not null,
  status text not null,
  message text,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  device_id uuid,
  device_name text,
  op text not null,
  entity text not null,
  entity_id uuid,
  label text,
  changes jsonb
);
create index audit_log_entity_idx on audit_log (entity, entity_id);
create index audit_log_at_idx on audit_log (at desc);

create table backup_status (
  id bigserial primary key,
  at timestamptz not null default now(),
  ok boolean not null,
  size_bytes bigint,
  message text
);

-- Отметки об отправленных серверных уведомлениях (чтобы не повторять).
create table notify_log (
  key text primary key,
  sent_at timestamptz not null default now()
);
