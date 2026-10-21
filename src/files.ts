import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, filesDir } from './config.js';

/**
 * Хранилище файлов (сканы документов, фото, чеки).
 * Каждый файл шифруется AES-256-GCM: [12 байт IV][16 байт тег][шифротекст].
 */

function key(): Buffer {
  if (!config.filesKey) throw new Error('Не задан FILES_KEY — ключ шифрования файлов');
  const k = Buffer.from(config.filesKey, 'base64');
  if (k.length !== 32) throw new Error('FILES_KEY должен содержать 32 байта в base64');
  return k;
}

function filePath(id: string): string {
  return path.join(filesDir(), id.slice(0, 2), `${id}.bin`);
}

export async function saveFile(id: string, data: Buffer): Promise<void> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const p = filePath(id);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

export async function readFile(id: string): Promise<Buffer> {
  const buf = await fs.readFile(filePath(id));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

export async function removeFile(id: string): Promise<void> {
  await fs.rm(filePath(id), { force: true });
}

export function checkFilesKey(): void {
  key();
}
