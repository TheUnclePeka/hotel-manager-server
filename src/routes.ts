import { registerOperations } from './operations.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  ENTITIES,
  type EntityName,
  type Op,
  type PullRequest,
  type SmtpSettings,
  guestFullName,
  todayMsk,
  addDays,
  usnDeadlines,
  usnDeclaration,
  usnDeclarationLines,
} from '@hotel-manager/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { authorizeRoute, canReadRow, fullDomain } from './permissions.js';
import { config, updatesDir } from './config.js';
import { sql, writeTx } from './db.js';
import { readFile } from './files.js';
import { type ExaPayload, importExa } from './import-exa.js';
import { getSmtp, processMailQueue, saveSmtp, sendTestEmail } from './mail.js';
import { broadcastChanged, fcmEnabled, notifyAll, registerEventsRoute } from './notify.js';
import { recognizeLabel, recognizePassport } from './ocr.js';
import { type Column, REPORTS, reportToXlsx, tableToXlsx } from './reports.js';
import { declarationXml, ensCard, ledger, missingForDeclaration, usnData } from './tax.js';
import { applyOps } from './sync/push.js';
import { pull } from './sync/pull.js';
import { missingForNotice, noticeXml } from './taxNotice.js';

const OpSchema = z.object({
  opId: z.uuid(),
  kind: z.enum(['create', 'patch', 'delete', 'restore', 'action']),
  entity: z.string(),
  id: z.uuid(),
  data: z.record(z.string(), z.unknown()).optional(),
  baseVersion: z.number().optional(),
  action: z.string().optional(),
  ts: z.string(),
});

const isEntity = (e: string): e is EntityName => Object.hasOwn(ENTITIES, e);

function xlsxReply(reply: import('fastify').FastifyReply, name: string, buf: Buffer) {
  return reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}.xlsx`)
    .send(buf);
}

export function registerRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => ({ ok: true, version: config.appVersion }));

  app.register(async (api) => {
    api.addHook('preHandler', authenticate);
    api.addHook('preHandler', authorizeRoute);
    registerEventsRoute(api);
    registerOperations(api);

    // ─── Синхронизация ──────────────────────────────────────────────────────
    api.post('/api/sync/push', { bodyLimit: 60 * 1024 * 1024 }, async (req) => {
      const body = z.object({ ops: z.array(OpSchema).max(500) }).parse(req.body);
      const { results, events } = await applyOps(body.ops as Op[], { deviceId: req.device.id, deviceName: req.device.name });
      if (results.some((r) => r.status !== 'duplicate')) broadcastChanged(req.device.id);
      for (const ev of events) {
        if (ev.event === 'email') void processMailQueue();
        else void notifyAll(ev);
      }
      if (body.ops.some((o) => o.entity === 'messages')) void processMailQueue();
      return { results };
    });

    api.post('/api/sync/pull', async (req) => {
      const body = req.body as PullRequest;
      const res = await pull(body);
      for (const entity of Object.keys(res.rows) as EntityName[]) {
        res.rows[entity] = res.rows[entity]?.filter(row => canReadRow(req.device.role, entity, row));
      }
      await sql`update devices set last_sync_at = now() where id = ${req.device.id}`;
      return res;
    });

    // ─── Списки и карточки (данные только на сервере) ───────────────────────
    api.get<{ Params: { entity: string }; Querystring: Record<string, string> }>('/api/entities/:entity', async (req, reply) => {
      const { entity } = req.params;
      if (!isEntity(entity)) return reply.code(404).send({ error: 'Неизвестная сущность' });
      const table = ENTITIES[entity].table;
      const q = { ...req.query };
      const deleted = q.deleted === '1';
      const limit = Math.min(Number(q.limit ?? 1000), 5000);
      delete q.deleted;
      delete q.limit;
      const filters = Object.entries(q).filter(([k]) => /^[a-zA-Z]+$/.test(k));
      const where = filters.map(([k, v]) => (v === 'null' ? sql`and ${sql(k)} is null` : sql`and ${sql(k)} = ${v}`));
      const rows = await sql`
        select * from ${sql(table)}
         where ${deleted ? sql`deleted_at is not null` : sql`deleted_at is null`}
         ${where.reduce((acc, w) => sql`${acc} ${w}`, sql``)}
         order by created_at desc limit ${limit}`;
      return rows.filter(r => (entity !== 'settings' || r.key !== 'smtp') && canReadRow(req.device.role,entity,r));
    });

    api.get<{ Params: { entity: string; id: string } }>('/api/entities/:entity/:id', async (req, reply) => {
      const { entity, id } = req.params;
      if (!isEntity(entity)) return reply.code(404).send({ error: 'Неизвестная сущность' });
      const [row] = await sql`select * from ${sql(ENTITIES[entity].table)} where id = ${id}`;
      if (!row || (entity === 'settings' && row.key === 'smtp') || !canReadRow(req.device.role,entity,row)) return reply.code(404).send({ error: 'Не найдено' });
      return row;
    });

    api.get<{ Params: { id: string } }>('/api/guests/:id/full', async (req, reply) => {
      const [guest] = await sql`select * from guests where id = ${req.params.id}`;
      if (!guest) return reply.code(404).send({ error: 'Гость не найден' });
      const [docs] = await sql`select * from guest_docs where guest_id = ${req.params.id} and deleted_at is null`;
      const files = await sql`select * from files where owner_type = 'guest' and owner_id = ${req.params.id} and deleted_at is null order by created_at`;
      const bookings = await sql`
        select b.*, t.total, t.paid, t.balance,
               (select json_agg(json_build_object('id', s.id, 'roomId', s.room_id, 'checkIn', s.check_in, 'checkOut', s.check_out, 'status', s.status) order by s.check_in)
                  from stays s where s.booking_id = b.id and s.deleted_at is null) as stays
          from bookings b left join booking_totals t on t.booking_id = b.id
         where b.guest_id = ${req.params.id} and b.deleted_at is null
         order by b.created_at desc`;
      return { guest, docs: docs ?? null, files, bookings };
    });

    api.get<{ Params: { id: string } }>('/api/bookings/:id/full', async (req, reply) => {
      const [booking] = await sql`select * from bookings where id = ${req.params.id}`;
      if (!booking) return reply.code(404).send({ error: 'Бронь не найдена' });
      const [stays, charges, payments, deposits] = await Promise.all(
        (['stays', 'charges', 'payments', 'deposits'] as const).map((t) => sql`select * from ${sql(t)} where booking_id = ${req.params.id}`),
      );
      const guest = booking.guestId ? (await sql`select * from guests where id = ${booking.guestId as string}`)[0] : null;
      return { bookings: [booking], stays, charges, payments, deposits, guests: guest ? [guest] : [] };
    });

    /** Расходники с остатками. */
    api.get('/api/supplies', async () =>
      sql`select s.*, st.qty as stock from supplies s join supply_stock st on st.supply_id = s.id
           where s.deleted_at is null order by s.is_active desc, s.category nulls last, s.name`);

    api.get<{ Params: { id: string } }>('/api/supplies/:id/moves', async (req) =>
      sql`select m.*, r.name as room_name, sp.name as supplier_name from supply_moves m
            left join rooms r on r.id = m.room_id left join suppliers sp on sp.id = m.supplier_id
           where m.supply_id = ${req.params.id} and m.deleted_at is null
           order by m.date desc, m.created_at desc limit 500`);

    /** Сколько раз гость уже приезжал (брони с заселением или выездом), не считая указанной брони. */
    api.get<{ Params: { id: string }; Querystring: { exclude?: string } }>('/api/guests/:id/visits', async (req) => {
      const [r] = await sql<{ visits: number; last: string | null }[]>`
        select count(distinct b.id)::int as visits, max(s.check_out) as last
          from bookings b join stays s on s.booking_id = b.id and s.deleted_at is null and s.status in ('checked_in', 'checked_out')
         where b.guest_id = ${req.params.id} and b.deleted_at is null
           and b.id <> ${req.query.exclude ?? '00000000-0000-0000-0000-000000000000'}`;
      return r;
    });

    /** Сотрудники: начислено, выплачено, долг (всего и за текущий месяц). */
    api.get('/api/staff', async () => {
      const month = todayMsk().slice(0, 7);
      return sql`
        select s.*,
               coalesce((select sum(amount) from staff_accruals a where a.staff_id = s.id and a.deleted_at is null), 0)
             - coalesce((select sum(amount) from staff_payments x where x.staff_id = s.id and x.deleted_at is null), 0) as balance,
               coalesce((select sum(amount) from staff_accruals a where a.staff_id = s.id and a.deleted_at is null and to_char(a.date, 'YYYY-MM') = ${month}), 0) as month_accrued,
               coalesce((select sum(amount) from staff_payments x where x.staff_id = s.id and x.deleted_at is null and to_char(x.date, 'YYYY-MM') = ${month}), 0) as month_paid,
               (select max(date) from staff_accruals a where a.staff_id = s.id and a.deleted_at is null and a.kind = 'work') as last_work
          from staff s where s.deleted_at is null
         order by s.is_active desc, s.sort_order nulls last, s.name`;
    });

    api.get<{ Params: { id: string } }>('/api/staff/:id/ledger', async (req) =>
      sql`select id, date, 'accrual' as entry, kind, qty, rate, amount, comment, created_at from staff_accruals
           where staff_id = ${req.params.id} and deleted_at is null
          union all
          select id, date, 'payment', kind, null, null, amount, comment, created_at from staff_payments
           where staff_id = ${req.params.id} and deleted_at is null
          order by date desc, created_at desc limit 500`);

    /** Счётчики с последним показанием и расходом за последний период. */
    api.get('/api/meters', async () =>
      sql`select m.*, r.name as room_name, last.date as last_date, last.value as last_value, last.usage as last_usage,
                 last.prev_date as last_prev_date, last.usage * last.price as last_cost
            from meters m
            left join rooms r on r.id = m.room_id
            left join lateral (
              select u.* from meter_usage u join meter_readings mr on mr.id = u.reading_id
               where u.meter_id = m.id order by u.date desc, mr.created_at desc limit 1
            ) last on true
           where m.deleted_at is null order by m.is_active desc, m.sort_order nulls last, m.name`);

    api.get<{ Params: { id: string } }>('/api/meters/:id/readings', async (req) =>
      sql`select mr.*, u.usage, u.price as eff_price, u.usage * u.price as cost, u.prev_date
            from meter_readings mr join meter_usage u on u.reading_id = mr.id
           where mr.meter_id = ${req.params.id} and mr.deleted_at is null
           order by mr.date desc, mr.created_at desc limit 500`);

    /** Брони с размещениями в периоде целиком (для шахматки вне окна кэша). */
    api.get<{ Querystring: { from: string; to: string } }>('/api/families', async (req) => {
      const { from, to } = z.object({ from: z.iso.date(), to: z.iso.date() }).parse(req.query);
      const ids = (
        await sql<{ id: string }[]>`
          select distinct booking_id as id from stays where deleted_at is null and check_in < ${to} and check_out > ${from}`
      ).map((r) => r.id);
      if (!ids.length) return {};
      const [bookings, stays, charges, payments, deposits] = await Promise.all([
        sql`select * from bookings where id in ${sql(ids)} and deleted_at is null`,
        sql`select * from stays where booking_id in ${sql(ids)} and deleted_at is null`,
        sql`select * from charges where booking_id in ${sql(ids)} and deleted_at is null`,
        sql`select * from payments where booking_id in ${sql(ids)} and deleted_at is null`,
        sql`select * from deposits where booking_id in ${sql(ids)} and deleted_at is null`,
      ]);
      return { bookings, stays, charges, payments, deposits };
    });

    /** Брони за период (вне кэша устройства): для списка броней и истории. */
    api.get<{ Querystring: { from?: string; to?: string; q?: string; status?: string; limit?: string } }>('/api/bookings', async (req) => {
      const from = req.query.from ?? addDays(todayMsk(), -365);
      const to = req.query.to ?? addDays(todayMsk(), 365);
      const q = (req.query.q ?? '').trim();
      const qNum = /^\d+$/.test(q) ? Number(q) : null;
      return sql`
        select b.id, b.number, b.temp_number, b.exa_key, b.guest_id, b.source_id, b.created_at, b.tag_ids,
               g.last_name, g.first_name, g.middle_name, g.phone,
               t.total, t.paid, t.balance, t.active,
               min(s.check_in) as check_in, max(s.check_out) as check_out,
               array_agg(distinct s.status) as statuses, array_agg(distinct r.name) as rooms
          from bookings b
          join stays s on s.booking_id = b.id and s.deleted_at is null
          join rooms r on r.id = s.room_id
          left join guests g on g.id = b.guest_id
          left join booking_totals t on t.booking_id = b.id
         where b.deleted_at is null and s.check_out >= ${from} and s.check_in <= ${to}
           ${req.query.status ? sql`and s.status = ${req.query.status}` : sql``}
           ${q ? sql`and (b.number = ${qNum ?? -1} or b.exa_key = ${q} or g.last_name ilike ${`%${q}%`} or g.first_name ilike ${`%${q}%`} or g.phone like ${`%${q.replace(/\D/g, '') || '-'}%`})` : sql``}
         group by b.id, g.id, t.total, t.paid, t.balance, t.active
         order by min(s.check_in) desc
         limit ${Math.min(Number(req.query.limit ?? 500), 2000)}`;
    });

    /** Общий поиск. */
    api.get<{ Querystring: { q: string } }>('/api/search', async (req) => {
      const q = (req.query.q ?? '').trim();
      if (q.length < 2) return { guests: [], bookings: [], assets: [], suppliers: [] };
      const like = `%${q}%`;
      const digits = q.replace(/\D/g, '');
      const guests = await sql`
        select g.id, g.last_name, g.first_name, g.middle_name, g.phone, g.birth_date, g.blacklisted from guests g
          left join guest_docs d on d.guest_id = g.id and d.deleted_at is null
         where g.deleted_at is null and (
           (g.last_name || ' ' || coalesce(g.first_name, '') || ' ' || coalesce(g.middle_name, '')) ilike ${like}
           or (${digits.length >= 4} and (regexp_replace(coalesce(g.phone, ''), '\\D', '', 'g') like ${`%${digits}%`}
                                          or (coalesce(d.doc_series, '') || coalesce(d.doc_number, '')) like ${`%${digits}%`}
                                          or replace(coalesce(d.doc_series, '') || coalesce(d.doc_number, ''), ' ', '') like ${`%${digits}%`})))
         order by g.last_name limit 30`;
      const bookings = /^\d+$/.test(q)
        ? await sql`
            select b.id, b.number, b.exa_key, g.last_name, g.first_name, (select min(check_in) from stays where booking_id = b.id and deleted_at is null) as check_in
              from bookings b left join guests g on g.id = b.guest_id
             where b.deleted_at is null and (b.number = ${Number(q)} or b.exa_key = ${q}) limit 10`
        : [];
      const assets = fullDomain(req.device.role) ? await sql`
        select id, inv_number, name, written_off_at from assets
         where deleted_at is null and (name ilike ${like} or inv_number ilike ${like}) order by name limit 20` : [];
      const suppliers = fullDomain(req.device.role) ? await sql`select id, name, phone from suppliers where deleted_at is null and name ilike ${like} limit 10` : [];
      return { guests, bookings, assets, suppliers };
    });

    // ─── Файлы ──────────────────────────────────────────────────────────────
    api.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
      const id = z.uuid().parse(req.params.id);
      const [f] = await sql<{ mime: string; fileName: string; ownerType: string }[]>`select mime, file_name, owner_type from files where id = ${id} and deleted_at is null`;
      if (!f || !canReadRow(req.device.role,'files',f)) return reply.code(404).send({ error: 'Файл не найден' });
      const data = await readFile(req.params.id);
      return reply
        .header('Content-Type', f.mime)
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`)
        .send(data);
    });

    api.get<{ Querystring: { ownerType: string; ownerId: string } }>('/api/files', async (req) => {
      const rows = await sql`
        select * from files where owner_type = ${req.query.ownerType} and owner_id = ${req.query.ownerId} and deleted_at is null
         order by created_at`;
      return rows.filter(row=>canReadRow(req.device.role,'files',row));
    });

    // ─── Распознавание паспорта ─────────────────────────────────────────────
    api.post('/api/ocr/passport', { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
      const { imageBase64 } = z.object({ imageBase64: z.string().min(100) }).parse(req.body);
      return recognizePassport(Buffer.from(imageBase64, 'base64'));
    });

    api.post('/api/ocr/label', { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
      const { imageBase64 } = z.object({ imageBase64: z.string().min(100) }).parse(req.body);
      return recognizeLabel(Buffer.from(imageBase64, 'base64'));
    });

    // ─── Налог ИП: расчёт УСН за год и уведомление ──────────────────────────
    /** Значения периода для сравнения с суммами на момент закрытия. */
    const periodValues = (d: Awaited<ReturnType<typeof usnData>>, period: number): Record<string, number> => {
      const p = d.periods[period - 1];
      if (period < 4) return { income: Math.round(p.income), tax: p.tax, reduction: p.reduction, payable: p.payable };
      const decl = usnDeclaration(d.periods, d.rateReason);
      return { income: Math.round(p.income), tax: p.tax, reduction: p.reduction, l100: decl.l100, l110: decl.l110 };
    };

    api.get<{ Querystring: { year?: string } }>('/api/tax/usn', async (req) => {
      const year = Number(req.query.year) || Number(todayMsk().slice(0, 4));
      const d = await usnData(year);
      const closed = await sql<{ id: string; period: number; closedAt: string; correction: number; snapshot: Record<string, number>; comment: string | null; reopenedAt: string | null; version: number }[]>`
        select id, period, closed_at, correction, snapshot, comment, reopened_at, version from tax_periods
         where deleted_at is null and year = ${year} order by period, closed_at desc`;
      return {
        year,
        regime: d.s.regime,
        ip: d.ip,
        start: d.start,
        kbk: d.kbk,
        fixed: d.fixed,
        periods: d.periods,
        declaration: usnDeclarationLines(d.periods, d.ip.oktmo, d.rateReason),
        decl: usnDeclaration(d.periods, d.rateReason),
        deadlines: usnDeadlines(year),
        missing: missingForNotice(d.ip),
        incomeCount: d.income.length,
        vat: { threshold: d.vatThreshold, income: Math.round(d.periods[3].income) },
        closed: closed.map((c) => {
          const now = periodValues(d, c.period);
          const changed = !c.reopenedAt && Object.keys(now).some((k) => Math.round(Number(c.snapshot?.[k] ?? 0)) !== Math.round(now[k]));
          return { ...c, current: now, changed };
        }),
      };
    });

    api.get<{ Querystring: { year?: string } }>('/api/tax/ledger', async (req) => {
      const year = Number(req.query.year) || Number(todayMsk().slice(0, 4));
      const d = await usnData(year);
      const entries = await sql`
        select * from tax_entries where deleted_at is null and date between ${`${year}-01-01`} and ${`${year}-12-31`} order by date, created_at`;
      return { year, start: d.start, rows: d.rows, entries };
    });

    api.get<{ Querystring: { year?: string } }>('/api/tax/ens', async (req) => ensCard(Number(req.query.year) || Number(todayMsk().slice(0, 4))));

    api.get<{ Querystring: { year: string; correction?: string } }>('/api/tax/declaration.xml', async (req, reply) => {
      const year = Number(req.query.year);
      if (!year) return reply.code(400).send({ error: 'Укажите год' });
      const d = await usnData(year);
      if (d.s.regime !== 'usn6') return reply.code(400).send({ error: 'Файл декларации формируется для УСН «доходы»; для других режимов заполните декларацию по значениям строк' });
      const miss = missingForDeclaration(d.ip);
      if (miss.length) return reply.code(400).send({ error: `Заполните в «Настройки → Реквизиты ИП»: ${miss.join(', ')}` });
      const f = declarationXml(d, Number(req.query.correction) || 0, config.appVersion);
      return reply
        .header('Content-Type', 'application/xml')
        .header('Content-Disposition', `attachment; filename="${f.fileName}"`)
        .send(f.data);
    });

    api.get<{ Querystring: { year: string; q: string } }>('/api/tax/usn/notice.xml', async (req, reply) => {
      const year = Number(req.query.year);
      const q = Number(req.query.q);
      if (!year || q < 1 || q > 3) return reply.code(400).send({ error: 'Уведомление подаётся за I квартал, полугодие и 9 месяцев' });
      const d = await usnData(year);
      const miss = missingForNotice(d.ip);
      if (miss.length) return reply.code(400).send({ error: `Заполните в «Настройки → Реквизиты ИП»: ${miss.join(', ')}` });
      const f = noticeXml(d.ip, d.periods[q - 1], d.kbk, year);
      return reply
        .header('Content-Type', 'application/xml')
        .header('Content-Disposition', `attachment; filename="${f.fileName}"`)
        .send(f.data);
    });

    // ─── Отчёты и выгрузки ──────────────────────────────────────────────────
    const ReportQuery = z.object({
      from: z.iso.date(),
      to: z.iso.date(),
      group: z.enum(['day', 'month']).optional(),
    });
    api.get('/api/reports', async () => Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title })));
    api.get<{ Params: { name: string } }>('/api/reports/:name', async (req, reply) => {
      const r = REPORTS[req.params.name];
      if (!r) return reply.code(404).send({ error: 'Отчёт не найден' });
      return r.run(ReportQuery.parse(req.query));
    });
    api.get<{ Params: { name: string } }>('/api/reports/:name/xlsx', async (req, reply) => {
      const r = REPORTS[req.params.name];
      if (!r) return reply.code(404).send({ error: 'Отчёт не найден' });
      const p = ReportQuery.parse(req.query);
      const report = await r.run(p);
      return xlsxReply(reply, `${report.title} ${p.from}_${p.to}`, await reportToXlsx(report));
    });
    api.post('/api/export/xlsx', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
      const body = z
        .object({
          title: z.string().max(100),
          columns: z.array(z.object({ key: z.string(), label: z.string(), type: z.string().optional() })),
          rows: z.array(z.record(z.string(), z.unknown())),
        })
        .parse(req.body);
      return xlsxReply(reply, body.title, await tableToXlsx(body.title, body.columns as Column[], body.rows));
    });

    // ─── Журнал изменений и корзина ─────────────────────────────────────────
    api.get<{ Querystring: { entity?: string; entityId?: string; before?: string; limit?: string; q?: string } }>('/api/audit', async (req) => {
      const { entity, entityId, before, q } = req.query;
      return sql`
        select * from audit_log
         where true
           ${entity ? sql`and entity = ${entity}` : sql``}
           ${entityId ? sql`and entity_id = ${entityId}` : sql``}
           ${before ? sql`and id < ${Number(before)}` : sql``}
           ${q ? sql`and (label ilike ${`%${q}%`} or device_name ilike ${`%${q}%`})` : sql``}
         order by id desc limit ${Math.min(Number(req.query.limit ?? 100), 500)}`;
    });

    api.get('/api/trash', async () => {
      const out: Record<string, unknown>[] = [];
      const kinds: EntityName[] = ['bookings', 'stays', 'guests', 'payments', 'charges', 'deposits', 'expenses', 'assets', 'suppliers', 'reminders', 'files', 'rooms', 'services', 'seasons', 'roomClosures', 'supplies', 'supplyMoves', 'priceRules', 'meters', 'meterReadings', 'staff', 'staffAccruals', 'staffPayments', 'taxEntries', 'taxAdjustments', 'taxPeriods'];
      for (const e of kinds) {
        const rows = await sql<Record<string, unknown>[]>`
          select * from ${sql(ENTITIES[e].table)} where deleted_at > now() - ${`${config.trashDays} days`}::interval order by deleted_at desc limit 200`;
        for (const r of rows) out.push({ entity: e, row: r, deletedAt: r.deletedAt });
      }
      // Связанные записи брони, удалённые вместе с ней, отдельно не показываются.
      const deletedBookings = new Map(out.filter((x) => x.entity === 'bookings').map((x) => [(x.row as { id: string }).id, x.deletedAt]));
      const filtered = out.filter((x) => {
        if (!['stays', 'payments', 'charges', 'deposits'].includes(x.entity as string)) return true;
        const r = x.row as { bookingId: string; deletedAt: string };
        return deletedBookings.get(r.bookingId) !== r.deletedAt;
      });
      // Подписи гостей для броней.
      const guestIds = filtered.map((x) => (x.row as { guestId?: string }).guestId).filter(Boolean) as string[];
      const guests = guestIds.length ? await sql`select id, last_name, first_name, middle_name from guests where id in ${sql(guestIds)}` : [];
      const gmap = new Map(guests.map((g) => [g.id as string, guestFullName(g as never)]));
      return filtered
        .map((x) => ({ ...x, guestName: gmap.get((x.row as { guestId?: string }).guestId ?? '') ?? null }) as Record<string, unknown>)
        .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    });

    // ─── Настройки почты ────────────────────────────────────────────────────
    api.get('/api/settings/smtp', async () => {
      const s = await getSmtp();
      return s ? { ...s, pass: '' , hasPassword: Boolean(s.pass) } : null;
    });
    api.put('/api/settings/smtp', async (req) => {
      const s = z
        .object({
          host: z.string().max(200),
          port: z.number().int().min(1).max(65535),
          secure: z.boolean(),
          user: z.string().max(200),
          pass: z.string().max(200),
          from: z.string().max(200),
        })
        .parse(req.body) as SmtpSettings;
      await saveSmtp(s);
      return { ok: true };
    });
    api.post('/api/settings/smtp/test', async (req) => {
      const { to } = z.object({ to: z.email() }).parse(req.body);
      await sendTestEmail(to);
      return { ok: true };
    });

    // ─── Состояние сервера ──────────────────────────────────────────────────
    api.get('/api/server/status', async () => {
      const [backup] = await sql`select at, ok, size_bytes, message from backup_status order by at desc limit 1`;
      const [lastOk] = await sql`select at, size_bytes from backup_status where ok order by at desc limit 1`;
      const [db] = await sql<{ size: number }[]>`select pg_database_size(current_database())::bigint as size`;
      let disk: { free: number; total: number } | null = null;
      try {
        const st = await fs.promises.statfs(config.dataDir);
        disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
      } catch {
        /* нет данных */
      }
      return {
        version: config.appVersion,
        serverTime: new Date().toISOString(),
        lastBackup: backup ?? null,
        lastSuccessfulBackup: lastOk ?? null,
        dbSize: db.size,
        disk,
        fcm: fcmEnabled(),
        smtp: Boolean(await getSmtp()),
      };
    });

    // ─── Обновления клиентов ────────────────────────────────────────────────
    api.get('/api/updates/latest', async () => {
      const f = path.join(updatesDir(), 'latest.json');
      if (!fs.existsSync(f)) return { desktop: null, android: null };
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    });
    api.get<{ Params: { name: string } }>('/api/updates/file/:name', async (req, reply) => {
      const name = path.basename(req.params.name);
      const f = path.join(updatesDir(), name);
      if (!fs.existsSync(f)) return reply.code(404).send({ error: 'Файл не найден' });
      const type = name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream';
      return reply.header('Content-Type', type).header('Content-Length', fs.statSync(f).size).send(fs.createReadStream(f));
    });

    // ─── Импорт из ExaHotelFree ─────────────────────────────────────────────
    api.post('/api/import/exa', { bodyLimit: 200 * 1024 * 1024 }, async (req) => {
      const report = await importExa(req.body as ExaPayload);
      broadcastChanged();
      return report;
    });

    // ─── Тестовое уведомление ───────────────────────────────────────────────
    api.post('/api/notify/test', async () => {
      await notifyAll({ event: 'conflicts', title: 'HotelManager', body: 'Проверка уведомлений: всё работает' });
      return { ok: true };
    });

    // Отметка о резервной копии (вызывается и из cli, но доступна и по API для диагностики).
    api.get('/api/backups', async () => sql`select * from backup_status order by at desc limit 60`);

    api.post('/api/conflicts/resolve-all', async () => {
      await writeTx((tx) => tx`update conflicts set resolved_at = now() where resolved_at is null and kind in ('relocated', 'rejected', 'deleted_edit')`);
      broadcastChanged();
      return { ok: true };
    });
  });
}
