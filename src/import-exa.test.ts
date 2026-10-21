import { describe, expect, it } from 'vitest';
import { exaUuid, isLivingLine, parseRoomName, replay } from './import-exa.js';

describe('импорт ExaHotelFree', () => {
  it('номер и категория из названия', () => {
    expect(parseRoomName('1. 2-х', '2-х местный, балкон')).toEqual({ number: '1', category: '2-местный', isService: false });
    expect(parseRoomName('10. 2-х (Тех)', '2-х местный')).toEqual({ number: '10', category: '2-местный', isService: true });
    expect(parseRoomName('15 Люкс', '')).toMatchObject({ number: '15', category: 'Люкс' });
    expect(parseRoomName('7. 4-х', '')).toMatchObject({ category: '4-местный' });
  });

  it('строки проживания и доп. услуги', () => {
    for (const n of ['Проживание', '1 номер', '№12', '2500-3x', '8-й', '12']) expect(isLivingLine(n)).toBe(true);
    for (const n of ['Вода', 'Пиво', 'Вино', 'До вечера']) expect(isLivingLine(n)).toBe(false);
  });

  it('идентификаторы детерминированы (повторный импорт обновляет те же записи)', () => {
    expect(exaUuid('order', 'abc')).toBe(exaUuid('order', 'abc'));
    expect(exaUuid('order', 'abc')).not.toBe(exaUuid('stay', 'abc'));
    expect(exaUuid('order', 'abc')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('журнал применяется поверх снимка; оплаты получают даты операций', () => {
    const { tables, payments, snapshotReceived } = replay({
      tables: {
        Orders: [{ ID: 'o1', Price: '5000', PriceReceived: '1000', DateFrom: '2026.06.01', DateTo: '2026.06.03', RoomID: 'r1', State: '0' }],
        Clients: [
          { ID: 'c1', Name: 'Старое Имя', ActualFrom: '2024.01.01' },
          { ID: 'c1', Name: 'Новое Имя', ActualFrom: '2025.01.01' },
        ],
      },
      journal: [
        [
          { tag: 'Orders.Edit', a: { ID: 'o1', 'PriceReceived.Difference': '1500' } },
          { tag: 'Log.Add', a: { ID: 'l1', Date: '2026.06.01' } },
        ],
        [
          { tag: 'Orders.Edit', a: { ID: 'o1', PriceReceived: '5000', State: '4' } },
          { tag: 'Log.Add', a: { ID: 'l2', Date: '2026.06.03' } },
        ],
        [
          { tag: 'Orders.Add', a: { ID: 'o2', Price: '100', DateFrom: '2026.07.01', DateTo: '2026.07.02', RoomID: 'r1' } },
          { tag: 'Orders.Delete', a: { ID: 'o2' } },
          { tag: 'Log.Add', a: { ID: 'l3', Date: '2026.06.04' } },
        ],
      ],
    });
    expect(tables.Clients.get('c1')!.Name).toBe('Новое Имя');
    expect(tables.Orders.get('o1')).toMatchObject({ PriceReceived: '5000', State: '4' });
    expect(tables.Orders.has('o2')).toBe(false);
    expect(snapshotReceived.get('o1')).toBe(1000);
    expect(payments).toEqual([
      { orderId: 'o1', date: '2026-06-01', amount: 1500 },
      { orderId: 'o1', date: '2026-06-03', amount: 2500 },
    ]);
  });
});
