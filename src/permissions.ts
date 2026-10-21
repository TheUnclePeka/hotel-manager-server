import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Op } from '@hotel-manager/shared';
import type { Tx } from './db.js';

export type Role = 'owner' | 'manager' | 'reception' | 'viewer';
const frontRead = new Set(['floors','roomCategories','rooms','roomClosures','seasons','priceRules','bookingTags','bookingSources','paymentMethods','services','guests','bookings','stays','charges','payments','deposits','waitlist','messageTemplates']);
const frontWrite = new Set(['guests','guestDocs','bookings','stays','charges','payments','deposits','waitlist','files']);
const frontSettings = new Set(['hotel','pricing','loyalty','touristTax']);
export const fullDomain = (role: Role) => role === 'owner' || role === 'manager';
export const canReadEntity = (role: Role, entity: string) => fullDomain(role) || frontRead.has(entity) || entity === 'settings' || (role === 'reception' && ['guestDocs','files'].includes(entity));
export function canReadRow(role: Role, entity: string, row: Record<string, unknown>): boolean {
  if (!canReadEntity(role, entity)) return false;
  if (fullDomain(role)) return true;
  if (entity === 'settings') return frontSettings.has(String(row.key));
  if (entity === 'files') return ['guest','booking'].includes(String(row.ownerType));
  return true;
}
export class PermissionError extends Error { constructor() { super('Недостаточно прав для этой операции'); } }

// Authorization precedes the duplicate-operation lookup, so an op ID cannot be used to read a forbidden row.
export async function authorizeOperation(tx: Tx, op: Op, deviceId: string | null): Promise<void> {
  if (!deviceId) return; // Explicit internal jobs/imports, never a client-supplied value.
  const [account] = await tx<{ role: Role }[]>`
    select u.role from devices d join users u on u.id=d.user_id
    where d.id=${deviceId} and d.revoked_at is null and d.expires_at>now()
    and d.access_expires_at>now() and u.disabled_at is null and d.auth_version=u.auth_version`;
  if (!account) throw new PermissionError();
  if (account.role === 'owner') return;
  // Global/security-sensitive settings are owner-only, even for managers.
  if (account.role === 'manager' && op.entity !== 'settings') return;
  if (account.role !== 'reception' || !frontWrite.has(op.entity) || ['delete','restore','action'].includes(op.kind)) throw new PermissionError();
  if (op.entity === 'files') {
    const [existing] = await tx`select owner_type from files where id=${op.id}`;
    if (existing && !['guest','booking'].includes(String(existing.ownerType))) throw new PermissionError();
    if (op.data?.ownerType !== undefined && !['guest','booking'].includes(String(op.data.ownerType))) throw new PermissionError();
    if (!existing && !['guest','booking'].includes(String(op.data?.ownerType))) throw new PermissionError();
  }
}

export async function authorizeRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const role = req.device.role;
  if (role === 'owner') return;
  const route = req.routeOptions.url ?? '';
  if (role === 'manager') {
    if (!/^\/api\/(settings\/smtp|server\/|backups|updates\/file|import\/)/.test(route)) return;
  } else {
    if (['/api/sync/pull','/api/sync/push','/api/events','/api/updates/latest'].includes(route)) return;
    if (route.startsWith('/api/entities/')) {
      const entity = (req.params as {entity: string}).entity;
      if (canReadEntity(role, entity)) return;
    }
    if (req.method === 'GET' && ['/api/bookings','/api/bookings/:id/full','/api/families','/api/guests/:id/visits'].includes(route)) return;
    if (role === 'reception' && ['/api/guests/:id/full','/api/search','/api/files','/api/files/:id','/api/ocr/passport'].includes(route)) return;
  }
  reply.code(403).send({ error: 'Недостаточно прав' });
}
