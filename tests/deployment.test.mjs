import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {generateDeployment,validate} from '../scripts/deployment.mjs';

const base={mode:'lan',host:'127.0.0.1',bind:'127.0.0.1',login:'owner',password:'test-only-password-phrase'};
test('isolated installations have unique secrets and valid pinned certificates',async()=>{
  const parent=path.resolve('.dev-data');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'installer-test-'));
  const first=await generateDeployment({...base,directory:path.join(directory,'first')});
  const second=await generateDeployment({...base,directory:path.join(directory,'second')});
  const read=(which,name)=>fs.readFile(path.join(which.directory,name),'utf8');
  assert.notEqual(await read(first,'secrets/files-key'),await read(second,'secrets/files-key'));
  assert.notEqual(await read(first,'secrets/database-url'),await read(second,'secrets/database-url'));
  assert.notEqual(first.certificateSha256,second.certificateSha256);
  const certificate=new crypto.X509Certificate(await read(first,'certs/server.crt'));
  assert.equal(certificate.checkIP('127.0.0.1'),'127.0.0.1');
  assert.equal(certificate.checkIP('127.0.0.2'),undefined);
  assert.equal(crypto.createHash('sha256').update(certificate.raw).digest('hex'),first.certificateSha256);
  const compose=JSON.parse(await read(first,'compose.json'));
  assert.equal(compose.services.api.ports,undefined);assert.equal(compose.services.db.ports,undefined);
  assert.deepEqual(compose.services.https.ports,['127.0.0.1:443:443']);
  assert.equal(JSON.stringify(compose).includes(base.password),false);
  assert.equal((await read(first,'connection.json')).includes(base.password),false);
  await assert.rejects(generateDeployment({...base,directory:first.directory}),/EEXIST/);
  assert.equal(await read(first,'secrets/owner-password'),base.password);
});
test('refuses Caddy injection, unknown interfaces and weak credentials',()=>{
  for(const override of [{host:'evil.example {\n respond hacked\n}'},{bind:'203.0.113.99'},{bind:'0.0.0.0'},{password:'short'},{mode:'public',host:'127.0.0.1'},{login:"admin';DROP TABLE users;"}]) assert.throws(()=>validate({...base,...override}));
});
