-- A successor is created exactly once even if multiple devices complete a task.
alter table reminders add column repeat_days integer not null default 0 check (repeat_days between 0 and 3660);
alter table reminders add column previous_id uuid unique references reminders(id) on delete set null;
