import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseMrzText, type MrzResult } from '@hotel-manager/shared';
import { config } from './config.js';

/**
 * Распознавание паспорта РФ на сервере (Tesseract, русский + английский для МЧЗ).
 * Возвращает поля, которые удалось найти; пользователь проверяет их перед сохранением.
 */

type Worker = { recognize: (img: Buffer) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };
let workerPromise: Promise<Worker> | null = null;

/** Каталог с языковыми данными: rus + eng вместе (копируются из npm-пакетов при первом запуске). */
function tessdataDir(): string {
  if (config.tessdataDir && fs.existsSync(config.tessdataDir)) return config.tessdataDir;
  const dir = path.join(config.dataDir, 'tessdata');
  fs.mkdirSync(dir, { recursive: true });
  const require = createRequire(import.meta.url);
  for (const lang of ['rus', 'eng']) {
    const target = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(target)) continue;
    const pkg = require(`@tesseract.js-data/${lang}`) as { langPath: string };
    const src = path.join(path.dirname(pkg.langPath), '4.0.0_best_int', `${lang}.traineddata.gz`);
    fs.copyFileSync(fs.existsSync(src) ? src : path.join(pkg.langPath, `${lang}.traineddata.gz`), target);
  }
  return dir;
}

async function worker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const dir = tessdataDir();
      return (await createWorker(['rus', 'eng'], 1, { langPath: dir, gzip: true, cachePath: dir })) as unknown as Worker;
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

type MrzWorker = Worker & { setParameters: (p: Record<string, string>) => Promise<unknown> };
let mrzWorkerPromise: Promise<MrzWorker> | null = null;

/** Отдельный проход для МЧЗ: английская модель и только символы A–Z, 0–9, «<». */
async function mrzWorker(): Promise<MrzWorker> {
  if (!mrzWorkerPromise) {
    mrzWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const dir = tessdataDir();
      const w = (await createWorker('eng', 1, { langPath: dir, gzip: true, cachePath: dir })) as unknown as MrzWorker;
      await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' });
      return w;
    })();
    mrzWorkerPromise.catch(() => (mrzWorkerPromise = null));
  }
  return mrzWorkerPromise;
}

export interface PassportOcr {
  mrz: MrzResult | null;
  docIssuedBy: string | null;
  docDeptCode: string | null;
  docIssueDate: string | null;
  birthPlace: string | null;
  text: string;
}

function clean(s: string): string {
  return s.replace(/[|_~]/g, ' ').replace(/\s+/g, ' ').trim();
}

function ruDate(s: string): string | null {
  const m = s.match(/(\d{2})[.\s,](\d{2})[.\s,](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function extractPassportFields(text: string): Omit<PassportOcr, 'text'> {
  const mrz = parseMrzText(text);
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const upper = lines.map((l) => l.toUpperCase());

  let docIssuedBy: string | null = null;
  const issuedIdx = upper.findIndex((l) => /ВЫДАН/.test(l));
  if (issuedIdx >= 0) {
    const parts: string[] = [];
    const first = lines[issuedIdx].replace(/.*выдан\S*/i, '').trim();
    if (first) parts.push(first);
    for (let i = issuedIdx + 1; i < Math.min(lines.length, issuedIdx + 5); i++) {
      if (/ДАТА|ВЫДАЧИ|КОД|ПОДРАЗДЕЛЕН|\d{2}\.\d{2}\.\d{4}/.test(upper[i])) break;
      parts.push(lines[i]);
    }
    docIssuedBy = parts.join(' ').replace(/[^А-ЯЁа-яё0-9.,\-\s"«»()№]/g, '').trim() || null;
  }

  const codeMatch = text.match(/(\d{3})\s?[-–—]\s?(\d{3})/);
  const docDeptCode = mrz?.docDeptCode || (codeMatch ? `${codeMatch[1]}-${codeMatch[2]}` : null);

  let docIssueDate: string | null = mrz?.docIssueDate ?? null;
  if (!docIssueDate) {
    const idx = upper.findIndex((l) => /ДАТА ВЫДАЧИ/.test(l));
    if (idx >= 0) docIssueDate = ruDate(lines.slice(idx, idx + 2).join(' '));
  }

  let birthPlace: string | null = null;
  const bpIdx = upper.findIndex((l) => /МЕСТО\s*РОЖД/.test(l));
  if (bpIdx >= 0) {
    const parts: string[] = [];
    const first = lines[bpIdx].replace(/.*рожд\S*/i, '').trim();
    if (first) parts.push(first);
    for (let i = bpIdx + 1; i < Math.min(lines.length, bpIdx + 4); i++) {
      if (/<|PNRUS|ЛИЧНЫЙ|ПОДПИСЬ/.test(upper[i])) break;
      parts.push(lines[i]);
    }
    birthPlace = parts.join(' ').replace(/[^А-ЯЁа-яё0-9.,\-\s]/g, '').trim() || null;
  }

  return { mrz, docIssuedBy, docDeptCode, docIssueDate, birthPlace };
}

/**
 * Текст с фото наклейки (серийный номер, модель). Кандидаты — строки после «S/N», «Serial», «Серийный»
 * и длинные сочетания латиницы с цифрами; пользователь выбирает нужный.
 */
export async function recognizeLabel(image: Buffer): Promise<{ text: string; candidates: string[] }> {
  const w = await worker();
  const { data } = await w.recognize(image);
  const text = data.text ?? '';
  const out: string[] = [];
  const add = (v: string) => {
    const s = v.replace(/[^A-Za-z0-9\-/.]/g, '').replace(/^[-/.]+|[-/.]+$/g, '');
    if (s.length >= 5 && /\d/.test(s) && !out.includes(s)) out.push(s);
  };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/(?:S\/?N|SN|SERIAL(?:\s*(?:NO|NUMBER))?|СЕР(?:ИЙНЫЙ)?\.?\s*(?:№|НОМЕР)?)\s*[:.#№]?\s*([A-Za-z0-9][A-Za-z0-9\-/. ]{3,})/i);
    if (m) add(m[1].split(/\s{2,}/)[0].replace(/\s+/g, ''));
  }
  for (const tok of text.match(/\b[A-Z0-9][A-Z0-9\-]{6,}\b/g) ?? []) if (/[A-Z]/.test(tok) && /\d/.test(tok)) add(tok);
  return { text, candidates: out.slice(0, 6) };
}

export async function recognizePassport(image: Buffer): Promise<PassportOcr> {
  const w = await worker();
  const { data } = await w.recognize(image);
  const fields = extractPassportFields(data.text);
  if (!fields.mrz) {
    const m = await mrzWorker();
    const { data: mrzData } = await m.recognize(image);
    const mrz = parseMrzText(mrzData.text);
    if (mrz) {
      fields.mrz = mrz;
      fields.docDeptCode = mrz.docDeptCode || fields.docDeptCode;
      fields.docIssueDate = mrz.docIssueDate ?? fields.docIssueDate;
    }
  }
  return { ...fields, text: data.text };
}
