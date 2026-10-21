import {
  BLOCKING_STATUSES,
  buildNights,
  DEFAULT_PRICING,
  type PricingSettings,
  ENTITIES,
  type EntityName,
  guestFullName,
  normalizePhone,
  type Night,
  type Op,
  type OpResult,
  type OpStatus,

  schemas,
  STAY_STATUS_LABELS,
  type StayStatus,
  todayMsk,
  fmtDate,
} from '@hotel-manager/shared';
import { type Tx, writeTx } from '../db.js';
import { authorizeOperation, PermissionError } from '../permissions.js';
import { saveFile } from '../files.js';
import { type AnyRow, audit, type AuditCtx, columnsOf, diff, getRow, insertRow, restoreRow, softDelete, updateRow } from '../repo.js';
import { findRelocationRoom, isRoomFree, isRoomUsable, roomName } from './placement.js';

export interface ServerEvent {
  /** Ключ события для фильтра уведомлений устройства. */
  event: 'automation' | 'conflicts' | 'backup' | 'warranty' | 'disk' | 'retention' | 'email' | 'supplies' | 'meters' | 'tax';
  title: string;
  body: string;
}

export interface ApplyCtx extends AuditCtx {
  events: ServerEvent[];
  /** Импорт: разрешено задавать номер брони. */
  importMode?: boolean;
}

class Reject extends Error {
  constructor(message: string, public kind: 'rejected' | 'deleted_edit' = 'rejected') {
    super(message);
  }
}

interface Outcome {
  status: OpStatus;
  message?: string;
  row?: AnyRow;
}

const TERMINAL: StayStatus[] = ['checked_in', 'checked_out'];

/** Применяет пачку операций; каждая — в своей транзакции. */
export async function applyOps(ops: Op[], ctx: AuditCtx): Promise<{ results: OpResult[]; events: ServerEvent[] }> {
  const results: OpResult[] = [];
  const events: ServerEvent[] = [];
  for (const op of ops) {
    const applyCtx: ApplyCtx = { ...ctx, events: [] };
    const res = await applyOp(op, applyCtx);
    results.push(res);
    events.push(...applyCtx.events);
  }
  return { results, events };
}

export async function applyOp(op: Op, ctx: ApplyCtx): Promise<OpResult> {
  try {
    return await writeTx(async (tx) => {
      await authorizeOperation(tx,op,ctx.deviceId);
      const [done] = await tx<{ status: OpStatus; message: string | null }[]>`select status, message from sync_ops where op_id = ${op.opId}`;
      if (done) {
        const row = ENTITIES[op.entity] ? await getRow(tx, op.entity, op.id) : undefined;
        return { opId: op.opId, status: 'duplicate', message: done.message ?? undefined, row };
      }
      const outcome = await dispatch(tx, op, ctx);
      await tx`
        insert into sync_ops (op_id, device_id, entity, kind, status, message)
        values (${op.opId}, ${ctx.deviceId}, ${op.entity}, ${op.kind}, ${outcome.status}, ${outcome.message ?? null})`;
      return { opId: op.opId, ...outcome };
    });
  } catch (e) {
    if (e instanceof PermissionError) return {opId:op.opId,status:'rejected',message:e.message};
    // Отклонённая операция: сохраняем её в «Требует решения», чтобы изменение не потерялось молча.
    const message = e instanceof Reject ? e.message : errorMessage(e);
    const kind = e instanceof Reject ? e.kind : 'rejected';
    return writeTx(async (tx) => {
      const [done] = await tx`select 1 from sync_ops where op_id = ${op.opId}`;
      if (!done) {
        await createConflict(tx, kind, op.entity, op.id, message, { op });
        await tx`
          insert into sync_ops (op_id, device_id, entity, kind, status, message)
          values (${op.opId}, ${ctx.deviceId}, ${op.entity}, ${op.kind}, 'rejected', ${message})`;
        ctx.events.push({ event: 'conflicts', title: 'Изменение не применено', body: message });
      }
      return { opId: op.opId, status: 'rejected' as const, message };
    });
  }
}

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'issues' in e) {
    const issues = (e as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    return `Неверные данные: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  }
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code: string }).code;
    if (code === '23P01') return 'Номер уже занят на эти даты';
    if (code === '23503') return 'Связанная запись не найдена';
    if (code === '23505') return 'Такая запись уже существует';
  }
  return e instanceof Error ? e.message : String(e);
}

async function dispatch(tx: Tx, op: Op, ctx: ApplyCtx): Promise<Outcome> {
  if (!ENTITIES[op.entity]) throw new Reject(`Неизвестная сущность ${op.entity}`);
  switch (op.kind) {
    case 'create':
      return create(tx, op, ctx);
    case 'patch':
      return patch(tx, op, ctx);
    case 'delete':
      return remove(tx, op, ctx);
    case 'restore':
      return restore(tx, op, ctx);
    case 'action':
      return action(tx, op, ctx);
    default:
      throw new Reject(`Неизвестная операция ${String(op.kind)}`);
  }
}

/** Оставляет только переданные поля (защита от подстановки значений по умолчанию). */
function parsePatch(entity: EntityName, data: Record<string, unknown>): Record<string, unknown> {
  const parsed = schemas[entity].partial().parse(data) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) if (k in parsed) out[k] = parsed[k];
  return out;
}

async function create(tx: Tx, op: Op, ctx: ApplyCtx): Promise<Outcome> {
  const entity = op.entity;
  if (ENTITIES[entity].serverOnly) throw new Reject('Эту запись создаёт только сервер');
  const existing = await getRow(tx, entity, op.id);
  if (existing) return patch(tx, { ...op, kind: 'patch' }, ctx);

  let data = schemas[entity].parse(op.data ?? {}) as Record<string, unknown>;

  switch (entity) {
    case 'meterReadings': {
      const meter = await getRow(tx, 'meters', data.meterId as string);
      if (meter && ['waste', 'internet'].includes(meter.kind as string)) {
        const price = Number(data.price ?? meter.tariff ?? 0);
        if (price <= 0) throw new Reject('Укажите сумму оплаты за период');
        data = { ...data, value: 1, price, isReset: false };
      }
      break;
    }
    case 'bookings':
      if (!ctx.importMode || !data.number) {
        const [{ n }] = await tx<{ n: number }[]>`select nextval('booking_number_seq')::int as n`;
        data = { ...data, number: n };
      }
      break;
    case 'stays':
      return createStay(tx, op, data, ctx);
    case 'guestDocs': {
      const [other] = await tx<AnyRow[]>`select * from guest_docs where guest_id = ${data.guestId as string}`;
      if (other) return patch(tx, { ...op, kind: 'patch', id: other.id }, ctx);
      break;
    }
    case 'settings': {
      const [other] = await tx<AnyRow[]>`select * from settings where key = ${data.key as string}`;
      if (other) return patch(tx, { ...op, kind: 'patch', id: other.id, data: { value: data.value } }, ctx);
      break;
    }
    case 'files': {
      const b64 = data.dataBase64 as string | undefined;
      if (!b64) throw new Reject('Файл не передан');
      const buf = Buffer.from(b64, 'base64');
      await saveFile(op.id, buf);
      data = { ...data, size: buf.length };
      break;
    }
    case 'assets':
      if (!data.invNumber) data = { ...data, invNumber: await nextInvNumber(tx) };
      break;
    case 'seasons':
      await checkSeasonOverlap(tx, op.id, data.dateFrom as string, data.dateTo as string);
      break;
    case 'roomClosures':
      await checkClosure(tx, op.id, data);
      break;
    case 'messages':
      if (data.channel === 'email' && data.status !== 'queued') data = { ...data, status: 'queued' };
      break;
  }

  const row = await insertRow(tx, entity, op.id, data);
  await audit(tx, ctx, 'create', entity, op.id, labelOf(entity, row), auditChanges(entity, undefined, row));

  if (entity === 'assetRepairs' && data.createExpense && Number(data.cost) > 0) {
    await createRepairExpense(tx, row, ctx);
  }
  if (entity === 'assetRepairs' && data.completeService) {
    await tx`update assets set condition='good',next_service_date=case when service_interval_days>0 then ${data.date as string}::date+service_interval_days else null end where id=${data.assetId as string} and deleted_at is null`;
  }
  if (entity === 'meterReadings' && data.createExpense && !data.isReset) {
    await createMeterExpense(tx, row, ctx);
  }
  if (entity === 'staffPayments' && data.createExpense && Number(data.amount) > 0) {
    await createStaffExpense(tx, row, ctx);
  }
  if (entity === 'supplyMoves' && data.kind === 'in' && data.createExpense && Number(data.price) > 0) {
    await createSupplyExpense(tx, row, ctx);
  }
  if (entity === 'guests') await detectGuestDuplicates(tx, row);
  if (entity === 'guestDocs') await detectDocDuplicates(tx, row);
  return { status: 'applied', row };
}

async function patch(tx: Tx, op: Op, ctx: ApplyCtx): Promise<Outcome> {
  const entity = op.entity;
  const existing = await getRow(tx, entity, op.id);
  if (!existing) throw new Reject('Запись не найдена на сервере');
  if (existing.deletedAt) {
    throw new Reject(`${ENTITIES[entity].label} удалена на другом устройстве — изменение не применено. Её можно восстановить из корзины.`, 'deleted_edit');
  }
  let data = parsePatch(entity, op.data ?? {});

  switch (entity) {
    case 'bookings':
      if (!ctx.importMode) delete data.number;
      break;
    case 'stays':
      return patchStay(tx, op, existing, data, ctx);
    case 'conflicts':
      data = 'resolvedAt' in data ? { resolvedAt: data.resolvedAt } : {};
      break;
    case 'settings':
      data = 'value' in data ? { value: data.value } : {};
      break;
    case 'files':
      delete data.dataBase64;
      break;
    case 'seasons':
      await checkSeasonOverlap(tx, op.id, (data.dateFrom ?? existing.dateFrom) as string, (data.dateTo ?? existing.dateTo) as string);
      break;
    case 'roomClosures':
      await checkClosure(tx, op.id, { ...existing, ...data });
      break;
    case 'purchases':
      if (existing.postedAt && 'items' in data) throw new Reject('Закупка уже проведена — состав изменить нельзя');
      break;
    case 'guestDocs':
      delete data.guestId;
      break;
  }

  const row = await updateRow(tx, entity, op.id, data);
  const changes = auditChanges(entity, existing, row);
  await audit(tx, ctx, 'patch', entity, op.id, labelOf(entity, row), changes);

  if (entity === 'reminders' && row.done && !existing.done && Number(row.repeatDays) > 0) {
    // Keep the original time of day and skip missed occurrences. The unique
    // predecessor also prevents duplicates after undo/redo or offline replay.
    const interval = Number(row.repeatDays) * 86400_000;
    const due = Date.parse(row.dueAt as string);
    const next = new Date(due + Math.max(1, Math.floor((Date.now() - due) / interval) + 1) * interval).toISOString();
    const [created] = await tx<AnyRow[]>`
      insert into reminders (text, due_at, booking_id, guest_id, asset_id, repeat_days, previous_id)
      values (${row.text as string}, ${next}, ${row.bookingId as string | null},
              ${row.guestId as string | null}, ${row.assetId as string | null}, ${Number(row.repeatDays)}, ${row.id})
      on conflict (previous_id) do nothing returning *`;
    if (created) await audit(tx, ctx, 'create', 'reminders', created.id, 'Следующее повторение задачи', null);
  }
  if (entity === 'assets') await recordAssetMove(tx, existing, row);
  if (entity === 'guestDocs') await detectDocDuplicates(tx, row);
  return { status: 'applied', row };
}

async function remove(tx: Tx, op: Op, ctx: ApplyCtx): Promise<Outcome> {
  const entity = op.entity;
  const row = await softDelete(tx, entity, op.id);
  if (!row) return { status: 'applied', row: await getRow(tx, entity, op.id) };
  if (entity === 'bookings') {
    for (const t of ['stays', 'charges', 'payments', 'deposits']) {
      await tx`update ${tx(t)} set deleted_at = ${row.deletedAt} where booking_id = ${op.id} and deleted_at is null`;
    }
  }
  if (entity === 'guests') {
    await tx`update guest_docs set deleted_at = ${row.deletedAt} where guest_id = ${op.id} and deleted_at is null`;
    await tx`update files set deleted_at = ${row.deletedAt} where owner_type = 'guest' and owner_id = ${op.id} and deleted_at is null`;
  }
  if (entity === 'assets') {
    await tx`update files set deleted_at = ${row.deletedAt} where owner_type = 'asset' and owner_id = ${op.id} and deleted_at is null`;
  }
  await audit(tx, ctx, 'delete', entity, op.id, labelOf(entity, row), null);
  return { status: 'applied', row };
}

async function restore(tx: Tx, op: Op, ctx: ApplyCtx): Promise<Outcome> {
  const entity = op.entity;
  const before = await getRow(tx, entity, op.id);
  if (!before) throw new Reject('Запись не найдена на сервере');
  if (!before.deletedAt) return { status: 'applied', row: before };
  const deletedAt = before.deletedAt;

  if (entity === 'stays') {
    const row = await restoreStay(tx, before, ctx);
    await audit(tx, ctx, 'restore', entity, op.id, labelOf(entity, row), null);
    return { status: row.status === 'conflict' ? 'conflict' : 'applied', row };
  }

  let row = await restoreRow(tx, entity, op.id);
  if (!row) throw new Reject('Не удалось восстановить запись');
  if (entity === 'bookings') {
    for (const t of ['charges', 'payments', 'deposits']) {
      await tx`update ${tx(t)} set deleted_at = null where booking_id = ${op.id} and deleted_at = ${deletedAt}`;
    }
    const stays = await tx<AnyRow[]>`select * from stays where booking_id = ${op.id} and deleted_at = ${deletedAt}`;
    for (const s of stays) await restoreStay(tx, s, ctx);
    row = (await getRow(tx, entity, op.id))!;
  }
  if (entity === 'guests') {
    await tx`update guest_docs set deleted_at = null where guest_id = ${op.id} and deleted_at = ${deletedAt}`;
    await tx`update files set deleted_at = null where owner_type = 'guest' and owner_id = ${op.id} and deleted_at = ${deletedAt}`;
  }
  if (entity === 'assets') {
    await tx`update files set deleted_at = null where owner_type = 'asset' and owner_id = ${op.id} and deleted_at = ${deletedAt}`;
  }
  await audit(tx, ctx, 'restore', entity, op.id, labelOf(entity, row), null);
  return { status: 'applied', row };
}

// ─── Размещения ─────────────────────────────────────────────────────────────

async function normalizeNights(tx: Tx, roomId: string, checkIn: string, checkOut: string, nights: Night[]): Promise<Night[]> {
  const [cat] = await tx<{ id: string; basePrice: number; weekendPrice: number | null }[]>`
    select c.id, c.base_price, c.weekend_price from rooms r join room_categories c on c.id = r.category_id where r.id = ${roomId}`;
  const seasons = await tx<{ dateFrom: string; dateTo: string; prices: Record<string, number>; weekendPrices: Record<string, number>; minStay: number | null; deletedAt: null }[]>`
    select date_from, date_to, prices, weekend_prices, min_stay, deleted_at from seasons where deleted_at is null and date_to >= ${checkIn} and date_from < ${checkOut}`;
  const rules = await tx<{ dateFrom: string; dateTo: string; prices: Record<string, number>; minStay: number | null; deletedAt: null }[]>`
    select date_from, date_to, prices, min_stay, deleted_at from price_rules where deleted_at is null and date_to >= ${checkIn} and date_from < ${checkOut}`;
  const [ps] = await tx<{ value: Partial<PricingSettings> }[]>`select value from settings where key = 'pricing' and deleted_at is null`;
  return buildNights(checkIn, checkOut, cat, { seasons, rules, ...DEFAULT_PRICING, ...(ps?.value ?? {}) }, nights, false);
}

/**
 * Размещает бронь: если номер занят — переселяет в свободный номер той же категории,
 * а если такого нет — сохраняет в статусе «Конфликт» (номер не занимается).
 */
async function place(
  tx: Tx,
  stayId: string,
  data: Record<string, unknown>,
  ctx: ApplyCtx,
  previousStatus: StayStatus | null,
): Promise<{ data: Record<string, unknown>; status: OpStatus; message?: string; relocatedTo?: string; originalStatus?: StayStatus }> {
  const status = data.status as StayStatus;
  if (!BLOCKING_STATUSES.includes(status)) return { data, status: 'applied' };
  const roomId = data.roomId as string;
  const checkIn = data.checkIn as string;
  const checkOut = data.checkOut as string;

  if ((await isRoomUsable(tx, roomId)) && (await isRoomFree(tx, roomId, checkIn, checkOut, stayId))) {
    return { data, status: 'applied' };
  }
  if (TERMINAL.includes(status) || (previousStatus && TERMINAL.includes(previousStatus))) {
    throw new Reject(
      `Номер ${await roomName(tx, roomId)} занят ${fmtDate(checkIn)}–${fmtDate(checkOut)}: изменение проживания (${STAY_STATUS_LABELS[status]}) не применено`,
    );
  }
  const alt = await findRelocationRoom(tx, roomId, checkIn, checkOut, stayId);
  if (alt) {
    return {
      data: { ...data, roomId: alt.id, relocatedFrom: roomId },
      status: 'relocated',
      message: `Номер ${await roomName(tx, roomId)} был занят — бронь переселена в номер ${alt.name}`,
      relocatedTo: alt.name,
    };
  }
  return {
    data: { ...data, status: 'conflict' },
    status: 'conflict',
    message: `Номер ${await roomName(tx, roomId)} занят ${fmtDate(checkIn)}–${fmtDate(checkOut)}, свободного номера той же категории нет`,
    originalStatus: status,
  };
}

function stayTimestamps(data: Record<string, unknown>, prev: AnyRow | undefined): Record<string, unknown> {
  const now = new Date().toISOString();
  const out = { ...data };
  const st = out.status as StayStatus;
  if (st === 'checked_in' && !out.checkedInAt && !prev?.checkedInAt) out.checkedInAt = now;
  if (st === 'checked_out' && !out.checkedOutAt && !prev?.checkedOutAt) out.checkedOutAt = now;
  if (st === 'cancelled' && !out.cancelledAt && !prev?.cancelledAt) out.cancelledAt = now;
  return out;
}

async function stayGuestLabel(tx: Tx, bookingId: string): Promise<string> {
  const [b] = await tx<{ number: number | null; lastName: string | null; firstName: string | null }[]>`
    select b.number, g.last_name, g.first_name from bookings b left join guests g on g.id = b.guest_id where b.id = ${bookingId}`;
  if (!b) return '';
  return `бронь № ${b.number ?? '—'}${b.lastName ? ` (${guestFullName(b)})` : ''}`;
}

async function afterPlacement(tx: Tx, stayId: string, bookingId: string, res: Awaited<ReturnType<typeof place>>, ctx: ApplyCtx) {
  if (res.status === 'relocated') {
    const label = await stayGuestLabel(tx, bookingId);
    await createConflict(tx, 'relocated', 'stays', stayId, `${res.message} — ${label}`, { bookingId });
    ctx.events.push({ event: 'conflicts', title: 'Бронь переселена автоматически', body: `${res.message} — ${label}` });
  } else if (res.status === 'conflict') {
    const label = await stayGuestLabel(tx, bookingId);
    await createConflict(tx, 'unplaced', 'stays', stayId, `${res.message} — ${label}`, { bookingId, originalStatus: res.originalStatus });
    ctx.events.push({ event: 'conflicts', title: 'Требует решения: нет свободного номера', body: `${res.message} — ${label}` });
  }
}

async function createStay(tx: Tx, op: Op, data: Record<string, unknown>, ctx: ApplyCtx): Promise<Outcome> {
  if ((data.checkOut as string) <= (data.checkIn as string)) throw new Reject('Дата выезда должна быть позже даты заезда');
  if (data.status === 'conflict') data = { ...data, status: 'confirmed' };
  data = stayTimestamps(data, undefined);
  data.nights = await normalizeNights(tx, data.roomId as string, data.checkIn as string, data.checkOut as string, (data.nights as Night[]) ?? []);
  const res = await place(tx, op.id, data, ctx, null);
  const row = await insertRow(tx, 'stays', op.id, res.data);
  await audit(tx, ctx, 'create', 'stays', op.id, labelOf('stays', row), auditChanges('stays', undefined, row));
  await afterPlacement(tx, op.id, row.bookingId as string, res, ctx);
  return { status: res.status, message: res.message, row };
}

async function patchStay(tx: Tx, op: Op, existing: AnyRow, data: Record<string, unknown>, ctx: ApplyCtx): Promise<Outcome> {
  delete data.bookingId;
  if (data.status === 'conflict') delete data.status;
  let merged = { ...existing, ...data } as Record<string, unknown>;
  if ((merged.checkOut as string) <= (merged.checkIn as string)) throw new Reject('Дата выезда должна быть позже даты заезда');
  merged = stayTimestamps(merged, existing);
  const placementChanged =
    merged.roomId !== existing.roomId ||
    merged.checkIn !== existing.checkIn ||
    merged.checkOut !== existing.checkOut ||
    merged.status !== existing.status;
  merged.nights = await normalizeNights(tx, merged.roomId as string, merged.checkIn as string, merged.checkOut as string, merged.nights as Night[]);

  let res: Awaited<ReturnType<typeof place>> = { data: merged, status: 'applied' };
  if (placementChanged || existing.status === 'conflict') {
    // Размещение в статусе «Конфликт» при любом изменении пробуем разместить снова в его исходном статусе.
    if (merged.status === 'conflict') {
      const [c] = await tx<{ data: { originalStatus?: StayStatus } | null }[]>`
        select data from conflicts where entity = 'stays' and entity_id = ${op.id} and kind = 'unplaced' order by created_at desc limit 1`;
      merged.status = c?.data?.originalStatus && c.data.originalStatus !== 'conflict' ? c.data.originalStatus : 'confirmed';
    }
    res = await place(tx, op.id, merged, ctx, existing.status as StayStatus);
  }
  const update: Record<string, unknown> = {};
  for (const f of columnsOf('stays')) update[f] = res.data[f];
  delete update.bookingId;
  const row = await updateRow(tx, 'stays', op.id, update);
  await audit(tx, ctx, 'patch', 'stays', op.id, labelOf('stays', row), auditChanges('stays', existing, row));
  await afterPlacement(tx, op.id, row.bookingId as string, res, ctx);
  if (existing.status === 'conflict' && row.status !== 'conflict') {
    await tx`update conflicts set resolved_at = now() where entity = 'stays' and entity_id = ${op.id} and kind = 'unplaced' and resolved_at is null`;
  }
  return { status: res.status, message: res.message, row };
}

async function restoreStay(tx: Tx, before: AnyRow, ctx: ApplyCtx): Promise<AnyRow> {
  const res = await place(tx, before.id, { ...before }, ctx, null);
  const update: Record<string, unknown> = {};
  for (const f of ['roomId', 'status', 'relocatedFrom']) update[f] = res.data[f];
  await tx`update stays set deleted_at = null where id = ${before.id}`;
  const row = await updateRow(tx, 'stays', before.id, update);
  await afterPlacement(tx, before.id, row.bookingId as string, res, ctx);
  return row;
}

// ─── Проверки справочников ──────────────────────────────────────────────────

async function checkSeasonOverlap(tx: Tx, id: string, from: string, to: string) {
  if (to < from) throw new Reject('Дата окончания сезона раньше даты начала');
  const [other] = await tx<{ name: string }[]>`
    select name from seasons where deleted_at is null and id <> ${id} and date_from <= ${to} and date_to >= ${from} limit 1`;
  if (other) throw new Reject(`Период пересекается с сезоном «${other.name}»`);
}

async function checkClosure(tx: Tx, id: string, data: Record<string, unknown>) {
  const from = data.dateFrom as string;
  const to = data.dateTo as string;
  if (to <= from) throw new Reject('Дата окончания закрытия должна быть позже даты начала');
  const stays = await tx<{ checkIn: string; checkOut: string }[]>`
    select check_in, check_out from stays
     where room_id = ${data.roomId as string} and deleted_at is null and status in ${tx(BLOCKING_STATUSES as string[])}
       and daterange(check_in, check_out) && daterange(${from}::date, ${to}::date)`;
  if (stays.length) {
    const s = stays[0];
    throw new Reject(`В эти даты в номере есть бронь (${fmtDate(s.checkIn)}–${fmtDate(s.checkOut)})`);
  }
  const [other] = await tx`
    select 1 from room_closures where room_id = ${data.roomId as string} and deleted_at is null and id <> ${id}
       and daterange(date_from, date_to) && daterange(${from}::date, ${to}::date)`;
  if (other) throw new Reject('Номер уже закрыт в эти даты');
}

// ─── Инвентарь ──────────────────────────────────────────────────────────────

async function nextInvNumber(tx: Tx): Promise<string> {
  for (;;) {
    const [{ n }] = await tx<{ n: number }[]>`select nextval('inv_number_seq')::int as n`;
    const inv = `ИН-${String(n).padStart(6, '0')}`;
    const [busy] = await tx`select 1 from assets where inv_number = ${inv} and deleted_at is null`;
    if (!busy) return inv;
  }
}

async function recordAssetMove(tx: Tx, before: AnyRow, after: AnyRow) {
  if (before.roomId === after.roomId && before.locationId === after.locationId) return;
  await tx`
    insert into asset_moves (asset_id, date, from_room_id, from_location_id, to_room_id, to_location_id)
    values (${after.id}, ${todayMsk()}, ${before.roomId as string | null}, ${before.locationId as string | null},
            ${after.roomId as string | null}, ${after.locationId as string | null})`;
}

async function categoryByName(tx: Tx, name: string): Promise<string | null> {
  const [c] = await tx<{ id: string }[]>`select id from expense_categories where deleted_at is null and lower(name) = lower(${name}) limit 1`;
  if (c) return c.id;
  const [n] = await tx<{ id: string }[]>`insert into expense_categories (name) values (${name}) returning id`;
  return n.id;
}

async function createRepairExpense(tx: Tx, repair: AnyRow, ctx: ApplyCtx) {
  const [asset] = await tx<{ name: string }[]>`select name from assets where id = ${repair.assetId as string}`;
  const categoryId = await categoryByName(tx, 'Ремонт');
  const [exp] = await tx<AnyRow[]>`
    insert into expenses (date, category_id, amount, comment, repair_id)
    values (${repair.date as string}, ${categoryId}, ${repair.cost as number}, ${`Ремонт: ${asset?.name ?? ''}. ${repair.description as string}`}, ${repair.id})
    returning *`;
  await audit(tx, ctx, 'create', 'expenses', exp.id, 'Расход на ремонт', null);
}

async function createSupplyExpense(tx: Tx, move: AnyRow, ctx: ApplyCtx) {
  const [supply] = await tx<{ name: string; unit: string }[]>`select name, unit from supplies where id = ${move.supplyId as string}`;
  const categoryId = await categoryByName(tx, 'Расходники');
  const amount = Math.round(Number(move.qty) * Number(move.price) * 100) / 100;
  const [exp] = await tx<AnyRow[]>`
    insert into expenses (date, category_id, amount, supplier_id, comment, supply_move_id)
    values (${move.date as string}, ${categoryId}, ${amount}, ${(move.supplierId as string) ?? null},
            ${`${supply?.name ?? 'Расходники'}: ${move.qty as number} ${supply?.unit ?? ''}`}, ${move.id})
    returning *`;
  await audit(tx, ctx, 'create', 'expenses', exp.id, 'Расход на расходники', null);
}

/** Выплата сотруднику — расход в категории «Зарплата». */
async function createStaffExpense(tx: Tx, pay: AnyRow, ctx: ApplyCtx) {
  const [st] = await tx<{ name: string }[]>`select name from staff where id = ${pay.staffId as string}`;
  const categoryId = await categoryByName(tx, 'Зарплата');
  const [exp] = await tx<AnyRow[]>`
    insert into expenses (date, category_id, amount, method_id, comment, staff_payment_id)
    values (${pay.date as string}, ${categoryId}, ${Number(pay.amount)}, ${(pay.methodId as string) ?? null},
            ${`${pay.kind === 'advance' ? 'Аванс' : 'Зарплата'}: ${st?.name ?? 'сотрудник'}`}, ${pay.id})
    returning *`;
  await audit(tx, ctx, 'create', 'expenses', exp.id, 'Выплата сотруднику', null);
}

/** Стоимость расхода по показанию счётчика (разница с предыдущим показанием × цена). */
async function createMeterExpense(tx: Tx, reading: AnyRow, ctx: ApplyCtx) {
  const [u] = await tx<{ usage: number | null; price: number | null; name: string; unit: string }[]>`
    select u.usage, u.price, m.name, m.unit from meter_usage u join meters m on m.id = u.meter_id where u.reading_id = ${reading.id as string}`;
  const amount = u?.usage != null && u.price != null ? Math.round(Number(u.usage) * Number(u.price) * 100) / 100 : 0;
  if (amount <= 0) return;
  const categoryId = await categoryByName(tx, 'Коммунальные услуги');
  const [exp] = await tx<AnyRow[]>`
    insert into expenses (date, category_id, amount, comment, meter_reading_id)
    values (${reading.date as string}, ${categoryId}, ${amount},
            ${`${u.name}: ${Number(u.usage).toLocaleString('ru-RU')} ${u.unit}`}, ${reading.id})
    returning *`;
  await audit(tx, ctx, 'create', 'expenses', exp.id, 'Расход по счётчику', null);
}

async function postPurchase(tx: Tx, id: string, ctx: ApplyCtx): Promise<Outcome> {
  const p = await getRow(tx, 'purchases', id);
  if (!p || p.deletedAt) throw new Reject('Закупка не найдена');
  if (p.postedAt) return { status: 'applied', row: p };
  const items = (p.items as { name: string; categoryId?: string | null; qty: number; price: number }[]) ?? [];
  if (!items.length) throw new Reject('В закупке нет позиций');
  const [storage] = await tx<{ id: string }[]>`select id from locations where deleted_at is null and kind = 'storage' order by sort_order nulls last limit 1`;
  let total = 0;
  for (const it of items) {
    for (let i = 0; i < it.qty; i++) {
      const inv = await nextInvNumber(tx);
      await tx`
        insert into assets (inv_number, name, category_id, location_id, cost, purchase_date, supplier_id, condition, purchase_id)
        values (${inv}, ${it.name}, ${it.categoryId ?? null}, ${storage?.id ?? null}, ${it.price}, ${p.date as string},
                ${p.supplierId as string | null}, 'new', ${id})`;
    }
    total += it.qty * it.price;
  }
  const categoryId = await categoryByName(tx, 'Основные средства');
  await tx`
    insert into expenses (date, category_id, amount, supplier_id, comment, purchase_id)
    values (${p.date as string}, ${categoryId}, ${Math.round(total * 100) / 100}, ${p.supplierId as string | null},
            ${`Закупка основных средств${p.comment ? `: ${p.comment as string}` : ''}`}, ${id})`;
  const row = await updateRow(tx, 'purchases', id, { postedAt: new Date().toISOString() });
  await audit(tx, ctx, 'action', 'purchases', id, `Проведена закупка на ${total} ₽`, null);
  return { status: 'applied', row };
}

// ─── Гости ──────────────────────────────────────────────────────────────────

async function detectGuestDuplicates(tx: Tx, g: AnyRow) {
  const phone = normalizePhone(g.phone as string | null);
  const candidates = await tx<AnyRow[]>`
    select * from guests
     where deleted_at is null and id <> ${g.id}
       and (
         (${phone.length >= 10} and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${phone.slice(-10)})
         or (${Boolean(g.birthDate)} and birth_date = ${(g.birthDate as string) ?? null}
             and lower(last_name) = lower(${g.lastName as string}) and lower(coalesce(first_name, '')) = lower(${(g.firstName as string) ?? ''}))
       )
     limit 3`;
  for (const c of candidates) {
    await createConflict(tx, 'duplicate_guest', 'guests', g.id, `Возможно, это один человек: «${guestFullName(g as never)}» и «${guestFullName(c as never)}»`, {
      guestId: g.id,
      otherId: c.id,
    });
  }
}

async function detectDocDuplicates(tx: Tx, d: AnyRow) {
  if (!d.docNumber) return;
  const others = await tx<{ guestId: string }[]>`
    select guest_id from guest_docs
     where deleted_at is null and guest_id <> ${d.guestId as string}
       and doc_number = ${d.docNumber as string} and coalesce(doc_series, '') = ${(d.docSeries as string) ?? ''}`;
  for (const o of others) {
    const [exists] = await tx`
      select 1 from conflicts where kind = 'duplicate_guest' and resolved_at is null
        and ((data->>'guestId' = ${d.guestId as string} and data->>'otherId' = ${o.guestId})
          or (data->>'guestId' = ${o.guestId} and data->>'otherId' = ${d.guestId as string}))`;
    if (exists) continue;
    const [a] = await tx<AnyRow[]>`select * from guests where id = ${d.guestId as string}`;
    const [b] = await tx<AnyRow[]>`select * from guests where id = ${o.guestId}`;
    await createConflict(tx, 'duplicate_guest', 'guests', d.guestId as string, `Одинаковый паспорт у гостей «${guestFullName(a as never)}» и «${guestFullName(b as never)}»`, {
      guestId: d.guestId,
      otherId: o.guestId,
    });
  }
}

/** Объединение гостей: всё переносится с source на target, source удаляется. */
async function mergeGuests(tx: Tx, targetId: string, sourceId: string, ctx: ApplyCtx): Promise<Outcome> {
  if (targetId === sourceId) throw new Reject('Нельзя объединить гостя с самим собой');
  const target = await getRow(tx, 'guests', targetId);
  const source = await getRow(tx, 'guests', sourceId);
  if (!target || target.deletedAt) throw new Reject('Основной гость не найден');
  if (!source || source.deletedAt) throw new Reject('Объединяемый гость не найден');

  await tx`update bookings set guest_id = ${targetId} where guest_id = ${sourceId}`;
  await tx`update reminders set guest_id = ${targetId} where guest_id = ${sourceId}`;
  await tx`update messages set guest_id = ${targetId} where guest_id = ${sourceId}`;
  await tx`update files set owner_id = ${targetId} where owner_type = 'guest' and owner_id = ${sourceId}`;

  // Пустые поля основного гостя заполняются из объединяемого.
  const fill: Record<string, unknown> = {};
  for (const f of columnsOf('guests')) {
    if ((target[f] === null || target[f] === '' || target[f] === undefined) && source[f] !== null && source[f] !== '') fill[f] = source[f];
  }
  if (source.notes && target.notes && source.notes !== target.notes) fill.notes = `${target.notes as string}\n${source.notes as string}`;
  if (source.blacklisted) fill.blacklisted = true;
  const row = await updateRow(tx, 'guests', targetId, fill);

  const [tDocs] = await tx<AnyRow[]>`select * from guest_docs where guest_id = ${targetId}`;
  const [sDocs] = await tx<AnyRow[]>`select * from guest_docs where guest_id = ${sourceId}`;
  if (sDocs && !tDocs) {
    await tx`update guest_docs set guest_id = ${targetId} where id = ${sDocs.id}`;
  } else if (sDocs && tDocs) {
    const docFill: Record<string, unknown> = {};
    for (const f of columnsOf('guestDocs')) {
      if (f === 'guestId') continue;
      if ((tDocs[f] === null || tDocs[f] === '') && sDocs[f] !== null && sDocs[f] !== '') docFill[f] = sDocs[f];
    }
    if (Object.keys(docFill).length) await updateRow(tx, 'guestDocs', tDocs.id, docFill);
    await softDelete(tx, 'guestDocs', sDocs.id);
  }
  await softDelete(tx, 'guests', sourceId);
  await tx`
    update conflicts set resolved_at = now()
     where kind = 'duplicate_guest' and resolved_at is null
       and (data->>'guestId' in (${targetId}, ${sourceId}) and data->>'otherId' in (${targetId}, ${sourceId}))`;
  await audit(tx, ctx, 'merge', 'guests', targetId, `Объединены гости: ${guestFullName(source as never)} → ${guestFullName(target as never)}`, null);
  return { status: 'applied', row };
}

async function action(tx: Tx, op: Op, ctx: ApplyCtx): Promise<Outcome> {
  switch (op.action) {
    case 'purchase.post':
      return postPurchase(tx, op.id, ctx);
    case 'guests.merge':
      return mergeGuests(tx, op.id, String(op.data?.sourceId ?? ''), ctx);
    case 'messages.send':
      ctx.events.push({ event: 'email', title: '', body: '' });
      return { status: 'applied' };
    default:
      throw new Reject(`Неизвестное действие ${String(op.action)}`);
  }
}

// ─── Общее ──────────────────────────────────────────────────────────────────

export async function createConflict(tx: Tx, kind: string, entity: string, entityId: string | null, message: string, data: unknown) {
  await tx`
    insert into conflicts (kind, entity, entity_id, message, data)
    values (${kind}, ${entity}, ${entityId}, ${message}, ${tx.json(data as never)})`;
}

function auditChanges(entity: EntityName, before: AnyRow | undefined, after: AnyRow): Record<string, unknown> | null {
  const fields = columnsOf(entity);
  const d = diff(before, after, fields);
  if (ENTITIES[entity].sensitive) {
    // Персональные данные в журнал не пишутся — только список изменённых полей.
    return { fields: Object.keys(d) };
  }
  return d;
}

function labelOf(entity: EntityName, row: AnyRow): string {
  switch (entity) {
    case 'guests':
      return guestFullName(row as never);
    case 'bookings':
      return `Бронь № ${row.number ?? row.tempNumber ?? '—'}`;
    case 'stays':
      return `${fmtDate(row.checkIn as string)}–${fmtDate(row.checkOut as string)}, ${STAY_STATUS_LABELS[row.status as StayStatus]}`;
    case 'payments':
      return `Оплата ${row.amount as number} ₽ от ${fmtDate(row.date as string)}`;
    case 'charges':
      return `${row.name as string}: ${row.qty as number} × ${row.price as number} ₽`;
    default:
      return String(row.name ?? row.key ?? row.invNumber ?? row.text ?? ENTITIES[entity].label);
  }
}

