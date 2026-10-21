import crypto from 'node:crypto';
import { type IpRequisites, todayMsk, type UsnPeriod } from '@hotel-manager/shared';

/** Кодировка windows-1251 для XML ФНС (кириллица, «№», остальное — ASCII). */
export function toCp1251(s: string): Buffer {
  const out = Buffer.alloc(s.length);
  let i = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    let b: number;
    if (c < 0x80) b = c;
    else if (c >= 0x410 && c <= 0x44f) b = c - 0x410 + 0xc0;
    else if (c === 0x401) b = 0xa8;
    else if (c === 0x451) b = 0xb8;
    else if (c === 0x2116) b = 0xb9;
    else if (c === 0xab) b = 0xab;
    else if (c === 0xbb) b = 0xbb;
    else if (c === 0x2014 || c === 0x2013) b = 0x2d;
    else b = 0x3f;
    out[i++] = b;
  }
  return out.subarray(0, i);
}

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Чего не хватает в реквизитах для уведомления. */
export function missingForNotice(ip: IpRequisites): string[] {
  const miss: string[] = [];
  if (!/^\d{12}$/.test(ip.inn)) miss.push('ИНН (12 цифр)');
  if (!/^\d{4}$/.test(ip.ifns)) miss.push('код налоговой (4 цифры)');
  if (!/^(\d{8}|\d{11})$/.test(ip.oktmo)) miss.push('ОКТМО (8 или 11 цифр)');
  if (!ip.lastName.trim() || !ip.firstName.trim()) miss.push('фамилия и имя');
  return miss;
}

/**
 * Уведомление об исчисленных суммах (КНД 1110355) в формате XML ФНС
 * (приказ ЕД-7-8/1047@, формат 5.02, схема UT_UVISCHSUMNAL_1_263_00_05_02_01) для загрузки в личный кабинет ИП.
 */
export function noticeXml(ip: IpRequisites, period: UsnPeriod, kbk: string, year: number): { fileName: string; data: Buffer } {
  const today = todayMsk();
  const ymd = today.replace(/-/g, '');
  const ddmmyyyy = `${today.slice(8, 10)}.${today.slice(5, 7)}.${today.slice(0, 4)}`;
  const id = `UT_UVISCHSUMNAL_${ip.ifns}_${ip.ifns}_${ip.inn}_${ymd}_${crypto.randomUUID().toUpperCase()}`;
  const [per, num] = period.code.split('/');
  const fio = `<ФИО Фамилия="${attr(ip.lastName.trim())}" Имя="${attr(ip.firstName.trim())}"${ip.middleName.trim() ? ` Отчество="${attr(ip.middleName.trim())}"` : ''}/>`;
  const xml = `<?xml version="1.0" encoding="windows-1251"?>
<Файл ИдФайл="${id}" ВерсПрог="HotelManager 1.0" ВерсФорм="5.02">
  <Документ КНД="1110355" ДатаДок="${ddmmyyyy}" КодНО="${ip.ifns}">
    <СвНП>
      <НПИП ИННФЛ="${ip.inn}"/>
    </СвНП>
    <Подписант ПрПодп="1">
      ${fio}
    </Подписант>
    <УвИсчСумНалог ОКТМО="${ip.oktmo}" КБК="${kbk}" СумНалогАванс="${period.payable}" Период="${per}" НомерМесКварт="${num}" Год="${year}"/>
  </Документ>
</Файл>
`;
  return { fileName: `${id}.xml`, data: toCp1251(xml) };
}
