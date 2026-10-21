import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { addDays, diffDays, todayMsk, mskToInstant, purchaseNeed } from '@hotel-manager/shared';
import { sql, writeTx, readTx, type Tx } from './db.js';
import { broadcastChanged, notifyOnce } from './notify.js';
import { config } from './config.js';

const day = z.iso.date();
const ruleSchema = z.object({
  enabled: z.boolean().default(false),
  arrivals: z.boolean().default(true),
  departures: z.boolean().default(true),
  supplies: z.boolean().default(true),
  maintenance: z.boolean().default(true),
  meters: z.boolean().default(true),
  notify: z.boolean().default(false),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('09:00'),
});
export async function generateTasks() {
  const [setting] = await sql`select value from settings where key = 'automation' and deleted_at is null`;
  const parsed = ruleSchema.safeParse(setting?.value ?? {});
  if (!parsed.success || !parsed.data.enabled) return { created: 0 };
  const rule = parsed.data,
    today = todayMsk(),
    tomorrow = addDays(today, 1);
  const tasks: { key: string; text: string; bookingId?: string; assetId?: string }[] = [];
  if (rule.arrivals || rule.departures) {
    const stays =
      await sql`select s.id, s.booking_id, s.check_in, s.check_out, s.status, r.name from stays s join rooms r on r.id=s.room_id where s.deleted_at is null and ((s.status in ('confirmed','tentative') and s.check_in <= ${today} and s.check_out > ${today}) or (s.status='checked_in' and s.check_out <= ${tomorrow}))`;
    for (const s of stays) {
      const arrival = s.status !== 'checked_in';
      if ((arrival && !rule.arrivals) || (!arrival && !rule.departures)) continue;
      tasks.push({
        key: `${arrival ? 'arrival' : 'departure'}:${s.id}:${arrival ? s.checkIn : s.checkOut}`,
        text: `${arrival ? 'Проверить заезд' : 'Подготовить выезд'}: номер ${s.name}, ${arrival ? s.checkIn : s.checkOut}`,
        bookingId: s.bookingId,
      });
    }
  }
  if (rule.maintenance)
    for (const a of await sql`select id,name,next_service_date from assets where deleted_at is null and written_off_at is null and next_service_date <= ${tomorrow}`)
      tasks.push({
        key: `service:${a.id}:${a.nextServiceDate}`,
        text: `Обслуживание: ${a.name}, срок ${a.nextServiceDate}`,
        assetId: a.id,
      });
  if (rule.supplies)
    for (const s of await sql`select s.id,s.name,st.qty,s.unit from supplies s join supply_stock st on st.supply_id=s.id where s.deleted_at is null and s.is_active and st.qty < s.min_qty`)
      tasks.push({ key: `stock:${s.id}:${today}`, text: `Закупить: ${s.name}, остаток ${s.qty} ${s.unit}` });
  if (rule.meters)
    for (const m of await sql`select id,name from meters m where deleted_at is null and is_active and remind_day <= ${Number(today.slice(8))} and not exists(select 1 from meter_readings r where r.meter_id=m.id and r.deleted_at is null and r.date >= ${today.slice(0, 7) + '-01'}::date and r.date <= ${today}::date)`)
      tasks.push({ key: `meter:${m.id}:${today.slice(0, 7)}`, text: `Снять показания: ${m.name}` });
  let retiredCount = 0;
  const created = await writeTx(async (tx) => {
    let n = 0;
    const keys = tasks.map((t) => t.key);
    const retired = keys.length
      ? await tx`update reminders set done=true,done_at=now() where automation_key is not null and not done and deleted_at is null and automation_key not in ${tx(keys)} returning id`
      : await tx`update reminders set done=true,done_at=now() where automation_key is not null and not done and deleted_at is null returning id`;
    retiredCount = retired.length;
    for (const t of tasks) {
      const rows =
        await tx`insert into reminders(text,due_at,booking_id,asset_id,automation_key) values(${t.text},${mskToInstant(today, rule.time)},${t.bookingId ?? null},${t.assetId ?? null},${t.key}) on conflict(automation_key) do nothing returning id`;
      n += rows.length;
    }
    return n;
  });
  if (created || retiredCount) broadcastChanged();
  // Once a day after the chosen Moscow time, including tasks generated earlier.
  if (rule.notify && Date.now() >= Date.parse(mskToInstant(today, rule.time)) && tasks.length)
    await notifyOnce(`automation:${today}`, {
      event: 'automation',
      title: 'Задачи гостевого дома',
      body: `Требуют внимания: ${tasks.length}. Откройте «Напоминания».`,
    });
  return { created };
}

async function cashRows(tx: Tx, date: string) {
  return tx<{ methodId: string | null; name: string; incoming: number; outgoing: number; net: number }[]>`
 with movements as (
  select method_id, amount as value from payments where deleted_at is null and date=${date}
  union all select method_id, amount from deposits where deleted_at is null and date=${date}
  union all select method_id, -(amount-withheld_amount) from deposits where deleted_at is null and returned_at=${date}
  union all select method_id, -amount from expenses where deleted_at is null and date=${date}
 ) select m.method_id, coalesce(p.name,'Без способа оплаты') as name,
 coalesce(sum(greatest(value,0)),0)::numeric as incoming, coalesce(sum(greatest(-value,0)),0)::numeric as outgoing,
 coalesce(sum(value),0)::numeric as net from movements m left join payment_methods p on p.id=m.method_id group by m.method_id,p.name`;
}
export function registerOperations(api: FastifyInstance) {
  api.get('/api/operations/rules', async () => {
    const [s] = await sql`select value from settings where key='automation' and deleted_at is null`;
    return ruleSchema.parse(s?.value ?? {});
  });
  api.put('/api/operations/rules', async (req) => {
    const value = ruleSchema.parse(req.body);
    await writeTx(
      (tx) =>
        tx`insert into settings(key,value) values('automation',${tx.json(value)}) on conflict(key) do update set value=excluded.value,deleted_at=null`,
    );
    broadcastChanged();
    return value;
  });
  api.post('/api/operations/tasks', async () => generateTasks());
  api.get('/api/operations/cash', async (req) => {
    const { date } = z.object({ date: day }).parse(req.query);
    return readTx(async (tx) => ({
      rows: await cashRows(tx, date),
      checks: await tx`select * from cash_checks where date=${date} order by created_at desc`,
    }));
  });
  api.post('/api/operations/cash', async (req, reply) => {
    const p = z
      .object({
        id: z.uuid(),
        date: day,
        methodId: z.uuid().nullable(),
        opening: z.number().finite().min(-1e9).max(1e9),
        net: z.number().finite(),
        actual: z.number().finite().min(-1e9).max(1e9),
        comment: z.string().max(1000).default(''),
      })
      .parse(req.body);
    const result = await writeTx(async (tx) => {
      const [existing] = await tx`select * from cash_checks where id=${p.id}`;
      if (existing) {
        if (
          existing.date !== p.date ||
          existing.methodId !== p.methodId ||
          Number(existing.opening) !== p.opening ||
          Number(existing.actual) !== p.actual ||
          existing.comment !== p.comment
        )
          throw Object.assign(new Error('Эта сверка уже сохранена с другими значениями.'), { statusCode: 409 });
        return existing;
      }
      const rows = await cashRows(tx, p.date);
      const net = Number(rows.find((r) => r.methodId === p.methodId)?.net ?? 0);
      if (Math.abs(net - p.net) > 0.001) return null;
      const [row] =
        await tx`insert into cash_checks(id,date,method_id,opening,expected,actual,comment) values(${p.id},${p.date},${p.methodId},${p.opening},${p.opening + net},${p.actual},${p.comment}) returning *`;
      return row;
    });
    if (!result) return reply.code(409).send({ error: 'Оборот изменился. Обновите сверку и проверьте сумму.' });
    return result;
  });
  api.get('/api/operations/procurement', async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    const from = todayMsk(),
      to = addDays(from, days);
    return readTx(async (tx) => {
      const [n] =
        await tx`select count(*)::int as nights from (select distinct s.room_id,d::date from stays s join rooms r on r.id=s.room_id cross join generate_series(${from}::date,${to}::date-1,interval '1 day') d where s.deleted_at is null and r.deleted_at is null and r.is_active and not r.is_service and s.status in ('tentative','confirmed','checked_in') and s.check_in <= d::date and s.check_out > d::date) occupied`;
      const supplies =
        await tx`select s.*,st.qty as stock from supplies s join supply_stock st on st.supply_id=s.id where s.deleted_at is null and s.is_active order by s.name`;
      return {
        from,
        to,
        nights: n.nights,
        items: supplies.map((s) => ({ ...s, need: purchaseNeed(Number(s.stock), Number(s.minQty), Number(s.perNight), Number(n.nights)) })),
      };
    });
  });
  api.get('/api/operations/procurement/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [r] = await sql`select created_at from procurement_receipts where id=${id}`;
    return { exists: !!r, createdAt: r?.createdAt ?? null };
  });
  api.post('/api/operations/procurement', async (req, reply) => {
    const p = z
      .object({
        id: z.uuid(),
        date: day,
        expense: z.boolean(),
        items: z
          .array(z.object({ supplyId: z.uuid(), qty: z.number().positive().max(1e6), price: z.number().min(0).max(1e7) }))
          .min(1)
          .max(200),
      })
      .parse(req.body);
    if (new Set(p.items.map((i) => i.supplyId)).size !== p.items.length)
      return reply.code(400).send({ error: 'Позиции не должны повторяться' });
    const result = await writeTx(async (tx) => {
      const [prev] = await tx`select payload from procurement_receipts where id=${p.id}`;
      if (prev) {
        if (!isDeepStrictEqual(prev.payload, p))
          throw Object.assign(new Error('Этот номер закупки уже проведён с другим составом.'), { statusCode: 409 });
        return { duplicate: true };
      }
      for (const item of p.items) {
        const [s] = await tx`select name from supplies where id=${item.supplyId} and deleted_at is null and is_active`;
        if (!s) throw Object.assign(new Error('Расходник удалён или отключён. Обновите список.'), { statusCode: 400 });
        const [m] =
          await tx`insert into supply_moves(supply_id,date,kind,qty,price,comment) values(${item.supplyId},${p.date},'in',${item.qty},${item.price},'План закупок') returning id`;
        if (p.expense && item.price > 0)
          await tx`insert into expenses(date,amount,comment,supply_move_id) values(${p.date},${Math.round(item.qty * item.price * 100) / 100},${'Закупка: ' + s.name},${m.id})`;
      }
      await tx`insert into procurement_receipts(id,payload) values(${p.id},${tx.json(p)})`;
      await tx`insert into audit_log(op,entity,entity_id,label) values('create','supplyMoves',${p.id},'Проведение плана закупок')`;
      return { duplicate: false };
    });
    broadcastChanged();
    return result;
  });
  api.post('/api/operations/undo-stay', async (req, reply) => {
    const p = z
      .object({
        id: z.uuid(),
        version: z.number().int().positive(),
        roomId: z.uuid(),
        checkIn: day,
        checkOut: day,
        nights: z.array(z.object({ date: day, price: z.number().min(0).max(1e8), manual: z.boolean().optional() })).max(3660),
      })
      .parse(req.body);
    if (
      p.checkOut <= p.checkIn ||
      p.nights.length !== diffDays(p.checkIn, p.checkOut) ||
      p.nights.some((n, i) => n.date !== addDays(p.checkIn, i))
    )
      return reply.code(400).send({ error: 'Некорректные даты или цены исходного проживания' });
    const result = await writeTx(async (tx) => {
      const [current] = await tx`select * from stays where id=${p.id} and deleted_at is null`;
      if (!current || Number(current.version) !== p.version || !['tentative', 'confirmed', 'checked_in'].includes(current.status))
        return null;
      const [room] = await tx`select id from rooms where id=${p.roomId} and deleted_at is null and is_active`;
      if (!room) return null;
      const [closure] =
        await tx`select id from room_closures where deleted_at is null and room_id=${p.roomId} and date_from<${p.checkOut}::date and date_to>${p.checkIn}::date`;
      if (closure) return null;
      const [busy] =
        await tx`select id from stays where deleted_at is null and id<>${p.id} and room_id=${p.roomId} and status in ('tentative','confirmed','checked_in') and check_in<${p.checkOut}::date and check_out>${p.checkIn}::date`;
      if (busy) return null;
      const [row] =
        await tx`update stays set room_id=${p.roomId},check_in=${p.checkIn},check_out=${p.checkOut},nights=${tx.json(p.nights)} where id=${p.id} returning *`;
      await tx`insert into audit_log(op,entity,entity_id,label) values('patch','stays',${p.id},'Отмена переноса проживания')`;
      return row;
    });
    if (!result) return reply.code(409).send({ error: 'Отмена невозможна: проживание изменилось или исходный номер занят/закрыт.' });
    broadcastChanged();
    return result;
  });
  api.get('/api/operations/diagnostics', async () => {
    const [db] = await sql`select 1 as ok`;
    const [backup] = await sql`select at,ok,size_bytes from backup_status order by at desc limit 1`;
    let restoreCheck: { checkedAt:string;ok:boolean;databaseOnly:boolean } | null = null;
    try {
      const value=JSON.parse((await fs.readFile(path.join(config.dataDir,'restore-check.json'),'utf8')).replace(/^\uFEFF/,''));
      if(typeof value.checkedAt==='string'&&typeof value.ok==='boolean')restoreCheck={checkedAt:value.checkedAt,ok:value.ok,databaseOnly:true};
    } catch { /* no completed validation yet */ }
    return { restoreCheck, serverVersion: config.appVersion, database: db.ok === 1, checkedAt: new Date().toISOString(), backup: backup ?? null };
  });
}
