import { HttpError, LIMITS } from './util';

export interface FileRow {
	id: string;
	owner_id: string;
	folder_id: string | null;
	name: string;
	kind: 'text' | 'image';
	mime_type: string;
	size_bytes: number;
	is_locked: number;
	locked_by_admin: number;
	created_at: string;
	updated_at: string;
	owner_name?: string;
}

export interface FolderRow {
	id: string;
	owner_id: string;
	parent_id: string | null;
	name: string;
	created_at: string;
	updated_at: string;
}

export const TEXT_DEFAULT_EXT = '.txt';
export const r2Key = (ownerId: string, fileId: string) => `users/${ownerId}/files/${fileId}`;

export const fileDto = (f: FileRow) => ({
	id: f.id,
	ownerId: f.owner_id,
	ownerName: f.owner_name,
	folderId: f.folder_id,
	name: f.name,
	kind: f.kind,
	mimeType: f.mime_type,
	size: f.size_bytes,
	isLocked: !!f.is_locked,
	lockedByAdmin: !!f.locked_by_admin,
	createdAt: f.created_at,
	updatedAt: f.updated_at,
});

export const folderDto = (f: FolderRow) => ({
	id: f.id,
	parentId: f.parent_id,
	name: f.name,
	createdAt: f.created_at,
	updatedAt: f.updated_at,
});

const FILE_SELECT = `SELECT f.*, u.display_name AS owner_name FROM files f JOIN users u ON u.id = f.owner_id`;

/** ownerId を指定した場合は所有者一致を強制する（他人のリソースは 404） */
export async function getFile(env: Env, id: string, ownerId?: string): Promise<FileRow> {
	const row = ownerId
		? await env.DB.prepare(`${FILE_SELECT} WHERE f.id = ?1 AND f.owner_id = ?2`).bind(id, ownerId).first<FileRow>()
		: await env.DB.prepare(`${FILE_SELECT} WHERE f.id = ?1`).bind(id).first<FileRow>();
	if (!row) throw new HttpError(404, 'NOT_FOUND', 'ファイルが見つかりません');
	return row;
}

export async function getFolder(env: Env, ownerId: string, id: string): Promise<FolderRow> {
	const row = await env.DB.prepare('SELECT * FROM folders WHERE id = ?1 AND owner_id = ?2').bind(id, ownerId).first<FolderRow>();
	if (!row) throw new HttpError(404, 'NOT_FOUND', 'フォルダが見つかりません');
	return row;
}

/** folderId（null=トップ）の深さ。トップ直下のフォルダは 1。 */
export async function folderDepth(env: Env, ownerId: string, folderId: string | null): Promise<number> {
	let depth = 0;
	let cur = folderId;
	while (cur) {
		depth++;
		if (depth > LIMITS.maxFolderDepth + 1) break;
		const f: FolderRow = await getFolder(env, ownerId, cur);
		cur = f.parent_id;
	}
	return depth;
}

/** folderId 自身と全子孫（d = 相対深さ） */
export async function subtree(env: Env, ownerId: string, folderId: string): Promise<{ id: string; d: number }[]> {
	const r = await env.DB.prepare(
		`WITH RECURSIVE sub(id, d) AS (
			SELECT id, 0 FROM folders WHERE id = ?1 AND owner_id = ?2
			UNION ALL
			SELECT f.id, sub.d + 1 FROM folders f JOIN sub ON f.parent_id = sub.id
		) SELECT id, d FROM sub`,
	)
		.bind(folderId, ownerId)
		.all<{ id: string; d: number }>();
	return r.results;
}

const SORTS: Record<string, string> = { name: 'name COLLATE NOCASE', updated: 'updated_at', size: 'size_bytes' };

export async function listChildren(env: Env, ownerId: string, folderId: string | null, sort = 'name', order = 'asc') {
	let folder: FolderRow | null = null;
	const breadcrumbs: { id: string; name: string }[] = [];
	if (folderId) {
		folder = await getFolder(env, ownerId, folderId);
		let cur: FolderRow | null = folder;
		while (cur) {
			breadcrumbs.unshift({ id: cur.id, name: cur.name });
			cur = cur.parent_id ? await getFolder(env, ownerId, cur.parent_id) : null;
		}
	}
	const col = SORTS[sort] ?? SORTS.name;
	const dir = order === 'desc' ? 'DESC' : 'ASC';
	const folderCol = sort === 'updated' ? 'updated_at' : 'name COLLATE NOCASE';
	const [folders, files] = await Promise.all([
		env.DB.prepare(`SELECT * FROM folders WHERE owner_id = ?1 AND COALESCE(parent_id,'') = COALESCE(?2,'') ORDER BY ${folderCol} ${dir}`)
			.bind(ownerId, folderId)
			.all<FolderRow>(),
		env.DB.prepare(`${FILE_SELECT} WHERE f.owner_id = ?1 AND COALESCE(f.folder_id,'') = COALESCE(?2,'') ORDER BY f.${col} ${dir}`)
			.bind(ownerId, folderId)
			.all<FileRow>(),
	]);
	return {
		folder: folder ? folderDto(folder) : null,
		breadcrumbs,
		folders: folders.results.map(folderDto),
		files: files.results.map(fileDto),
	};
}

export async function usedBytes(env: Env, ownerId: string): Promise<number> {
	const r = await env.DB.prepare('SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_id = ?1').bind(ownerId).first<{ s: number }>();
	return r?.s ?? 0;
}

export async function assertQuota(env: Env, ownerId: string, addBytes: number) {
	if (addBytes <= 0) return;
	if ((await usedBytes(env, ownerId)) + addBytes > LIMITS.userQuotaBytes) {
		throw new HttpError(413, 'QUOTA_EXCEEDED', '使用容量の上限(1GB)を超えます');
	}
}

export function assertMutable(f: FileRow) {
	if (f.is_locked) throw new HttpError(403, 'FILE_LOCKED', 'このファイルは変更禁止です');
}

export async function deleteR2Keys(env: Env, keys: string[]) {
	for (let i = 0; i < keys.length; i += 1000) {
		try {
			await env.FILES.delete(keys.slice(i, i + 1000));
		} catch (e) {
			// D1 行は既に削除済み。孤児は日次 GC で回収する
			console.error('r2 delete failed', e);
		}
	}
}

export function contentDisposition(name: string, download: boolean): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export async function streamFile(env: Env, f: FileRow, download: boolean): Promise<Response> {
	const obj = await env.FILES.get(r2Key(f.owner_id, f.id));
	if (!obj) throw new HttpError(404, 'NOT_FOUND', 'ファイル本体が見つかりません');
	const headers = new Headers({
		'Content-Type': f.kind === 'text' ? 'text/plain; charset=utf-8' : f.mime_type,
		'Content-Length': String(obj.size),
		'Content-Disposition': contentDisposition(f.name, download),
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': "default-src 'none'; sandbox",
	});
	return new Response(obj.body, { headers });
}
