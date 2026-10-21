import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { sql } from './db.js';
import { tokenHash } from './auth.js';
import type { ServerEvent } from './sync/push.js';

/**
 * Серверные уведомления:
 *  - SSE-поток /api/events для запущенных программ (ПК и Android на переднем плане):
 *    «changed» — данные изменились, пора синхронизироваться; «notify» — показать уведомление;
 *  - Firebase Cloud Messaging для Android (доходит, даже когда приложение закрыто).
 */

interface Client {
  deviceId: string;
  accessHash: string;
  close: () => void;
  write: (s: string) => void;
}

const clients = new Set<Client>();

type Messaging = { send: (msg: unknown) => Promise<string> };
let messaging: Messaging | null = null;
let fcmInit = false;

async function fcm(): Promise<Messaging | null> {
  if (fcmInit) return messaging;
  fcmInit = true;
  if (!config.firebaseServiceAccount || !fs.existsSync(config.firebaseServiceAccount)) return null;
  try {
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    const app = initializeApp({ credential: cert(JSON.parse(fs.readFileSync(config.firebaseServiceAccount, 'utf8'))) });
    messaging = getMessaging(app) as unknown as Messaging;
  } catch (e) {
    console.error('Firebase не инициализирован:', e);
  }
  return messaging;
}

export function fcmEnabled(): boolean {
  return Boolean(config.firebaseServiceAccount && fs.existsSync(config.firebaseServiceAccount));
}

/** Сообщить всем подключённым устройствам, что данные изменились. */
export function broadcastChanged(exceptDeviceId?: string): void {
  void liveClients().then(live => {
    for (const c of live) if (c.deviceId !== exceptDeviceId) c.write(`event: changed\ndata: {}\n\n`);
  }).catch(() => { for (const c of clients) c.close(); });
}

async function liveClients(): Promise<Client[]> {
  if (!clients.size) return [];
  const allowed = await sql<{tokenHash:string}[]>`select d.token_hash from devices d join users u on u.id=d.user_id
    where d.token_hash in ${sql([...clients].map(c=>c.accessHash))} and d.revoked_at is null and d.expires_at>now()
    and d.access_expires_at>now() and u.disabled_at is null and d.auth_version=u.auth_version`;
  const hashes = new Set(allowed.map(row=>row.tokenHash));
  const live:Client[]=[];
  for (const c of clients) { if(hashes.has(c.accessHash)) live.push(c); else c.close(); }
  return live;
}

/** Отправить уведомление на все устройства, где это событие включено. */
export async function notifyAll(ev: ServerEvent): Promise<void> {
  if (!ev.title) return;
  const devices = await sql<{ id: string; fcmToken: string | null; prefs: Record<string, boolean> }[]>`
    select d.id, d.fcm_token, d.prefs from devices d join users u on u.id=d.user_id
      where d.revoked_at is null and d.expires_at > now() and u.disabled_at is null and d.auth_version=u.auth_version`;
  const online = new Set<string>();
  const publicNotice = {title:'Hotel Manager',body:'Есть обновления. Откройте приложение.',event:ev.event};
  for (const c of await liveClients()) {
    const d = devices.find((x) => x.id === c.deviceId);
    if (d && d.prefs?.[ev.event] === false) continue;
    c.write(`event: notify\ndata: ${JSON.stringify(publicNotice)}\n\n`);
    online.add(c.deviceId);
  }
  const m = await fcm();
  if (!m) return;
  for (const d of devices) {
    if (!d.fcmToken || online.has(d.id) || d.prefs?.[ev.event] === false) continue;
    try {
      await m.send({
        token: d.fcmToken,
        notification: { title: publicNotice.title, body: publicNotice.body },
        android: { priority: 'high', notification: { channelId: 'server', icon: 'ic_stat_notify' } },
        data: { event: ev.event },
      });
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        await sql`update devices set fcm_token = null where id = ${d.id}`;
      } else {
        console.error('FCM:', e);
      }
    }
  }
}

/** Отправляет уведомление один раз на ключ (например, «гарантия ИН-000012»). */
export async function notifyOnce(key: string, ev: ServerEvent): Promise<void> {
  const [ins] = await sql`insert into notify_log (key) values (${key}) on conflict do nothing returning key`;
  if (ins) await notifyAll(ev);
}

export function registerEventsRoute(app: FastifyInstance): void {
  app.get('/api/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const client: Client = { deviceId: req.device.id, accessHash:tokenHash(req.headers.authorization!.slice(7)), close:()=>reply.raw.end(), write: (s) => reply.raw.write(s) };
    clients.add(client);
    client.write(`event: hello\ndata: {}\n\n`);
    const ping = setInterval(() => { void liveClients().then(live=>{if(live.includes(client)) client.write(`: ping\n\n`);}).catch(()=>client.close()); }, 25_000);
    reply.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
  });
}
