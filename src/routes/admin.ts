import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAdmin } from '../middleware/auth';
import { HttpError, isUniqueError, now, validateName } from '../lib/util';
import { hashPassword, validatePassword } from '../lib/password';
import { revokeUserSessions } from '../lib/session';
import { deleteR2Keys, fileDto, getFile, listChildren, r2Key, streamFile } from '../lib/storage';

export const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin);

interface UserRow {
	id: string;
	display_name: string;
	email: string;
	is_admin: number;
	created_at: string;
	updated_at: string;
	file_count?: number;
	used_bytes?: number;
}

const userDto = (u: UserRow) => ({
	id: u.id,
	displayName: u.display_name,
	email: u.email,
	isAdmin: !!u.is_admin,
	createdAt: u.created_at,
	updatedAt: u.updated_at,
	fileCount: u.file_count ?? 0,
	usedBytes: u.used_bytes ?? 0,
});

function validateEmail(v: unknown): string {
	const e = typeof v === 'string' ? v.trim() : '';
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new HttpError(400, 'INVALID_EMAIL', 'メールアドレスが不正です');
	return e;
}

function validateDisplayName(v: unknown): string {
	const n = typeof v === 'string' ? v.normalize('NFC').trim() : '';
	if (n.length < 1 || n.length > 50) throw new HttpError(400, 'INVALID_NAME', '表示名は1〜50文字で指定してください');
	return n;
}

async function adminCount(env: Env): Promise<number> {
	return (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').first<{ n: number }>())?.n ?? 0;
}

async function getUser(env: Env, id: string): Promise<UserRow> {
	const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<UserRow>();
	if (!u) throw new HttpError(404, 'NOT_FOUND', 'ユーザーが見つかりません');
	return u;
}

admin.get('/users', async (c) => {
	const q = (c.req.query('q') ?? '').trim();
	const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
	const r = await c.env.DB.prepare(
		`SELECT u.*, COALESCE(s.n,0) AS file_count, COALESCE(s.b,0) AS used_bytes
		 FROM users u LEFT JOIN (SELECT owner_id, COUNT(*) n, SUM(size_bytes) b FROM files GROUP BY owner_id) s ON s.owner_id = u.id
		 WHERE (?1 = '' OR u.email LIKE ?2 ESCAPE '\\' OR u.display_name LIKE ?2 ESCAPE '\\')
		 ORDER BY u.created_at LIMIT 500`,
	)
		.bind(q, like)
		.all<UserRow>();
	return c.json({ users: r.results.map(userDto) });
});

admin.post('/users', async (c) => {
	const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
	const displayName = validateDisplayName(b.displayName);
	const email = validateEmail(b.email);
	const hash = await hashPassword(validatePassword(b.password));
	const id = crypto.randomUUID();
	const t = now();
	try {
		await c.env.DB.prepare('INSERT INTO users (id, display_name, email, password_hash, is_admin, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)')
			.bind(id, displayName, email, hash, b.isAdmin ? 1 : 0, t)
			.run();
	} catch (e) {
		if (isUniqueError(e)) throw new HttpError(409, 'DUPLICATE', 'このメールアドレスは既に登録されています');
		throw e;
	}
	return c.json({ user: userDto(await getUser(c.env, id)) }, 201);
});

admin.patch('/users/:id', async (c) => {
	const id = c.req.param('id');
	const me = c.get('user');
	const u = await getUser(c.env, id);
	const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

	const displayName = b.displayName !== undefined ? validateDisplayName(b.displayName) : u.display_name;
	const email = b.email !== undefined ? validateEmail(b.email) : u.email;
	const isAdmin = b.isAdmin !== undefined ? (b.isAdmin ? 1 : 0) : u.is_admin;
	const hash = b.password ? await hashPassword(validatePassword(b.password)) : null;

	if (u.is_admin && !isAdmin) {
		if (id === me.id) throw new HttpError(400, 'SELF_DEMOTE', '自分自身の管理者権限は外せません');
		if ((await adminCount(c.env)) <= 1) throw new HttpError(400, 'LAST_ADMIN', '最後の管理者は降格できません');
	}
	try {
		await c.env.DB.prepare('UPDATE users SET display_name = ?1, email = ?2, is_admin = ?3, password_hash = COALESCE(?4, password_hash), updated_at = ?5 WHERE id = ?6')
			.bind(displayName, email, isAdmin, hash, now(), id)
			.run();
	} catch (e) {
		if (isUniqueError(e)) throw new HttpError(409, 'DUPLICATE', 'このメールアドレスは既に登録されています');
		throw e;
	}
	if (hash || isAdmin !== u.is_admin) await revokeUserSessions(c.env, id, id === me.id ? c.get('sessionId') : undefined);
	console.log(JSON.stringify({ audit: 'user.update', admin: me.id, target: id, at: now() }));
	return c.json({ user: userDto(await getUser(c.env, id)) });
});

admin.delete('/users/:id', async (c) => {
	const id = c.req.param('id');
	const me = c.get('user');
	const u = await getUser(c.env, id);
	if (id === me.id) throw new HttpError(400, 'SELF_DELETE', '自分自身は削除できません');
	if (u.is_admin && (await adminCount(c.env)) <= 1) throw new HttpError(400, 'LAST_ADMIN', '最後の管理者は削除できません');

	const ids = (await c.env.DB.prepare('SELECT id FROM files WHERE owner_id = ?1').bind(id).all<{ id: string }>()).results;
	await c.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id).run(); // folders / files はカスケード
	await deleteR2Keys(c.env, ids.map((f) => r2Key(id, f.id)));
	await revokeUserSessions(c.env, id);
	console.log(JSON.stringify({ audit: 'user.delete', admin: me.id, target: id, files: ids.length, at: now() }));
	return c.json({ ok: true });
});

admin.get('/users/:id/tree', async (c) => {
	const id = c.req.param('id');
	await getUser(c.env, id);
	const fid = c.req.query('folderId');
	const q = c.req.query();
	return c.json(await listChildren(c.env, id, fid && fid !== 'root' ? fid : null, q.sort, q.order, Number(q.page), Number(q.limit)));
});

admin.get('/files/:id/content', async (c) => {
	const f = await getFile(c.env, c.req.param('id'));
	console.log(JSON.stringify({ audit: 'file.download', admin: c.get('user').id, target: f.id, at: now() }));
	return streamFile(c.env, f, c.req.query('download') !== '0');
});

admin.delete('/files/:id', async (c) => {
	const f = await getFile(c.env, c.req.param('id'));
	if (f.is_locked) throw new HttpError(409, 'FILE_LOCKED', '先に編集ロックを解除してください');
	await c.env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(f.id).run();
	await deleteR2Keys(c.env, [r2Key(f.owner_id, f.id)]);
	console.log(JSON.stringify({ audit: 'file.delete', admin: c.get('user').id, target: f.id, at: now() }));
	return c.json({ ok: true });
});

admin.patch('/files/:id/lock', async (c) => {
	const f = await getFile(c.env, c.req.param('id'));
	const b = await c.req.json<{ isLocked?: boolean }>().catch(() => ({}) as { isLocked?: boolean });
	if (typeof b.isLocked !== 'boolean') throw new HttpError(400, 'INVALID_INPUT', 'isLocked が必要です');
	await c.env.DB.prepare('UPDATE files SET is_locked = ?1, locked_by_admin = ?1 WHERE id = ?2').bind(b.isLocked ? 1 : 0, f.id).run();
	console.log(JSON.stringify({ audit: 'file.lock', admin: c.get('user').id, target: f.id, locked: b.isLocked, at: now() }));
	return c.json({ file: fileDto(await getFile(c.env, f.id)) });
});
