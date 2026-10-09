import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { getSession, deleteSession } from '../lib/session';
import { HttpError } from '../lib/util';

export const COOKIE_SECURE = '__Host-sid';
export const COOKIE_PLAIN = 'sid'; // http://localhost 開発用

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 状態変更系リクエストの Origin が自ホストであることを検証 */
export const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (!SAFE.has(c.req.method)) {
		const origin = c.req.header('Origin');
		if (origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, 'BAD_ORIGIN', '不正なリクエスト元です');
	}
	await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
	const sid = getCookie(c, COOKIE_SECURE) ?? getCookie(c, COOKIE_PLAIN);
	if (!sid) throw new HttpError(401, 'UNAUTHENTICATED', 'ログインが必要です');
	const session = await getSession(c.env, sid);
	if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'ログインが必要です');

	const u = await c.env.DB.prepare('SELECT id, display_name, email, is_admin FROM users WHERE id = ?1')
		.bind(session.userId)
		.first<{ id: string; display_name: string; email: string; is_admin: number }>();
	if (!u) {
		await deleteSession(c.env, sid, session.userId);
		throw new HttpError(401, 'UNAUTHENTICATED', 'ログインが必要です');
	}

	if (!SAFE.has(c.req.method) && c.req.header('X-CSRF-Token') !== session.csrf) {
		throw new HttpError(403, 'BAD_CSRF', 'CSRFトークンが不正です');
	}

	c.set('user', { id: u.id, displayName: u.display_name, email: u.email, isAdmin: !!u.is_admin });
	c.set('session', session);
	c.set('sessionId', sid);
	await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	await requireUser(c, async () => {
		if (!c.get('user').isAdmin) throw new HttpError(403, 'FORBIDDEN', '管理者権限が必要です');
		await next();
	});
};
