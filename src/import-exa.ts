import crypto from 'node:crypto';
import { addDays, diffDays, fmtDate, type Night, normalizePhone, todayMsk } from '@hotel-manager/shared';
import { type Tx, writeTx } from './db.js';

/**
 * Перенос данных из ExaHotelFree.
 *
 * Программа на ПК читает файлы базы ExaHotel (снимки таблиц *.dat и журнал *.ts),
 * распаковывает их и присылает сюда как есть. Сервер применяет журнал поверх снимков
 * и переносит данные. Идентификаторы HotelManager вычисляются из идентификаторов ExaHotel,
 * поэтому повторный импорт обновляет те же записи, а не создаёт дубли.
 */

export type ExaRec = Record<string, string>;
export interface ExaElem {
  tag: string;
  a: ExaRec;
}
export interface ExaPayload {
  tables: Record<string, ExaRec[]>;
  /** Транзакции журнала в хронологическом порядке. */
  journal: ExaElem[][];
}

export interface ImportReport {
  rooms: number;
  roomsCreated: number;
  guests: number;
  bookings: number;
  stays: number;
  payments: number;
  charges: number;
  services: number;
  cancelled: number;
  conflicts: number;
  checkedInPast: number;
  exaTotal: number;
  myTotal: number;
  exaReceived: number;
  myReceived: number;
  warnings: string[];
}

/** UUID, детерминированно вычисленный из идентификатора ExaHotel. */
export function exaUuid(kind: string, id: string): string {
  const h = crypto.createHash('sha1').update(`hotelmanager-exa:${kind}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const exaDate = (s: string | undefined): string | null => (s && /^\d{4}\.\d{2}\.\d{2}$/.test(s) ? s.replace(/\./g, '-') : null);
const num = (s: string | undefined): number => (s ? Number(s.replace(',', '.')) || 0 : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Состояния брони ExaHotel → статусы HotelManager. */
const STATE_MAP: Record<string, string> = {
  '0': 'confirmed',
  '1': 'checked_in',
  '2': 'no_show',
  '3': 'cancelled',
  '4': 'checked_out',
};

interface PaymentEvent {
  orderId: string;
  date: string;
  amount: number;
}

/** Применяет журнал поверх снимков; собирает события оплат с датами. */
export function replay(payload: ExaPayload): { tables: Record<string, Map<string, ExaRec>>; payments: PaymentEvent[]; snapshotReceived: Map<string, number> } {
  const tables: Record<string, Map<string, ExaRec>> = {};
  for (const [name, rows] of Object.entries(payload.tables)) {
    const m = new Map<string, ExaRec>();
    // ActualFrom — версия записи: остаётся самая поздняя.
    for (const r of rows) {
      const prev = m.get(r.ID);
      if (!prev || (r.ActualFrom ?? '') >= (prev.ActualFrom ?? '')) m.set(r.ID, r);
    }
    tables[name] = m;
  }
  const snapshotReceived = new Map<string, number>();
  for (const o of tables.Orders?.values() ?? []) if (num(o.PriceReceived)) snapshotReceived.set(o.ID, num(o.PriceReceived));

  const payments: PaymentEvent[] = [];
  for (const tx of payload.journal) {
    const log = tx.find((e) => e.tag === 'Log.Add');
    const date = exaDate(log?.a.Date) ?? todayMsk();
    for (const e of tx) {
      const [table, op] = e.tag.split('.');
      if (table === 'Log' || !op) continue;
      const t = (tables[table] ??= new Map());
      if (op === 'Add') {
        t.set(e.a.ID, { ...e.a });
        if (table === 'Orders' && num(e.a.PriceReceived)) payments.push({ orderId: e.a.ID, date, amount: num(e.a.PriceReceived) });
      } else if (op === 'Edit') {
        const cur = { ...(t.get(e.a.ID) ?? { ID: e.a.ID }) };
        for (const [k, v] of Object.entries(e.a)) {
          if (k === 'ID') continue;
          if (k.endsWith('.Difference')) {
            const field = k.slice(0, -'.Difference'.length);
            const before = num(cur[field]);
            cur[field] = String(r2(before + num(v)));
            if (table === 'Orders' && field === 'PriceReceived') payments.push({ orderId: e.a.ID, date, amount: num(v) });
          } else {
            if (table === 'Orders' && k === 'PriceReceived') {
              const delta = r2(num(v) - num(cur.PriceReceived));
              if (delta) payments.push({ orderId: e.a.ID, date, amount: delta });
            }
            cur[k] = v;
          }
        }
        t.set(e.a.ID, cur);
      } else if (op === 'Delete') {
        t.delete(e.a.ID);
      }
    }
  }
  return { tables, payments, snapshotReceived };
}

function splitName(full: string): { lastName: string; firstName: string | null; middleName: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { lastName: 'Без имени', firstName: null, middleName: null };
  return { lastName: parts[0], firstName: parts[1] ?? null, middleName: parts.slice(2).join(' ') || null };
}

/** «1. 2-х», «15 Люкс», «10. 2-х (Тех)» → номер, категория, служебный. */
export function parseRoomName(name: string, notes: string | undefined): { number: string; category: string; isService: boolean } {
  const number = name.match(/^\s*(\d+)/)?.[1] ?? name.trim();
  const text = `${name} ${notes ?? ''}`.toLowerCase();
  let category = '2-местный';
  if (/люкс/.test(text)) category = 'Люкс';
  else if (/4\s*-?\s*х/.test(text)) category = '4-местный';
  else if (/3\s*-?\s*х/.test(text)) category = '3-местный';
  else if (/2\s*-?\s*х/.test(text)) category = '2-местный';
  return { number, category, isService: /\(тех\)|служеб/i.test(name) };
}

/** Строка заказа — проживание или доп. услуга (вода, вино, «до вечера»…). */
export function isLivingLine(name: string): boolean {
  return /номер|прожив|№|^\s*\d|мест|-х|\dx|-й/i.test(name);
}

const PASSPORT_SERIES = /^(\d{2})\s?(\d{2})\s?(\d{5,6})$/;

export async function importExa(payload: ExaPayload): Promise<ImportReport> {
  const { tables, payments, snapshotReceived } = replay(payload);
  const report: ImportReport = {
    rooms: 0, roomsCreated: 0, guests: 0, bookings: 0, stays: 0, payments: 0, charges: 0, services: 0,
    cancelled: 0, conflicts: 0, checkedInPast: 0, exaTotal: 0, myTotal: 0, exaReceived: 0, myReceived: 0, warnings: [],
  };
  const today = todayMsk();

  return writeTx(async (tx) => {
    // Прошлый импорт: всё помечается удалённым и «воскрешается» при повторной загрузке.
    const importedBookings = await tx<{ id: string; number: number }[]>`select id, number from bookings where exa_key is not null`;
    const prevNumbers = new Map(importedBookings.map((b) => [b.id, b.number]));
    await tx`update stays set deleted_at = now() where booking_id in (select id from bookings where exa_key is not null) and deleted_at is null`;
    for (const t of ['charges', 'payments']) {
      await tx`update ${tx(t)} set deleted_at = now() where booking_id in (select id from bookings where exa_key is not null) and deleted_at is null`;
    }
    await tx`update bookings set deleted_at = now() where exa_key is not null and deleted_at is null`;

    // Номера и категории.
    const cats = new Map(
      (await tx<{ id: string; name: string; places: number }[]>`select id, name, places from room_categories where deleted_at is null`).map((c) => [c.name, c]),
    );
    const roomIdMap = new Map<string, string>();
    const roomPlaces = new Map<string, number>();
    const roomNumber = new Map<string, string>();
    for (const r of tables.Rooms?.values() ?? []) {
      const p = parseRoomName(r.Name, r.Notes);
      let cat = cats.get(p.category);
      if (!cat) {
        const [c] = await tx<{ id: string; name: string; places: number }[]>`
          insert into room_categories (name, places, base_price) values (${p.category}, ${Number(p.category[0]) || 2}, 0) returning id, name, places`;
        cats.set(p.category, c);
        cat = c;
      }
      const [existing] = await tx<{ id: string; places: number }[]>`select id, places from rooms where name = ${p.number} and deleted_at is null limit 1`;
      let id = existing?.id;
      if (!id) {
        id = exaUuid('room', r.ID);
        await tx`
          insert into rooms (id, name, category_id, places, notes, is_service, sort_order)
          values (${id}, ${p.number}, ${cat.id}, ${cat.places}, ${r.Notes ?? null}, ${p.isService}, ${Number(p.number) || null})
          on conflict (id) do update set deleted_at = null`;
        report.roomsCreated++;
      }
      roomIdMap.set(r.ID, id);
      roomNumber.set(r.ID, p.number);
      roomPlaces.set(r.ID, existing?.places ?? cat.places);
      report.rooms++;
    }

    // Гости.
    const guestIdMap = new Map<string, string>();
    for (const c of tables.Clients?.values() ?? []) {
      const id = exaUuid('client', c.ID);
      guestIdMap.set(c.ID, id);
      const n = splitName(c.Name ?? '');
      const phone = normalizePhone(c.Phone);
      const guest = {
        id,
        lastName: n.lastName,
        firstName: n.firstName,
        middleName: n.middleName,
        birthDate: exaDate(c.Birthday),
        gender: c.Gender === '1' ? 'm' : c.Gender === '2' ? 'f' : null,
        phone: phone ? `+${phone}` : null,
        extraPhones: c.AdditPhones ?? null,
        email: c.Email ?? null,
        notes: c.Notes ?? null,
        exaId: c.ID,
        deletedAt: null,
      };
      await tx`
        insert into guests ${tx(guest)}
        on conflict (id) do update set
          last_name = excluded.last_name, first_name = excluded.first_name, middle_name = excluded.middle_name,
          birth_date = excluded.birth_date, gender = excluded.gender, phone = excluded.phone, extra_phones = excluded.extra_phones,
          email = excluded.email, notes = coalesce(guests.notes, excluded.notes), deleted_at = null`;
      report.guests++;

      const hasDocs = c.PassportNumber || c.PassportGivenBy || c.Address || c.Region || c.City || c.YAddress || c.Nationality || c.BirthCity;
      if (hasDocs) {
        const pn = (c.PassportNumber ?? '').trim();
        const m = pn.match(PASSPORT_SERIES);
        const code = (c.PassportGivenByCode ?? '').replace(/\D/g, '');
        const docs = {
          id: exaUuid('docs', c.ID),
          guestId: id,
          docSeries: m ? `${m[1]} ${m[2]}` : null,
          docNumber: m ? m[3] : pn || null,
          docIssuedBy: c.PassportGivenBy ?? null,
          docIssueDate: exaDate(c.PassportFrom),
          docDeptCode: code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : c.PassportGivenByCode ?? null,
          birthPlace: [c.BirthCountry, c.BirthRegion, c.BirthCity].filter(Boolean).join(', ') || null,
          citizenship: c.Nationality ? (/^р(ф|оссия)$/i.test(c.Nationality.trim()) ? 'Россия' : c.Nationality) : null,
          regCountry: c.Country ? (/^р(ф|оссия)$/i.test(c.Country.trim()) ? 'Россия' : c.Country) : null,
          regRegion: c.Region ?? null,
          regCity: c.City ?? null,
          regAddress: c.Address ?? null,
          regIndex: c.PostIndex ?? null,
          factAddress: [c.YCountry, c.YRegion, c.YCity, c.YAddress, c.YPostIndex].filter(Boolean).join(', ') || null,
          deletedAt: null,
        };
        await tx`
          insert into guest_docs ${tx(docs)}
          on conflict (guest_id) do update set
            doc_series = coalesce(guest_docs.doc_series, excluded.doc_series), doc_number = coalesce(guest_docs.doc_number, excluded.doc_number),
            doc_issued_by = coalesce(guest_docs.doc_issued_by, excluded.doc_issued_by), doc_issue_date = coalesce(guest_docs.doc_issue_date, excluded.doc_issue_date),
            doc_dept_code = coalesce(guest_docs.doc_dept_code, excluded.doc_dept_code), birth_place = coalesce(guest_docs.birth_place, excluded.birth_place),
            citizenship = coalesce(guest_docs.citizenship, excluded.citizenship), reg_country = coalesce(guest_docs.reg_country, excluded.reg_country),
            reg_region = coalesce(guest_docs.reg_region, excluded.reg_region), reg_city = coalesce(guest_docs.reg_city, excluded.reg_city),
            reg_address = coalesce(guest_docs.reg_address, excluded.reg_address), fact_address = coalesce(guest_docs.fact_address, excluded.fact_address),
            deleted_at = null`;
      }
    }

    // Доп. услуги из строк заказов → справочник.
    const services = new Map(
      (await tx<{ id: string; name: string }[]>`select id, name from services where deleted_at is null`).map((s) => [s.name.toLowerCase(), s.id]),
    );
    const linesByOrder = new Map<string, ExaRec[]>();
    for (const l of tables.OrderLiving?.values() ?? []) {
      const list = linesByOrder.get(l.OrderID) ?? [];
      list.push(l);
      linesByOrder.set(l.OrderID, list);
    }

    // Брони: по порядку оформления; номера — сквозные.
    const orders = [...(tables.Orders?.values() ?? [])].sort((a, b) =>
      `${a.SaleDate ?? ''} ${a.SaleTime ?? ''} ${a.Key ?? ''}`.localeCompare(`${b.SaleDate ?? ''} ${b.SaleTime ?? ''} ${b.Key ?? ''}`),
    );
    const paymentsByOrder = new Map<string, PaymentEvent[]>();
    for (const p of payments) {
      const list = paymentsByOrder.get(p.orderId) ?? [];
      list.push(p);
      paymentsByOrder.set(p.orderId, list);
    }

    for (const o of orders) {
      const checkIn = exaDate(o.DateFrom);
      const checkOut = exaDate(o.DateTo);
      // Заказ может включать несколько номеров: RoomID="id1,id2".
      const stayRooms = (o.RoomID ?? '')
        .split(/[,;\s]+/)
        .filter(Boolean)
        .map((exaId) => ({ exaId, roomId: roomIdMap.get(exaId), number: roomNumber.get(exaId) ?? '' }))
        .filter((r): r is { exaId: string; roomId: string; number: string } => Boolean(r.roomId));
      if (!checkIn || !checkOut || !stayRooms.length) {
        report.warnings.push(`Заказ ${o.Key ?? o.ID}: нет дат или номера — пропущен`);
        continue;
      }
      const nightsCount = Math.max(1, diffDays(checkIn, checkOut));
      const stayCheckOut = diffDays(checkIn, checkOut) >= 1 ? checkOut : addDays(checkIn, 1);
      // Состояние не указано (старые заказы) — по датам: прошедшие считаются завершёнными.
      const status = o.State ? (STATE_MAP[o.State] ?? 'confirmed') : checkOut < today ? 'checked_out' : 'confirmed';
      const bookingId = exaUuid('order', o.ID);
      const clientIds = (o.Clients ?? '').split(/[,;\s]+/).filter(Boolean);
      const guestId = clientIds.map((c) => guestIdMap.get(c)).find(Boolean) ?? null;
      const others = clientIds.slice(1).map((c) => tables.Clients?.get(c)?.Name).filter(Boolean);
      const notes = [o.Notes, others.length ? `Также проживали: ${others.join(', ')}` : null].filter(Boolean).join('\n') || null;

      // Суммы. Строки проживания с номером комнаты в названии («1 номер», «№12») относятся к этому номеру.
      const lines = linesByOrder.get(o.ID) ?? [];
      const assigned = new Map<string, number>();
      let unassigned = 0;
      let persons = 1;
      const serviceLines: { name: string; qty: number; price: number; id: string }[] = [];
      for (const l of lines) {
        const qty = num(l.Count) * num(l.Days);
        const price = num(l.Price) * (1 - num(l.Discount) / 100);
        if (isLivingLine(l.Name)) {
          const digits = l.Name.match(/\d+/)?.[0];
          const target = stayRooms.length > 1 ? stayRooms.find((r) => r.number === digits) : undefined;
          if (target) assigned.set(target.exaId, (assigned.get(target.exaId) ?? 0) + qty * price);
          else unassigned += qty * price;
          if (stayRooms.length === 1) persons = Math.max(persons, num(l.Count) || 1);
        } else {
          serviceLines.push({ name: l.Name, qty, price: r2(price), id: l.ID });
        }
      }
      const svcTotal = r2(serviceLines.reduce((a, s) => a + s.qty * s.price, 0));
      const price = num(o.Price);
      if (!lines.length) unassigned = price;
      const living = r2(unassigned + [...assigned.values()].reduce((a, b) => a + b, 0));
      let discount = r2(living + svcTotal - price);
      if (discount < 0) {
        // Цена заказа больше суммы строк — разница добавляется к проживанию.
        unassigned -= discount;
        discount = 0;
      }

      const number = prevNumbers.get(bookingId) ?? (await tx<{ n: number }[]>`select nextval('booking_number_seq')::int as n`)[0].n;
      await tx`
        insert into bookings (id, number, guest_id, discount, notes, exa_key, created_at)
        values (${bookingId}, ${number}, ${guestId}, ${discount}, ${notes}, ${o.Key ?? o.ID},
                ${`${exaDate(o.SaleDate) ?? checkIn}T${o.SaleTime ?? '12:00:00'}+03:00`})
        on conflict (id) do update set number = excluded.number, guest_id = excluded.guest_id, discount = excluded.discount,
          notes = excluded.notes, exa_key = excluded.exa_key, deleted_at = null`;
      report.bookings++;

      // Нераспределённая сумма делится поровну между номерами без своих строк.
      const free = stayRooms.filter((r) => !assigned.has(r.exaId));
      const shareTargets = free.length ? free : stayRooms;
      const share = Math.floor((unassigned / shareTargets.length) * 100) / 100;
      let shareRest = r2(unassigned - share * shareTargets.length);

      for (const [idx, sr] of stayRooms.entries()) {
        let roomLiving = assigned.get(sr.exaId) ?? 0;
        if (shareTargets.includes(sr)) {
          roomLiving += share + shareRest;
          shareRest = 0;
        }
        roomLiving = r2(roomLiving);
        // Цена ночи — равными частями, остаток копеек на последнюю ночь.
        const per = Math.floor((roomLiving / nightsCount) * 100) / 100;
        const nights: Night[] = [];
        for (let i = 0; i < nightsCount; i++) {
          nights.push({ date: addDays(checkIn, i), price: i === nightsCount - 1 ? r2(roomLiving - per * (nightsCount - 1)) : per, manual: true });
        }
        const stay = {
          id: exaUuid('stay', idx === 0 ? o.ID : `${o.ID}:${sr.exaId}`),
          bookingId,
          roomId: sr.roomId,
          checkIn,
          checkOut: stayCheckOut,
          persons: Math.min(persons, roomPlaces.get(sr.exaId) ?? persons),
          status,
          nights: tx.json(nights as never),
          cancelledAt: status === 'cancelled' ? `${exaDate(o.CancelledOn) ?? checkIn}T12:00:00+03:00` : null,
          deletedAt: null,
        };
        try {
          await tx.savepoint(async (sp) => {
            await sp`
              insert into stays ${sp(stay)}
              on conflict (id) do update set booking_id = excluded.booking_id, room_id = excluded.room_id, check_in = excluded.check_in,
                check_out = excluded.check_out, persons = excluded.persons, status = excluded.status, nights = excluded.nights,
                cancelled_at = excluded.cancelled_at, deleted_at = null`;
          });
        } catch (e) {
          if ((e as { code?: string }).code !== '23P01') throw e;
          await tx`
            insert into stays ${tx({ ...stay, status: 'conflict' })}
            on conflict (id) do update set booking_id = excluded.booking_id, room_id = excluded.room_id, check_in = excluded.check_in,
              check_out = excluded.check_out, persons = excluded.persons, status = 'conflict', nights = excluded.nights, deleted_at = null`;
          const [cnf] = await tx`select 1 from conflicts where entity_id = ${stay.id} and kind = 'unplaced' and resolved_at is null`;
          if (!cnf) {
            await tx`
              insert into conflicts (kind, entity, entity_id, message, data)
              values ('unplaced', 'stays', ${stay.id},
                      ${`Импорт из ExaHotel: заказ ${o.Key ?? ''} (номер ${sr.number}, ${fmtDate(checkIn)} – ${fmtDate(checkOut)}) пересекается с другой бронью`},
                      ${tx.json({ bookingId, originalStatus: status } as never)})`;
          }
          report.conflicts++;
        }
        report.stays++;
      }
      if (status === 'cancelled') report.cancelled++;
      if (status === 'checked_in' && checkOut < today) report.checkedInPast++;
      if (!['cancelled', 'no_show'].includes(status)) report.exaTotal += price;

      for (const s of serviceLines) {
        let serviceId = services.get(s.name.toLowerCase());
        if (!serviceId) {
          const [svc] = await tx<{ id: string }[]>`insert into services (name, price) values (${s.name}, ${s.price}) returning id`;
          serviceId = svc.id;
          services.set(s.name.toLowerCase(), serviceId);
          report.services++;
        }
        await tx`
          insert into charges (id, booking_id, service_id, name, qty, price, date)
          values (${exaUuid('charge', s.id)}, ${bookingId}, ${serviceId}, ${s.name}, ${s.qty}, ${s.price}, ${checkIn})
          on conflict (id) do update set booking_id = excluded.booking_id, name = excluded.name, qty = excluded.qty,
            price = excluded.price, deleted_at = null`;
        report.charges++;
      }

      // Оплаты: из снимка — одной суммой на дату заезда; из журнала — с датами операций.
      const events: PaymentEvent[] = [];
      const snap = snapshotReceived.get(o.ID);
      if (snap) events.push({ orderId: o.ID, date: checkIn, amount: snap });
      events.push(...(paymentsByOrder.get(o.ID) ?? []));
      const finalReceived = num(o.PriceReceived);
      const sumEvents = r2(events.reduce((a, e) => a + e.amount, 0));
      if (Math.abs(sumEvents - finalReceived) > 0.009) {
        events.push({ orderId: o.ID, date: checkIn, amount: r2(finalReceived - sumEvents) });
      }
      let i = 0;
      for (const ev of events) {
        if (!ev.amount) continue;
        await tx`
          insert into payments (id, booking_id, date, amount, comment)
          values (${exaUuid('pay', `${o.ID}:${i++}`)}, ${bookingId}, ${ev.date}, ${ev.amount}, 'Перенесено из ExaHotel')
          on conflict (id) do update set booking_id = excluded.booking_id, date = excluded.date, amount = excluded.amount, deleted_at = null`;
        report.payments++;
      }
      report.exaReceived += finalReceived;
    }

    // Номера броней, созданных в HotelManager, продолжаются после импортированных.
    await tx`select setval('booking_number_seq', greatest((select coalesce(max(number), 0) from bookings), 1))`;

    const [tot] = await tx<{ total: number; paid: number }[]>`
      select coalesce(sum(t.total), 0) as total, coalesce(sum(t.payments), 0) as paid
        from booking_totals t join bookings b on b.id = t.booking_id where b.exa_key is not null`;
    report.myTotal = r2(tot.total);
    report.myReceived = r2(tot.paid);
    report.exaTotal = r2(report.exaTotal);
    report.exaReceived = r2(report.exaReceived);
    if (report.checkedInPast) {
      report.warnings.push(`${report.checkedInPast} размещ. числятся «Заселён», хотя дата выезда прошла — проверьте и оформите выезд`);
    }
    await tx`
      insert into audit_log (op, entity, label, changes)
      values ('import', 'exa', 'Импорт из ExaHotelFree', ${tx.json(report as never)})`;
    return report;
  });
}

export type { Tx };
