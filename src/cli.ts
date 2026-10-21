/**
 * Служебные команды сервера (запускаются внутри контейнера):
 *   node dist/cli.js set-password <логин>         — задать пароль (читается из HOTEL_MANAGER_NEW_PASSWORD или stdin)
 *   node dist/cli.js backup-report ok <байт>      — отметить успешную резервную копию
 *   node dist/cli.js backup-report fail <текст>   — отметить ошибку резервного копирования
 *   node dist/cli.js revoke-devices               — отвязать все устройства
 *   node dist/cli.js gen-key                      — сгенерировать ключ шифрования файлов
 */
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { setPassword } from './auth.js';
import { initDb, sql } from './db.js';
import { migrate } from './migrate.js';

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  if (cmd === 'gen-key') {
    console.log(crypto.randomBytes(32).toString('base64'));
    return;
  }
  initDb();
  await migrate(sql, () => {});
  switch (cmd) {
    case 'set-password': {
      const login = args[0] ?? 'admin';
      let pass = process.env.HOTEL_MANAGER_NEW_PASSWORD ?? '';
      if (!pass) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        pass = await rl.question('Новый пароль (не менее 12 символов): ');
        rl.close();
      }
      if (pass.length < 12) throw new Error('Пароль короче 12 символов');
      await setPassword(login, pass);
      console.log(`Пароль для «${login}» установлен`);
      break;
    }
    case 'backup-report': {
      const ok = args[0] === 'ok';
      await sql`
        insert into backup_status (ok, size_bytes, message)
        values (${ok}, ${ok ? Number(args[1] ?? 0) : null}, ${ok ? null : args.slice(1).join(' ') || 'Ошибка'})`;
      console.log('Записано');
      break;
    }
    case 'revoke-devices':
      await sql`update devices set revoked_at = now() where revoked_at is null`;
      console.log('Все устройства отвязаны');
      break;
    default:
      console.log('Команды: set-password, backup-report, revoke-devices, gen-key');
  }
}

main()
  .then(() => sql?.end())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await sql?.end();
    process.exit(1);
  });
