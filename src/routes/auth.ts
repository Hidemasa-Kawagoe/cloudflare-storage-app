import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { COOKIE_PLAIN, COOKIE_SECURE, requireUser } from '../middleware/auth';
import { dummyVerify, verifyPassword } from '../lib/password';
import { createSession, deleteSession } from '../lib/session';
import { HttpError, LIMITS, sha256Hex } from '../lib/util';

const MAX_FAILS = 5;
const LOCK_SECONDS = 900;

export const auth = new Hono<AppEnv>();

async function login(c: import('hono').Context<AppEnv>, adminOnly: boolean) {
	const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
	const email = typeof body.email === 'string' ? body.email.trim() : '';
	const password = typeof body.password === 'string' ? body.password : '';
	if (!email || !password || password.length > 128) throw new HttpError(400, 'INVALID_INPUT', 'メールアドレスとパスワードを入力してください');

	const ip = c.req.header('CF-Connecting-IP') ?? 'local';
	const rlKey = `rl:login:${await sha256Hex(`${email.toLowerCase()}|${ip}`)}`;
	const fails = Number((await c.env.SESSIONS.get(rlKey)) ?? 0);
	if (fails >= MAX_FAILS) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '試行回数が多すぎます。しばらくしてからお試しください');

	const u = await c.env.DB.prepare('SELECT id, display_name, email, password_hash, is_admin FROM users WHERE email = ?1')
		.bind(email)
		.first<{ id: string; display_name: string; email: string; password_hash: string; is_admin: number }>();
	let ok = false;
	if (u) ok = (await verifyPassword(password, u.password_hash)) && (!adminOnly || !!u.is_admin);
	else await dummyVerify(password);

	if (!ok || !u) {
		await c.env.SESSIONS.put(rlKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
		throw new HttpError(401, 'INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが違います');
	}
	await c.env.SESSIONS.delete(rlKey);

	const ttl = adminOnly ? LIMITS.maxSessionTtlAdmin : LIMITS.maxSessionTtlUser;
	const { id, data } = await createSession(c.env, u.id, ttl);
	const secure = new URL(c.req.url).protocol === 'https:';
	setCookie(c, secure ? COOKIE_SECURE : COOKIE_PLAIN, id, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: ttl });
	return c.json({
		user: { id: u.id, displayName: u.display_name, email: u.email, isAdmin: !!u.is_admin },
		csrfToken: data.csrf,
	});
}

auth.post('/login', (c) => login(c, false));
auth.post('/admin-login', (c) => login(c, true));

auth.post('/logout', requireUser, async (c) => {
	await deleteSession(c.env, c.get('sessionId'), c.get('user').id);
	deleteCookie(c, COOKIE_SECURE, { path: '/', secure: true });
	deleteCookie(c, COOKIE_PLAIN, { path: '/' });
	return c.json({ ok: true });
});

auth.get('/me', requireUser, (c) => c.json({ user: c.get('user'), csrfToken: c.get('session').csrf }));
