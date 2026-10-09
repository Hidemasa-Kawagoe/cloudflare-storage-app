import { Hono } from 'hono';
import type { AppEnv } from './env';
import { admin } from './routes/admin';
import { auth } from './routes/auth';
import { files } from './routes/files';
import { folders } from './routes/folders';
import { originCheck } from './middleware/auth';
import { HttpError } from './lib/util';

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
	await next();
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	c.header('Referrer-Policy', 'same-origin');
	c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});
app.use('/api/*', originCheck);

app.route('/api/auth', auth);
app.route('/api/folders', folders);
app.route('/api/files', files);
app.route('/api/admin', admin);

app.onError((err, c) => {
	if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
	console.error(err);
	return c.json({ error: { code: 'INTERNAL', message: 'サーバーエラーが発生しました' } }, 500);
});
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not Found' } }, 404));

// 日次 GC: D1 に存在しない R2 オブジェクト（孤児）を削除
async function collectOrphans(env: Env) {
	let cursor: string | undefined;
	const cutoff = Date.now() - 3600_000; // アップロード途中のものは対象外
	do {
		const page = await env.FILES.list({ prefix: 'users/', cursor, limit: 500 });
		const cands = page.objects.filter((o) => o.uploaded.getTime() < cutoff);
		if (cands.length) {
			const ids = cands.map((o) => o.key.split('/')[3]);
			const found = new Set<string>();
			for (let i = 0; i < ids.length; i += 90) {
				const chunk = ids.slice(i, i + 90);
				const r = await env.DB.prepare(`SELECT id FROM files WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(',')})`)
					.bind(...chunk)
					.all<{ id: string }>();
				r.results.forEach((x) => found.add(x.id));
			}
			const orphans = cands.filter((o) => !found.has(o.key.split('/')[3])).map((o) => o.key);
			if (orphans.length) {
				await env.FILES.delete(orphans);
				console.log(JSON.stringify({ gc: 'orphans_deleted', count: orphans.length }));
			}
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export default {
	fetch: app.fetch,
	async scheduled(_ev, env, ctx) {
		ctx.waitUntil(collectOrphans(env));
	},
} satisfies ExportedHandler<Env>;
