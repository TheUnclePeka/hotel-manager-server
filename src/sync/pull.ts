import {
  addDays,
  BOOKING_CHILDREN,
  currentWindow,
  ENTITIES,
  type EntityName,
  type PullRequest,
  type PullResponse,
  RECENT_DAYS,
  SERVER_ONLY_SETTINGS,
  todayMsk,
} from '@hotel-manager/shared';
import { readTx, type Tx } from '../db.js';

const FAMILY: EntityName[] = ['bookings', ...BOOKING_CHILDREN];

/**
 * Отдаёт изменения для кэша устройства.
 *
 * Брони передаются «семьями» (бронь + размещения, начисления, оплаты, залоги):
 *  - при первой синхронизации — все брони в окне дат и брони с долгом или залогом;
 *  - далее — семьи всех изменённых броней и броней, вошедших в окно при его сдвиге.
 * Устройство само удаляет из кэша семьи, вышедшие за окно.
 */
export async function pull(req: PullRequest): Promise<PullResponse> {
  const today = todayMsk();
  const window = currentWindow(today);
  const since = Math.max(0, Number(req.since) || 0);
  const initial = since === 0 || !req.window;

  return readTx(async (tx) => {
    const [seq] = await tx<{ lastValue: number; isCalled: boolean }[]>`select last_value, is_called from sync_version`;
    const version = seq.isCalled ? seq.lastValue : 0;
    const rows: PullResponse['rows'] = {};

    for (const [name, meta] of Object.entries(ENTITIES) as [EntityName, (typeof ENTITIES)[EntityName]][]) {
      const t = tx(meta.table);
      if (meta.cache === 'all') {
        let list: Record<string, unknown>[] = initial
          ? await tx`select * from ${t} where deleted_at is null`
          : await tx`select * from ${t} where version > ${since}`;
        if (name === 'settings') list = list.filter((r) => !SERVER_ONLY_SETTINGS.includes(r.key as never));
        if (list.length) rows[name] = list;
      } else if (meta.cache === 'recent') {
        const list = initial
          ? await tx`select * from ${t} where deleted_at is null and date >= ${addDays(today, -RECENT_DAYS)}`
          : await tx`select * from ${t} where version > ${since}`;
        if (list.length) rows[name] = list;
      }
    }

    // Брони и связанные записи.
    let bookingIds: string[];
    if (initial) {
      bookingIds = (
        await tx<{ id: string }[]>`
          select distinct b.id from bookings b
           where b.deleted_at is null and (
             exists (select 1 from stays s where s.booking_id = b.id and s.deleted_at is null
                      and s.check_out >= ${window.from} and s.check_in <= ${window.to})
             or exists (select 1 from booking_totals t where t.booking_id = b.id and (t.balance <> 0 or t.deposit_held <> 0))
           )`
      ).map((r) => r.id);
    } else {
      const changed = new Set<string>();
      for (const name of FAMILY) {
        const col = name === 'bookings' ? 'id' : 'booking_id';
        const list = await tx<{ id: string }[]>`select ${tx(col)} as id from ${tx(ENTITIES[name].table)} where version > ${since}`;
        list.forEach((r) => changed.add(r.id));
      }
      // Брони, вошедшие в окно при его сдвиге вперёд.
      const prevTo = req.window!.to;
      if (window.to > prevTo) {
        const entered = await tx<{ id: string }[]>`
          select distinct booking_id as id from stays
           where deleted_at is null and check_in > ${prevTo} and check_in <= ${window.to}`;
        entered.forEach((r) => changed.add(r.id));
      }
      bookingIds = [...changed];
    }

    if (bookingIds.length) await loadFamilies(tx, bookingIds, rows, initial);
    return { version, window, rows, serverTime: new Date().toISOString() };
  });
}

async function loadFamilies(tx: Tx, ids: string[], rows: PullResponse['rows'], skipDeleted: boolean) {
  const del = skipDeleted ? tx`and deleted_at is null` : tx``;
  // Удалённые брони передаются, чтобы устройство убрало их из кэша.
  const bookings = await tx`select * from bookings where id in ${tx(ids)} ${del}`;
  if (bookings.length) rows.bookings = bookings;
  for (const name of BOOKING_CHILDREN) {
    const list = await tx`select * from ${tx(ENTITIES[name].table)} where booking_id in ${tx(ids)} ${del}`;
    if (list.length) rows[name] = list;
  }
}
