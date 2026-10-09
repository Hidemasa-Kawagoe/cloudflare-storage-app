import type { SessionData } from '../env';
import { randomToken, now } from './util';

export async function createSession(env: Env, userId: string, ttl: number) {
	const id = randomToken(32);
	const data: SessionData = { userId, csrf: randomToken(24), createdAt: now() };
	await Promise.all([
		env.SESSIONS.put(`sess:${id}`, JSON.stringify(data), { expirationTtl: ttl }),
		env.SESSIONS.put(`usess:${userId}:${id}`, '', { expirationTtl: ttl }),
	]);
	return { id, data };
}

export async function getSession(env: Env, id: string): Promise<SessionData | null> {
	return env.SESSIONS.get<SessionData>(`sess:${id}`, 'json');
}

export async function deleteSession(env: Env, id: string, userId?: string) {
	await env.SESSIONS.delete(`sess:${id}`);
	if (userId) await env.SESSIONS.delete(`usess:${userId}:${id}`);
}

export async function revokeUserSessions(env: Env, userId: string, except?: string) {
	let cursor: string | undefined;
	do {
		const page = await env.SESSIONS.list({ prefix: `usess:${userId}:`, cursor });
		for (const k of page.keys) {
			const sid = k.name.split(':')[2];
			if (sid === except) continue;
			await env.SESSIONS.delete(`sess:${sid}`);
			await env.SESSIONS.delete(k.name);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
}
