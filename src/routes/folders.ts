import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../middleware/auth';
import { HttpError, LIMITS, isUniqueError, now, validateName } from '../lib/util';
import { deleteR2Keys, folderDepth, folderDto, getFolder, listChildren, r2Key, subtree, type FolderRow } from '../lib/storage';

export const folders = new Hono<AppEnv>();
folders.use('*', requireUser);

// 移動ダイアログ用: 全フォルダのフラット一覧
folders.get('/', async (c) => {
	const r = await c.env.DB.prepare('SELECT * FROM folders WHERE owner_id = ?1 ORDER BY name COLLATE NOCASE').bind(c.get('user').id).all<FolderRow>();
	return c.json({ folders: r.results.map(folderDto) });
});

folders.get('/:id/children', async (c) => {
	const id = c.req.param('id');
	const q = c.req.query();
	return c.json(await listChildren(c.env, c.get('user').id, id === 'root' ? null : id, q.sort, q.order));
});

folders.post('/', async (c) => {
	const uid = c.get('user').id;
	const b = await c.req.json<{ name?: string; parentId?: string | null }>().catch(() => ({}) as { name?: string; parentId?: string | null });
	const name = validateName(b.name, 'フォルダ名');
	const parentId = b.parentId ?? null;
	if (parentId) await getFolder(c.env, uid, parentId);
	if ((await folderDepth(c.env, uid, parentId)) + 1 > LIMITS.maxFolderDepth) {
		throw new HttpError(400, 'TOO_DEEP', `フォルダは${LIMITS.maxFolderDepth}階層までです`);
	}
	const id = crypto.randomUUID();
	const t = now();
	try {
		await c.env.DB.prepare('INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)')
			.bind(id, uid, parentId, name, t)
			.run();
	} catch (e) {
		if (isUniqueError(e)) throw new HttpError(409, 'DUPLICATE', '同名のフォルダが既に存在します');
		throw e;
	}
	return c.json({ folder: folderDto(await getFolder(c.env, uid, id)) }, 201);
});

folders.patch('/:id', async (c) => {
	const uid = c.get('user').id;
	const id = c.req.param('id');
	const f = await getFolder(c.env, uid, id);
	const b = await c.req.json<{ name?: string; parentId?: string | null }>().catch(() => ({}) as { name?: string; parentId?: string | null });
	const name = b.name !== undefined ? validateName(b.name, 'フォルダ名') : f.name;
	let parentId = f.parent_id;
	if (b.parentId !== undefined) {
		parentId = b.parentId;
		if (parentId) {
			await getFolder(c.env, uid, parentId);
			const sub = await subtree(c.env, uid, id);
			if (sub.some((s) => s.id === parentId)) throw new HttpError(400, 'CYCLE', '自身または配下のフォルダには移動できません');
			const height = Math.max(...sub.map((s) => s.d)) + 1;
			if ((await folderDepth(c.env, uid, parentId)) + height > LIMITS.maxFolderDepth) {
				throw new HttpError(400, 'TOO_DEEP', `フォルダは${LIMITS.maxFolderDepth}階層までです`);
			}
		}
	}
	try {
		await c.env.DB.prepare('UPDATE folders SET name = ?1, parent_id = ?2, updated_at = ?3 WHERE id = ?4 AND owner_id = ?5')
			.bind(name, parentId, now(), id, uid)
			.run();
	} catch (e) {
		if (isUniqueError(e)) throw new HttpError(409, 'DUPLICATE', '同名のフォルダが既に存在します');
		throw e;
	}
	return c.json({ folder: folderDto(await getFolder(c.env, uid, id)) });
});

folders.delete('/:id', async (c) => {
	const uid = c.get('user').id;
	const id = c.req.param('id');
	await getFolder(c.env, uid, id);
	const ids = (await subtree(c.env, uid, id)).map((s) => s.id);
	const ph = ids.map((_, i) => `?${i + 2}`).join(',');
	const files = await c.env.DB.prepare(`SELECT id, is_locked FROM files WHERE owner_id = ?1 AND folder_id IN (${ph})`)
		.bind(uid, ...ids)
		.all<{ id: string; is_locked: number }>();
	if (files.results.some((f) => f.is_locked)) {
		throw new HttpError(409, 'CONTAINS_LOCKED', '変更禁止のファイルが含まれているため削除できません');
	}
	await c.env.DB.prepare('DELETE FROM folders WHERE id = ?1 AND owner_id = ?2').bind(id, uid).run(); // files はカスケード
	await deleteR2Keys(c.env, files.results.map((f) => r2Key(uid, f.id)));
	return c.json({ ok: true });
});
