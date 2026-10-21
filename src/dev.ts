/**
 * Запуск сервера для разработки: локальный PostgreSQL в каталоге .dev-data,
 * Случайные пароли находятся в .dev-data/development-secrets.json.
 *
 * PostgreSQL запускается через pg_ctl: он понижает права процесса, поэтому
 * сервер БД стартует и из консоли администратора Windows.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const root = path.resolve(import.meta.dirname, '..', '.dev-data');
fs.mkdirSync(root, { recursive: true });
const secretsFile = path.join(root, 'development-secrets.json');
if (!fs.existsSync(secretsFile)) {
  if (fs.existsSync(path.join(root, 'pg', 'PG_VERSION'))) throw new Error('Восстановите development-secrets.json для существующей dev-базы');
  fs.writeFileSync(secretsFile, JSON.stringify({ adminPassword: crypto.randomBytes(24).toString('base64url'), databasePassword: crypto.randomBytes(24).toString('base64url') }, null, 2), { mode: 0o600, flag: 'wx' });
}
const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8')) as { adminPassword: string; databasePassword: string };
const keyFile = path.join(root, 'files.key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'));

process.env.FILES_KEY ??= fs.readFileSync(keyFile, 'utf8').trim();
process.env.DATA_DIR ??= path.join(root, 'data');
process.env.ADMIN_LOGIN ??= 'admin';
process.env.ADMIN_PASSWORD ??= secrets.adminPassword;
process.env.PORT ??= '8080';
process.env.LOG_LEVEL ??= 'warn';

const pgPort = Number(process.env.DEV_PG_PORT ?? 54329);
const pgDir = path.join(root, 'pg');
const pgPkg = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const binDir = path.join(root, '..', 'node_modules', '@embedded-postgres', pgPkg, 'native', 'bin');
const exe = (name: string) => path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

if (!fs.existsSync(path.join(pgDir, 'PG_VERSION'))) {
  const pwFile = path.join(root, 'pw.tmp');
  fs.writeFileSync(pwFile, secrets.databasePassword, { mode: 0o600 });
  execFileSync(exe('initdb'), ['-D', pgDir, '-U', 'hotelmanager', '--pwfile', pwFile, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], { stdio: 'inherit' });
  fs.rmSync(pwFile);
}

const pgCtl = (args: string[]) => execFileSync(exe('pg_ctl'), ['-D', pgDir, ...args], { stdio: 'ignore' });
try {
  pgCtl(['status']);
} catch {
  pgCtl(['-o', `-p ${pgPort} -h 127.0.0.1`, '-l', path.join(root, 'pg.log'), '-w', 'start']);
}

const databaseBase = `postgres://hotelmanager:${encodeURIComponent(secrets.databasePassword)}@127.0.0.1:${pgPort}`;
const admin = postgres(`${databaseBase}/postgres`, { onnotice: () => {} });
const [exists] = await admin`select 1 from pg_database where datname = 'hotelmanager'`;
if (!exists) await admin`create database hotelmanager`;
await admin.end();
process.env.DATABASE_URL ??= `${databaseBase}/hotelmanager`;

const stop = () => {
  try {
    pgCtl(['-m', 'fast', 'stop']);
  } catch {
    /* уже остановлен */
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const { createApp } = await import('./app.js');
const app = await createApp();
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) });
console.log(`[hotelmanager] dev API: http://127.0.0.1:${process.env.PORT}. Пароль admin хранится в ${secretsFile}. Для подключения приложения настройте HTTPS.`);
