import { generateTasks } from './operations.js';
import fs from 'node:fs/promises';
import {
  addDays,
  DEFAULT_INCOME_TAX,
  DEFAULT_IP,
  DEFAULT_RETENTION,
  fmtDate,
  guestFullName,
  type IncomeTaxSettings,
  type IpRequisites,
  plural,
  type RetentionSettings,
  type TaxFilings,
  todayMsk,
  usnDeadlines,
} from '@hotel-manager/shared';
import { usnData } from './tax.js';
import { config } from './config.js';
import { sql, writeTx } from './db.js';
import { removeFile } from './files.js';
import { processMailQueue } from './mail.js';
import { broadcastChanged, notifyAll, notifyOnce } from './notify.js';

const startedAt = Date.now();

/** Порядок удаления из корзины: сначала зависимые таблицы. */
const PURGE_ORDER = [
  'waitlist', 'tax_entries', 'tax_adjustments', 'tax_periods', 'staff_accruals', 'staff_payments', 'staff', 'meter_readings', 'meters', 'supply_moves', 'supplies', 'price_rules', 'booking_tags',
  'stays', 'charges', 'payments', 'deposits', 'reminders', 'messages', 'asset_moves', 'expenses', 'asset_repairs',
  'assets', 'purchases', 'bookings', 'guest_docs', 'files', 'guests', 'room_closures', 'seasons', 'services',
  'booking_sources', 'payment_methods', 'expense_categories', 'suppliers', 'asset_categories', 'locations',
  'message_templates', 'conflicts', 'rooms', 'room_categories', 'floors',
];

async function safe(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.error(`Задача «${name}»:`, e);
  }
}

export async function checkBackup(): Promise<void> {
  const [last] = await sql<{ at: string }[]>`select at from backup_status where ok order by at desc limit 1`;
  const lastAt = last ? new Date(last.at).getTime() : startedAt;
  if (Date.now() - lastAt > 26 * 3600_000) {
    await notifyOnce(`backup:${todayMsk()}`, {
      event: 'backup',
      title: 'Резервная копия не создана',
      body: last ? `Последняя успешная копия: ${fmtDate(last.at.slice(0, 10))}. Проверьте сервер.` : 'Резервных копий ещё нет. Проверьте настройку cron на сервере.',
    });
  }
}

async function checkWarranty() {
  const today = todayMsk();
  const list = await sql<{ id: string; name: string; invNumber: string; warrantyUntil: string }[]>`
    select id, name, inv_number, warranty_until from assets
     where deleted_at is null and written_off_at is null and warranty_until between ${today} and ${addDays(today, 30)}`;
  for (const a of list) {
    await notifyOnce(`warranty:${a.id}:${a.warrantyUntil}`, {
      event: 'warranty',
      title: 'Заканчивается гарантия',
      body: `${a.name} (${a.invNumber}) — гарантия до ${fmtDate(a.warrantyUntil)}`,
    });
  }
}

/** Заканчивающиеся расходники: остаток ниже порога (уведомление раз в сутки на позицию). */
async function checkSupplies() {
  const low = await sql<{ id: string; name: string; unit: string; qty: number; minQty: number }[]>`
    select s.id, s.name, s.unit, st.qty, s.min_qty from supplies s join supply_stock st on st.supply_id = s.id
     where s.deleted_at is null and s.is_active and s.min_qty > 0 and st.qty < s.min_qty
     order by s.name`;
  if (!low.length) return;
  const key = `supplies:${todayMsk()}:${low.map((l) => l.id).join(',')}`;
  const list = low.slice(0, 6).map((l) => `${l.name} — ${Number(l.qty)} ${l.unit}`).join('; ');
  await notifyOnce(key, {
    event: 'supplies',
    title: `Заканчиваются расходники: ${low.length}`,
    body: `${list}${low.length > 6 ? '…' : ''}`,
  });
}

/** Напоминание передать показания: в выбранный день месяца, если в этом месяце показаний ещё нет. */
async function checkMeters() {
  const today = todayMsk();
  const day = Number(today.slice(8, 10));
  const due = await sql<{ id: string; name: string }[]>`
    select m.id, m.name from meters m
     where m.deleted_at is null and m.is_active and m.remind_day is not null and m.remind_day <= ${day}
       and not exists (select 1 from meter_readings r where r.meter_id = m.id and r.deleted_at is null
                        and r.date >= date_trunc('month', ${today}::date) and r.date <= ${today}::date)
     order by m.sort_order nulls last, m.name`;
  if (!due.length) return;
  await notifyOnce(`meters:${today.slice(0, 7)}:${due.map((m) => m.id).join(',')}`, {
    event: 'meters',
    title: 'Пора снять показания счётчиков',
    body: due.map((m) => m.name).join(', '),
  });
}

/** Сроки налога ИП: уведомление, аванс, взносы, декларация — за reminderDays дней (после регистрации ИП). */
async function checkTaxDeadlines() {
  const today = todayMsk();
  const year = Number(today.slice(0, 4));
  const rows = await sql<{ key: string; value: Record<string, unknown> }[]>`select key, value from settings where key in ('incomeTax', 'ipRequisites', 'taxFilings') and deleted_at is null`;
  const get = <T,>(k: string, d: T): T => ({ ...d, ...((rows.find((r) => r.key === k)?.value as T) ?? {}) });
  const ip = get<IpRequisites>('ipRequisites', DEFAULT_IP);
  const s = get<IncomeTaxSettings>('incomeTax', DEFAULT_INCOME_TAX);
  const filings = get<TaxFilings>('taxFilings', {});
  if (!ip.registeredAt || ip.registeredAt > today || s.regime === 'npd') return;
  const days = s.reminderDays ?? 3;
  const items = [...usnDeadlines(year - 1), ...usnDeadlines(year)].filter((d) => d.date >= today && d.date <= addDays(today, days) && d.date >= ip.registeredAt!);
  if (!items.length) return;
  const cache = new Map<number, Awaited<ReturnType<typeof usnData>>>();
  const dataFor = async (y: number) => {
    if (!cache.has(y)) cache.set(y, await usnData(y));
    return cache.get(y)!;
  };
  for (const it of items) {
    // Сумма для уведомления и аванса: по номеру квартала из текста срока.
    const qMatch = /(I квартал|полугодие|9 месяцев) (\d{4})/.exec(it.what);
    let amount: number | null = null;
    let fKey: string | null = null;
    if (qMatch) {
      const q = qMatch[1] === 'I квартал' ? 1 : qMatch[1] === 'полугодие' ? 2 : 3;
      const d = await dataFor(Number(qMatch[2]));
      amount = d.periods[q - 1].payable;
      fKey = `${qMatch[2]}-${q}`;
    } else if (it.what.startsWith('Налог по УСН') || it.what.startsWith('Декларация')) {
      const y = Number(it.what.slice(-4));
      const d = await dataFor(y);
      amount = d.periods[3].payable;
      fKey = `${y}-4`;
    } else if (it.what.startsWith('Фиксированные')) amount = (await dataFor(Number(it.what.slice(-4)))).fixed;
    else if (it.what.startsWith('Взнос 1 %')) {
      const y = (await dataFor(Number(it.what.slice(-4)))).periods[3];
      amount = Math.round(Math.max(0, (s.regime === 'usn15' ? y.income - y.expenses : y.income) - 300_000) * 0.01);
      if (!amount) continue;
    }
    const f = fKey ? filings[fKey] : undefined;
    if (it.kind === 'notice' && (f?.filedAt || amount === 0)) continue;
    if (it.kind === 'pay' && (f?.paidAt || amount === 0)) continue;
    if (it.kind === 'declaration' && f?.filedAt) continue;
    const left = Math.round((Date.parse(it.date) - Date.parse(today)) / 86_400_000);
    await notifyOnce(`tax:${it.date}:${it.what}`, {
      event: 'tax',
      title: `${left === 0 ? 'Сегодня' : `Через ${left} дн.`}: ${it.what}`,
      body: `Срок ${fmtDate(it.date)}${amount ? `, сумма ${amount.toLocaleString('ru-RU')} ₽` : ''}. Отчёты → «Отчётность ИП за квартал».`,
    });
  }
}

/** Порог НДС на УСН и изменения в закрытых (сданных) периодах. */
async function checkTaxControl() {
  const today = todayMsk();
  const year = Number(today.slice(0, 4));
  const rows = await sql<{ key: string; value: Record<string, unknown> }[]>`select key, value from settings where key = 'ipRequisites' and deleted_at is null`;
  const ip: IpRequisites = { ...DEFAULT_IP, ...((rows[0]?.value as unknown as Partial<IpRequisites> | undefined) ?? {}) };
  if (!ip.registeredAt || ip.registeredAt > today) return;
  const d = await usnData(year);
  const income = d.periods[3].income;
  const share = d.vatThreshold > 0 ? income / d.vatThreshold : 0;
  for (const [level, text] of [
    [1, 'Доход превысил порог освобождения от НДС'],
    [0.95, 'Доход достиг 95 % порога освобождения от НДС'],
    [0.8, 'Доход достиг 80 % порога освобождения от НДС'],
  ] as const) {
    if (share >= level) {
      await notifyOnce(`vat:${year}:${level}`, {
        event: 'tax',
        title: text,
        body: `Доход с начала ${year}: ${Math.round(income).toLocaleString('ru-RU')} ₽ из ${d.vatThreshold.toLocaleString('ru-RU')} ₽.${level >= 1 ? ' С 1-го числа следующего месяца нужно платить НДС — обратитесь к бухгалтеру.' : ''}`,
      });
      break;
    }
  }
  const closed = await sql<{ year: number; period: number; snapshot: Record<string, number>; closedAt: string }[]>`
    select year, period, snapshot, closed_at from tax_periods where deleted_at is null and reopened_at is null and year >= ${year - 1}`;
  const byYear = new Map<number, Awaited<ReturnType<typeof usnData>>>([[year, d]]);
  for (const c of closed) {
    if (!byYear.has(c.year)) byYear.set(c.year, await usnData(c.year));
    const p = byYear.get(c.year)!.periods[c.period - 1];
    const was = Math.round(Number(c.snapshot?.income ?? 0));
    const now = Math.round(p.income);
    if (was !== now) {
      const name = c.period === 4 ? `год ${c.year} (декларация)` : `${p.label.toLowerCase().replace('i квартал', 'I квартал')} ${c.year}`;
      await notifyOnce(`closed:${c.year}:${c.period}:${c.closedAt}:${now}`, {
        event: 'tax',
        title: `Изменился сданный период: ${name}`,
        body: `Доход был ${was.toLocaleString('ru-RU')} ₽, стал ${now.toLocaleString('ru-RU')} ₽. Проверьте в «Бухгалтерии» — может понадобиться уточнённое ${c.period === 4 ? 'декларация' : 'уведомление'}.`,
      });
    }
  }
}

async function checkDisk() {
  const st = await fs.statfs(config.dataDir);
  const freeShare = st.bavail / st.blocks;
  if (freeShare < 0.15) {
    await notifyOnce(`disk:${todayMsk()}`, {
      event: 'disk',
      title: 'Мало места на диске сервера',
      body: `Свободно ${Math.round(freeShare * 100)} % (${Math.round((st.bavail * st.bsize) / 1024 ** 3)} ГБ)`,
    });
  }
}

/** Удаление персональных данных по сроку (если включено в настройках). */
async function retention() {
  const [row] = await sql<{ value: RetentionSettings }[]>`select value from settings where key = 'retention' and deleted_at is null`;
  const r = { ...DEFAULT_RETENTION, ...(row?.value ?? {}) };
  if (!r.enabled || r.months < 1) return;
  const candidates = await sql<{ id: string; lastName: string; firstName: string | null; middleName: string | null }[]>`
    select g.id, g.last_name, g.first_name, g.middle_name from guests g
     where g.deleted_at is null
       and (exists (select 1 from guest_docs d where d.guest_id = g.id and (d.doc_number is not null or d.reg_address is not null))
            or exists (select 1 from files f where f.owner_type = 'guest' and f.owner_id = g.id and f.deleted_at is null))
       and not exists (select 1 from stays s join bookings b on b.id = s.booking_id
                        where b.guest_id = g.id and s.deleted_at is null and s.status not in ('cancelled','no_show')
                          and s.check_out > (current_date - make_interval(months => ${r.months})))`;
  if (!candidates.length) return;

  // Сначала предупреждение, удаление — через 7 дней после него.
  const warned = await sql<{ key: string; sentAt: string }[]>`select key, sent_at from notify_log where key like 'retention:%'`;
  const warnedAt = new Map(warned.map((w) => [w.key.slice('retention:'.length), new Date(w.sentAt).getTime()]));
  const toWarn = candidates.filter((c) => !warnedAt.has(c.id));
  if (toWarn.length) {
    for (const c of toWarn) await sql`insert into notify_log (key) values (${`retention:${c.id}`}) on conflict do nothing`;
    const names = toWarn.slice(0, 5).map((c) => guestFullName(c)).join(', ');
    await notifyAll({
      event: 'retention',
      title: 'Удаление персональных данных через 7 дней',
      body: `${toWarn.length} ${plural(toWarn.length, 'гость', 'гостя', 'гостей')}: ${names}${toWarn.length > 5 ? '…' : ''}. Отключить можно в настройках.`,
    });
  }
  const due = candidates.filter((c) => (warnedAt.get(c.id) ?? Infinity) < Date.now() - 7 * 86400_000);
  if (!due.length) return;
  await writeTx(async (tx) => {
    for (const c of due) {
      await tx`
        update guest_docs set doc_series = null, doc_number = null, doc_issued_by = null, doc_issue_date = null,
               doc_dept_code = null, birth_place = null, reg_country = null, reg_region = null, reg_city = null,
               reg_address = null, reg_index = null, fact_address = null
         where guest_id = ${c.id}`;
      await tx`update files set deleted_at = now() where owner_type = 'guest' and owner_id = ${c.id} and deleted_at is null`;
      await tx`
        insert into audit_log (op, entity, entity_id, label) values ('retention', 'guests', ${c.id}, 'Персональные данные удалены по сроку хранения')`;
    }
  });
  broadcastChanged();
}

/** Окончательное удаление записей из корзины (старше 30 дней). */
async function purgeTrash() {
  for (const t of PURGE_ORDER) {
    try {
      const rows = await sql<{ id: string }[]>`
        delete from ${sql(t)} where deleted_at < now() - ${`${config.trashDays} days`}::interval returning id`;
      if (t === 'files') for (const r of rows) await removeFile(r.id);
    } catch {
      // Запись всё ещё используется (например, номер в старых бронях) — удаляем построчно то, что можно.
      const ids = await sql<{ id: string }[]>`select id from ${sql(t)} where deleted_at < now() - ${`${config.trashDays} days`}::interval`;
      for (const { id } of ids) {
        try {
          await sql`delete from ${sql(t)} where id = ${id}`;
          if (t === 'files') await removeFile(id);
        } catch {
          /* остаётся в корзине */
        }
      }
    }
  }
  await sql`delete from sync_ops where created_at < now() - interval '180 days'`;
}

export function startScheduler(): void {
  setInterval(() => void safe('почта', processMailQueue), 30_000);
  const every10 = async () => {
    await safe('автоматические задачи', async () => { await generateTasks(); });
    await safe('бэкап', checkBackup);
    await safe('гарантия', checkWarranty);
    await safe('диск', checkDisk);
    await safe('расходники', checkSupplies);
    await safe('счётчики', checkMeters);
    await safe('налог ИП', checkTaxDeadlines);
    await safe('контроль налога', checkTaxControl);
  };
  setTimeout(() => void every10(), 60_000);
  setInterval(() => void every10(), 10 * 60_000);
  const daily = async () => {
    await safe('хранение ПДн', retention);
    await safe('корзина', purgeTrash);
  };
  setTimeout(() => void daily(), 5 * 60_000);
  setInterval(() => void daily(), 24 * 3600_000);
}
