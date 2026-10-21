import { BLOCKING_STATUSES, type ISODate } from '@hotel-manager/shared';
import type { Tx } from '../db.js';

/** Свободен ли номер в период [checkIn, checkOut) с учётом броней и закрытий. */
export async function isRoomFree(tx: Tx, roomId: string, checkIn: ISODate, checkOut: ISODate, excludeStayId?: string): Promise<boolean> {
  const exclude = excludeStayId ?? '00000000-0000-0000-0000-000000000000';
  const [busy] = await tx`
    select 1 from stays
     where room_id = ${roomId} and deleted_at is null and id <> ${exclude}
       and status in ${tx(BLOCKING_STATUSES as string[])}
       and daterange(check_in, check_out) && daterange(${checkIn}::date, ${checkOut}::date)
    union all
    select 1 from room_closures
     where room_id = ${roomId} and deleted_at is null
       and daterange(date_from, date_to) && daterange(${checkIn}::date, ${checkOut}::date)
    limit 1`;
  return !busy;
}

export async function isRoomUsable(tx: Tx, roomId: string): Promise<boolean> {
  const [r] = await tx`select 1 from rooms where id = ${roomId} and deleted_at is null and is_active`;
  return Boolean(r);
}

/**
 * Подбирает свободный на весь период номер той же категории:
 * активный, не служебный, не закрытый; с наименьшим номером.
 */
export async function findRelocationRoom(
  tx: Tx,
  roomId: string,
  checkIn: ISODate,
  checkOut: ISODate,
  stayId: string,
): Promise<{ id: string; name: string } | null> {
  const candidates = await tx<{ id: string; name: string }[]>`
    select r.id, r.name from rooms r
      join rooms src on src.id = ${roomId}
     where r.category_id = src.category_id and r.id <> src.id
       and r.deleted_at is null and r.is_active and not r.is_service
     order by r.sort_order nulls last, nullif(substring(r.name from '^\\d+'), '')::int nulls last, r.name`;
  for (const c of candidates) {
    if (await isRoomFree(tx, c.id, checkIn, checkOut, stayId)) return c;
  }
  return null;
}

export async function roomName(tx: Tx, roomId: string): Promise<string> {
  const [r] = await tx<{ name: string }[]>`select name from rooms where id = ${roomId}`;
  return r?.name ?? '?';
}
