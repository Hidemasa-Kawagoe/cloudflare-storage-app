import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../middleware/auth';
import { HttpError, LIMITS, isUniqueError, now, validateName } from '../lib/util';
import { extOf, isValidUtf8, kindOfName, matchesImageMagic, mimeFor, type Kind } from '../lib/mime';
import { assertMutable, assertQuota, fileDto, getFile, getFolder, r2Key, streamFile, deleteR2Keys, TEXT_DEFAULT_EXT } from '../lib/storage';

export const files = new Hono<AppEnv>();
files.use('*', requireUser);

function duplicate(e: unknown): never {
	if (isUniqueError(e)) throw new HttpError(409, 'DUPLICATE', '同名のファイルが既に存在します');
	throw e;
}

function checkContent(name: string, bytes: Uint8Array): { kind: Kind; mime: string } {
	const kind = kindOfName(name);
	if (!kind) throw new HttpError(415, 'UNSUPPORTED_TYPE', 'テキストまたは画像(JPEG/PNG/GIF/WebP)のみ保存できます');
	if (kind === 'image' && !matchesImageMagic(bytes, extOf(name))) {
		throw new HttpError(415, 'CONTENT_MISMATCH', 'ファイルの内容が拡張子と一致しません');
	}
	if (kind === 'text' && !isValidUtf8(bytes)) throw new HttpError(415, 'NOT_UTF8', 'テキストはUTF-8のみ対応しています');
	return { kind, mime: mimeFor(name) };
}

async function putR2(env: Env, ownerId: string, id: string, bytes: Uint8Array, mime: string) {
	await env.FILES.put(r2Key(ownerId, id), bytes, {
		httpMetadata: { contentType: mime },
		customMetadata: { ownerId, fileId: id },
	});
}

// アップロード（multipart: file, folderId?）。?overwrite=true で同名を上書き
files.post('/', async (c) => {
	const uid = c.get('user').id;
	const len = Number(c.req.header('Content-Length') ?? 0);
	if (len > LIMITS.maxFileBytes + 64 * 1024) throw new HttpError(413, 'TOO_LARGE', 'ファイルサイズの上限(25MB)を超えています');
	const form = await c.req.formData().catch(() => null);
	const file = form?.get('file');
	if (!form || !(file instanceof File)) throw new HttpError(400, 'INVALID_INPUT', 'file が必要です');
	if (file.size > LIMITS.maxFileBytes) throw new HttpError(413, 'TOO_LARGE', 'ファイルサイズの上限(25MB)を超えています');

	const name = validateName(file.name.split(/[\\/]/).pop(), 'ファイル名');
	const folderIdRaw = form.get('folderId');
	const folderId = typeof folderIdRaw === 'string' && folderIdRaw && folderIdRaw !== 'root' ? folderIdRaw : null;
	if (folderId) await getFolder(c.env, uid, folderId);

	const bytes = new Uint8Array(await file.arrayBuffer());
	const { kind, mime } = checkContent(name, bytes);

	const existing = await c.env.DB.prepare("SELECT * FROM files WHERE owner_id = ?1 AND COALESCE(folder_id,'') = COALESCE(?2,'') AND name = ?3")
		.bind(uid, folderId, name)
		.first<{ id: string; kind: string; is_locked: number; size_bytes: number }>();
	const t = now();

	if (existing) {
		if (c.req.query('overwrite') !== 'true') throw new HttpError(409, 'DUPLICATE', '同名のファイルが既に存在します');
		const cur = await getFile(c.env, existing.id, uid);
		assertMutable(cur);
		if (cur.kind !== kind) throw new HttpError(400, 'KIND_MISMATCH', 'ファイル種別が異なるため上書きできません');
		await assertQuota(c.env, uid, bytes.byteLength - cur.size_bytes);
		await putR2(c.env, uid, cur.id, bytes, mime);
		await c.env.DB.prepare('UPDATE files SET size_bytes = ?1, updated_at = ?2 WHERE id = ?3').bind(bytes.byteLength, t, cur.id).run();
		return c.json({ file: fileDto(await getFile(c.env, cur.id, uid)) });
	}

	await assertQuota(c.env, uid, bytes.byteLength);
	const id = crypto.randomUUID();
	await putR2(c.env, uid, id, bytes, mime);
	try {
		await c.env.DB.prepare(
			'INSERT INTO files (id, owner_id, folder_id, name, kind, mime_type, size_bytes, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)',
		)
			.bind(id, uid, folderId, name, kind, mime, bytes.byteLength, t)
			.run();
	} catch (e) {
		await c.env.FILES.delete(r2Key(uid, id)); // 補償
		duplicate(e);
	}
	return c.json({ file: fileDto(await getFile(c.env, id, uid)) }, 201);
});

// 新規テキスト作成
files.post('/text', async (c) => {
	const uid = c.get('user').id;
	const b = await c.req.json<{ name?: string; folderId?: string | null; content?: string }>().catch(() => ({}) as { name?: string; folderId?: string | null; content?: string });
	let name = validateName(b.name, 'ファイル名');
	if (!extOf(name)) name += TEXT_DEFAULT_EXT;
	if (kindOfName(name) !== 'text') throw new HttpError(415, 'UNSUPPORTED_TYPE', 'テキストファイルの拡張子を指定してください');
	const folderId = b.folderId && b.folderId !== 'root' ? b.folderId : null;
	if (folderId) await getFolder(c.env, uid, folderId);
	const bytes = new TextEncoder().encode(typeof b.content === 'string' ? b.content : '');
	if (bytes.byteLength > LIMITS.maxEditBytes) throw new HttpError(413, 'TOO_LARGE', 'テキストの上限(1MB)を超えています');
	await assertQuota(c.env, uid, bytes.byteLength);

	const id = crypto.randomUUID();
	const t = now();
	await putR2(c.env, uid, id, bytes, 'text/plain');
	try {
		await c.env.DB.prepare(
			"INSERT INTO files (id, owner_id, folder_id, name, kind, mime_type, size_bytes, created_at, updated_at) VALUES (?1,?2,?3,?4,'text','text/plain',?5,?6,?6)",
		)
			.bind(id, uid, folderId, name, bytes.byteLength, t)
			.run();
	} catch (e) {
		await c.env.FILES.delete(r2Key(uid, id));
		duplicate(e);
	}
	return c.json({ file: fileDto(await getFile(c.env, id, uid)) }, 201);
});

files.get('/:id', async (c) => c.json({ file: fileDto(await getFile(c.env, c.req.param('id'), c.get('user').id)) }));

files.get('/:id/content', async (c) => {
	const f = await getFile(c.env, c.req.param('id'), c.get('user').id);
	return streamFile(c.env, f, c.req.query('download') === '1');
});

// テキスト保存
files.put('/:id/content', async (c) => {
	const uid = c.get('user').id;
	const f = await getFile(c.env, c.req.param('id'), uid);
	assertMutable(f);
	if (f.kind !== 'text') throw new HttpError(400, 'NOT_TEXT', 'テキストファイルではありません');
	const b = await c.req.json<{ content?: string; expectedUpdatedAt?: string }>().catch(() => ({}) as { content?: string; expectedUpdatedAt?: string });
	if (typeof b.content !== 'string') throw new HttpError(400, 'INVALID_INPUT', 'content が必要です');
	if (b.expectedUpdatedAt !== f.updated_at) throw new HttpError(409, 'CONFLICT', '他の場所で更新されています。開き直してください');
	const bytes = new TextEncoder().encode(b.content);
	if (bytes.byteLength > LIMITS.maxEditBytes) throw new HttpError(413, 'TOO_LARGE', 'テキストの上限(1MB)を超えています');
	await assertQuota(c.env, uid, bytes.byteLength - f.size_bytes);
	await putR2(c.env, uid, f.id, bytes, 'text/plain');
	await c.env.DB.prepare('UPDATE files SET size_bytes = ?1, updated_at = ?2 WHERE id = ?3').bind(bytes.byteLength, now(), f.id).run();
	return c.json({ file: fileDto(await getFile(c.env, f.id, uid)) });
});

// 名前変更 / 移動 / ロック
files.patch('/:id', async (c) => {
	const uid = c.get('user').id;
	const f = await getFile(c.env, c.req.param('id'), uid);
	const b = await c.req.json<{ name?: string; folderId?: string | null; isLocked?: boolean }>().catch(() => ({}) as { name?: string; folderId?: string | null; isLocked?: boolean });

	const changesLocation = b.name !== undefined || b.folderId !== undefined;
	if (changesLocation) assertMutable(f);

	let isLocked = f.is_locked;
	let lockedByAdmin = f.locked_by_admin;
	if (b.isLocked !== undefined) {
		if (b.isLocked) {
			isLocked = 1;
		} else {
			if (f.locked_by_admin) throw new HttpError(403, 'LOCKED_BY_ADMIN', '管理者によるロックは解除できません');
			isLocked = 0;
		}
	}

	let name = f.name;
	if (b.name !== undefined) {
		name = validateName(b.name, 'ファイル名');
		if (kindOfName(name) !== f.kind) throw new HttpError(400, 'KIND_MISMATCH', '拡張子の種別を変更することはできません');
	}
	let folderId = f.folder_id;
	if (b.folderId !== undefined) {
		folderId = b.folderId && b.folderId !== 'root' ? b.folderId : null;
		if (folderId) await getFolder(c.env, uid, folderId);
	}
	try {
		await c.env.DB.prepare('UPDATE files SET name = ?1, folder_id = ?2, is_locked = ?3, locked_by_admin = ?4, updated_at = ?5 WHERE id = ?6')
			.bind(name, folderId, isLocked, lockedByAdmin, changesLocation || b.isLocked !== undefined ? now() : f.updated_at, f.id)
			.run();
	} catch (e) {
		duplicate(e);
	}
	return c.json({ file: fileDto(await getFile(c.env, f.id, uid)) });
});

files.delete('/:id', async (c) => {
	const uid = c.get('user').id;
	const f = await getFile(c.env, c.req.param('id'), uid);
	assertMutable(f);
	await c.env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(f.id).run();
	await deleteR2Keys(c.env, [r2Key(uid, f.id)]);
	return c.json({ ok: true });
});
