import { api, confirmDialog, fmtDate, fmtSize, h, logout, modal, pager, promptDialog, requireLogin, toast } from './common.js';

const user = await requireLogin('/login');
if (!user) throw new Error('redirect');
document.getElementById('who').textContent = user.displayName;
document.getElementById('logout').onclick = () => logout('/');

const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const state = {
	folderId: new URLSearchParams(location.search).get('folder') || 'root',
	view: pref('view', 'list'),
	sort: pref('sort', 'name'),
	order: pref('order', 'asc'),
	page: Number(new URLSearchParams(location.search).get('page')) || 1,
	limit: Number(pref('limit', '50')),
	data: null,
};
const root = document.getElementById('root');
const fileInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '.txt,.md,.csv,.json,.log,.xml,.yaml,.yml,.jpg,.jpeg,.png,.gif,.webp' });
fileInput.addEventListener('change', () => { upload([...fileInput.files]); fileInput.value = ''; });

const run = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, true); } };

async function load(pushState = true) {
	try {
		state.data = await api(`/folders/${state.folderId}/children?sort=${state.sort}&order=${state.order}&page=${state.page}&limit=${state.limit}`);
		state.page = state.data.paging.page;
	} catch (e) {
		if (e.status === 404 && state.folderId !== 'root') { state.folderId = 'root'; return load(); }
		toast(e.message, true);
		return;
	}
	if (pushState) {
		const q = new URLSearchParams();
		if (state.folderId !== 'root') q.set('folder', state.folderId);
		if (state.page > 1) q.set('page', state.page);
		history.replaceState(null, '', '/app' + (q.size ? `?${q}` : ''));
	}
	render();
}

function go(id) { state.folderId = id; state.page = 1; load(); }

const icon = (f) => (f.kind === 'image' ? '🖼️' : '📄');

function render() {
	const d = state.data;
	const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'パンくず' }, h('a', { onclick: () => go('root') }, 'トップ'),
		d.breadcrumbs.map((b) => [h('span', { class: 'sep' }, '›'), h('a', { onclick: () => go(b.id) }, b.name)]));

	const sortSel = h('select', { 'aria-label': '並び替え', onchange: () => { state.sort = sortSel.value; setPref('sort', state.sort); state.page = 1; load(); } },
		[['name', '名前'], ['updated', '更新日時'], ['size', 'サイズ']].map(([v, l]) => h('option', { value: v, selected: v === state.sort }, l)));
	const toolbar = h('div', { class: 'toolbar' },
		h('button', { class: 'primary', onclick: () => fileInput.click() }, '⬆ アップロード'),
		h('button', { onclick: newText }, '＋ テキスト'),
		h('button', { onclick: newFolder }, '＋ フォルダ'),
		h('span', { class: 'grow' }),
		sortSel,
		h('button', { title: '昇順/降順', onclick: () => { state.order = state.order === 'asc' ? 'desc' : 'asc'; setPref('order', state.order); state.page = 1; load(); } }, state.order === 'asc' ? '↑' : '↓'),
		h('button', { class: state.view === 'list' ? 'primary' : '', onclick: () => setView('list') }, '≡ 詳細'),
		h('button', { class: state.view === 'grid' ? 'primary' : '', onclick: () => setView('grid') }, '▦ サムネイル'));

	const empty = !d.folders.length && !d.files.length ? h('p', { class: 'muted' }, 'このフォルダは空です。ファイルをドラッグ＆ドロップしてアップロードできます。') : null;
	const pg = () => pager(d.paging, ({ page, limit }) => {
		if (limit !== state.limit) setPref('limit', limit);
		Object.assign(state, { page, limit });
		load();
		scrollTo(0, 0);
	});
	root.replaceChildren(crumbs, toolbar, pg(), state.view === 'list' ? listView(d) : gridView(d), empty, pg());
}

function setView(v) { state.view = v; setPref('view', v); render(); }

function fileActions(f) {
	return [
		h('button', { class: 'sm', onclick: () => download(f) }, 'DL'),
		h('button', { class: 'sm', disabled: f.isLocked, onclick: () => renameFile(f) }, '名前'),
		h('button', { class: 'sm', disabled: f.isLocked, onclick: () => moveItem('file', f) }, '移動'),
		h('button', { class: 'sm', disabled: f.isLocked && f.lockedByAdmin, title: f.lockedByAdmin ? '管理者によるロック' : '', onclick: () => toggleLock(f) }, f.isLocked ? '🔓解除' : '🔒禁止'),
		h('button', { class: 'sm danger', disabled: f.isLocked, onclick: () => deleteFile(f) }, '削除'),
	];
}
function folderActions(fo) {
	return [
		h('button', { class: 'sm', onclick: () => renameFolder(fo) }, '名前'),
		h('button', { class: 'sm', onclick: () => moveItem('folder', fo) }, '移動'),
		h('button', { class: 'sm danger', onclick: () => deleteFolder(fo) }, '削除'),
	];
}

function listView(d) {
	const rows = [
		...d.folders.map((fo) => h('tr', {},
			h('td', {}, h('span', { class: 'name', onclick: () => go(fo.id) }, '📁 ', fo.name)),
			h('td', { class: 'hide-s' }, 'フォルダ'), h('td', { class: 'hide-s' }, '—'),
			h('td', { class: 'hide-s' }, fmtDate(fo.createdAt)), h('td', {}, fmtDate(fo.updatedAt)),
			h('td', { class: 'actions' }, folderActions(fo)))),
		...d.files.map((f) => h('tr', {},
			h('td', {}, h('span', { class: 'name', onclick: () => preview(f) }, icon(f), ' ', f.name, f.isLocked ? ' 🔒' : '')),
			h('td', { class: 'hide-s' }, f.kind === 'image' ? '画像' : 'テキスト'), h('td', { class: 'hide-s' }, fmtSize(f.size)),
			h('td', { class: 'hide-s' }, fmtDate(f.createdAt)), h('td', {}, fmtDate(f.updatedAt)),
			h('td', { class: 'actions' }, fileActions(f)))),
	];
	return h('table', {}, h('thead', {}, h('tr', {}, ['ファイル名', '種別', 'サイズ', '作成日時', '更新日時', ''].map((t, i) => h('th', { class: i && i < 4 ? 'hide-s' : '' }, t)))), h('tbody', {}, rows));
}

function gridView(d) {
	return h('div', { class: 'grid' },
		d.folders.map((fo) => h('div', { class: 'tile' },
			h('div', { class: 'thumb', onclick: () => go(fo.id) }, '📁'),
			h('div', { class: 'meta' }, h('div', { class: 'fn', title: fo.name }, fo.name), h('div', { class: 'row' }, folderActions(fo))))),
		d.files.map((f) => h('div', { class: 'tile' },
			h('div', { class: 'thumb', onclick: () => preview(f) },
				f.kind === 'image' ? h('img', { src: `/api/files/${f.id}/content`, alt: f.name, loading: 'lazy' }) : '📄'),
			h('div', { class: 'meta' }, h('div', { class: 'fn', title: f.name }, f.isLocked ? '🔒 ' : '', f.name), h('div', { class: 'row' }, fileActions(f))))));
}

/* ---------- 操作 ---------- */
async function newFolder() {
	const name = await promptDialog('新規フォルダ', 'フォルダ名');
	if (name == null) return;
	await run(async () => { await api('/folders', { method: 'POST', json: { name, parentId: state.folderId === 'root' ? null : state.folderId } }); await load(false); });
}
async function newText() {
	const name = await promptDialog('新規テキストファイル', 'ファイル名（拡張子省略時は .txt）');
	if (name == null) return;
	await run(async () => {
		const r = await api('/files/text', { method: 'POST', json: { name, folderId: state.folderId === 'root' ? null : state.folderId, content: '' } });
		await load(false);
		preview(r.file);
	});
}
async function renameFile(f) {
	const name = await promptDialog('名前の変更', 'ファイル名', f.name);
	if (name == null || name === f.name) return;
	await run(async () => { await api(`/files/${f.id}`, { method: 'PATCH', json: { name } }); await load(false); });
}
async function renameFolder(fo) {
	const name = await promptDialog('名前の変更', 'フォルダ名', fo.name);
	if (name == null || name === fo.name) return;
	await run(async () => { await api(`/folders/${fo.id}`, { method: 'PATCH', json: { name } }); await load(false); });
}
async function deleteFile(f) {
	if (!(await confirmDialog(`「${f.name}」を削除しますか？`, '削除', true))) return;
	await run(async () => { await api(`/files/${f.id}`, { method: 'DELETE' }); await load(false); });
}
async function deleteFolder(fo) {
	if (!(await confirmDialog(`「${fo.name}」とその中身をすべて削除しますか？`, '削除', true))) return;
	await run(async () => { await api(`/folders/${fo.id}`, { method: 'DELETE' }); await load(false); });
}
async function toggleLock(f) {
	await run(async () => { await api(`/files/${f.id}`, { method: 'PATCH', json: { isLocked: !f.isLocked } }); await load(false); });
}
function download(f) {
	const a = h('a', { href: `/api/files/${f.id}/content?download=1`, download: f.name });
	document.body.append(a); a.click(); a.remove();
}

async function moveItem(type, item) {
	const { folders } = await run(() => api('/folders')) ?? {};
	if (!folders) return;
	// 自身と配下は移動先にできない
	const banned = new Set();
	if (type === 'folder') {
		banned.add(item.id);
		let grew = true;
		while (grew) { grew = false; for (const f of folders) if (f.parentId && banned.has(f.parentId) && !banned.has(f.id)) { banned.add(f.id); grew = true; } }
	}
	const byId = new Map(folders.map((f) => [f.id, f]));
	const path = (f) => (f.parentId && byId.get(f.parentId) ? path(byId.get(f.parentId)) + ' / ' : '/ ') + f.name;
	let sel = 'root';
	const list = h('div', { class: 'tree-list' });
	const entries = [['root', 'トップ'], ...folders.filter((f) => !banned.has(f.id)).map((f) => [f.id, path(f)]).sort((a, b) => a[1].localeCompare(b[1], 'ja'))];
	const paint = () => list.replaceChildren(...entries.map(([id, label]) => h('div', { class: id === sel ? 'sel' : '', onclick: () => { sel = id; paint(); } }, id === 'root' ? '🏠 ' + label : '📁 ' + label)));
	paint();
	const m = modal([h('h2', {}, `「${item.name}」の移動先`), list,
		h('div', { class: 'foot' }, h('button', { onclick: () => m.close() }, 'キャンセル'),
			h('button', { class: 'primary', onclick: () => run(async () => {
				const key = type === 'file' ? 'folderId' : 'parentId';
				await api(`/${type === 'file' ? 'files' : 'folders'}/${item.id}`, { method: 'PATCH', json: { [key]: sel === 'root' ? null : sel } });
				m.close(); await load(false);
			}) }, '移動'))], { small: true });
}

/* ---------- アップロード ---------- */
async function upload(list) {
	for (const file of list) {
		const send = async (overwrite) => {
			const form = new FormData();
			form.append('file', file);
			form.append('folderId', state.folderId);
			return api(`/files${overwrite ? '?overwrite=true' : ''}`, { method: 'POST', form });
		};
		try {
			await send(false);
			toast(`${file.name} をアップロードしました`);
		} catch (e) {
			if (e.code === 'DUPLICATE') {
				if (await confirmDialog(`「${file.name}」は既に存在します。上書きしますか？`, '上書き', true)) await run(() => send(true));
			} else toast(`${file.name}: ${e.message}`, true);
		}
	}
	load(false);
}
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; root.classList.add('drop'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; root.classList.remove('drop'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; root.classList.remove('drop'); if (e.dataTransfer?.files.length) upload([...e.dataTransfer.files]); });

/* ---------- プレビュー / 編集 ---------- */
async function preview(f) {
	if (f.kind === 'image') return previewImage(f);
	return previewText(f);
}

function infoRow(f) {
	return h('div', { class: 'info' }, h('span', {}, '所有者: ', f.ownerName ?? user.displayName), h('span', {}, fmtSize(f.size)),
		h('span', {}, '作成: ', fmtDate(f.createdAt)), h('span', {}, '更新: ', fmtDate(f.updatedAt)), f.isLocked ? h('span', {}, '🔒 変更禁止') : null);
}

function previewImage(f) {
	const m = modal([h('h2', {}, f.name), h('img', { class: 'preview-img', src: `/api/files/${f.id}/content`, alt: f.name }), infoRow(f),
		h('div', { class: 'foot' }, h('button', { onclick: () => download(f) }, 'ダウンロード'), h('button', { class: 'primary', onclick: () => m.close() }, '閉じる'))]);
}

async function previewText(f) {
	const res = await run(() => api(`/files/${f.id}/content`));
	if (!res) return;
	const text = await res.text();
	const fresh = (await run(() => api(`/files/${f.id}`)))?.file ?? f;
	const editable = !fresh.isLocked && fresh.size <= 1024 * 1024;
	const ta = h('textarea', { 'aria-label': '内容', spellcheck: 'false' });
	ta.value = text;
	ta.readOnly = !editable;
	let current = fresh;
	let saved = text;
	const info = h('div', {}, infoRow(fresh));
	const saveBtn = h('button', { class: 'primary', disabled: !editable, onclick: save }, '保存');
	async function save() {
		const r = await run(() => api(`/files/${f.id}/content`, { method: 'PUT', json: { content: ta.value, expectedUpdatedAt: current.updatedAt } }));
		if (!r) return;
		current = r.file; saved = ta.value;
		info.replaceChildren(infoRow(current));
		toast('保存しました');
		load(false);
	}
	const m = modal([h('h2', {}, f.name, editable ? '' : '（読み取り専用）'), info, ta,
		h('div', { class: 'foot' },
			h('button', { onclick: () => {
				const a = h('a', { href: URL.createObjectURL(new Blob([ta.value], { type: 'text/plain;charset=utf-8' })), download: f.name });
				document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
			} }, 'ダウンロード'),
			saveBtn, h('button', { onclick: () => m.tryClose() }, '閉じる'))],
		{ onClose: () => ta.value === saved || confirm('未保存の変更があります。破棄して閉じますか？') });
	if (editable) ta.focus();
}

addEventListener('popstate', () => { const q = new URLSearchParams(location.search); state.folderId = q.get('folder') || 'root'; state.page = Number(q.get('page')) || 1; load(false); });
await load(false);
