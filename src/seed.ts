import { DEFAULT_HOTEL, DEFAULT_RETENTION, DEFAULT_TEMPLATES } from '@hotel-manager/shared';
import { writeTx } from './db.js';

/** Общие справочники. Структуру гостиницы и рабочие данные создаёт владелец. */
export async function seed(log: (m: string) => void): Promise<void> {
  await writeTx(async (tx) => {
    const [exists] = await tx`select 1 from settings where key = 'hotel'`;
    if (exists) return;
    log('Создание начальных справочников');

    await tx`insert into settings (key, value) values ('hotel', ${tx.json(DEFAULT_HOTEL as never)})`;
    await tx`insert into settings (key, value) values ('retention', ${tx.json(DEFAULT_RETENTION as never)})`;

    const lists: [string, string[]][] = [
      ['payment_methods', ['Наличные', 'Карта', 'Перевод', 'СБП']],
      ['booking_sources', ['Телефон', 'Авито', 'Сайт', 'Повторный гость', 'Знакомые', 'Прочее']],
      ['expense_categories', ['Коммунальные платежи', 'Ремонт', 'Хозтовары', 'Продукты', 'Зарплата', 'Налоги', 'Основные средства', 'Прочее']],
      ['asset_categories', ['Мебель', 'Техника', 'Текстиль', 'Посуда', 'Прочее']],
    ];
    for (const [table, names] of lists) {
      for (const [i, name] of names.entries()) await tx`insert into ${tx(table)} (name, sort_order) values (${name}, ${i + 1})`;
    }

    for (const [i, t] of DEFAULT_TEMPLATES.entries()) {
      await tx`insert into message_templates (name, subject, body, sort_order) values (${t.name}, ${t.subject}, ${t.body}, ${i + 1})`;
    }
  });
}
