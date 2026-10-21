import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { sql, writeTx, type Tx } from './db.js';
import type { Role } from './permissions.js';

export interface DeviceInfo { id: string; name: string; platform: string; userId: string; role: Role; authVersion: number; }
interface Account { id: string; login: string; name: string; role: Role; authVersion: number; passwordHash: string; disabledAt: string | null; }
declare module 'fastify' { interface FastifyRequest { device: DeviceInfo; } }
export const tokenHash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const Password = z.string().min(12, 'Пароль должен содержать не менее 12 символов').max(200);
const Login = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._@-]+$/).transform(s => s.toLowerCase());
const Device = z.object({ deviceName: z.string().trim().min(1).max(100), platform: z.enum(['windows','android','web']) });
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const RoleSchema = z.enum(['manager','reception','viewer']);
const safeAccount = (a: Account) => ({ id: a.id, login: a.login, name: a.name, role: a.role, authVersion: a.authVersion });
const dummyHash = hash(secret(), { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const hashPassword = (value: string) => hash(value, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });

async function audit(tx: Tx, event: string, userId: string | null, deviceId: string | null = null, targetId: string | null = null) {
  await tx`insert into security_audit(event,user_id,device_id,target_id) values(${event},${userId},${deviceId},${targetId})`;
}
async function revokeUser(tx: Tx, userId: string) {
  await tx`update devices set revoked_at=coalesce(revoked_at,now()) where user_id=${userId}`;
  await tx`update device_invitations set revoked_at=coalesce(revoked_at,now()) where user_id=${userId} and used_at is null`;
}

/** Local recovery only. Cannot turn an existing staff account into an owner. */
export async function setPassword(login: string, password: string): Promise<void> {
  const normalized = Login.parse(login);
  const passwordHash = await hashPassword(Password.parse(password));
  await writeTx(async tx => {
    const [owner] = await tx<Account[]>`select * from users where role='owner'`;
    if (owner) {
      await tx`update users set login=${normalized},password_hash=${passwordHash},auth_version=auth_version+1,disabled_at=null where id=${owner.id}`;
      await revokeUser(tx, owner.id);
      await audit(tx,'owner.recovered',owner.id);
    } else {
      const [created] = await tx`insert into users(login,name,password_hash,role) values(${normalized},${normalized},${passwordHash},'owner') returning id`;
      await audit(tx,'owner.created',created.id as string);
    }
  });
}
export async function ensureAdmin(log: (message: string) => void): Promise<void> {
  if ((await sql`select 1 from users where role='owner'`).length) return;
  if (!config.adminPassword) { log('Создайте владельца локальной командой cli set-password перед подключением устройств.'); return; }
  const passwordHash = await hashPassword(Password.parse(config.adminPassword));
  await writeTx(async tx => {
    if ((await tx`select 1 from users where role='owner'`).length) return;
    const login = Login.parse(config.adminLogin);
    const [created] = await tx`insert into users(login,name,password_hash,role) values(${login},${login},${passwordHash},'owner') returning id`;
    await audit(tx,'owner.created',created.id as string);
  });
}

// Persisted limits survive a process restart. The global bucket bounds storage under an attack.
async function rateLimit(req: FastifyRequest, reply: FastifyReply, account = '', refresh = false): Promise<boolean> {
  const allowed = await writeTx(async tx => {
    await tx`delete from auth_rate_limits where window_end < now()`;
    for (const [key, max] of [[refresh?'refresh:global':'login:global',refresh?10000:300], [`${refresh?'refresh':'login'}:ip:${tokenHash(req.ip)}`,refresh?1000:30], ...(account ? [[`account:${tokenHash(account)}`,10] as const] : [])] as const) {
      const [row] = await tx`insert into auth_rate_limits(bucket,attempts,window_end) values(${key},1,now()+interval '10 minutes')
        on conflict(bucket) do update set attempts=auth_rate_limits.attempts+1 returning attempts`;
      if (Number(row.attempts) > max) return false;
    }
    return true;
  });
  if (!allowed) reply.header('Retry-After','600').code(429).send({ error:'Слишком много попыток. Повторите через 10 минут.' });
  return allowed;
}

async function issue(tx: Tx, account: Account, device: z.infer<typeof Device>, deviceId?: string) {
  const token = secret();
  const refreshToken = secret();
  const [installation] = await tx<{id: string}[]>`select id from installation where singleton=true`;
  let id = deviceId;
  if (!id) {
    const [created] = await tx<{id: string}[]>`insert into devices(name,platform,user_id,auth_version,token_hash,access_expires_at,expires_at,last_seen_at)
      values(${device.deviceName},${device.platform},${account.id},${account.authVersion},${tokenHash(token)},now()+interval '15 minutes',now()+interval '30 days',now()) returning id`;
    id = created.id;
  } else {
    await tx`update devices set token_hash=${tokenHash(token)},access_expires_at=now()+interval '15 minutes',expires_at=now()+interval '30 days',last_seen_at=now() where id=${id}`;
  }
  await tx`insert into device_refresh_tokens(token_hash,device_id,expires_at) values(${tokenHash(refreshToken)},${id},now()+interval '30 days')`;
  const [clock] = await tx<{serverTime: string; offlineUntil: string; expiresAt: string}[]>`
    select now() as server_time, now()+interval '24 hours' as offline_until, now()+interval '15 minutes' as expires_at`;
  return { token, refreshToken, deviceId:id, installationId:installation.id, user:safeAccount(account), ...clock };
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  if (!Token.safeParse(token).success) return void reply.code(401).send({error:'Требуется вход'});
  const [d] = await sql<DeviceInfo[]>`select d.id,d.name,d.platform,d.user_id,u.role,u.auth_version
    from devices d join users u on u.id=d.user_id where d.token_hash=${tokenHash(token)}
    and d.revoked_at is null and d.expires_at>now() and d.access_expires_at>now()
    and u.disabled_at is null and u.auth_version=d.auth_version`;
  if (!d) return void reply.code(401).send({error:'Сессия истекла или доступ отозван'});
  req.device = d;
}
async function ownerOnly(req: FastifyRequest, reply: FastifyReply) {
  if (req.device.role !== 'owner') reply.code(403).send({error:'Доступно только владельцу'});
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/auth/') || req.url.startsWith('/api/invitations')) reply.header('Cache-Control','no-store');
    return payload;
  });
  app.post('/api/auth/login', async (req, reply) => {
    const body = Device.extend({login:Login,password:z.string().max(200)}).parse(req.body);
    if (!(await rateLimit(req,reply,body.login))) return;
    const [account] = await sql<Account[]>`select * from users where login=${body.login}`;
    const valid = await verify(account?.passwordHash ?? await dummyHash,body.password);
    if (!valid || !account || account.disabledAt) return reply.code(401).send({error:'Неверный логин или пароль'});
    return writeTx(async tx => {
      const [current] = await tx<Account[]>`select * from users where id=${account.id} and disabled_at is null and auth_version=${account.authVersion}`;
      if (!current) return reply.code(401).send({error:'Доступ изменён. Повторите вход.'});
      const result = await issue(tx,current,body);
      await audit(tx,'device.login',current.id,result.deviceId);
      return result;
    });
  });
  app.post('/api/auth/refresh', async (req,reply) => {
    const body = z.object({refreshToken:Token,installationId:z.uuid()}).parse(req.body);
    if (!(await rateLimit(req,reply,'',true))) return;
    const result = await writeTx(async tx => {
      const [installation] = await tx`select id from installation where singleton=true`;
      if (installation.id !== body.installationId) return {error:'Другой сервер'};
      const [record] = await tx<{deviceId:string;usedAt:string|null}[]>`select device_id,used_at from device_refresh_tokens where token_hash=${tokenHash(body.refreshToken)} and expires_at>now()`;
      if (!record) return {error:'Войдите снова'};
      if (record.usedAt) {
        await tx`update devices set revoked_at=coalesce(revoked_at,now()) where id=${record.deviceId}`;
        await audit(tx,'refresh.replay',null,record.deviceId);
        return {error:'Повторное использование сессии. Войдите снова.'};
      }
      const [account] = await tx<Account[]>`select u.* from users u join devices d on d.user_id=u.id where d.id=${record.deviceId}
        and d.revoked_at is null and d.expires_at>now() and u.disabled_at is null and d.auth_version=u.auth_version`;
      if (!account) return {error:'Доступ отозван'};
      await tx`update device_refresh_tokens set used_at=now() where token_hash=${tokenHash(body.refreshToken)}`;
      return issue(tx,account,{deviceName:'',platform:'web'},record.deviceId);
    });
    return 'error' in result ? reply.code(401).send(result) : result;
  });
  app.post('/api/auth/pair', async (req,reply) => {
    const body = Device.extend({invitationToken:Token,installationId:z.uuid()}).parse(req.body);
    if (!(await rateLimit(req,reply))) return;
    return writeTx(async tx => {
      const [installation] = await tx`select id from installation where singleton=true`;
      if (installation.id !== body.installationId) return reply.code(401).send({error:'Приглашение другого сервера'});
      const [invite] = await tx<{id:string;userId:string;authVersion:number}[]>`select id,user_id,auth_version from device_invitations
        where token_hash=${tokenHash(body.invitationToken)} and used_at is null and revoked_at is null and expires_at>now()`;
      if (!invite) return reply.code(401).send({error:'Приглашение недействительно или уже использовано'});
      const [account] = await tx<Account[]>`select * from users where id=${invite.userId} and auth_version=${invite.authVersion} and disabled_at is null`;
      if (!account) return reply.code(401).send({error:'Доступ изменён'});
      await tx`update device_invitations set used_at=now() where id=${invite.id}`;
      const result = await issue(tx,account,body);
      await audit(tx,'device.paired',account.id,result.deviceId,invite.id);
      return result;
    });
  });
  app.register(async scoped => {
    scoped.addHook('preHandler',authenticate);
    scoped.get('/api/auth/me',async req => {
      const [account] = await sql<Account[]>`select * from users where id=${req.device.userId}`;
      const [installation] = await sql`select id from installation where singleton=true`;
      const [clock] = await sql`select now() as server_time,now()+interval '24 hours' as offline_until`;
      return {login:account.login,user:safeAccount(account),device:req.device,installationId:installation.id,...clock};
    });
    scoped.post('/api/auth/logout',async req => {
      await writeTx(async tx => { await tx`update devices set revoked_at=now() where id=${req.device.id}`; await audit(tx,'device.logout',req.device.userId,req.device.id); });
      return {ok:true};
    });
    scoped.post('/api/auth/password',async (req,reply) => {
      const body = z.object({current:z.string().max(200),next:Password}).parse(req.body);
      if (!(await rateLimit(req,reply,req.device.userId))) return;
      const [account] = await sql<Account[]>`select * from users where id=${req.device.userId}`;
      if (!(await verify(account.passwordHash,body.current))) return reply.code(400).send({error:'Текущий пароль неверен'});
      const nextHash = await hashPassword(body.next);
      await writeTx(async tx => {
        const changed = await tx`update users set password_hash=${nextHash},auth_version=auth_version+1 where id=${account.id} and auth_version=${account.authVersion} returning id`;
        if (!changed.length) throw Object.assign(new Error('Доступ изменён. Войдите снова.'),{statusCode:409});
        await revokeUser(tx,account.id); await audit(tx,'password.changed',account.id,req.device.id);
      });
      return {ok:true,reauthenticate:true};
    });
    scoped.get('/api/devices',async req => {
      const list = await sql`select d.id,d.name,d.platform,d.user_id,u.name as user_name,d.created_at,d.last_seen_at,d.last_sync_at,d.expires_at,d.revoked_at
        from devices d join users u on u.id=d.user_id where (${req.device.role === 'owner'} or d.user_id=${req.device.userId}) order by d.created_at desc`;
      return list.map(d=>({...d,current:d.id===req.device.id}));
    });
    scoped.delete<{Params:{id:string}}>('/api/devices/:id',async (req,reply) => {
      const id = z.uuid().parse(req.params.id);
      return writeTx(async tx => {
        const rows = await tx`update devices set revoked_at=coalesce(revoked_at,now()) where id=${id} and (${req.device.role==='owner'} or user_id=${req.device.userId}) returning id`;
        if (!rows.length) return reply.code(404).send({error:'Устройство не найдено'});
        await audit(tx,'device.revoked',req.device.userId,req.device.id,id); return {ok:true};
      });
    });
    scoped.put('/api/devices/me',async req => {
      const body=z.object({name:z.string().trim().min(1).max(100).optional(),fcmToken:z.string().max(4096).nullable().optional(),prefs:z.record(z.string(),z.boolean()).optional()}).parse(req.body);
      if (body.name!==undefined) await sql`update devices set name=${body.name} where id=${req.device.id}`;
      if (body.fcmToken!==undefined) await sql`update devices set fcm_token=${body.fcmToken} where id=${req.device.id}`;
      if (body.prefs) await sql`update devices set prefs=${sql.json(body.prefs)} where id=${req.device.id}`;
      return {ok:true};
    });
    scoped.register(async admin => {
      admin.addHook('preHandler',ownerOnly);
      admin.get('/api/users',async ()=>sql`select id,login,name,role,auth_version,disabled_at,created_at from users order by created_at`);
      admin.post('/api/users',async (req,reply) => {
        const body=z.object({login:Login,name:z.string().trim().min(1).max(100),password:Password,role:RoleSchema}).parse(req.body);
        const passwordHash=await hashPassword(body.password);
        return writeTx(async tx=>{
          if ((await tx`select 1 from users where login=${body.login}`).length) return reply.code(409).send({error:'Логин уже занят'});
          const [created]=await tx`insert into users(login,name,password_hash,role) values(${body.login},${body.name},${passwordHash},${body.role}) returning id,login,name,role`;
          await audit(tx,'user.created',req.device.userId,req.device.id,created.id as string); return created;
        });
      });
      admin.put<{Params:{id:string}}>('/api/users/:id',async (req,reply)=>{
        const id=z.uuid().parse(req.params.id);
        const body=z.object({name:z.string().trim().min(1).max(100),role:RoleSchema,disabled:z.boolean(),password:Password.optional()}).parse(req.body);
        const passwordHash=body.password ? await hashPassword(body.password):null;
        return writeTx(async tx=>{
          const [account]=await tx<Account[]>`select * from users where id=${id} and role<>'owner'`;
          if (!account) return reply.code(404).send({error:'Сотрудник не найден'});
          await tx`update users set name=${body.name},role=${body.role},disabled_at=${body.disabled ? new Date():null},password_hash=${passwordHash??account.passwordHash},auth_version=auth_version+1 where id=${id}`;
          await revokeUser(tx,id); await audit(tx,'user.updated',req.device.userId,req.device.id,id); return {ok:true};
        });
      });
      admin.post('/api/invitations',async (req,reply)=>{
        const body=z.object({userId:z.uuid()}).parse(req.body);
        const invitationToken=secret();
        return writeTx(async tx=>{
          const [account]=await tx<Account[]>`select * from users where id=${body.userId} and disabled_at is null`;
          if (!account) return reply.code(404).send({error:'Пользователь не найден'});
          const [invite]=await tx`insert into device_invitations(token_hash,user_id,auth_version,created_by,expires_at)
            values(${tokenHash(invitationToken)},${account.id},${account.authVersion},${req.device.userId},now()+interval '10 minutes') returning id,expires_at`;
          const [installation]=await tx`select id from installation where singleton=true`;
          await audit(tx,'invitation.created',req.device.userId,req.device.id,invite.id as string);
          return {id:invite.id,invitationToken,installationId:installation.id,expiresAt:invite.expiresAt,user:safeAccount(account)};
        });
      });
      admin.delete<{Params:{id:string}}>('/api/invitations/:id',async req=>{
        const id=z.uuid().parse(req.params.id);
        await writeTx(async tx=>{await tx`update device_invitations set revoked_at=now() where id=${id}`;await audit(tx,'invitation.revoked',req.device.userId,req.device.id,id);});return {ok:true};
      });
    });
  });
}
