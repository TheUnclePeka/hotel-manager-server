import {
  addDays,
  diffDays,
  fmtDate,
  type ISODate,
  monthName,
  nightsBetween,
  todayMsk,
  guestFullName,
  ASSET_CONDITION_LABELS,
  bookingTouristTax,
  DEFAULT_TOURIST_TAX,
  type Stay,
  TOURIST_TAX_CHARGE,
  type TouristTaxSettings,
  DEFAULT_INCOME_TAX,
  type IncomeTaxSettings,
  DEFAULT_IP,
  fixedContributions,
  type IpRequisites,
  USN_PERIODS,
  usnDeclarationLines,
  usnKbk,
  usnYear,
  workingDay,
  STAFF_ACCRUAL_LABELS,
} from '@hotel-manager/shared';
import ExcelJS from 'exceljs';
import { sql } from './db.js';
import { sumAmount, usnData } from './tax.js';

/**
 * Отчёты. Каждый отчёт возвращает единый формат: показатели (kpis) и таблицы (sections).
 * По этому же формату строится выгрузка в Excel и печать.
 */

export type ColType = 'text' | 'money' | 'int' | 'num' | 'percent' | 'date';
export interface Column {
  key: string;
  label: string;
  type?: ColType;
}
export interface Section {
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  /** Подсказка UI: показать как тепловую карту. */
  heatmap?: boolean;
}
export interface Kpi {
  label: string;
  value: number;
  type: ColType;
  hint?: string;
}
export interface Report {
  title: string;
  period: string;
  kpis: Kpi[];
  sections: Section[];
}

export interface ReportParams {
  from: ISODate;
  to: ISODate;
  group?: 'day' | 'month';
}

const BILLABLE = ['tentative', 'confirmed', 'checked_in', 'checked_out'];

export const REPORTS: Record<string, { title: string; run: (p: ReportParams) => Promise<Report> }> = {
  occupancy: { title: 'Загрузка, ADR, RevPAR', run: occupancy },
  compare: { title: 'Сравнение с прошлым годом и прогноз', run: compare },
  revenue: { title: 'Выручка', run: revenue },
  arrivals: { title: 'Заезды и выезды', run: arrivals },
  residents: { title: 'Проживающие', run: residents },
  debts: { title: 'Долги и переплаты', run: debts },
  sources: { title: 'Источники броней', run: sources },
  guests: { title: 'Гости', run: guestsReport },
  profit: { title: 'Расходы и прибыль', run: profit },
  ksr: { title: 'Сводка для формы 1-КСР', run: ksr },
  inventory: { title: 'Инвентарь', run: inventory },
  utilities: { title: 'Коммунальные расходы', run: utilities },
  touristTax: { title: 'Туристический налог', run: touristTaxReport },
  incomeTax: { title: 'Налог ИП (УСН, НПД)', run: incomeTaxReport },
  staff: { title: 'Персонал и зарплата', run: staffReport },
};

function period(p: ReportParams): string {
  return p.from === p.to ? fmtDate(p.from) : `${fmtDate(p.from)} — ${fmtDate(p.to)}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : 0);

function monthKey(d: ISODate) {
  return d.slice(0, 7);
}
function monthLabel(key: string) {
  return `${monthName(Number(key.slice(5, 7)))} ${key.slice(0, 4)}`;
}

interface RoomInfo {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  isService: boolean;
  places: number;
}

async function roomsInfo(): Promise<RoomInfo[]> {
  return sql<RoomInfo[]>`
    select r.id, r.name, r.category_id, c.name as category_name, r.is_service, r.places
      from rooms r join room_categories c on c.id = r.category_id
     where r.deleted_at is null and r.is_active
     order by r.sort_order nulls last, nullif(substring(r.name from '^\\d+'), '')::int nulls last, r.name`;
}

/** Доступные и проданные номеро-ночи по дням и номерам (служебные номера не учитываются). */
async function occupancyData(p: ReportParams) {
  const rooms = (await roomsInfo()).filter((r) => !r.isService);
  const roomIds = rooms.map((r) => r.id);
  const dates = nightsBetween(p.from, addDays(p.to, 1));
  const closures = roomIds.length
    ? await sql<{ roomId: string; dateFrom: string; dateTo: string }[]>`
        select room_id, date_from, date_to from room_closures
         where deleted_at is null and room_id in ${sql(roomIds)} and date_to > ${p.from} and date_from <= ${p.to}`
    : [];
  const nights = roomIds.length
    ? await sql<{ roomId: string; date: string; price: number; persons: number; stayId: string }[]>`
        select room_id, date, price, persons, stay_id from stay_nights
         where status in ${sql(BILLABLE)} and room_id in ${sql(roomIds)} and date between ${p.from} and ${p.to}`
    : [];
  const closed = new Set<string>();
  for (const c of closures) for (const d of nightsBetween(c.dateFrom, c.dateTo)) closed.add(`${c.roomId}|${d}`);
  return { rooms, dates, closed, nights };
}

async function occupancy(p: ReportParams): Promise<Report> {
  const { rooms, dates, closed, nights } = await occupancyData(p);
  const group = p.group ?? (dates.length > 62 ? 'month' : 'day');
  const avail = new Map<string, number>();
  const availRoom = new Map<string, number>();
  for (const d of dates) {
    for (const r of rooms) {
      if (closed.has(`${r.id}|${d}`)) continue;
      const k = group === 'month' ? monthKey(d) : d;
      avail.set(k, (avail.get(k) ?? 0) + 1);
      availRoom.set(r.id, (availRoom.get(r.id) ?? 0) + 1);
    }
  }
  const sold = new Map<string, { n: number; rev: number }>();
  const soldRoom = new Map<string, { n: number; rev: number }>();
  const heat = new Map<string, number>();
  for (const n of nights) {
    const k = group === 'month' ? monthKey(n.date) : n.date;
    const s = sold.get(k) ?? { n: 0, rev: 0 };
    s.n++;
    s.rev += n.price;
    sold.set(k, s);
    const sr = soldRoom.get(n.roomId) ?? { n: 0, rev: 0 };
    sr.n++;
    sr.rev += n.price;
    soldRoom.set(n.roomId, sr);
    const hk = `${n.roomId}|${monthKey(n.date)}`;
    heat.set(hk, (heat.get(hk) ?? 0) + 1);
  }
  const keys = [...new Set(dates.map((d) => (group === 'month' ? monthKey(d) : d)))];
  const totalAvail = [...avail.values()].reduce((a, b) => a + b, 0);
  const totalSold = nights.length;
  const totalRev = r2(nights.reduce((a, n) => a + n.price, 0));

  const byPeriod: Section = {
    title: group === 'month' ? 'По месяцам' : 'По дням',
    columns: [
      { key: 'period', label: group === 'month' ? 'Месяц' : 'Дата' },
      { key: 'avail', label: 'Доступно ном.-ночей', type: 'int' },
      { key: 'sold', label: 'Продано ном.-ночей', type: 'int' },
      { key: 'occ', label: 'Загрузка', type: 'percent' },
      { key: 'rev', label: 'Выручка от проживания', type: 'money' },
      { key: 'adr', label: 'ADR', type: 'money' },
      { key: 'revpar', label: 'RevPAR', type: 'money' },
    ],
    rows: keys.map((k) => {
      const a = avail.get(k) ?? 0;
      const s = sold.get(k) ?? { n: 0, rev: 0 };
      return {
        period: group === 'month' ? monthLabel(k) : fmtDate(k),
        avail: a,
        sold: s.n,
        occ: pct(s.n, a),
        rev: r2(s.rev),
        adr: s.n ? r2(s.rev / s.n) : 0,
        revpar: a ? r2(s.rev / a) : 0,
      };
    }),
    totals: {
      period: 'Итого',
      avail: totalAvail,
      sold: totalSold,
      occ: pct(totalSold, totalAvail),
      rev: totalRev,
      adr: totalSold ? r2(totalRev / totalSold) : 0,
      revpar: totalAvail ? r2(totalRev / totalAvail) : 0,
    },
  };

  const cats = new Map<string, { name: string; a: number; n: number; rev: number }>();
  for (const r of rooms) {
    const c = cats.get(r.categoryId) ?? { name: r.categoryName, a: 0, n: 0, rev: 0 };
    c.a += availRoom.get(r.id) ?? 0;
    c.n += soldRoom.get(r.id)?.n ?? 0;
    c.rev += soldRoom.get(r.id)?.rev ?? 0;
    cats.set(r.categoryId, c);
  }
  const roomCols: Column[] = [
    { key: 'name', label: 'Категория' },
    { key: 'avail', label: 'Доступно', type: 'int' },
    { key: 'sold', label: 'Продано', type: 'int' },
    { key: 'occ', label: 'Загрузка', type: 'percent' },
    { key: 'rev', label: 'Выручка', type: 'money' },
    { key: 'adr', label: 'ADR', type: 'money' },
    { key: 'revpar', label: 'RevPAR', type: 'money' },
  ];
  const row = (name: string, a: number, n: number, rev: number) => ({
    name,
    avail: a,
    sold: n,
    occ: pct(n, a),
    rev: r2(rev),
    adr: n ? r2(rev / n) : 0,
    revpar: a ? r2(rev / a) : 0,
  });

  const months = [...new Set(dates.map(monthKey))];
  const daysInMonth = new Map<string, number>();
  for (const d of dates) daysInMonth.set(monthKey(d), (daysInMonth.get(monthKey(d)) ?? 0) + 1);
  const heatmap: Section = {
    title: 'Загрузка по номерам и месяцам, %',
    heatmap: true,
    columns: [{ key: 'name', label: 'Номер' }, ...months.map((m) => ({ key: m, label: monthLabel(m), type: 'percent' as const }))],
    rows: rooms.map((r) => {
      const out: Record<string, unknown> = { name: r.name };
      for (const m of months) {
        let a = 0;
        for (const d of dates) if (monthKey(d) === m && !closed.has(`${r.id}|${d}`)) a++;
        out[m] = pct(heat.get(`${r.id}|${m}`) ?? 0, a);
      }
      return out;
    }),
  };

  return {
    title: 'Загрузка, ADR, RevPAR',
    period: period(p),
    kpis: [
      { label: 'Загрузка', value: pct(totalSold, totalAvail), type: 'percent', hint: 'Проданные номеро-ночи / доступные' },
      { label: 'ADR', value: totalSold ? r2(totalRev / totalSold) : 0, type: 'money', hint: 'Средняя цена проданной ночи' },
      { label: 'RevPAR', value: totalAvail ? r2(totalRev / totalAvail) : 0, type: 'money', hint: 'Выручка на доступный номер' },
      { label: 'Выручка от проживания', value: totalRev, type: 'money' },
      { label: 'Продано номеро-ночей', value: totalSold, type: 'int' },
    ],
    sections: [
      byPeriod,
      { title: 'По категориям', columns: roomCols, rows: [...cats.values()].map((c) => row(c.name, c.a, c.n, c.rev)) },
      {
        title: 'По номерам',
        columns: [{ key: 'name', label: 'Номер' }, ...roomCols.slice(1)],
        rows: rooms.map((r) => row(r.name, availRoom.get(r.id) ?? 0, soldRoom.get(r.id)?.n ?? 0, soldRoom.get(r.id)?.rev ?? 0)),
      },
      heatmap,
    ],
  };
}

interface MonthAgg {
  avail: number;
  nights: number;
  revenue: number;
}

/** Доступные номеро-ночи по месяцам года (без служебных и закрытых номеров). */
async function availByMonth(year: number): Promise<number[]> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const { rooms, dates, closed } = await occupancyData({ from, to });
  const out = Array.from({ length: 12 }, () => 0);
  for (const d of dates) for (const r of rooms) if (!closed.has(`${r.id}|${d}`)) out[Number(d.slice(5, 7)) - 1]++;
  return out;
}

/**
 * Проданные ночи и выручка от проживания по месяцам года.
 * cut — «на дату»: учитываются брони, созданные не позже этой даты, включая отменённые позже.
 */
async function soldByMonth(year: number, cut: ISODate | null): Promise<{ nights: number; revenue: number }[]> {
  const rows = cut
    ? await sql<{ m: number; n: number; rev: number }[]>`
        select extract(month from n.date)::int as m, count(*)::int as n, coalesce(sum(n.price), 0) as rev
          from stay_nights n
          join stays s on s.id = n.stay_id
          join rooms r on r.id = n.room_id and not r.is_service
          join bookings b on b.id = n.booking_id and b.deleted_at is null
         where extract(year from n.date) = ${year}
           and b.created_at < (${cut}::date + 1)::timestamp at time zone 'Europe/Moscow'
           and (n.status in ('tentative','confirmed','checked_in','checked_out','no_show')
                or (n.status = 'cancelled' and s.cancelled_at >= (${cut}::date + 1)::timestamp at time zone 'Europe/Moscow'))
         group by 1`
    : await sql<{ m: number; n: number; rev: number }[]>`
        select extract(month from n.date)::int as m, count(*)::int as n, coalesce(sum(n.price), 0) as rev
          from stay_nights n
          join rooms r on r.id = n.room_id and not r.is_service
          join bookings b on b.id = n.booking_id and b.deleted_at is null
         where extract(year from n.date) = ${year} and n.status in ('tentative','confirmed','checked_in','checked_out')
         group by 1`;
  const out = Array.from({ length: 12 }, () => ({ nights: 0, revenue: 0 }));
  for (const r of rows) out[r.m - 1] = { nights: r.n, revenue: Number(r.rev) };
  return out;
}

async function compare(p: ReportParams): Promise<Report> {
  const year = Number(p.from.slice(0, 4));
  const prev = year - 1;
  const today = todayMsk();
  const curYear = Number(today.slice(0, 4));
  const curMonth = year === curYear ? Number(today.slice(5, 7)) : year < curYear ? 13 : 1;
  const sameDayLastYear = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`.replace('-02-29', '-02-28');

  const [availNow, availPrev, soldNow, soldPrev, otbPrev] = await Promise.all([
    availByMonth(year),
    availByMonth(prev),
    soldByMonth(year, null),
    soldByMonth(prev, null),
    year === curYear ? soldByMonth(prev, sameDayLastYear) : Promise.resolve(null),
  ]);

  const pctOf = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : 0);
  const delta = (a: number, b: number) => (b > 0 ? r2(((a - b) / b) * 100) : null);

  const byMonth = Array.from({ length: 12 }, (_, i) => {
    const a = soldNow[i];
    const b = soldPrev[i];
    return {
      month: monthLabel(`${year}-${String(i + 1).padStart(2, '0')}`).replace(/ \d{4}$/, ''),
      occNow: pctOf(a.nights, availNow[i]),
      occPrev: pctOf(b.nights, availPrev[i]),
      revNow: r2(a.revenue),
      revPrev: r2(b.revenue),
      revDelta: delta(a.revenue, b.revenue),
      adrNow: a.nights ? r2(a.revenue / a.nights) : 0,
      adrPrev: b.nights ? r2(b.revenue / b.nights) : 0,
    };
  });

  // С начала года по сегодняшний день (для текущего года) или за весь год.
  const ytdMonths = year === curYear ? curMonth - 1 : 12;
  const ytdCut = year === curYear ? today : `${year}-12-31`;
  const ytdCutPrev = year === curYear ? sameDayLastYear : `${prev}-12-31`;
  const [[ytdNow], [ytdPrev]] = await Promise.all([
    sql<{ rev: number; n: number }[]>`
      select coalesce(sum(n.price), 0) as rev, count(*)::int as n from stay_nights n join rooms r on r.id = n.room_id and not r.is_service
        join bookings b on b.id = n.booking_id and b.deleted_at is null
       where n.date between ${`${year}-01-01`} and ${ytdCut} and n.status in ('tentative','confirmed','checked_in','checked_out')`,
    sql<{ rev: number; n: number }[]>`
      select coalesce(sum(n.price), 0) as rev, count(*)::int as n from stay_nights n join rooms r on r.id = n.room_id and not r.is_service
        join bookings b on b.id = n.booking_id and b.deleted_at is null
       where n.date between ${`${prev}-01-01`} and ${ytdCutPrev} and n.status in ('tentative','confirmed','checked_in','checked_out')`,
  ]);
  void ytdMonths;

  const sections: Section[] = [
    {
      title: `По месяцам: ${year} и ${prev}`,
      columns: [
        { key: 'month', label: 'Месяц' },
        { key: 'occNow', label: `Загрузка ${year}`, type: 'percent' },
        { key: 'occPrev', label: `Загрузка ${prev}`, type: 'percent' },
        { key: 'revNow', label: `Выручка ${year}`, type: 'money' },
        { key: 'revPrev', label: `Выручка ${prev}`, type: 'money' },
        { key: 'revDelta', label: 'Изменение', type: 'percent' },
        { key: 'adrNow', label: `ADR ${year}`, type: 'money' },
        { key: 'adrPrev', label: `ADR ${prev}`, type: 'money' },
      ],
      rows: byMonth,
      totals: {
        month: 'Итого',
        occNow: pctOf(soldNow.reduce((a, x) => a + x.nights, 0), availNow.reduce((a, x) => a + x, 0)),
        occPrev: pctOf(soldPrev.reduce((a, x) => a + x.nights, 0), availPrev.reduce((a, x) => a + x, 0)),
        revNow: r2(soldNow.reduce((a, x) => a + x.revenue, 0)),
        revPrev: r2(soldPrev.reduce((a, x) => a + x.revenue, 0)),
        revDelta: delta(soldNow.reduce((a, x) => a + x.revenue, 0), soldPrev.reduce((a, x) => a + x.revenue, 0)),
      },
    },
  ];

  const kpis: Kpi[] = [
    { label: year === curYear ? `Выручка с 1 января` : `Выручка ${year}`, value: r2(Number(ytdNow.rev)), type: 'money' },
    { label: year === curYear ? `Год назад на эту дату` : `Выручка ${prev}`, value: r2(Number(ytdPrev.rev)), type: 'money' },
    { label: 'Изменение', value: delta(Number(ytdNow.rev), Number(ytdPrev.rev)) ?? 0, type: 'percent' },
  ];

  if (otbPrev) {
    // Прогноз методом «добора»: уже забронировано + сколько в прошлом году добронировали после этой даты.
    let fNights = 0;
    let fRev = 0;
    let fAvail = 0;
    const rows = [];
    for (let i = 0; i < 12; i++) {
      const done = i + 1 < curMonth;
      const otbN = soldNow[i].nights;
      const otbR = soldNow[i].revenue;
      const pickN = Math.max(0, soldPrev[i].nights - otbPrev[i].nights);
      const pickR = Math.max(0, soldPrev[i].revenue - otbPrev[i].revenue);
      const nights = done ? otbN : Math.min(availNow[i], otbN + pickN);
      const rev = done ? otbR : otbR + pickR;
      fNights += nights;
      fRev += rev;
      fAvail += availNow[i];
      if (!done) {
        rows.push({
          month: byMonth[i].month,
          otbNow: otbN,
          otbPrev: otbPrev[i].nights,
          finalPrev: soldPrev[i].nights,
          forecastNights: nights,
          forecastOcc: pctOf(nights, availNow[i]),
          forecastRev: r2(rev),
        });
      }
    }
    sections.push({
      title: `Прогноз на ${year}`,
      columns: [
        { key: 'month', label: 'Месяц' },
        { key: 'otbNow', label: 'Забронировано сейчас, ночей', type: 'int' },
        { key: 'otbPrev', label: 'Год назад на эту дату', type: 'int' },
        { key: 'finalPrev', label: `Итог ${prev}`, type: 'int' },
        { key: 'forecastNights', label: 'Прогноз ночей', type: 'int' },
        { key: 'forecastOcc', label: 'Прогноз загрузки', type: 'percent' },
        { key: 'forecastRev', label: 'Прогноз выручки', type: 'money' },
      ],
      rows,
    });
    kpis.push(
      { label: `Прогноз выручки за ${year}`, value: r2(fRev), type: 'money', hint: 'Уже забронировано + столько, сколько в прошлом году добронировали после этой даты' },
      { label: `Прогноз загрузки за ${year}`, value: pctOf(fNights, fAvail), type: 'percent' },
    );
  }

  return { title: 'Сравнение с прошлым годом и прогноз', period: `${year} год`, kpis, sections };
}

async function revenue(p: ReportParams): Promise<Report> {
  const living = await sql<{ month: string; sum: number }[]>`
    select to_char(date, 'YYYY-MM') as month, sum(price) as sum from stay_nights n
      join bookings b on b.id = n.booking_id and b.deleted_at is null
     where status in ${sql(BILLABLE)} and date between ${p.from} and ${p.to}
     group by 1`;
  const services = await sql<{ name: string; month: string; sum: number }[]>`
    select c.name, to_char(c.date, 'YYYY-MM') as month, sum(c.qty * c.price) as sum
      from charges c join booking_totals t on t.booking_id = c.booking_id and t.active
     where c.deleted_at is null and c.date between ${p.from} and ${p.to}
     group by 1, 2`;
  const discounts = await sql<{ month: string; sum: number }[]>`
    select to_char(f.first_in, 'YYYY-MM') as month, sum(b.discount) as sum from bookings b
      join (select booking_id, min(check_in) as first_in from stays
             where deleted_at is null and status in ${sql(BILLABLE)} group by 1) f on f.booking_id = b.id
     where b.deleted_at is null and b.discount <> 0 and f.first_in between ${p.from} and ${p.to}
     group by 1`;
  const withheld = await sql<{ month: string; sum: number }[]>`
    select to_char(coalesce(returned_at, date), 'YYYY-MM') as month, sum(withheld_amount) as sum from deposits
     where deleted_at is null and withheld_amount > 0 and coalesce(returned_at, date) between ${p.from} and ${p.to}
     group by 1`;
  const payments = await sql<{ method: string | null; month: string; sum: number; cnt: number }[]>`
    select m.name as method, to_char(p.date, 'YYYY-MM') as month, sum(p.amount) as sum, count(*)::int as cnt
      from payments p
      join bookings b on b.id = p.booking_id and b.deleted_at is null
      left join payment_methods m on m.id = p.method_id
     where p.deleted_at is null and p.date between ${p.from} and ${p.to}
     group by 1, 2`;

  const sum = (rows: { sum: number }[]) => r2(rows.reduce((a, r) => a + Number(r.sum), 0));
  const items: Record<string, unknown>[] = [{ name: 'Проживание', sum: sum(living) }];
  const svcNames = [...new Set(services.map((s) => s.name))].sort();
  for (const n of svcNames) items.push({ name: n, sum: sum(services.filter((s) => s.name === n)) });
  if (withheld.length) items.push({ name: 'Удержания из залогов', sum: sum(withheld) });
  if (discounts.length) items.push({ name: 'Скидки', sum: -sum(discounts) });
  const accrued = r2(items.reduce((a, r) => a + (r.sum as number), 0));

  const methods = [...new Set(payments.map((x) => x.method ?? 'Не указан'))].sort();
  const methodRows = methods.map((m) => {
    const rows = payments.filter((x) => (x.method ?? 'Не указан') === m);
    return { name: m, cnt: rows.reduce((a, r) => a + r.cnt, 0), sum: sum(rows) };
  });
  const received = sum(payments);

  const months = [...new Set([...living, ...services, ...payments, ...discounts, ...withheld].map((r) => r.month))].sort();
  const monthly = months.map((m) => {
    const acc =
      sum(living.filter((r) => r.month === m)) +
      sum(services.filter((r) => r.month === m)) +
      sum(withheld.filter((r) => r.month === m)) -
      sum(discounts.filter((r) => r.month === m));
    return { month: monthLabel(m), accrued: r2(acc), received: sum(payments.filter((r) => r.month === m)) };
  });

  return {
    title: 'Выручка',
    period: period(p),
    kpis: [
      { label: 'Начислено', value: accrued, type: 'money' },
      { label: 'Поступило оплат', value: received, type: 'money' },
      { label: 'Проживание', value: sum(living), type: 'money' },
      { label: 'Доп. услуги', value: sum(services), type: 'money' },
    ],
    sections: [
      {
        title: 'Начисления по статьям',
        columns: [
          { key: 'name', label: 'Статья' },
          { key: 'sum', label: 'Сумма', type: 'money' },
        ],
        rows: items,
        totals: { name: 'Итого', sum: accrued },
      },
      {
        title: 'Поступления по способам оплаты',
        columns: [
          { key: 'name', label: 'Способ оплаты' },
          { key: 'cnt', label: 'Оплат', type: 'int' },
          { key: 'sum', label: 'Сумма', type: 'money' },
        ],
        rows: methodRows,
        totals: { name: 'Итого', cnt: methodRows.reduce((a, r) => a + r.cnt, 0), sum: received },
      },
      {
        title: 'По месяцам',
        columns: [
          { key: 'month', label: 'Месяц' },
          { key: 'accrued', label: 'Начислено', type: 'money' },
          { key: 'received', label: 'Поступило', type: 'money' },
        ],
        rows: monthly,
      },
    ],
  };
}

interface StayListRow {
  stayId: string;
  bookingId: string;
  number: number | null;
  roomName: string;
  checkIn: string;
  checkOut: string;
  persons: number;
  status: string;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  phone: string | null;
  total: number;
  balance: number;
}

async function stayList(where: ReturnType<typeof sql>): Promise<StayListRow[]> {
  return sql<StayListRow[]>`
    select s.id as stay_id, s.booking_id, b.number, r.name as room_name, s.check_in, s.check_out, s.persons, s.status,
           g.last_name, g.first_name, g.middle_name, g.phone, t.total, t.balance
      from stays s
      join bookings b on b.id = s.booking_id and b.deleted_at is null
      join rooms r on r.id = s.room_id
      left join guests g on g.id = b.guest_id
      left join booking_totals t on t.booking_id = b.id
     where s.deleted_at is null and ${where}
     order by s.check_in, r.sort_order nulls last, r.name`;
}

const stayColumns: Column[] = [
  { key: 'date', label: 'Дата', type: 'date' },
  { key: 'room', label: 'Номер' },
  { key: 'guest', label: 'Гость' },
  { key: 'phone', label: 'Телефон' },
  { key: 'nights', label: 'Ночей', type: 'int' },
  { key: 'persons', label: 'Чел.', type: 'int' },
  { key: 'total', label: 'Сумма', type: 'money' },
  { key: 'balance', label: 'Остаток', type: 'money' },
];

function stayRow(s: StayListRow, date: string) {
  return {
    bookingId: s.bookingId,
    date,
    room: s.roomName,
    guest: guestFullName(s),
    phone: s.phone ?? '',
    nights: diffDays(s.checkIn, s.checkOut),
    persons: s.persons,
    total: s.total ?? 0,
    balance: s.balance ?? 0,
  };
}

async function arrivals(p: ReportParams): Promise<Report> {
  const arr = await stayList(sql`s.status in ${sql(BILLABLE)} and s.check_in between ${p.from} and ${p.to}`);
  const dep = await stayList(sql`s.status in ${sql(BILLABLE)} and s.check_out between ${p.from} and ${p.to}`);
  return {
    title: 'Заезды и выезды',
    period: period(p),
    kpis: [
      { label: 'Заездов', value: arr.length, type: 'int' },
      { label: 'Выездов', value: dep.length, type: 'int' },
    ],
    sections: [
      { title: 'Заезды', columns: stayColumns, rows: arr.map((s) => stayRow(s, s.checkIn)) },
      { title: 'Выезды', columns: stayColumns, rows: dep.map((s) => stayRow(s, s.checkOut)) },
    ],
  };
}

async function residents(p: ReportParams): Promise<Report> {
  const list = await stayList(sql`s.status in ${sql(BILLABLE)} and s.check_in <= ${p.to} and s.check_out > ${p.from}`);
  const persons = list.reduce((a, s) => a + s.persons, 0);
  return {
    title: 'Проживающие',
    period: period(p),
    kpis: [
      { label: 'Размещений', value: list.length, type: 'int' },
      { label: 'Человек', value: persons, type: 'int' },
    ],
    sections: [
      {
        title: 'Проживающие',
        columns: [
          { key: 'room', label: 'Номер' },
          { key: 'guest', label: 'Гость' },
          { key: 'phone', label: 'Телефон' },
          { key: 'checkIn', label: 'Заезд', type: 'date' },
          { key: 'checkOut', label: 'Выезд', type: 'date' },
          { key: 'persons', label: 'Чел.', type: 'int' },
          { key: 'balance', label: 'Остаток', type: 'money' },
        ],
        rows: list.map((s) => ({
          bookingId: s.bookingId,
          room: s.roomName,
          guest: guestFullName(s),
          phone: s.phone ?? '',
          checkIn: s.checkIn,
          checkOut: s.checkOut,
          persons: s.persons,
          balance: s.balance ?? 0,
        })),
      },
    ],
  };
}

async function debts(_p: ReportParams): Promise<Report> {
  const rows = await sql<{ bookingId: string; number: number | null; lastName: string | null; firstName: string | null; middleName: string | null; phone: string | null; checkIn: string | null; checkOut: string | null; total: number; paid: number; balance: number; depositHeld: number }[]>`
    select t.booking_id, b.number, g.last_name, g.first_name, g.middle_name, g.phone,
           (select min(check_in) from stays where booking_id = b.id and deleted_at is null) as check_in,
           (select max(check_out) from stays where booking_id = b.id and deleted_at is null) as check_out,
           t.total, t.paid, t.balance, t.deposit_held
      from booking_totals t join bookings b on b.id = t.booking_id left join guests g on g.id = b.guest_id
     where t.balance <> 0 or t.deposit_held <> 0
     order by t.balance desc`;
  const debt = r2(rows.filter((r) => r.balance > 0).reduce((a, r) => a + r.balance, 0));
  const over = r2(rows.filter((r) => r.balance < 0).reduce((a, r) => a - r.balance, 0));
  const held = r2(rows.reduce((a, r) => a + r.depositHeld, 0));
  return {
    title: 'Долги и переплаты',
    period: `на ${fmtDate(todayMsk())}`,
    kpis: [
      { label: 'Долги гостей', value: debt, type: 'money' },
      { label: 'Переплаты', value: over, type: 'money' },
      { label: 'Залоги на руках', value: held, type: 'money' },
    ],
    sections: [
      {
        title: 'Брони с ненулевым балансом или залогом',
        columns: [
          { key: 'number', label: '№ брони', type: 'int' },
          { key: 'guest', label: 'Гость' },
          { key: 'phone', label: 'Телефон' },
          { key: 'checkIn', label: 'Заезд', type: 'date' },
          { key: 'checkOut', label: 'Выезд', type: 'date' },
          { key: 'total', label: 'Начислено', type: 'money' },
          { key: 'paid', label: 'Оплачено', type: 'money' },
          { key: 'balance', label: 'Остаток', type: 'money' },
          { key: 'depositHeld', label: 'Залог', type: 'money' },
        ],
        rows: rows.map((r) => ({ ...r, guest: guestFullName(r) })),
        totals: { guest: 'Итого', balance: r2(debt - over), depositHeld: held },
      },
    ],
  };
}

async function sources(p: ReportParams): Promise<Report> {
  const rows = await sql<{ name: string | null; bookings: number; nights: number; revenue: number }[]>`
    select src.name, count(distinct b.id)::int as bookings, count(n.*)::int as nights, coalesce(sum(n.price), 0) as revenue
      from bookings b
      join stays s on s.booking_id = b.id and s.deleted_at is null and s.status in ${sql(BILLABLE)}
      left join stay_nights n on n.stay_id = s.id
      left join booking_sources src on src.id = b.source_id
     where b.deleted_at is null and s.check_in between ${p.from} and ${p.to}
     group by src.name order by revenue desc`;
  const total = r2(rows.reduce((a, r) => a + Number(r.revenue), 0));
  return {
    title: 'Источники броней',
    period: period(p),
    kpis: [{ label: 'Броней', value: rows.reduce((a, r) => a + r.bookings, 0), type: 'int' }],
    sections: [
      {
        title: 'По источникам (по дате заезда)',
        columns: [
          { key: 'name', label: 'Источник' },
          { key: 'bookings', label: 'Броней', type: 'int' },
          { key: 'nights', label: 'Ночей', type: 'int' },
          { key: 'revenue', label: 'Выручка от проживания', type: 'money' },
          { key: 'share', label: 'Доля', type: 'percent' },
        ],
        rows: rows.map((r) => ({ ...r, name: r.name ?? 'Не указан', share: pct(Number(r.revenue), total) })),
      },
    ],
  };
}

async function guestsReport(p: ReportParams): Promise<Report> {
  const rows = await sql<{ guestId: string; lastName: string; firstName: string | null; middleName: string | null; phone: string | null; stays: number; nights: number; revenue: number; firstEver: string }[]>`
    select g.id as guest_id, g.last_name, g.first_name, g.middle_name, g.phone,
           count(distinct s.id)::int as stays,
           coalesce(sum(s.check_out - s.check_in), 0)::int as nights,
           coalesce(sum((select coalesce(sum((n->>'price')::numeric), 0) from jsonb_array_elements(s.nights) n)), 0) as revenue,
           (select min(s2.check_in) from stays s2 join bookings b2 on b2.id = s2.booking_id
             where b2.guest_id = g.id and s2.deleted_at is null and s2.status in ${sql(BILLABLE)}) as first_ever
      from guests g
      join bookings b on b.guest_id = g.id and b.deleted_at is null
      join stays s on s.booking_id = b.id and s.deleted_at is null and s.status in ${sql(BILLABLE)}
     where g.deleted_at is null and s.check_in between ${p.from} and ${p.to}
     group by g.id order by revenue desc`;
  const isNew = (r: (typeof rows)[number]) => r.firstEver >= p.from;
  return {
    title: 'Гости',
    period: period(p),
    kpis: [
      { label: 'Гостей', value: rows.length, type: 'int' },
      { label: 'Новых', value: rows.filter(isNew).length, type: 'int' },
      { label: 'Повторных', value: rows.filter((r) => !isNew(r)).length, type: 'int' },
    ],
    sections: [
      {
        title: 'Гости по выручке',
        columns: [
          { key: 'guest', label: 'Гость' },
          { key: 'phone', label: 'Телефон' },
          { key: 'kind', label: 'Тип' },
          { key: 'stays', label: 'Размещений', type: 'int' },
          { key: 'nights', label: 'Ночей', type: 'int' },
          { key: 'revenue', label: 'Выручка', type: 'money' },
        ],
        rows: rows.map((r) => ({ guestId: r.guestId, guest: guestFullName(r), phone: r.phone ?? '', kind: isNew(r) ? 'Новый' : 'Повторный', stays: r.stays, nights: r.nights, revenue: Number(r.revenue) })),
      },
    ],
  };
}

async function profit(p: ReportParams): Promise<Report> {
  const exp = await sql<{ name: string | null; month: string; sum: number }[]>`
    select c.name, to_char(e.date, 'YYYY-MM') as month, sum(e.amount) as sum from expenses e
      left join expense_categories c on c.id = e.category_id
     where e.deleted_at is null and e.date between ${p.from} and ${p.to}
     group by 1, 2`;
  const pay = await sql<{ month: string; sum: number }[]>`
    select to_char(p.date, 'YYYY-MM') as month, sum(p.amount) as sum from payments p
      join bookings b on b.id = p.booking_id and b.deleted_at is null
     where p.deleted_at is null and p.date between ${p.from} and ${p.to} group by 1`;
  const withheld = await sql<{ month: string; sum: number }[]>`
    select to_char(coalesce(returned_at, date), 'YYYY-MM') as month, sum(withheld_amount) as sum from deposits
     where deleted_at is null and withheld_amount > 0 and coalesce(returned_at, date) between ${p.from} and ${p.to} group by 1`;
  const sum = (rows: { sum: number }[]) => r2(rows.reduce((a, r) => a + Number(r.sum), 0));
  const income = r2(sum(pay) + sum(withheld));
  const expenses = sum(exp);
  const cats = [...new Set(exp.map((e) => e.name ?? 'Без категории'))].sort();
  const months = [...new Set([...exp, ...pay, ...withheld].map((r) => r.month))].sort();
  return {
    title: 'Расходы и прибыль',
    period: period(p),
    kpis: [
      { label: 'Поступления', value: income, type: 'money' },
      { label: 'Расходы', value: expenses, type: 'money' },
      { label: 'Прибыль', value: r2(income - expenses), type: 'money' },
    ],
    sections: [
      {
        title: 'Расходы по категориям',
        columns: [
          { key: 'name', label: 'Категория' },
          { key: 'sum', label: 'Сумма', type: 'money' },
          { key: 'share', label: 'Доля', type: 'percent' },
        ],
        rows: cats.map((c) => {
          const s = sum(exp.filter((e) => (e.name ?? 'Без категории') === c));
          return { name: c, sum: s, share: pct(s, expenses) };
        }),
        totals: { name: 'Итого', sum: expenses },
      },
      {
        title: 'По месяцам',
        columns: [
          { key: 'month', label: 'Месяц' },
          { key: 'income', label: 'Поступления', type: 'money' },
          { key: 'expenses', label: 'Расходы', type: 'money' },
          { key: 'profit', label: 'Прибыль', type: 'money' },
        ],
        rows: months.map((m) => {
          const inc = r2(sum(pay.filter((r) => r.month === m)) + sum(withheld.filter((r) => r.month === m)));
          const e = sum(exp.filter((r) => r.month === m));
          return { month: monthLabel(m), income: inc, expenses: e, profit: r2(inc - e) };
        }),
        totals: { month: 'Итого', income, expenses, profit: r2(income - expenses) },
      },
    ],
  };
}

async function ksr(p: ReportParams): Promise<Report> {
  const { rooms, dates, closed, nights } = await occupancyData(p);
  let avail = 0;
  for (const d of dates) for (const r of rooms) if (!closed.has(`${r.id}|${d}`)) avail++;
  const placeNights = dates.length * rooms.reduce((a, r) => a + r.places, 0);
  const personNights = nights.reduce((a, n) => a + n.persons, 0);
  const [arrived] = await sql<{ stays: number; persons: number }[]>`
    select count(*)::int as stays, coalesce(sum(s.persons), 0)::int as persons from stays s
      join rooms r on r.id = s.room_id and not r.is_service
      join bookings b on b.id = s.booking_id and b.deleted_at is null
     where s.deleted_at is null and s.status in ${sql(BILLABLE)} and s.check_in between ${p.from} and ${p.to}`;
  const [svc] = await sql<{ sum: number }[]>`
    select coalesce(sum(c.qty * c.price), 0) as sum from charges c join booking_totals t on t.booking_id = c.booking_id and t.active
     where c.deleted_at is null and c.date between ${p.from} and ${p.to}`;
  const living = r2(nights.reduce((a, n) => a + n.price, 0));
  const rows: Record<string, unknown>[] = [
    { name: 'Число номеров (без служебных)', value: rooms.length, type: 'int' },
    { name: 'Число мест', value: rooms.reduce((a, r) => a + r.places, 0) },
    { name: 'Календарных дней в периоде', value: dates.length },
    { name: 'Номеро-ночей доступно', value: avail },
    { name: 'Номеро-ночей продано', value: nights.length },
    { name: 'Койко-ночей (мест × дней)', value: placeNights },
    { name: 'Размещено лиц (заезды в периоде)', value: arrived.persons },
    { name: 'Размещений (заезды в периоде)', value: arrived.stays },
    { name: 'Человеко-ночей (ночёвок)', value: personNights },
    { name: 'Загрузка номерного фонда, %', value: pct(nights.length, avail) },
    { name: 'Загрузка по местам, %', value: pct(personNights, placeNights) },
    { name: 'Доход от проживания, ₽', value: living },
    { name: 'Доход от доп. услуг, ₽', value: r2(Number(svc.sum)) },
    { name: 'Доходы всего, ₽', value: r2(living + Number(svc.sum)) },
  ];
  return {
    title: 'Сводка для формы 1-КСР',
    period: period(p),
    kpis: [],
    sections: [
      {
        title: 'Показатели',
        columns: [
          { key: 'name', label: 'Показатель' },
          { key: 'value', label: 'Значение', type: 'num' },
        ],
        rows,
      },
    ],
  };
}

async function inventory(p: ReportParams): Promise<Report> {
  const assets = await sql<{ invNumber: string; name: string; category: string | null; place: string | null; cost: number; condition: string; writtenOffAt: string | null }[]>`
    select a.inv_number, a.name, c.name as category, coalesce('Номер ' || r.name, l.name) as place, a.cost, a.condition, a.written_off_at
      from assets a
      left join asset_categories c on c.id = a.category_id
      left join rooms r on r.id = a.room_id
      left join locations l on l.id = a.location_id
     where a.deleted_at is null
     order by place nulls last, a.name`;
  const active = assets.filter((a) => !a.writtenOffAt);
  const writtenOff = assets.filter((a) => a.writtenOffAt && a.writtenOffAt >= p.from && a.writtenOffAt <= p.to);
  const repairs = await sql<{ date: string; name: string; invNumber: string; description: string; contractor: string | null; cost: number }[]>`
    select r.date, a.name, a.inv_number, r.description, r.contractor, r.cost from asset_repairs r join assets a on a.id = r.asset_id
     where r.deleted_at is null and r.date between ${p.from} and ${p.to} order by r.date`;
  const byPlace = new Map<string, { cnt: number; cost: number }>();
  for (const a of active) {
    const k = a.place ?? 'Не указано';
    const v = byPlace.get(k) ?? { cnt: 0, cost: 0 };
    v.cnt++;
    v.cost += a.cost;
    byPlace.set(k, v);
  }
  const value = r2(active.reduce((s, a) => s + a.cost, 0));
  const supplies = await sql<{ name: string; unit: string; category: string | null; stock: number; minQty: number; used: number; received: number }[]>`
    select s.name, s.unit, s.category, st.qty as stock, s.min_qty,
           coalesce((select sum(qty) from supply_moves m where m.supply_id = s.id and m.deleted_at is null and m.kind = 'out' and m.date between ${p.from} and ${p.to}), 0) as used,
           coalesce((select sum(qty) from supply_moves m where m.supply_id = s.id and m.deleted_at is null and m.kind = 'in' and m.date between ${p.from} and ${p.to}), 0) as received
      from supplies s join supply_stock st on st.supply_id = s.id
     where s.deleted_at is null and s.is_active
     order by s.category nulls last, s.name`;
  return {
    title: 'Инвентарь',
    period: period(p),
    kpis: [
      { label: 'Основных средств', value: active.length, type: 'int' },
      { label: 'Стоимость', value, type: 'money' },
      { label: 'Списано за период', value: writtenOff.length, type: 'int' },
      { label: 'Ремонтов за период', value: repairs.length, type: 'int' },
    ],
    sections: [
      {
        title: 'По местонахождению',
        columns: [
          { key: 'name', label: 'Место' },
          { key: 'cnt', label: 'Количество', type: 'int' },
          { key: 'cost', label: 'Стоимость', type: 'money' },
        ],
        rows: [...byPlace.entries()].map(([name, v]) => ({ name, cnt: v.cnt, cost: r2(v.cost) })),
        totals: { name: 'Итого', cnt: active.length, cost: value },
      },
      {
        title: 'Ведомость основных средств',
        columns: [
          { key: 'invNumber', label: 'Инв. №' },
          { key: 'name', label: 'Наименование' },
          { key: 'category', label: 'Категория' },
          { key: 'place', label: 'Место' },
          { key: 'condition', label: 'Состояние' },
          { key: 'cost', label: 'Стоимость', type: 'money' },
        ],
        rows: active.map((a) => ({ ...a, condition: ASSET_CONDITION_LABELS[a.condition as keyof typeof ASSET_CONDITION_LABELS] ?? a.condition })),
      },
      {
        title: 'Списано за период',
        columns: [
          { key: 'writtenOffAt', label: 'Дата', type: 'date' },
          { key: 'invNumber', label: 'Инв. №' },
          { key: 'name', label: 'Наименование' },
          { key: 'cost', label: 'Стоимость', type: 'money' },
        ],
        rows: writtenOff,
      },
      {
        title: 'Расходники: остатки и движение за период',
        columns: [
          { key: 'name', label: 'Наименование' },
          { key: 'category', label: 'Группа' },
          { key: 'unit', label: 'Ед.' },
          { key: 'received', label: 'Приход', type: 'num' },
          { key: 'used', label: 'Расход', type: 'num' },
          { key: 'stock', label: 'Остаток', type: 'num' },
          { key: 'minQty', label: 'Минимум', type: 'num' },
        ],
        rows: supplies.map((x) => ({ ...x, stock: Number(x.stock), minQty: Number(x.minQty), used: Number(x.used), received: Number(x.received) })),
      },
      {
        title: 'Ремонты за период',
        columns: [
          { key: 'date', label: 'Дата', type: 'date' },
          { key: 'invNumber', label: 'Инв. №' },
          { key: 'name', label: 'Наименование' },
          { key: 'description', label: 'Что сделано' },
          { key: 'contractor', label: 'Исполнитель' },
          { key: 'cost', label: 'Стоимость', type: 'money' },
        ],
        rows: repairs,
      },
    ],
  };
}

// ─── Выгрузка в Excel ───────────────────────────────────────────────────────

const NUM_FMT: Partial<Record<ColType, string>> = {
  money: '#,##0.00 ₽',
  int: '0',
  num: '#,##0.##',
  percent: '0.0"%"',
};

/** Коммунальные расходы: расход и стоимость по счётчикам, в пересчёте на проданную ночь. */
async function utilities(p: ReportParams): Promise<Report> {
  const usage = await sql<{ meterId: string; name: string; unit: string; kind: string; month: string; usage: number; cost: number; readings: number }[]>`
    select m.id as meter_id, m.name, m.unit, m.kind, to_char(u.date, 'YYYY-MM') as month,
           coalesce(sum(u.usage), 0) as usage, coalesce(sum(u.usage * u.price), 0) as cost, count(*)::int as readings
      from meter_usage u join meters m on m.id = u.meter_id and m.deleted_at is null
     where u.date between ${p.from} and ${p.to}
     group by 1, 2, 3, 4, 5
     order by m.sort_order nulls last, m.name, 5`;
  const sold = await sql<{ month: string; n: number }[]>`
    select to_char(n.date, 'YYYY-MM') as month, count(*)::int as n
      from stay_nights n join rooms r on r.id = n.room_id and not r.is_service
      join bookings b on b.id = n.booking_id and b.deleted_at is null
     where n.date between ${p.from} and ${p.to} and n.status in ${sql(BILLABLE)}
     group by 1`;
  const soldBy = new Map(sold.map((s) => [s.month, s.n]));
  const months = [...new Set(usage.map((u) => u.month))].sort();
  const meters = [...new Map(usage.map((u) => [u.meterId, u])).values()];
  const byMonth = months.map((m) => {
    const row: Record<string, unknown> = { month: monthLabel(m) };
    let cost = 0;
    for (const mt of meters) {
      const u = usage.find((x) => x.meterId === mt.meterId && x.month === m);
      row[`u_${mt.meterId}`] = u ? r2(Number(u.usage)) : null;
      cost += u ? Number(u.cost) : 0;
    }
    const nights = soldBy.get(m) ?? 0;
    row.cost = r2(cost);
    row.nights = nights;
    row.perNight = nights ? r2(cost / nights) : null;
    return row;
  });
  const totalCost = r2(usage.reduce((a, u) => a + Number(u.cost), 0));
  const totalNights = months.reduce((a, m) => a + (soldBy.get(m) ?? 0), 0);
  return {
    title: 'Коммунальные расходы',
    period: period(p),
    kpis: [
      { label: 'Стоимость за период', value: totalCost, type: 'money' },
      { label: 'Продано ночей', value: totalNights, type: 'int' },
      { label: 'Коммуналка на ночь', value: totalNights ? r2(totalCost / totalNights) : 0, type: 'money', hint: 'Стоимость по счётчикам, делённая на проданные номеро-ночи тех же месяцев' },
    ],
    sections: [
      {
        title: 'По месяцам',
        columns: [
          { key: 'month', label: 'Месяц' },
          ...meters.map((m) => ({ key: `u_${m.meterId}`, label: `${m.name}, ${m.unit}`, type: 'num' as const })),
          { key: 'cost', label: 'Стоимость', type: 'money' },
          { key: 'nights', label: 'Ночей', type: 'int' },
          { key: 'perNight', label: 'На ночь', type: 'money' },
        ],
        rows: byMonth,
        totals: { month: 'Итого', cost: totalCost, nights: totalNights, perNight: totalNights ? r2(totalCost / totalNights) : null },
      },
      {
        title: 'По счётчикам',
        columns: [
          { key: 'name', label: 'Счётчик' },
          { key: 'usage', label: 'Расход', type: 'num' },
          { key: 'unit', label: 'Ед.' },
          { key: 'cost', label: 'Стоимость', type: 'money' },
        ],
        rows: meters.map((m) => {
          const list = usage.filter((u) => u.meterId === m.meterId);
          return {
            name: m.name,
            usage: r2(list.reduce((a, u) => a + Number(u.usage), 0)),
            unit: m.unit,
            cost: r2(list.reduce((a, u) => a + Number(u.cost), 0)),
          };
        }),
      },
    ],
  };
}

/** Туристический налог по размещениям с выездом в периоде. */
async function touristTaxReport(p: ReportParams): Promise<Report> {
  const [st] = await sql<{ value: TouristTaxSettings }[]>`select value from settings where key = 'touristTax' and deleted_at is null`;
  const settings: TouristTaxSettings = { ...DEFAULT_TOURIST_TAX, ...(st?.value ?? {}) };
  const bookings = await sql<{ id: string; number: number | null; discount: number; touristTaxExempt: boolean; lastName: string | null; firstName: string | null; middleName: string | null }[]>`
    select b.id, b.number, b.discount, b.tourist_tax_exempt, g.last_name, g.first_name, g.middle_name
      from bookings b left join guests g on g.id = b.guest_id
     where b.deleted_at is null and exists (
       select 1 from stays s where s.booking_id = b.id and s.deleted_at is null
          and s.status in ${sql(BILLABLE)} and s.check_out between ${p.from} and ${p.to})`;
  const ids = bookings.map((b) => b.id);
  const stays = ids.length
    ? await sql<(Pick<Stay, 'id' | 'bookingId' | 'roomId' | 'checkIn' | 'checkOut' | 'status' | 'nights' | 'deletedAt'> & { roomName: string; isService: boolean })[]>`
        select s.id, s.booking_id, s.room_id, s.check_in, s.check_out, s.status, s.nights, s.deleted_at, r.name as room_name, r.is_service
          from stays s join rooms r on r.id = s.room_id
         where s.booking_id in ${sql(ids)} and s.deleted_at is null`
    : [];
  const services = ids.length
    ? await sql<{ bookingId: string; sum: number }[]>`
        select booking_id, coalesce(sum(qty * price), 0) as sum from charges
         where booking_id in ${sql(ids)} and deleted_at is null and name <> ${TOURIST_TAX_CHARGE}
         group by 1`
    : [];
  const svc = new Map(services.map((s) => [s.bookingId, Number(s.sum)]));
  const rows: Record<string, unknown>[] = [];
  for (const b of bookings) {
    const own = stays.filter((s) => s.bookingId === b.id).map((s) => ({ ...s, nights: (s.nights ?? []).map((n) => ({ ...n, price: Number(n.price) })) }));
    const res = bookingTouristTax({ discount: Number(b.discount), touristTaxExempt: b.touristTaxExempt }, own, svc.get(b.id) ?? 0, settings, (s) => Boolean(own.find((x) => x.id === s.id)?.isService));
    for (const t of res.stays) {
      const s = own.find((x) => x.id === t.stayId)!;
      if (s.checkOut < p.from || s.checkOut > p.to) continue;
      rows.push({
        bookingId: b.id,
        booking: b.number ? `№ ${b.number}` : '',
        guest: guestFullName(b),
        room: s.roomName,
        checkIn: s.checkIn,
        checkOut: s.checkOut,
        nights: t.nights,
        price: t.price,
        base: t.base,
        rate: t.rate,
        tax: t.tax,
        exempt: t.exempt ? 'льгота' : '',
      });
    }
  }
  rows.sort((a, b) => String(a.checkOut).localeCompare(String(b.checkOut)));
  const sum = (k: string, list = rows) => r2(list.reduce((a, r) => a + Number(r[k] ?? 0), 0));
  const months = [...new Set(rows.map((r) => String(r.checkOut).slice(0, 7)))].sort();
  return {
    title: 'Туристический налог',
    period: period(p),
    kpis: [
      { label: 'Налог к уплате', value: sum('tax'), type: 'money' },
      { label: 'Налоговая база', value: sum('base'), type: 'money' },
      { label: 'Размещений', value: rows.length, type: 'int' },
      { label: 'Льготников', value: rows.filter((r) => r.exempt).length, type: 'int' },
    ],
    sections: [
      {
        title: 'По месяцам выезда',
        columns: [
          { key: 'month', label: 'Месяц' },
          { key: 'count', label: 'Размещений', type: 'int' },
          { key: 'nights', label: 'Ночей', type: 'int' },
          { key: 'base', label: 'База', type: 'money' },
          { key: 'tax', label: 'Налог', type: 'money' },
        ],
        rows: months.map((m) => {
          const list = rows.filter((r) => String(r.checkOut).startsWith(m));
          return { month: monthLabel(m), count: list.length, nights: sum('nights', list), base: sum('base', list), tax: sum('tax', list) };
        }),
        totals: { month: 'Итого', count: rows.length, nights: sum('nights'), base: sum('base'), tax: sum('tax') },
      },
      {
        title: 'Размещения',
        columns: [
          { key: 'booking', label: 'Бронь' },
          { key: 'guest', label: 'Гость' },
          { key: 'room', label: 'Номер' },
          { key: 'checkIn', label: 'Заезд', type: 'date' },
          { key: 'checkOut', label: 'Выезд', type: 'date' },
          { key: 'nights', label: 'Ночей', type: 'int' },
          { key: 'price', label: 'Стоимость', type: 'money' },
          { key: 'base', label: 'База', type: 'money' },
          { key: 'rate', label: 'Ставка', type: 'percent' },
          { key: 'tax', label: 'Налог', type: 'money' },
          { key: 'exempt', label: 'Льгота' },
        ],
        rows,
        totals: { booking: 'Итого', nights: sum('nights'), price: sum('price'), base: sum('base'), tax: sum('tax') },
      },
    ],
  };
}

/** Налог ИП: авансовые платежи по кварталам (УСН) или по месяцам (НПД) и книга учёта доходов. */
async function incomeTaxReport(p: ReportParams): Promise<Report> {
  const year = Number(p.from.slice(0, 4));
  const d = await usnData(year);
  const { s, ip } = d;
  const inPeriod = (r: { date: string }) => r.date >= p.from && r.date <= p.to;
  const periodIncome = d.income.filter(inPeriod);
  const periodExpenses = d.expenses.filter(inPeriod);
  const sections: Section[] = [];
  const kpis: Kpi[] = [];
  const incP = sumAmount(periodIncome);
  const expP = sumAmount(periodExpenses);

  if (s.regime === 'npd') {
    const rate = s.npdRate / 100;
    const rows = Array.from({ length: 12 }, (_, i) => {
      const m = `${year}-${String(i + 1).padStart(2, '0')}`;
      const inc = sumAmount(d.income.filter((r) => r.date.startsWith(m)));
      const due = workingDay(i === 11 ? `${year + 1}-01-28` : `${m.slice(0, 5)}${String(i + 2).padStart(2, '0')}-28`);
      return { period: monthLabel(m), income: inc, tax: r2(Math.max(0, inc) * rate), due };
    });
    sections.push({
      title: `Налог на профессиональный доход, ${year}`,
      columns: [
        { key: 'period', label: 'Месяц' },
        { key: 'income', label: 'Доход', type: 'money' },
        { key: 'tax', label: `Налог ${s.npdRate} %`, type: 'money' },
        { key: 'due', label: 'Уплатить до', type: 'date' },
      ],
      rows,
      totals: { period: 'Итого', income: r2(rows.reduce((a, r) => a + r.income, 0)), tax: r2(rows.reduce((a, r) => a + r.tax, 0)) },
    });
    kpis.push(
      { label: 'Доход за период', value: incP, type: 'money' },
      { label: `Налог ${s.npdRate} % за период`, value: r2(Math.max(0, incP) * rate), type: 'money', hint: 'Налоговый вычет 10 000 ₽ (снижение ставки) здесь не учитывается — точную сумму показывает приложение «Мой налог»' },
      { label: `Доход с начала ${year}`, value: sumAmount(d.income), type: 'money', hint: 'Для НПД доход за год ограничен — следите за лимитом' },
    );
  } else {
    const usn6 = s.regime === 'usn6';
    const y = d.periods[3];
    sections.push({
      title: `${usn6 ? 'УСН «доходы»' : 'УСН «доходы минус расходы»'}, ${year} (нарастающим итогом)`,
      columns: [
        { key: 'label', label: 'Период' },
        { key: 'code', label: 'Код' },
        { key: 'income', label: 'Доходы', type: 'money' },
        ...(usn6 ? [] : [{ key: 'expenses', label: 'Расходы', type: 'money' as const }]),
        { key: 'rate', label: 'Ставка', type: 'percent' },
        { key: 'tax', label: 'Налог', type: 'money' },
        ...(usn6 ? [{ key: 'reduction', label: 'Уменьшение на взносы', type: 'money' as const }] : []),
        { key: 'due', label: 'К уплате, всего', type: 'money' },
        { key: 'payable', label: 'Платёж за период', type: 'money' },
        { key: 'payDeadline', label: 'Уплатить до', type: 'date' },
      ],
      rows: d.periods.map((x) => ({ ...x, expenses: usn6 ? null : x.expenses, reduction: usn6 ? x.reduction : null })),
    });
    const yearBase = usn6 ? y.income : y.income - y.expenses;
    const extra = r2(Math.max(0, yearBase - 300_000) * 0.01);
    kpis.push(
      { label: 'Доходы за период', value: incP, type: 'money' },
      ...(usn6 ? [] : [{ label: 'Расходы за период', value: expP, type: 'money' as const }]),
      { label: `Налог за ${year}, к уплате`, value: y.due, type: 'money', hint: usn6 ? `Ставка ${y.rate} %, уменьшение на взносы ${y.reduction} ₽` : undefined },
      ...(usn6 ? [{ label: `Фиксированные взносы ИП за ${year}`, value: d.fixed, type: 'money' as const, hint: `Уплатить до ${fmtDate(workingDay(`${year}-12-28`))}. ИП без работников уменьшает налог на них даже до уплаты.` }] : []),
      {
        label: 'Взнос 1 % сверх 300 000 ₽',
        value: extra,
        type: 'money',
        hint: `Дополнительный взнос ИП за ${year}: 1 % с ${usn6 ? 'доходов' : 'доходов за вычетом расходов'} свыше 300 000 ₽, уплатить до ${fmtDate(workingDay(`${year + 1}-07-01`))}.`,
      },
    );
    if (usn6) {
      sections.push({
        title: 'Данные для декларации по УСН (разделы 1.1 и 2.1.1)',
        columns: [
          { key: 'code', label: 'Раздел / строка' },
          { key: 'label', label: 'Показатель' },
          { key: 'value', label: 'Значение' },
        ],
        rows: usnDeclarationLines(d.periods, ip.oktmo, d.rateReason),
      });
    }
  }

  // Книга учёта доходов (и расходов — для УСН 15 %), с итогами по кварталам.
  const entries: Record<string, unknown>[] = periodIncome.map((r) => ({ date: r.date, doc: r.doc, content: r.content, income: r.amount, expense: null }));
  if (s.regime === 'usn15')
    for (const e of periodExpenses) entries.push({ date: e.date, doc: e.doc, content: e.content, income: null, expense: Number(e.amount) });
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const book: Record<string, unknown>[] = [];
  let n = 0;
  for (const per of USN_PERIODS) {
    const qStart = per.q === 1 ? `${year}-01-01` : `${year}-${USN_PERIODS[per.q - 2].end}`;
    const list = entries.filter((e) => String(e.date) > (per.q === 1 ? `${year - 1}-12-31` : qStart) && String(e.date) <= `${year}-${per.end}`);
    for (const e of list) book.push({ ...e, n: ++n });
    if (list.length || entries.some((e) => String(e.date) <= `${year}-${per.end}`)) {
      const sumQ = r2(list.reduce((a, e) => a + Number(e.income ?? 0), 0));
      const cum = r2(entries.filter((e) => String(e.date) <= `${year}-${per.end}`).reduce((a, e) => a + Number(e.income ?? 0), 0));
      book.push({ content: `Итого за ${['I', 'II', 'III', 'IV'][per.q - 1]} квартал`, income: sumQ });
      if (per.q > 1) book.push({ content: `Итого за ${per.q === 2 ? 'полугодие' : per.q === 3 ? '9 месяцев' : 'год'}`, income: cum });
    }
  }
  sections.push({
    title: s.regime === 'npd' ? 'Поступления' : `Книга учёта доходов и расходов (КУДиР), раздел I${ip.lastName ? ` — ИП ${[ip.lastName, ip.firstName, ip.middleName].filter(Boolean).join(' ')}${ip.inn ? `, ИНН ${ip.inn}` : ''}` : ''}`,
    columns: [
      { key: 'n', label: '№', type: 'int' },
      { key: 'date', label: 'Дата', type: 'date' },
      { key: 'doc', label: 'Документ' },
      { key: 'content', label: 'Содержание операции' },
      { key: 'income', label: 'Доходы', type: 'money' },
      ...(s.regime === 'usn15' ? [{ key: 'expense', label: 'Расходы', type: 'money' as const }] : []),
    ],
    rows: book,
    totals: { doc: 'Итого за период', income: incP, expense: s.regime === 'usn15' ? expP : null },
  });

  if (s.regime === 'usn6') {
    sections.push({
      title: 'КУДиР, раздел IV: страховые взносы, уменьшающие налог',
      columns: [
        { key: 'what', label: 'Взносы' },
        { key: 'amount', label: 'Сумма', type: 'money' },
        { key: 'note', label: 'Примечание' },
      ],
      rows: [
        { what: `Фиксированные взносы ИП за ${year}`, amount: d.fixed, note: 'Уменьшают налог в течение года даже до уплаты (ИП без работников)' },
        ...(d.employeeContrib ? [{ what: 'Уплаченные взносы за работников', amount: d.employeeContrib, note: `Категория расходов «${s.employeeContribCategory}»` }] : []),
      ],
    });
  }

  return { title: s.regime === 'npd' ? 'Налог на профессиональный доход' : 'Налог УСН', period: period(p), kpis, sections };
}

/** Персонал: начислено, выплачено и долг по каждому сотруднику. */
async function staffReport(p: ReportParams): Promise<Report> {
  const rows = await sql<{ id: string; name: string; position: string | null; accrued: number; paid: number; accruedAll: number; paidAll: number }[]>`
    select s.id, s.name, s.position,
           coalesce((select sum(amount) from staff_accruals a where a.staff_id = s.id and a.deleted_at is null and a.date between ${p.from} and ${p.to}), 0) as accrued,
           coalesce((select sum(amount) from staff_payments x where x.staff_id = s.id and x.deleted_at is null and x.date between ${p.from} and ${p.to}), 0) as paid,
           coalesce((select sum(amount) from staff_accruals a where a.staff_id = s.id and a.deleted_at is null and a.date <= ${p.to}), 0) as accrued_all,
           coalesce((select sum(amount) from staff_payments x where x.staff_id = s.id and x.deleted_at is null and x.date <= ${p.to}), 0) as paid_all
      from staff s where s.deleted_at is null
     order by s.is_active desc, s.sort_order nulls last, s.name`;
  const list = rows
    .map((r) => ({ name: r.name, position: r.position, accrued: r2(Number(r.accrued)), paid: r2(Number(r.paid)), balance: r2(Number(r.accruedAll) - Number(r.paidAll)) }))
    .filter((r) => r.accrued || r.paid || r.balance);
  const ledger = await sql<{ date: string; name: string; kind: string; what: string; qty: number | null; amount: number }[]>`
    select a.date, s.name, 'accrual' as kind, a.kind as what, a.qty, a.amount from staff_accruals a join staff s on s.id = a.staff_id
     where a.deleted_at is null and s.deleted_at is null and a.date between ${p.from} and ${p.to}
    union all
    select x.date, s.name, 'payment', x.kind, null, x.amount from staff_payments x join staff s on s.id = x.staff_id
     where x.deleted_at is null and s.deleted_at is null and x.date between ${p.from} and ${p.to}
    order by 1, 2`;
  const what: Record<string, string> = { ...STAFF_ACCRUAL_LABELS, advance: 'Аванс' };
  const sum = (k: 'accrued' | 'paid' | 'balance') => r2(list.reduce((a, r) => a + r[k], 0));
  return {
    title: 'Персонал и зарплата',
    period: period(p),
    kpis: [
      { label: 'Начислено', value: sum('accrued'), type: 'money' },
      { label: 'Выплачено', value: sum('paid'), type: 'money' },
      { label: 'Долг перед сотрудниками', value: sum('balance'), type: 'money', hint: 'На конец периода: всё начисленное минус всё выплаченное' },
    ],
    sections: [
      {
        title: 'По сотрудникам',
        columns: [
          { key: 'name', label: 'Сотрудник' },
          { key: 'position', label: 'Должность' },
          { key: 'accrued', label: 'Начислено', type: 'money' },
          { key: 'paid', label: 'Выплачено', type: 'money' },
          { key: 'balance', label: 'Долг на конец', type: 'money' },
        ],
        rows: list,
        totals: { name: 'Итого', accrued: sum('accrued'), paid: sum('paid'), balance: sum('balance') },
      },
      {
        title: 'Начисления и выплаты',
        columns: [
          { key: 'date', label: 'Дата', type: 'date' },
          { key: 'name', label: 'Сотрудник' },
          { key: 'op', label: 'Операция' },
          { key: 'qty', label: 'Кол-во', type: 'num' },
          { key: 'accrued', label: 'Начислено', type: 'money' },
          { key: 'paid', label: 'Выплачено', type: 'money' },
        ],
        rows: ledger.map((l) => ({
          date: l.date,
          name: l.name,
          op: l.kind === 'payment' ? (l.what === 'advance' ? 'Аванс' : 'Выплата зарплаты') : (what[l.what] ?? l.what),
          qty: l.qty === null ? null : Number(l.qty),
          accrued: l.kind === 'accrual' ? Number(l.amount) : null,
          paid: l.kind === 'payment' ? Number(l.amount) : null,
        })),
      },
    ],
  };
}

export async function reportToXlsx(report: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HotelManager';
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([report.period]);
  ws.addRow([]);
  for (const k of report.kpis) {
    const r = ws.addRow([k.label, k.value]);
    r.getCell(2).numFmt = NUM_FMT[k.type] ?? 'General';
  }
  for (const s of report.sections) {
    ws.addRow([]);
    ws.addRow([s.title]).font = { bold: true, size: 12 };
    const header = ws.addRow(s.columns.map((c) => c.label));
    header.font = { bold: true };
    header.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F0F7' } }));
    const all = s.totals ? [...s.rows, s.totals] : s.rows;
    all.forEach((row, i) => {
      const r = ws.addRow(
        s.columns.map((c) => {
          const v = row[c.key];
          if (c.type === 'date' && typeof v === 'string') return fmtDate(v);
          return v ?? '';
        }),
      );
      s.columns.forEach((c, ci) => {
        const f = NUM_FMT[c.type ?? 'text'];
        if (f) r.getCell(ci + 1).numFmt = f;
      });
      if (s.totals && i === all.length - 1) r.font = { bold: true };
    });
  }
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: false }, (c) => {
      max = Math.max(max, String(c.value ?? '').length + 2);
    });
    col.width = Math.min(max, 60);
  });
  ws.getColumn(1).width = Math.min(Math.max(ws.getColumn(1).width ?? 20, 20), 45);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Выгрузка произвольной таблицы (списки гостей, броней и т. п.). */
export async function tableToXlsx(title: string, columns: Column[], rows: Record<string, unknown>[]): Promise<Buffer> {
  return reportToXlsx({ title, period: `Выгружено ${fmtDate(todayMsk())}`, kpis: [], sections: [{ title, columns, rows }] });
}
