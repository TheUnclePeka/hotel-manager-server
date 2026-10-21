create table waitlist (
 id uuid primary key default gen_random_uuid(),
 version bigint not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 deleted_at timestamptz,
 name text not null, phone text, check_in date not null, check_out date not null,
 category_id uuid references room_categories(id), notes text,
 closed boolean not null default false,
 check (check_out > check_in)
);
create trigger waitlist_touch before insert or update on waitlist for each row execute function touch_row();
create index waitlist_version_idx on waitlist(version);
