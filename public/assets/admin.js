import { api, confirmDialog, fmtDate, fmtSize, h, logout, modal, requireLogin, toast } from './common.js';

const me = await requireLogin('/admin/login', true);
if (!me) throw new Error('redirect');
document.getElementById('who').textContent = me.displayName;
document.getElementById('logout').onclick = () => logout('/admin/login');

const root = document.getElementById('root');
const run = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, true); } };
let tab = 'users';
const fstate = { userId: '', folderId: 'root', users: [] };

function shell(body) {
	const tabs = h('div', { class: 'tabs' },
		h('button', { class: tab === 'users' ? 'on' : '', onclick: () => { tab = 'users'; showUsers(); } }, 'ユーザー管理'),
		h('button', { class: tab === 'files' ? 'on' : '', onclick: () => { tab = 'files'; showFiles(); } }, 'ファイル管理'));
	root.replaceChildren(tabs, body);
}

/* ---------- ユーザー管理 ---------- */
async function showUsers() {
	const r = await run(() => api('/admin/users'));
	if (!r) return;
	fstate.users = r.users;
	const rows = r.users.map((u) => h('tr', {},
		h('td', {}, u.displayName), h('td', {}, u.email), h('td', {}, u.isAdmin ? '管理者' : ''),
		h('td', { class: 'hide-s' }, `${u.fileCount} 件 / ${fmtSize(u.usedBytes)}`), h('td', { class: 'hide-s' }, fmtDate(u.createdAt)),
		h('td', { class: 'actions' },
			h('button', { class: 'sm', onclick: () => userForm(u) }, '編集'),
			h('button', { class: 'sm', onclick: () => { fstate.userId = u.id; fstate.folderId = 'root'; tab = 'files'; showFiles(); } }, 'ファイル'),
			h('button', { class: 'sm danger', disabled: u.id === me.id, onclick: () => delUser(u) }, '削除'))));
	shell(h('div', {},
		h('div', { class: 'toolbar' }, h('button', { class: 'primary', onclick: () => userForm(null) }, '＋ ユーザー登録')),
		h('table', {}, h('thead', {}, h('tr', {}, ['表示名', 'メールアドレス', '権限', 'ファイル', '登録日', ''].map((t, i) => h('th', { class: i > 2 && i < 5 ? 'hide-s' : '' }, t)))), h('tbody', {}, rows))));
}

function userForm(u) {
	const name = h('input', { type: 'text', value: u?.displayName ?? '', maxlength: 50 });
	const email = h('input', { type: 'email', value: u?.email ?? '' });
	const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: u ? '変更する場合のみ入力' : '10文字以上' });
	const adm = h('input', { type: 'checkbox', checked: !!u?.isAdmin });
	const err = h('div', { class: 'err', role: 'alert' });
	const m = modal(h('form', {
		onsubmit: async (e) => {
			e.preventDefault();
			const json = { displayName: name.value, email: email.value, isAdmin: adm.checked };
			if (pw.value || !u) json.password = pw.value;
			try {
				await api(u ? `/admin/users/${u.id}` : '/admin/users', { method: u ? 'PATCH' : 'POST', json });
				m.close(); toast('保存しました'); showUsers();
			} catch (ex) { err.textContent = ex.message; }
		},
	}, h('h2', {}, u ? 'ユーザー編集' : 'ユーザー登録'),
		u ? h('div', { class: 'muted' }, 'GUID: ', u.id) : null,
		h('label', {}, '表示名'), name, h('label', {}, 'メールアドレス'), email, h('label', {}, 'パスワード'), pw,
		h('label', {}, adm, ' 管理者'), err,
		h('div', { class: 'foot' }, h('button', { type: 'button', onclick: () => m.close() }, 'キャンセル'), h('button', { class: 'primary', type: 'submit' }, '保存'))), { small: true });
	name.focus();
}

async function delUser(u) {
	if (!(await confirmDialog(`「${u.displayName}」を削除します。このユーザーの全ファイル(${u.fileCount}件)も削除されます。よろしいですか？`, '削除', true))) return;
	await run(async () => { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); toast('削除しました'); await showUsers(); });
}

/* ---------- ファイル管理 ---------- */
async function showFiles() {
	if (!fstate.users.length) fstate.users = (await run(() => api('/admin/users')))?.users ?? [];
	if (!fstate.userId) fstate.userId = fstate.users[0]?.id ?? '';
	const sel = h('select', { 'aria-label': 'ユーザー', onchange: () => { fstate.userId = sel.value; fstate.folderId = 'root'; showFiles(); } },
		fstate.users.map((u) => h('option', { value: u.id, selected: u.id === fstate.userId }, `${u.displayName} <${u.email}>`)));
	if (!fstate.userId) return shell(h('p', { class: 'muted' }, 'ユーザーがいません'));

	const d = await run(() => api(`/admin/users/${fstate.userId}/tree?folderId=${fstate.folderId}`));
	if (!d) { fstate.folderId = 'root'; return shell(sel); }
	const go = (id) => { fstate.folderId = id; showFiles(); };
	const crumbs = h('nav', { class: 'crumbs' }, h('a', { onclick: () => go('root') }, 'トップ'),
		d.breadcrumbs.map((b) => [h('span', { class: 'sep' }, '›'), h('a', { onclick: () => go(b.id) }, b.name)]));
	const rows = [
		...d.folders.map((fo) => h('tr', {}, h('td', {}, h('span', { class: 'name', onclick: () => go(fo.id) }, '📁 ', fo.name)),
			h('td', { class: 'hide-s' }, '—'), h('td', {}, fmtDate(fo.updatedAt)), h('td', {}, ''))),
		...d.files.map((f) => h('tr', {},
			h('td', {}, (f.kind === 'image' ? '🖼️ ' : '📄 ') + f.name, f.isLocked ? (f.lockedByAdmin ? ' 🔒(管理者)' : ' 🔒') : ''),
			h('td', { class: 'hide-s' }, fmtSize(f.size)), h('td', {}, fmtDate(f.updatedAt)),
			h('td', { class: 'actions' },
				h('a', { class: 'btn sm', href: `/api/admin/files/${f.id}/content`, download: f.name }, 'ダウンロード'), ' ',
				h('button', { class: 'sm', onclick: () => lock(f) }, f.isLocked ? '🔓 ロック解除' : '🔒 編集ロック'), ' ',
				h('button', { class: 'sm danger', onclick: () => delFile(f) }, '削除')))),
	];
	shell(h('div', {}, h('div', { class: 'toolbar' }, sel), crumbs,
		h('table', {}, h('thead', {}, h('tr', {}, ['名前', 'サイズ', '更新日時', ''].map((t, i) => h('th', { class: i === 1 ? 'hide-s' : '' }, t)))), h('tbody', {}, rows)),
		rows.length ? null : h('p', { class: 'muted' }, 'ファイルがありません')));
}

async function lock(f) {
	await run(async () => { await api(`/admin/files/${f.id}/lock`, { method: 'PATCH', json: { isLocked: !f.isLocked } }); await showFiles(); });
}
async function delFile(f) {
	if (f.isLocked) return toast('先に編集ロックを解除してください', true);
	if (!(await confirmDialog(`「${f.name}」を削除しますか？`, '削除', true))) return;
	await run(async () => { await api(`/admin/files/${f.id}`, { method: 'DELETE' }); await showFiles(); });
}

showUsers();
