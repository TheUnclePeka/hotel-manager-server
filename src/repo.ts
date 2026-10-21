import { ENTITIES, type EntityName, entityFields } from '@hotel-manager/shared';
import type { Tx } from './db.js';

export type AnyRow = Record<string, unknown> & { id: string; version: number; deletedAt: string | null };

/** Поля, которые не являются колонками таблицы. */
const VIRTUAL_FIELDS: Partial<Record<EntityName, string[]>> = {
  files: ['dataBase64'],
};

export function columnsOf(entity: EntityName): string[] {
  const virtual = VIRTUAL_FIELDS[entity] ?? [];
  return entityFields(entity).filter((f) => !virtual.includes(f));
}

function prepare(tx: Tx, entity: EntityName, data: Record<string, unknown>): Record<string, unknown> {
  const meta = ENTITIES[entity];
  const cols = new Set(columnsOf(entity));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!cols.has(k) || v === undefined) continue;
    out[k] = meta.json?.includes(k) && v !== null ? tx.json(v as never) : v;
  }
  return out;
}

export async function getRow(tx: Tx, entity: EntityName, id: string): Promise<AnyRow | undefined> {
  const [row] = await tx<AnyRow[]>`select * from ${tx(ENTITIES[entity].table)} where id = ${id}`;
  return row;
}

export async function insertRow(tx: Tx, entity: EntityName, id: string, data: Record<string, unknown>): Promise<AnyRow> {
  const values = { id, ...prepare(tx, entity, data) };
  const [row] = await tx<AnyRow[]>`insert into ${tx(ENTITIES[entity].table)} ${tx(values)} returning *`;
  return row;
}

export async function updateRow(tx: Tx, entity: EntityName, id: string, patch: Record<string, unknown>): Promise<AnyRow> {
  const values = prepare(tx, entity, patch);
  if (Object.keys(values).length === 0) {
    // Пустое изменение всё равно поднимает версию — клиент получит актуальную строку.
    const [row] = await tx<AnyRow[]>`update ${tx(ENTITIES[entity].table)} set updated_at = now() where id = ${id} returning *`;
    return row;
  }
  const [row] = await tx<AnyRow[]>`update ${tx(ENTITIES[entity].table)} set ${tx(values)} where id = ${id} returning *`;
  return row;
}

export async function softDelete(tx: Tx, entity: EntityName, id: string): Promise<AnyRow | undefined> {
  const [row] = await tx<AnyRow[]>`
    update ${tx(ENTITIES[entity].table)} set deleted_at = now() where id = ${id} and deleted_at is null returning *`;
  return row;
}

export async function restoreRow(tx: Tx, entity: EntityName, id: string): Promise<AnyRow | undefined> {
  const [row] = await tx<AnyRow[]>`
    update ${tx(ENTITIES[entity].table)} set deleted_at = null where id = ${id} returning *`;
  return row;
}

/** Разница между строками для журнала изменений. */
export function diff(before: Record<string, unknown> | undefined, after: Record<string, unknown>, fields: string[]): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const f of fields) {
    const a = before?.[f] ?? null;
    const b = after[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = [a, b];
  }
  return out;
}

export interface AuditCtx {
  deviceId: string | null;
  deviceName: string | null;
}

export async function audit(
  tx: Tx,
  ctx: AuditCtx,
  op: string,
  entity: string,
  entityId: string | null,
  label: string | null,
  changes: Record<string, unknown> | null,
): Promise<void> {
  await tx`
    insert into audit_log (device_id, user_id, device_name, op, entity, entity_id, label, changes)
    values (${ctx.deviceId}, (select user_id from devices where id=${ctx.deviceId}), ${ctx.deviceName}, ${op}, ${entity}, ${entityId}, ${label}, ${changes ? tx.json(changes as never) : null})`;
}
