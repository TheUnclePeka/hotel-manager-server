import crypto from 'node:crypto';
import {
  DEFAULT_INCOME_TAX,
  DEFAULT_IP,
  fixedContributions,
  guestFullName,
  type IncomeTaxSettings,
  type IpRequisites,
  type ISODate,
  todayMsk,
  USN_PERIODS,
  usnDeclaration,
  usnKbk,
  usnYear,
  vatThreshold,
  workingDay,
} from '@hotel-manager/shared';
import { sql } from './db.js';
import { toCp1251 } from './taxNotice.js';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Настройки налога и реквизиты ИП. */
export async function taxSettings(): Promise<{ s: IncomeTaxSettings; ip: IpRequisites }> {
  const rows = await sql<{ key: string; value: unknown }[]>`select key, value from settings where key in ('incomeTax', 'ipRequisites') and deleted_at is null`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value as object | undefined;
  return { s: { ...DEFAULT_INCOME_TAX, ...(get('incomeTax') ?? {}) }, ip: { ...DEFAULT_IP, ...(get('ipRequisites') ?? {}) } };
}

/** Строка книги налогового учёта. */
export interface LedgerRow {
  key: string;
  source: 'payment' | 'deposit' | 'manual' | 'expense';
  sourceId: string;
  date: string;
  /** Исходная дата оплаты, если учтена другой датой. */
  origDate: string | null;
  kind: 'income' | 'expense';
  docType: string;
  docNumber: string | null;
  doc: string;
  content: string;
  /** Доход со знаком (возврат — минус); расход — положительный. */
  amount: number;
  method: string | null;
  counterparty: string | null;
  excluded: boolean;
  bookingId: string | null;
  adjustment: { id: string; action: string; reason: string; newDate: string | null; splitAmount: number | null } | null;
}

const DOC_LABELS: Record<string, string> = {
  receipt: 'Кассовый чек',
  payment_order: 'Платёжное поручение',
  cash_order: 'ПКО',
  bank_statement: 'Банковская выписка',
  contract: 'Договор',
  other: 'Документ',
};

/**
 * Книга налогового учёта за период: оплаты гостей и удержанные залоги (с корректировками),
 * ручные доходы и возвраты, расходы (из «Расходов» и ручные — для УСН «доходы минус расходы»).
 * Исключённые строки возвращаются с excluded = true и в суммы не входят.
 */
export async function ledger(from: ISODate, to: ISODate): Promise<LedgerRow[]> {
  // Оплаты и залоги берутся с запасом: корректировка может перенести дату в период или из него.
  const [pay, held, adj, manual, exp] = await Promise.all([
    sql<{ id: string; bookingId: string; date: string; amount: number; comment: string | null; number: number | null; method: string | null; lastName: string | null; firstName: string | null; middleName: string | null }[]>`
      select p.id, p.booking_id, p.date, p.amount, p.comment, b.number, pm.name as method, g.last_name, g.first_name, g.middle_name
        from payments p join bookings b on b.id = p.booking_id and b.deleted_at is null
        left join payment_methods pm on pm.id = p.method_id
        left join guests g on g.id = b.guest_id
       where p.deleted_at is null and p.date between ${from}::date - 400 and ${to}::date + 400`,
    sql<{ id: string; bookingId: string; date: string; amount: number; number: number | null; reason: string | null; lastName: string | null; firstName: string | null; middleName: string | null }[]>`
      select d.id, d.booking_id, coalesce(d.returned_at, d.date) as date, d.withheld_amount as amount, b.number, d.withheld_reason as reason, g.last_name, g.first_name, g.middle_name
        from deposits d join bookings b on b.id = d.booking_id and b.deleted_at is null
        left join guests g on g.id = b.guest_id
       where d.deleted_at is null and d.withheld_amount > 0 and coalesce(d.returned_at, d.date) between ${from}::date - 400 and ${to}::date + 400`,
    sql<{ id: string; sourceType: string; sourceId: string; action: string; newDate: string | null; splitAmount: number | null; reason: string }[]>`
      select id, source_type, source_id, action, new_date, split_amount, reason from tax_adjustments where deleted_at is null`,
    sql<{ id: string; date: string; kind: string; docType: string; docNumber: string | null; content: string; amount: number; method: string | null; counterparty: string | null }[]>`
      select id, date, kind, doc_type, doc_number, content, amount, method, counterparty from tax_entries
       where deleted_at is null and kind in ('income', 'refund', 'expense') and date between ${from} and ${to}`,
    sql<{ id: string; date: string; amount: number; category: string | null; comment: string | null; supplier: string | null }[]>`
      select e.id, e.date, e.amount, c.name as category, e.comment, s.name as supplier
        from expenses e left join expense_categories c on c.id = e.category_id left join suppliers s on s.id = e.supplier_id
       where e.deleted_at is null and e.date between ${from} and ${to}`,
  ]);
  const adjOf = new Map(adj.map((a) => [`${a.sourceType}:${a.sourceId}`, a]));
  const out: LedgerRow[] = [];

  const auto = (source: 'payment' | 'deposit', id: string, bookingId: string, date: string, amount: number, doc: string, content: string, method: string | null) => {
    const a = adjOf.get(`${source}:${id}`);
    const adjustment = a ? { id: a.id, action: a.action, reason: a.reason, newDate: a.newDate, splitAmount: a.splitAmount === null ? null : Number(a.splitAmount) } : null;
    const base = { source, sourceId: id, kind: 'income' as const, docType: 'receipt', docNumber: null, doc, content, method, counterparty: null, bookingId, adjustment };
    if (!a) return out.push({ ...base, key: `${source}:${id}`, date, origDate: null, amount, excluded: false });
    if (a.action === 'exclude') return out.push({ ...base, key: `${source}:${id}`, date, origDate: null, amount, excluded: true });
    if (a.action === 'redate') return out.push({ ...base, key: `${source}:${id}`, date: a.newDate ?? date, origDate: date, amount, excluded: false });
    // split: часть суммы — другой датой (или не учитывается, если дата не указана)
    const part = Math.min(Math.abs(amount), Number(a.splitAmount ?? 0)) * Math.sign(amount);
    out.push({ ...base, key: `${source}:${id}`, date, origDate: null, amount: r2(amount - part), excluded: false });
    out.push({ ...base, key: `${source}:${id}:split`, date: a.newDate ?? date, origDate: date, amount: r2(part), excluded: !a.newDate });
  };

  for (const p of pay) {
    const amount = Number(p.amount);
    auto(
      'payment',
      p.id,
      p.bookingId,
      p.date,
      amount,
      `${p.number ? `Бронь № ${p.number}` : 'Бронь'}${p.method ? `, ${p.method.toLowerCase()}` : ''}`,
      `${amount < 0 ? 'Возврат оплаты' : 'Оплата проживания и услуг'}${guestFullName(p) ? `: ${guestFullName(p)}` : ''}`,
      p.method,
    );
  }
  for (const h of held)
    auto('deposit', h.id, h.bookingId, h.date, Number(h.amount), h.number ? `Бронь № ${h.number}` : 'Бронь', `Удержано из залога${h.reason ? ` (${h.reason})` : ''}${guestFullName(h) ? `: ${guestFullName(h)}` : ''}`, null);

  for (const m of manual) {
    const sign = m.kind === 'refund' ? -1 : 1;
    out.push({
      key: `manual:${m.id}`,
      source: 'manual',
      sourceId: m.id,
      date: m.date,
      origDate: null,
      kind: m.kind === 'expense' ? 'expense' : 'income',
      docType: m.docType,
      docNumber: m.docNumber,
      doc: `${DOC_LABELS[m.docType] ?? 'Документ'}${m.docNumber ? ` № ${m.docNumber}` : ''}`,
      content: m.content,
      amount: r2(Number(m.amount) * sign),
      method: m.method === 'cash' ? 'наличные' : m.method === 'cashless' ? 'безналичные' : null,
      counterparty: m.counterparty,
      excluded: false,
      bookingId: null,
      adjustment: null,
    });
  }
  for (const e of exp)
    out.push({
      key: `expense:${e.id}`,
      source: 'expense',
      sourceId: e.id,
      date: e.date,
      origDate: null,
      kind: 'expense',
      docType: 'other',
      docNumber: null,
      doc: e.category ?? 'Расход',
      content: [e.comment, e.supplier].filter(Boolean).join(', ') || e.category || 'Расход',
      amount: Number(e.amount),
      method: null,
      counterparty: e.supplier,
      excluded: false,
      bookingId: null,
      adjustment: null,
      // категория нужна для взносов за сотрудников
      ...({ category: e.category } as object),
    } as LedgerRow);

  return out.filter((r) => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

export const sumAmount = (rows: { date: string; amount: number }[], to?: string) => r2(rows.filter((r) => !to || r.date <= to).reduce((a, r) => a + Number(r.amount), 0));

/** Платежи на ЕНС (ручные записи вида «платёж»). */
export async function ensPayments(from: ISODate, to: ISODate) {
  return sql<{ id: string; date: string; purpose: string | null; forYear: number | null; amount: number; content: string; docNumber: string | null }[]>`
    select id, date, purpose, for_year, amount, content, doc_number from tax_entries
     where deleted_at is null and kind = 'payment' and date between ${from} and ${to} order by date, created_at`;
}

/** Расчёт УСН за год: доходы и расходы с даты регистрации ИП, авансы по кварталам. */
export async function usnData(year: number) {
  const { s, ip } = await taxSettings();
  const start = ip.registeredAt && ip.registeredAt > `${year}-01-01` ? ip.registeredAt : `${year}-01-01`;
  const yTo = `${year}-12-31`;
  const rows = start > yTo ? [] : await ledger(start, yTo);
  const counted = rows.filter((r) => !r.excluded);
  const income = counted.filter((r) => r.kind === 'income');
  const expenses = counted.filter((r) => r.kind === 'expense') as (LedgerRow & { category?: string | null })[];
  const isCat = (e: { category?: string | null }, name: string | undefined) => Boolean(name) && (e.category ?? '').toLowerCase() === name!.toLowerCase();
  const employeeContrib = expenses.filter((e) => isCat(e, s.employeeContribCategory));
  // 1 % за прошлый год, если по настройке он уменьшает налог следующего года.
  let onePercentPrev = 0;
  if (s.onePercentInYear === false) {
    const [prev] = await sql<{ sum: number }[]>`
      select coalesce(sum(amount), 0) as sum from tax_entries
       where deleted_at is null and kind = 'payment' and purpose = 'contrib_1pct' and for_year = ${year - 1}`;
    onePercentPrev = Number(prev?.sum ?? 0);
  }
  const ends = USN_PERIODS.map((p) => `${year}-${p.end}`);
  const periods = usnYear(
    s,
    year,
    ends.map((e) => sumAmount(income, e)),
    ends.map((e) => sumAmount(expenses, e)),
    ends.map((e) => sumAmount(employeeContrib, e)),
    { onePercentPrev },
  );
  return {
    s,
    ip,
    year,
    start,
    periods,
    rows,
    income,
    expenses,
    fixed: fixedContributions(s, year),
    employeeContrib: sumAmount(employeeContrib),
    kbk: usnKbk(s),
    rateReason: s.rateReasons?.[String(year)] ?? '',
    vatThreshold: vatThreshold(s, year),
  };
}

export type UsnData = Awaited<ReturnType<typeof usnData>>;

/**
 * Карточка расчётов с бюджетом за год: начисления (авансы и налог по УСН, взносы ИП) и платежи на ЕНС.
 * Платежи по УСН распределяются по начислениям в порядке сроков.
 */
export async function ensCard(year: number) {
  const d = await usnData(year);
  const decl = usnDeclaration(d.periods, d.rateReason);
  const pays = await ensPayments(`${year}-01-01`, `${year + 1}-12-31`);
  const forThisYear = (p: (typeof pays)[number]) => (p.forYear ?? Number(p.date.slice(0, 4))) === year;
  const usnPaid = r2(pays.filter((p) => p.purpose === 'usn' && forThisYear(p)).reduce((a, p) => a + Number(p.amount), 0));
  const fixedPaid = r2(pays.filter((p) => p.purpose === 'contrib_fixed' && forThisYear(p)).reduce((a, p) => a + Number(p.amount), 0));
  const onePaid = r2(pays.filter((p) => p.purpose === 'contrib_1pct' && forThisYear(p)).reduce((a, p) => a + Number(p.amount), 0));
  const onePercent = Math.round(Math.max(0, (d.s.regime === 'usn15' ? d.periods[3].income - d.periods[3].expenses : d.periods[3].income) - 300_000) * 0.01);
  const usnItems = [
    { what: `Аванс по УСН за I квартал ${year}`, due: d.periods[0].payDeadline, amount: decl.l020 },
    { what: `Аванс по УСН за полугодие ${year}`, due: d.periods[1].payDeadline, amount: decl.l040 - decl.l050 },
    { what: `Аванс по УСН за 9 месяцев ${year}`, due: d.periods[2].payDeadline, amount: decl.l070 - decl.l080 },
    { what: `Налог по УСН за ${year}`, due: d.periods[3].payDeadline, amount: decl.l100 - decl.l110 },
  ];
  let left = usnPaid;
  const items = usnItems.map((i) => {
    const paid = i.amount > 0 ? Math.min(left, i.amount) : 0;
    left = r2(left - paid);
    return { ...i, kind: 'usn', paid: r2(paid) };
  });
  items.push(
    { what: `Фиксированные взносы ИП за ${year}`, due: workingDay(`${year}-12-28`), amount: d.fixed, kind: 'contrib_fixed', paid: Math.min(fixedPaid, d.fixed) },
    { what: `Взнос 1 % за ${year}`, due: workingDay(`${year + 1}-07-01`), amount: onePercent, kind: 'contrib_1pct', paid: Math.min(onePaid, onePercent) },
  );
  const today = todayMsk();
  const dueNow = items.filter((i) => i.due <= today);
  const totalPaid = r2(usnPaid + fixedPaid + onePaid);
  const accruedDue = r2(dueNow.reduce((a, i) => a + i.amount, 0));
  return {
    year,
    items: items.map((i) => ({ ...i, status: i.amount <= 0 ? 'none' : i.paid >= i.amount ? 'paid' : i.due < today ? 'overdue' : i.paid > 0 ? 'partial' : 'pending' })),
    payments: pays.filter(forThisYear),
    totalPaid,
    accruedDue,
    /** Плюс — переплата, минус — долг на сегодня (по данным программы). */
    saldo: r2(totalPaid - accruedDue),
    overpaidUsn: r2(left),
  };
}

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const rate = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Чего не хватает для декларации. */
export function missingForDeclaration(ip: IpRequisites): string[] {
  const miss: string[] = [];
  if (!/^\d{12}$/.test(ip.inn)) miss.push('ИНН (12 цифр)');
  if (!/^\d{4}$/.test(ip.ifns)) miss.push('код налоговой (4 цифры)');
  if (!/^(\d{8}|\d{11})$/.test(ip.oktmo)) miss.push('ОКТМО (8 или 11 цифр)');
  if (!ip.lastName.trim() || !ip.firstName.trim()) miss.push('фамилия и имя');
  return miss;
}

/**
 * Налоговая декларация по УСН «доходы» (КНД 1152017) в формате ФНС 5.09
 * (приказ ФНС от 26.11.2025 № ЕД-7-3/1017@, схема NO_USN_1_030_00_05_09_01).
 */
export function declarationXml(d: UsnData, correction: number, version: string): { fileName: string; data: Buffer } {
  const { ip } = d;
  const decl = usnDeclaration(d.periods, d.rateReason);
  const today = todayMsk();
  const ymd = today.replace(/-/g, '');
  const ddmmyyyy = `${today.slice(8, 10)}.${today.slice(5, 7)}.${today.slice(0, 4)}`;
  const id = `NO_USN_${ip.ifns}_${ip.ifns}_${ip.inn}_${ymd}_${crypto.randomUUID().toUpperCase()}`;
  const sums = (v: number[]) => `СумЗаКв="${Math.round(v[0])}" СумЗаПг="${Math.round(v[1])}" СумЗа9м="${Math.round(v[2])}" СумЗаНалПер="${Math.round(v[3])}"`;
  const signed = (pay: number, reduce: number) => String(pay > 0 ? pay : reduce > 0 ? -reduce : 0);
  const reason = /^(3462010|3462020|3462040)\/.{12}$/.test(decl.rateReason) ? ` КодЛьгот="${attr(decl.rateReason)}"` : '';
  const phone = ip.phone.trim() ? ` Тлф="${attr(ip.phone.trim().slice(0, 20))}"` : '';
  const xml = `<?xml version="1.0" encoding="windows-1251"?>
<Файл ИдФайл="${id}" ВерсПрог="HotelManager ${attr(version)}" ВерсФорм="5.09">
  <Документ КНД="1152017" ДатаДок="${ddmmyyyy}" Период="34" ОтчетГод="${d.year}" КодНО="${ip.ifns}" НомКорр="${correction}" ПоМесту="120">
    <СвНП${phone}>
      <НПФЛ ИННФЛ="${ip.inn}">
        <ФИО Фамилия="${attr(ip.lastName.trim())}" Имя="${attr(ip.firstName.trim())}"${ip.middleName.trim() ? ` Отчество="${attr(ip.middleName.trim())}"` : ''}/>
      </НПФЛ>
    </СвНП>
    <Подписант ПрПодп="1"/>
    <УСН ОбНал="1">
      <СумНалПУ_НП ОКТМО="${ip.oktmo}" АвПУКв="${decl.l020}" АвПУУменПг="${signed(decl.l040, decl.l050)}" АвПУУмен9м="${signed(decl.l070, decl.l080)}" НалПУУменПер="${signed(decl.l100, decl.l110)}">
        <РасчНал1 ПризНП="${decl.priz}">
          <Доход ${sums(decl.income)}/>
          <Ставка СтавкаКв="${rate(decl.rate[0])}" СтавкаПг="${rate(decl.rate[1])}" Ставка9м="${rate(decl.rate[2])}" СтавкаНалПер="${rate(decl.rate[3])}"${reason}/>
          <Исчисл ${sums(decl.tax)}/>
          <УменНал ${sums(decl.reduction)}/>
          <Стр143Разд2.1.1 ФиксРазм="${decl.l150}" ДохПрев300="${decl.l160}" РасПерТекГод="${decl.l161}" РасПерПредГод="${decl.l162}"/>
        </РасчНал1>
      </СумНалПУ_НП>
    </УСН>
  </Документ>
</Файл>
`;
  return { fileName: `${id}.xml`, data: toCp1251(xml) };
}
