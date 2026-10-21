import path from 'node:path';
import fs from 'node:fs';

function env(name: string, fallback?: string): string {
  const file=process.env[`${name}_FILE`];
  const fromFile=file ? fs.readFileSync(file,'utf8') : undefined;
  const v = file ? (name==='ADMIN_PASSWORD'?fromFile:fromFile!.trim()) : process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Не задана переменная окружения ${name}`);
  }
  return v;
}

export const config = {
  databaseUrl: env('DATABASE_URL'),
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', '8080')),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  /** Ключ шифрования файлов: 32 байта в base64. */
  filesKey: env('FILES_KEY', ''),
  adminLogin: env('ADMIN_LOGIN', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', ''),
  firebaseServiceAccount: env('FIREBASE_SERVICE_ACCOUNT', ''),
  tessdataDir: env('TESSDATA_DIR', ''),
  appVersion: env('APP_VERSION', '1.0.0'),
  /** Срок действия токена устройства, дней (продлевается при каждой синхронизации). */
  deviceTokenDays: 90,
  /** Срок хранения удалённых записей в корзине, дней. */
  trashDays: 30,
  logLevel: env('LOG_LEVEL', 'info'),
  allowedOrigins: env('ALLOWED_ORIGINS', 'https://localhost,capacitor://localhost,null').split(',').map(value => value.trim()).filter(Boolean),
  // Only enable behind exactly one private reverse proxy with no direct API port.
  singleProxy: env('SINGLE_PRIVATE_PROXY','false')==='true',
  /** HTTPS без прокси (установка на Windows): пути к сертификату и ключу. */
  tlsCert: env('TLS_CERT', ''),
  tlsKey: env('TLS_KEY', ''),
};

export const filesDir = () => path.join(config.dataDir, 'files');
export const updatesDir = () => path.join(config.dataDir, 'updates');
