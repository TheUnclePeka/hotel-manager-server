import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {generateDeployment} from './deployment.mjs';

if(spawnSync('docker',['info'],{stdio:'ignore',windowsHide:true}).status!==0) throw new Error('Для этой проверки нужен работающий Docker. Ничего не установлено и не изменено.');
await fs.mkdir('.dev-data',{recursive:true});
const parent=await fs.mkdtemp(path.resolve('.dev-data/deployment-test-'));
const password=crypto.randomBytes(32).toString('base64url');
const deployment=await generateDeployment({mode:'lan',host:'127.0.0.1',bind:'127.0.0.1',login:'owner',password,directory:path.join(parent,'server')});
const compose=JSON.parse(await fs.readFile(path.join(deployment.directory,'compose.json'),'utf8'));
// Use a separate port; never stop or reuse an existing deployment.
compose.services.https.ports=['127.0.0.1:19443:443'];
await fs.writeFile(path.join(deployment.directory,'compose.json'),JSON.stringify(compose));
const ca=await fs.readFile(path.join(deployment.directory,'certs/server.crt'));
const run=args=>spawnSync('docker',['compose','-f','compose.json',...args],{cwd:deployment.directory,stdio:'inherit',windowsHide:true}).status;
function request(method,url,body,token) {
  return new Promise((resolve,reject)=>{
    const req=https.request(`https://127.0.0.1:19443${url}`,{method,ca,timeout:10000,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}},res=>{
      let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));
    });req.on('timeout',()=>req.destroy(new Error('HTTPS timeout')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
}
try {
  assert.equal(run(['up','-d','--build','--wait','--wait-timeout','180']),0,'Docker deployment failed');
  const session=await request('POST','/api/auth/login',{login:'owner',password,deviceName:'CI',platform:'windows'});
  assert.equal(session.status,200);
  assert.equal((await request('GET','/api/auth/me',undefined,session.body.token)).body.user.role,'owner');
  assert.equal((await request('GET','/api/users')).status,401);
  console.log('Fresh Docker deployment, real HTTPS and owner login verified.');
} finally {run(['down','-v']);}
