alter table assets add column next_service_date date;
alter table assets add column service_interval_days integer not null default 0 check (service_interval_days between 0 and 3660);
alter table supplies add column per_night numeric(12,4) not null default 0 check (per_night between 0 and 10000);
alter table reminders add column automation_key text unique;
create table procurement_receipts (id uuid primary key, payload jsonb not null, created_at timestamptz not null default now());
create table cash_checks (
 id uuid primary key, date date not null, method_id uuid references payment_methods(id),
 opening numeric(12,2) not null, expected numeric(12,2) not null, actual numeric(12,2) not null,
 comment text, created_at timestamptz not null default now()
);

alter table asset_repairs add column complete_service boolean not null default false;
