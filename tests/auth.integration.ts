import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import crypto from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../src/app.js';
import {sql} from '../src/db.js';
interface Credentials {token:string;refreshToken:string;deviceId:string;installationId:string;user:{id:string;role:string};offlineUntil:string;}
let app:FastifyInstance;
let owner:Credentials;
let front:Credentials;
let viewer:Credentials;
const frontPassword=crypto.randomBytes(24).toString('base64url');
const headers=(session:Credentials)=>({authorization:`Bearer ${session.token}`});
const login=(name:string,password:string)=>app.inject({method:'POST',url:'/api/auth/login',payload:{login:name,password,deviceName:'Security test',platform:'windows'}});
beforeAll(async()=>{
  app=await createApp({scheduler:false,logger:false}); await app.ready();
  const entered=await login('owner',process.env.ADMIN_PASSWORD!); expect(entered.statusCode).toBe(200); owner=entered.json();
  for(const [name,role] of [['front','reception'],['view','viewer']]) {
    const created=await app.inject({method:'POST',url:'/api/users',headers:headers(owner),payload:{login:name,name,role,password:frontPassword}}); expect(created.statusCode).toBe(200);
  }
  front=(await login('front',frontPassword)).json(); viewer=(await login('view',frontPassword)).json();
});
beforeEach(async()=>{await sql`delete from auth_rate_limits`;});
afterAll(async()=>{await app?.close();await sql?.end();});

describe('account and device security against PostgreSQL',()=>{
  it('starts with an empty hotel and no guest or booking data',async()=>{
    for (const table of ['floors','room_categories','rooms','locations','guests','bookings']) {
      const [result]=await sql`select count(*)::int as count from ${sql(table)}`;
      expect(result.count,table).toBe(0);
    }
    const [hotel]=await sql`select value from settings where key='hotel'`;
    for (const field of ['address','phone','email','inn','requisites']) expect(hotel.value[field],field).toBe('');
    const [methods]=await sql`select count(*)::int as count from payment_methods`;
    expect(methods.count).toBeGreaterThan(0);
  });
  it('keeps passwords and tokens hashed and grants a 24-hour offline window',async()=>{
    const [stored]=await sql`select d.token_hash,u.password_hash from devices d join users u on u.id=d.user_id where d.id=${front.deviceId}`;
    expect(stored.tokenHash).not.toBe(front.token);expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(new Date(front.offlineUntil).getTime()-Date.now()).toBeGreaterThan(23*3600000);
    const body=await app.inject({url:'/api/auth/me',headers:headers(front)});
    expect(body.json().user.role).toBe('reception'); expect(body.body).not.toContain('passwordHash');
  });
  it('denies staff account management and privileged endpoints',async()=>{
    for(const url of ['/api/users','/api/staff','/api/reports','/api/tax/ledger','/api/backups','/api/settings/smtp','/api/audit','/api/trash','/api/operations/diagnostics']) {
      expect((await app.inject({url,headers:headers(front)})).statusCode,url).toBe(403);
    }
    expect((await app.inject({method:'POST',url:'/api/invitations',headers:headers(front),payload:{userId:owner.user.id}})).statusCode).toBe(403);
    expect((await app.inject({method:'DELETE',url:`/api/devices/${owner.deviceId}`,headers:headers(front)})).statusCode).toBe(404);
  });
  it('filters protected rows out of sync and generic entity routes',async()=>{
    const [setting]=await sql`insert into settings(key,value) values('incomeTax','{"private":"sentinel"}') on conflict(key) do update set value=excluded.value returning id`;
    const sync=await app.inject({method:'POST',url:'/api/sync/pull',headers:headers(front),payload:{since:0,window:null}});
    expect(sync.statusCode).toBe(200);expect(sync.body).not.toContain('sentinel');
    expect((await app.inject({url:`/api/entities/settings/${setting.id}`,headers:headers(front)})).statusCode).toBe(404);
    expect((await app.inject({url:'/api/entities/staffPayments',headers:headers(front)})).statusCode).toBe(403);
    const all=await app.inject({url:'/api/entities/settings',headers:headers(front)});expect(all.body).not.toContain('sentinel');
  });
  it('cannot read an expense attachment through files or generic routes',async()=>{
    const id=crypto.randomUUID();const ownerId=crypto.randomUUID();
    await sql`insert into files(id,owner_type,owner_id,kind,file_name,mime) values(${id},'expense',${ownerId},'scan','private.pdf','application/pdf')`;
    expect((await app.inject({url:`/api/files/${id}`,headers:headers(front)})).statusCode).toBe(404);
    expect((await app.inject({url:`/api/entities/files/${id}`,headers:headers(front)})).statusCode).toBe(404);
    expect((await app.inject({url:`/api/files?ownerType=expense&ownerId=${ownerId}`,headers:headers(front)})).json()).toEqual([]);
  });
  it('syncs passport data for reception but excludes it for the viewer',async()=>{
    const guestId=crypto.randomUUID();
    await sql`insert into guests(id,last_name) values(${guestId},'Synthetic Passport Guest')`;
    await sql`insert into guest_docs(guest_id,doc_number) values(${guestId},'SYNTHETIC-SECRET')`;
    const pull=async(session:Credentials)=>app.inject({method:'POST',url:'/api/sync/pull',headers:headers(session),payload:{since:0,window:null}});
    expect((await pull(front)).body).toContain('SYNTHETIC-SECRET');
    expect((await pull(viewer)).body).not.toContain('SYNTHETIC-SECRET');
    expect((await app.inject({url:`/api/guests/${guestId}/full`,headers:headers(viewer)})).statusCode).toBe(403);
  });
  it('rejects forbidden offline changes and action/entity spoofing',async()=>{
    for(const [entity,kind,action] of [['settings','create',undefined],['staffPayments','create',undefined],['guests','action','purchase.post']] as const) {
      const response=await app.inject({method:'POST',url:'/api/sync/push',headers:headers(front),payload:{ops:[{opId:crypto.randomUUID(),id:crypto.randomUUID(),entity,kind,action,data:{key:'incomeTax',value:{}},ts:new Date().toISOString()}]}});
      expect(response.statusCode).toBe(200);expect(response.json().results[0].status).toBe('rejected');
    }
    const response=await app.inject({method:'POST',url:'/api/sync/push',headers:headers(viewer),payload:{ops:[{opId:crypto.randomUUID(),id:crypto.randomUUID(),entity:'guests',kind:'create',data:{lastName:'Test'},ts:new Date().toISOString()}]}});
    expect(response.json().results[0].status).toBe('rejected');
  });
  it('applies an authorized change once and attributes its audit to the user',async()=>{
    const id=crypto.randomUUID();const opId=crypto.randomUUID();
    const request={method:'POST' as const,url:'/api/sync/push',headers:headers(front),payload:{ops:[{opId,id,entity:'guests',kind:'create',data:{lastName:'Synthetic Guest'},ts:new Date().toISOString()}]}};
    const first=await app.inject(request);expect(first.json().results[0].status).toBe('applied');
    const second=await app.inject(request);expect(second.json().results[0].status).toBe('duplicate');
    const [audit]=await sql`select user_id from audit_log where entity_id=${id}`;expect(audit.userId).toBe(front.user.id);
  });
  it('exports a workbook for the owner and denies mass export to reception',async()=>{
    const payload={title:'Synthetic export',columns:[{key:'name',label:'Name'}],rows:[{name:'Synthetic Guest'}]};
    expect((await app.inject({method:'POST',url:'/api/export/xlsx',headers:headers(front),payload})).statusCode).toBe(403);
    const exported=await app.inject({method:'POST',url:'/api/export/xlsx',headers:headers(owner),payload});
    expect(exported.statusCode).toBe(200);expect(exported.rawPayload.subarray(0,2).toString()).toBe('PK');
  });
  it('redeems an invitation once under concurrent requests',async()=>{
    const invite=(await app.inject({method:'POST',url:'/api/invitations',headers:headers(owner),payload:{userId:front.user.id}})).json();
    const payload={invitationToken:invite.invitationToken,installationId:invite.installationId,deviceName:'Paired',platform:'android'};
    const results=await Promise.all([app.inject({method:'POST',url:'/api/auth/pair',payload}),app.inject({method:'POST',url:'/api/auth/pair',payload})]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,401]);
    expect(results.find(r=>r.statusCode===200)!.json().user.role).toBe('reception');
  });
  it('rejects expired invitations and invitations for another installation',async()=>{
    const invite=(await app.inject({method:'POST',url:'/api/invitations',headers:headers(owner),payload:{userId:front.user.id}})).json();
    const payload={invitationToken:invite.invitationToken,installationId:crypto.randomUUID(),deviceName:'Other',platform:'android'};
    expect((await app.inject({method:'POST',url:'/api/auth/pair',payload})).statusCode).toBe(401);
    await sql`update device_invitations set expires_at=now()-interval '1 second' where id=${invite.id}`;
    expect((await app.inject({method:'POST',url:'/api/auth/pair',payload:{...payload,installationId:invite.installationId}})).statusCode).toBe(401);
  });
  it('rotates refresh tokens and revokes the device after replay',async()=>{
    const session:Credentials=(await login('front',frontPassword)).json();
    const payload={refreshToken:session.refreshToken,installationId:session.installationId};
    const fresh=await app.inject({method:'POST',url:'/api/auth/refresh',payload});expect(fresh.statusCode).toBe(200);
    expect(fresh.json().refreshToken).not.toBe(session.refreshToken);
    expect((await app.inject({url:'/api/auth/me',headers:headers(session)})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/auth/refresh',payload})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/auth/me',headers:headers(fresh.json())})).statusCode).toBe(401);
  });
  it('blocks guessing even with spoofed forwarded addresses',async()=>{
    for(let i=0;i<10;i++) expect((await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-forwarded-for':`192.0.2.${i}`},payload:{login:'missing',password:'bad',deviceName:'Attack',platform:'web'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/auth/login',payload:{login:'missing',password:'bad',deviceName:'Attack',platform:'web'}})).statusCode).toBe(429);
  });
  it('revokes sessions and pending invitations when an employee is disabled',async()=>{
    const invite=(await app.inject({method:'POST',url:'/api/invitations',headers:headers(owner),payload:{userId:front.user.id}})).json();
    const changed=await app.inject({method:'PUT',url:`/api/users/${front.user.id}`,headers:headers(owner),payload:{name:'Front',role:'reception',disabled:true}});expect(changed.statusCode).toBe(200);
    expect((await app.inject({url:'/api/auth/me',headers:headers(front)})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/auth/refresh',payload:{refreshToken:front.refreshToken,installationId:front.installationId}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/auth/pair',payload:{invitationToken:invite.invitationToken,installationId:invite.installationId,deviceName:'Late',platform:'android'}})).statusCode).toBe(401);
  });
  it('rejects the first installation token on a freshly initialized second server',async()=>{
    await sql`create database security_second`;
    await app.close();await sql.end();
    app=await createApp({databaseUrl:process.env.DATABASE_URL!.replace(/\/postgres$/,'/security_second'),scheduler:false,logger:false});await app.ready();
    expect((await app.inject({url:'/api/auth/me',headers:headers(owner)})).statusCode).toBe(401);
    const second=(await login('owner',process.env.ADMIN_PASSWORD!)).json();
    expect(second.installationId).not.toBe(owner.installationId);
  });
});
