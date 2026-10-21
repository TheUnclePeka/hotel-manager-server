import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const platform=process.platform==='win32'?'windows':process.platform;
const bin=path.join(root,'node_modules/@embedded-postgres',`${platform}-${process.arch}`,'native/bin');
const exe=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
if(!fs.existsSync(exe('pg_ctl'))) throw new Error('Install embedded-postgres native binaries before running security tests.');
const parent=path.join(root,'.dev-data'); fs.mkdirSync(parent,{recursive:true});
const dir=fs.mkdtempSync(path.join(parent,'security-'));
const data=path.join(dir,'pg'); const pw=path.join(dir,'password');
const password=crypto.randomBytes(32).toString('base64url');
fs.writeFileSync(pw,password,{mode:0o600});
const probe=net.createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
let started=false;
try {
  execFileSync(exe('initdb'),['-D',data,'-U','security_test','--pwfile',pw,'-A','scram-sha-256','-E','UTF8','--locale=C'],{stdio:'pipe'});
  fs.unlinkSync(pw);
  execFileSync(exe('pg_ctl'),['-D',data,'-o',`-p ${port} -h 127.0.0.1`,'-l',path.join(dir,'postgres.log'),'-w','start'],{stdio:'ignore'}); started=true;
  const child=spawn(process.execPath,[path.join(root,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.integration.config.mts'],{
    cwd:root,stdio:'inherit',env:{...process.env,DATABASE_URL:`postgres://security_test:${password}@127.0.0.1:${port}/postgres`,DATA_DIR:path.join(dir,'files'),FILES_KEY:crypto.randomBytes(32).toString('base64'),ADMIN_LOGIN:'owner',ADMIN_PASSWORD:crypto.randomBytes(32).toString('base64url')},
  });
  process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code??1));});
} finally {
  if(started) execFileSync(exe('pg_ctl'),['-D',data,'-m','fast','-w','stop'],{stdio:'ignore'});
  console.log('Isolated security-test PostgreSQL stopped. Test files remain in ignored .dev-data/.');
}
