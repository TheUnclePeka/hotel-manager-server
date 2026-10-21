import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import selfsigned from 'selfsigned';

const source=path.resolve(import.meta.dirname,'..');
const secret=()=>crypto.randomBytes(32).toString('base64url');
export function interfaces() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter(i=>i?.family==='IPv4').map(i=>i.address))];
}
export function validate(input) {
  const {mode,host,bind,login,password}=input;
  if(!['lan','vpn','public'].includes(mode)) throw new Error('Выберите способ подключения');
  if(typeof login!=='string'||! /^[a-zA-Z0-9._@-]{1,100}$/.test(login)) throw new Error('Логин: латиница, цифры, точка, дефис или @');
  if(typeof password!=='string'||password.length<12||password.length>200) throw new Error('Пароль: от 12 до 200 символов');
  if(typeof host!=='string'||host.length>253||!(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))||host.includes('..')) throw new Error('Укажите имя сервера или IPv4-адрес без https:// и порта');
  if(!net.isIPv4(bind)||(!interfaces().includes(bind)&&!(mode==='public'&&bind==='0.0.0.0'))) throw new Error('Адрес прослушивания должен принадлежать этому компьютеру');
  if(mode==='public'&&(net.isIP(host)||!host.includes('.')||host.endsWith('.local'))) throw new Error('Для прямого интернета нужен публичный домен');
  if(mode!=='public'&&bind==='0.0.0.0') throw new Error('Выберите конкретный интерфейс локальной сети или VPN');
  if(mode==='public'&&(typeof input.email!=='string'||!/^[\w.+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(input.email))) throw new Error('Укажите email для сертификата');
  return {...input,login:login.toLowerCase(),host:host.toLowerCase()};
}

async function protect(directory) {
  if(process.platform==='win32') {
    const user=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
    const sid=user.match(/S-1-5-[\d-]+/)?.[0];
    if(!sid) throw new Error('Не удалось определить владельца каталога');
    execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{stdio:'ignore',windowsHide:true});
  } else await fs.chmod(directory,0o700);
}

export async function generateDeployment(raw) {
  const input=validate(raw);
  const destination=path.resolve(input.directory);
  await fs.mkdir(destination,{mode:0o700}); // Never overwrite an existing installation.
  await protect(destination);
  for(const directory of ['secrets','certs','app']) await fs.mkdir(path.join(destination,directory),{mode:0o700});
  const write=(name,value)=>fs.writeFile(path.join(destination,name),value,{mode:0o600,flag:'wx'});
  const dbPassword=secret(),rootPassword=secret();
  await write('secrets/database-password',rootPassword);
  await write('secrets/database-url',`postgres://hotelmanager:${dbPassword}@db:5432/hotelmanager`);
  await write('secrets/files-key',crypto.randomBytes(32).toString('base64'));
  await write('secrets/owner-password',input.password);
  await write('secrets/init.sql',`CREATE ROLE hotelmanager LOGIN PASSWORD '${dbPassword}';\nALTER DATABASE hotelmanager OWNER TO hotelmanager;\n`);
  // Parent directories stay 0700; Docker bind-mounted secret files must be readable by the non-root container users.
  if(process.platform!=='win32') for(const name of await fs.readdir(path.join(destination,'secrets'))) await fs.chmod(path.join(destination,'secrets',name),0o444);
  let fingerprint;
  if(input.mode!=='public') {
    const cert=await selfsigned.generate([{name:'commonName',value:input.host}],{
      keyType:'ec',curve:'P-256',algorithm:'sha256',notBeforeDate:new Date(Date.now()-60000),notAfterDate:new Date(Date.now()+365*86400000),
      extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[net.isIP(input.host)?{type:7,ip:input.host}:{type:2,value:input.host}]}],
    });
    await write('certs/server.crt',cert.cert);await write('certs/server.key',cert.private);
    fingerprint=crypto.createHash('sha256').update(new crypto.X509Certificate(cert.cert).raw).digest('hex');
  }
  const compose={name:'hotelmanager-'+crypto.randomBytes(6).toString('hex'),services:{
    db:{image:'postgres:18-bookworm',restart:'unless-stopped',environment:{POSTGRES_DB:'hotelmanager',POSTGRES_PASSWORD_FILE:'/run/secrets/database_password'},secrets:['database_password'],volumes:['database:/var/lib/postgresql','./secrets/init.sql:/docker-entrypoint-initdb.d/01-account.sql:ro'],healthcheck:{test:['CMD','pg_isready','-h','127.0.0.1','-U','postgres','-d','hotelmanager'],interval:'5s',timeout:'3s',retries:30},networks:['backend']},
    api:{build:'./app',restart:'unless-stopped',init:true,depends_on:{db:{condition:'service_healthy'}},environment:{DATABASE_URL_FILE:'/run/secrets/database_url',FILES_KEY_FILE:'/run/secrets/files_key',ADMIN_PASSWORD_FILE:'/run/secrets/owner_password',ADMIN_LOGIN:input.login,SINGLE_PRIVATE_PROXY:'true',APP_VERSION:'0.2.0'},secrets:['database_url','files_key','owner_password'],volumes:['files:/app/data'],networks:['backend','edge'],healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'10s',timeout:'5s',retries:18,start_period:'30s'},security_opt:['no-new-privileges:true'],cap_drop:['ALL']},
    https:{image:'caddy:2',restart:'unless-stopped',depends_on:['api'],ports:[`${input.bind}:443:443`],volumes:['./Caddyfile:/etc/caddy/Caddyfile:ro','./certs:/certs:ro','certificates:/data','caddy_config:/config'],networks:['backend','edge']},
  },networks:{backend:{internal:true},edge:{}},volumes:{database:{},files:{},certificates:{},caddy_config:{}},secrets:Object.fromEntries(['database_password','database_url','files_key','owner_password'].map(key=>[key,{file:'./secrets/'+key.replaceAll('_','-')}]))};
  await write('compose.json',JSON.stringify(compose,null,2)+'\n');
  const tls=input.mode==='public'?`tls ${input.email}`:'tls /certs/server.crt /certs/server.key';
  await write('Caddyfile',`{\n auto_https disable_redirects\n}\nhttps://${input.host} {\n ${tls}\n reverse_proxy api:8080\n}\n`);
  const profile={serverUrl:`https://${input.host}`,...(fingerprint?{certificateSha256:fingerprint}:{})};
  await write('connection.json',JSON.stringify(profile,null,2)+'\n');
  await write('installation.json',JSON.stringify({mode:input.mode,host:input.host,bind:input.bind,createdAt:new Date().toISOString(),login:input.login},null,2)+'\n');
  await write('.gitignore','*\n');
  for(const name of ['Dockerfile','.dockerignore','LICENSE','THIRD_PARTY_NOTICES.txt','package.json','package-lock.json','tsconfig.json','tsconfig.base.json','src','vendor']) await fs.cp(path.join(source,name),path.join(destination,'app',name),{recursive:true});
  await fs.mkdir(path.join(destination,'app/scripts'));await fs.copyFile(path.join(source,'scripts/copy-migrations.mjs'),path.join(destination,'app/scripts/copy-migrations.mjs'));
  await write('README.txt',`Hotel Manager\nАдрес: ${profile.serverUrl}\nВладелец: ${input.login}\n\nЗапуск из этой папки: docker compose -f compose.json up -d --build\nОстановка: docker compose -f compose.json stop\nСостояние: docker compose -f compose.json ps\nЖурнал: docker compose -f compose.json logs --tail 100 api\n\nВ приложении выберите QR или файл, откройте connection.json, подтвердите адрес и войдите с паролем, заданным в мастере. Затем создайте сотрудников и приглашения.\n\nconnection.json не содержит пароля. Остальные файлы этой папки, база и тома Docker — секретные. Не публикуйте их. Для резервной копии нужны БД, том files, secrets и сертификаты. Не используйте down -v: это удаляет данные.\n${fingerprint?'Локальный сертификат действует 1 год. Перед истечением замените его и передайте новый профиль всем устройствам.':''}\n`);
  return {directory:destination,...profile};
}
