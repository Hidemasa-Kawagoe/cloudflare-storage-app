export function h(tag, attrs = {}, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === false || v == null) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (k === 'value') el.value = v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of kids.flat()) {
		if (kid == null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}

let csrf = '';
export const setCsrf = (t) => (csrf = t);

export async function api(path, { method = 'GET', json, form } = {}) {
	const headers = {};
	if (csrf) headers['X-CSRF-Token'] = csrf;
	let body;
	if (json !== undefined) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(json);
	} else if (form) body = form;
	const res = await fetch('/api' + path, { method, headers, body, credentials: 'same-origin' });
	if (!res.ok) {
		let e = {};
		try { e = (await res.json()).error ?? {}; } catch {}
		const err = new Error(e.message ?? `エラー (${res.status})`);
		err.status = res.status;
		err.code = e.code;
		throw err;
	}
	return res.headers.get('content-type')?.includes('application/json') ? res.json() : res;
}

/** ログイン確認。未ログインなら loginUrl へ遷移して null を返す */
export async function requireLogin(loginUrl, needAdmin = false) {
	try {
		const r = await api('/auth/me');
		setCsrf(r.csrfToken);
		if (needAdmin && !r.user.isAdmin) throw new Error('forbidden');
		return r.user;
	} catch {
		location.replace(loginUrl);
		return null;
	}
}

export function fmtDate(iso) {
	return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function fmtSize(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function toast(msg, isErr = false) {
	const t = h('div', { class: 'toast' + (isErr ? ' error' : ''), role: 'status' }, msg);
	document.body.append(t);
	setTimeout(() => t.remove(), isErr ? 5000 : 2500);
}

/** モーダル表示。戻り値の close() で閉じる。onClose が false を返すと閉じない */
export function modal(content, { small = false, onClose } = {}) {
	const overlay = h('div', { class: 'overlay' });
	const dlg = h('div', { class: 'dialog' + (small ? ' small' : ''), role: 'dialog', 'aria-modal': 'true' }, content);
	overlay.append(dlg);
	const close = (force = false) => {
		if (!force && onClose && onClose() === false) return;
		overlay.remove();
		document.removeEventListener('keydown', esc);
	};
	const esc = (e) => e.key === 'Escape' && close();
	overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
	document.addEventListener('keydown', esc);
	document.body.append(overlay);
	return { close: () => close(true), tryClose: () => close(false), dlg };
}

export function confirmDialog(message, okLabel = 'OK', danger = false) {
	return new Promise((resolve) => {
		const m = modal(
			[
				h('p', {}, message),
				h('div', { class: 'foot' },
					h('button', { onclick: () => (m.close(), resolve(false)) }, 'キャンセル'),
					h('button', { class: danger ? 'primary danger' : 'primary', onclick: () => (m.close(), resolve(true)) }, okLabel)),
			],
			{ small: true, onClose: () => (resolve(false), true) },
		);
	});
}

export function promptDialog(title, label, initial = '') {
	return new Promise((resolve) => {
		const input = h('input', { type: 'text', value: initial });
		const done = (v) => (m.close(), resolve(v));
		const m = modal(
			h('form', { onsubmit: (e) => (e.preventDefault(), done(input.value)) },
				h('h2', {}, title), h('label', {}, label), input,
				h('div', { class: 'foot' },
					h('button', { type: 'button', onclick: () => done(null) }, 'キャンセル'),
					h('button', { class: 'primary', type: 'submit' }, 'OK'))),
			{ small: true, onClose: () => (resolve(null), true) },
		);
		input.focus();
		input.select();
	});
}

export async function logout(redirect) {
	try { await api('/auth/logout', { method: 'POST' }); } catch {}
	location.replace(redirect);
}

export function loginForm(endpoint, redirect, title) {
	const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
	const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
	const err = h('div', { class: 'err', role: 'alert' });
	const btn = h('button', { class: 'primary', type: 'submit' }, 'ログイン');
	const form = h('form', {
		onsubmit: async (e) => {
			e.preventDefault();
			btn.disabled = true;
			err.textContent = '';
			try {
				await api(endpoint, { method: 'POST', json: { email: email.value, password: pw.value } });
				location.assign(redirect);
			} catch (ex) {
				err.textContent = ex.message;
				btn.disabled = false;
			}
		},
	}, h('h1', { class: 'card-title' }, title),
		h('label', {}, 'メールアドレス'), email, h('label', {}, 'パスワード'), pw, err, btn,
		h('p', {}, h('a', { href: '/' }, '← トップへ')));
	document.getElementById('root').append(h('div', { class: 'card' }, form));
}

/** ページャ。paging = {page, limit, total, totalPages}。onChange({page, limit}) */
export function pager(paging, onChange, sizes = [25, 50, 100]) {
	if (paging.total <= Math.min(...sizes)) return null;
	const { page, limit, total, totalPages } = paging;
	const btn = (label, p, disabled, cur) =>
		h('button', { class: 'sm' + (cur ? ' primary' : ''), disabled, 'aria-label': `${p}ページ`, 'aria-current': cur ? 'page' : false, onclick: () => onChange({ page: p, limit }) }, label);
	const nums = [];
	const near = new Set([1, totalPages, page - 1, page, page + 1]);
	let last = 0;
	for (let p = 1; p <= totalPages; p++) {
		if (!near.has(p)) continue;
		if (p - last > 1) nums.push(h('span', { class: 'muted' }, '…'));
		nums.push(btn(String(p), p, false, p === page));
		last = p;
	}
	const sel = h('select', { 'aria-label': '1ページの表示件数', onchange: () => onChange({ page: 1, limit: Number(sel.value) }) },
		sizes.map((n) => h('option', { value: n, selected: n === limit }, `${n}件/ページ`)));
	const from = (page - 1) * limit + 1;
	return h('div', { class: 'pager' },
		h('span', { class: 'muted' }, `全 ${total} 件中 ${from}–${Math.min(total, page * limit)} 件`),
		btn('‹ 前へ', page - 1, page <= 1), nums, btn('次へ ›', page + 1, page >= totalPages), sel);
}
