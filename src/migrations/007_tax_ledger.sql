-- Бухгалтерия ИП: ручные записи налогового учёта, корректировки автоматических доходов, закрытые периоды.

create table tax_entries (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  date date not null,
  kind text not null,
  purpose text,
  for_year int,
  doc_type text not null default 'other',
  doc_number text,
  content text not null,
  amount numeric(14,2) not null,
  method text,
  counterparty text,
  comment text
);
create index tax_entries_date_idx on tax_entries (date);

create table tax_adjustments (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  source_type text not null,
  source_id uuid not null,
  action text not null,
  new_date date,
  split_amount numeric(14,2),
  reason text not null
);
create unique index tax_adjustments_source_idx on tax_adjustments (source_type, source_id) where deleted_at is null;

create table tax_periods (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  year int not null,
  period int not null,
  closed_at timestamptz not null,
  correction int not null default 0,
  snapshot jsonb not null default '{}',
  comment text,
  reopened_at timestamptz
);
create index tax_periods_year_idx on tax_periods (year, period);

do $$
declare t text;
begin
  foreach t in array array['tax_entries', 'tax_adjustments', 'tax_periods'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function touch_row()', t || '_touch', t);
    execute format('create index %I on %I (version)', t || '_version_idx', t);
  end loop;
end $$;
