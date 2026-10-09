export class HttpError extends Error {
	constructor(
		public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429,
		public code: string,
		message?: string,
	) {
		super(message ?? code);
	}
}

export const LIMITS = {
	maxFileBytes: 25 * 1024 * 1024,
	maxEditBytes: 1024 * 1024,
	userQuotaBytes: 1024 * 1024 * 1024,
	maxFolderDepth: 5,
	maxSessionTtlUser: 7 * 24 * 3600,
	maxSessionTtlAdmin: 8 * 3600,
};

export const now = () => new Date().toISOString();

export function validateName(raw: unknown, label = '名前'): string {
	if (typeof raw !== 'string') throw new HttpError(400, 'INVALID_NAME', `${label}が不正です`);
	const name = raw.normalize('NFC').trim();
	if (name.length < 1 || name.length > 255) throw new HttpError(400, 'INVALID_NAME', `${label}は1〜255文字で指定してください`);
	if (/[\/\\\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'INVALID_NAME', `${label}に使用できない文字が含まれています`);
	if (name === '.' || name === '..') throw new HttpError(400, 'INVALID_NAME', `${label}が不正です`);
	return name;
}

export function isUniqueError(e: unknown): boolean {
	return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

export function b64(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function b64url(buf: Uint8Array): string {
	return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	let diff = a.length ^ b.length;
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

export async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
