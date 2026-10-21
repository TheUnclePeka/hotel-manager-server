import postgres from 'postgres';
import { config } from './config.js';

/** Преобразует значение timestamptz из PostgreSQL ('2026-10-05 16:43:25.123+00') в ISO-строку. */
function parseTimestamp(x: string): string {
  return new Date(x.replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString();
}

export function createSql(url = config.databaseUrl) {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    connection: { TimeZone: 'UTC' },
    transform: postgres.camel,
    types: {
      // date → строка YYYY-MM-DD
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      // timestamptz → ISO
      timestamptz: { to: 1184, from: [1184], serialize: (x: string | Date) => (x instanceof Date ? x.toISOString() : x), parse: parseTimestamp },
      // numeric → number
      numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      // bigint → number (версии и счётчики не превышают 2^53)
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
}

export type Sql = ReturnType<typeof createSql>;
export type Tx = postgres.TransactionSql<Record<string, never>>;

export let sql: Sql;

export function initDb(url?: string): Sql {
  sql = createSql(url);
  return sql;
}

/** Ключ глобальной блокировки записи: все изменения выполняются последовательно. */
export const WRITE_LOCK = 7001;

/**
 * Транзакция записи. Глобальная блокировка гарантирует, что при чтении изменений (pull)
 * нет незавершённых транзакций с меньшими номерами версий.
 */
export async function writeTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${WRITE_LOCK})`;
    return fn(tx as unknown as Tx);
  }) as Promise<T>;
}

export async function readTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin('isolation level repeatable read', async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(${WRITE_LOCK})`;
    return fn(tx as unknown as Tx);
  }) as Promise<T>;
}
