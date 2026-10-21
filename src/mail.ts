import type { SmtpSettings } from '@hotel-manager/shared';
import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { sql, writeTx } from './db.js';
import { broadcastChanged } from './notify.js';

export async function getSmtp(): Promise<SmtpSettings | null> {
  const [row] = await sql<{ value: SmtpSettings }[]>`select value from settings where key = 'smtp' and deleted_at is null`;
  const s = row?.value;
  return s?.host ? s : null;
}

export async function saveSmtp(s: SmtpSettings): Promise<void> {
  await writeTx(async (tx) => {
    const [row] = await tx<{ id: string; value: SmtpSettings }[]>`select id, value from settings where key = 'smtp'`;
    // Пустой пароль в форме означает «не менять».
    const value = { ...s, pass: s.pass || row?.value?.pass || '' };
    if (row) await tx`update settings set value = ${tx.json(value as never)} where id = ${row.id}`;
    else await tx`insert into settings (key, value) values ('smtp', ${tx.json(value as never)})`;
  });
}

/** Адрес IPv4 почтового сервера: без маршрута IPv6 (обычная домашняя сеть) соединение по IPv6 падает с ENETUNREACH. */
async function ipv4(host: string): Promise<string> {
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch {
    return host;
  }
}

function create(s: SmtpSettings, ip: string, port: number, secure: boolean) {
  return nodemailer.createTransport({
    host: ip,
    // Сертификат проверяется по имени сервера, а не по IP.
    tls: { servername: s.host },
    port,
    secure,
    // Без SSL пароль отправляется только после STARTTLS.
    requireTLS: !secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: 15_000,
  });
}

/** Подключение к почтовому серверу. Порт 465 часто закрыт провайдером — тогда пробуем 587 со STARTTLS. */
async function transport(s: SmtpSettings) {
  const ip = await ipv4(s.host);
  const t = create(s, ip, s.port, s.secure);
  if (s.port !== 465) return t;
  try {
    await t.verify();
    return t;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'ETIMEDOUT' && code !== 'ECONNREFUSED' && code !== 'ESOCKET' && code !== 'ECONNECTION') throw e;
    const alt = create(s, ip, 587, false);
    await alt.verify();
    return alt;
  }
}

/** Понятное описание ошибки почтового сервера; исходный текст остаётся в конце. */
export function explainSmtpError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const code = (e as { code?: string })?.code;
  const hint = /5\.7\.9|Application-specific password/i.test(msg)
    ? 'Нужен пароль приложения, а не обычный пароль от почты. Создайте его в настройках безопасности почтового ящика (Gmail: myaccount.google.com/apppasswords) и вставьте в поле «Пароль приложения».'
    : /535|534|Invalid login|authentication failed|Username and Password not accepted/i.test(msg)
      ? 'Почтовый сервер не принял логин или пароль. Проверьте адрес ящика и пароль приложения.'
      : code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ESOCKET' || code === 'ECONNECTION'
        ? 'Нет связи с почтовым сервером. Проверьте адрес сервера и порт (обычно 587) и подключение к интернету.'
        : code === 'EDNS' || /ENOTFOUND|getaddrinfo/.test(msg)
          ? 'Почтовый сервер с таким адресом не найден. Проверьте поле «SMTP-сервер».'
          : null;
  return hint ? `${hint} (${msg})` : msg;
}

export async function sendTestEmail(to: string): Promise<void> {
  const s = await getSmtp();
  if (!s) throw new Error('Почта не настроена');
  try {
    await (await transport(s)).sendMail({ from: s.from || s.user, to, subject: 'HotelManager: проверка почты', text: 'Почта настроена правильно.' });
  } catch (e) {
    throw new Error(explainSmtpError(e));
  }
}

let running = false;

/** Отправляет письма из очереди. Вызывается по таймеру и после новых сообщений. */
export async function processMailQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const s = await getSmtp();
    if (!s) return;
    const queue = await sql<{ id: string; to: string; subject: string | null; body: string }[]>`
      select id, "to", subject, body from messages
       where channel = 'email' and status = 'queued' and deleted_at is null
       order by created_at limit 20`;
    if (!queue.length) return;
    const t = await transport(s);
    for (const m of queue) {
      try {
        await t.sendMail({ from: s.from || s.user, to: m.to, subject: m.subject ?? '', text: m.body });
        await writeTx((tx) => tx`update messages set status = 'sent', sent_at = now(), error = null where id = ${m.id}`);
      } catch (e) {
        await writeTx((tx) => tx`update messages set status = 'failed', error = ${explainSmtpError(e).slice(0, 1000)} where id = ${m.id}`);
      }
    }
    broadcastChanged();
  } finally {
    running = false;
  }
}
