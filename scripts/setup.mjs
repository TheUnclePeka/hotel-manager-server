import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {generateDeployment,interfaces} from './deployment.mjs';

const token=crypto.randomBytes(32).toString('base64url');
const endpoint='/setup/'+token;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let installed=null,busy=false,status='',origin='';
const docker=spawnSync('docker',['compose','version'],{encoding:'utf8',windowsHide:true}).status===0;
function page(content) {return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Установка Hotel Manager</title><style>body{font:17px system-ui;background:#f3f6f6;color:#19383e;margin:0}main{max-width:760px;margin:40px auto;padding:32px;background:white;border-radius:18px}label{display:block;margin:20px 0 8px}input,select,button{font:inherit;padding:12px;border:1px solid #a5babc;border-radius:8px;box-sizing:border-box;max-width:100%}input,select{width:100%}button{background:#126d76;color:white;margin-top:24px;cursor:pointer}small{display:block;color:#52686c;line-height:1.5}p,li{line-height:1.55}.note{padding:16px;background:#eaf3f2;border-radius:8px}a{color:#126d76}</style><main><h1>Hotel Manager</h1>${content}</main></html>`;}
function form(){return page(`<p>Этот мастер создаст отдельную установку гостиницы. Сервер работает в Docker, одинаково на Linux и Windows. Данные и секреты хранятся отдельно от публичного репозитория.</p>
${!docker?'<p class="note">Docker Compose пока не найден. Установите Docker Engine с Compose на Linux или Docker Desktop с Linux-контейнерами на Windows. Сейчас можно подготовить конфигурацию; запустить сервер получится после установки Docker.</p>':''}
<form method="post" action="${endpoint}/create"><label for="mode">Как будут подключаться устройства?</label><select id="mode" name="mode"><option value="lan">Только локальная сеть гостиницы</option><option value="vpn">Локально и через VPN из интернета</option><option value="public">Напрямую через интернет — домен и HTTPS</option></select>
<small>Локальная сеть: не требуется интернет после установки. VPN: подходит при CGNAT и закрытых входящих портах; сначала установите VPN на сервер и устройства (например, Tailscale или WireGuard). Прямой доступ: нужен домен, публичный IP и доступный TCP 443. VPN не открывает порт приложения всему интернету.</small>
<label for="host">Имя сервера или IPv4-адрес</label><input id="host" name="host" required placeholder="192.168.1.20 или hotel.example.org" autocomplete="off"><small>Для локальной сети закрепите адрес сервера в роутере. Для VPN укажите адрес VPN. Для интернета — домен, направленный на публичный адрес сервера. Без https://, пути и порта.</small>
<label for="bind">На каком сетевом адресе принимать подключения?</label><select id="bind" name="bind">${interfaces().map(ip=>`<option>${escape(ip)}</option>`).join('')}<option value="0.0.0.0">Все интерфейсы (только прямой интернет)</option></select><small>Для VPN выберите адрес VPN, для локальной сети — адрес гостиничной сети. Мастер не меняет брандмауэр и не открывает порты роутера. Разрешите TCP 443 только из выбранной сети; для публичного режима — входящий 443.</small>
<label for="email">Email для публичного HTTPS-сертификата</label><input id="email" name="email" type="email"><small>Нужен только для прямого интернета. Caddy получает и продлевает сертификат автоматически. Для LAN/VPN мастер создаёт отдельный локальный сертификат и файл доверия.</small>
<label for="login">Логин владельца</label><input id="login" name="login" value="owner" required pattern="[a-zA-Z0-9._@-]+" maxlength="100" autocomplete="username">
<label for="password">Пароль владельца</label><input id="password" name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password"><small>Придумайте уникальную парольную фразу от 12 символов. Сотрудникам вы создадите отдельные аккаунты.</small>
<label for="directory">Новая папка установки</label><input id="directory" name="directory" required value="${escape(path.join(os.homedir(),'HotelManagerServer'))}"><small>Папка не должна существовать. В ней будут закрытые настройки; Docker хранит базу и вложения в отдельных томах. Для нескольких гостиниц используйте отдельные папки и сетевые адреса.</small>
<button>Создать установку</button></form>`);}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if(req.headers.host!==new URL(origin).host || !req.url?.startsWith(endpoint) || (req.method==='POST'&&req.headers.origin!==origin)) {res.writeHead(403);res.end('Доступ запрещён');return;}
  try {
    if(req.method==='GET'&&req.url===endpoint) {
      if(!installed) return res.end(form());
      return res.end(page(`<h2>Установка подготовлена</h2><p>Папка: ${escape(installed.directory)}</p><p>Адрес: ${escape(installed.serverUrl)}</p><p class="note">${escape(status||'Нажмите «Запустить сервер», чтобы собрать контейнер и запустить службы.')}</p><ol><li>Дождитесь завершения запуска. Для публичного режима должны быть настроены DNS и доступ к TCP 443.</li><li>Передайте connection.json из папки установки на первое устройство. В приложении выберите «QR или файл», подтвердите адрес и отпечаток.</li><li>Войдите с логином и паролем, заданными в мастере. В настройках создайте сотрудников и приглашения.</li></ol><form method="post" action="${endpoint}/start"><button ${busy?'disabled':''}>Запустить сервер</button></form><p><a href="${endpoint}">Обновить статус</a></p><p>Контейнеры перезапускаются вместе с Docker. На Windows включите автозапуск Docker Desktop; он зависит от входа пользователя в систему. Для сервера без интерактивного входа используйте Linux. Мастер можно закрыть сочетанием Ctrl+C.</p>`));
    }
    if(req.method==='POST'&&req.url===endpoint+'/create') {
      if(installed||busy) throw new Error('Установка уже подготовлена или выполняется');
      let body='';for await(const chunk of req){body+=chunk;if(body.length>16000)throw new Error('Слишком большой запрос');}
      busy=true;
      try {installed=await generateDeployment(Object.fromEntries(new URLSearchParams(body)));} finally {busy=false;}
    } else if(req.method==='POST'&&req.url===endpoint+'/start') {
      if(!installed||busy) throw new Error('Дождитесь завершения текущего действия');
      busy=true;status='Сборка и запуск выполняются. Это может занять несколько минут. Журнал: install.log в папке установки.';
      const log=fs.openSync(path.join(installed.directory,'install.log'),'a',0o600);
      const child=spawn('docker',['compose','-f','compose.json','up','-d','--build','--wait','--wait-timeout','180'],{cwd:installed.directory,stdio:['ignore',log,log],windowsHide:true});
      const done=(message)=>{busy=false;status=message;fs.closeSync(log);};
      child.once('error',()=>done('Не удалось запустить Docker. Установите и запустите Docker с Compose; затем повторите.'));
      child.once('exit',code=>done(code===0?'Контейнеры запущены. Проверьте подключение из приложения. HTTPS-сертификат публичного домена может выпускаться ещё несколько минут.':'Запуск завершился ошибкой. Проверьте install.log, Docker, свободный TCP 443 и доступ к интернету. Конфигурация и данные сохранены.'));
    } else {res.writeHead(404);return res.end('Не найдено');}
    res.writeHead(303,{Location:endpoint});res.end();
  } catch(e){res.writeHead(400);res.end(page(`<h2>Не удалось выполнить действие</h2><p>${escape(e.message)}</p><a href="${endpoint}">Вернуться</a>`));}
});
server.listen(0,'127.0.0.1',()=>{
  origin=`http://127.0.0.1:${server.address().port}`;
  console.log(`Откройте мастер на этом компьютере: ${origin}${endpoint}`);
  if(process.platform==='win32'&&!process.argv.includes('--no-open')) spawn('rundll32.exe',['url.dll,FileProtocolHandler',origin+endpoint],{stdio:'ignore',windowsHide:true}).on('error',()=>{});
});
