import { HttpError, b64, timingSafeEqual, unb64 } from './util';

const ITERATIONS = 100_000; // Workers の WebCrypto PBKDF2 上限

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, ITERATIONS);
	return `pbkdf2$sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, alg, iter, salt, hash] = stored.split('$');
	if (scheme !== 'pbkdf2' || alg !== 'sha256') return false;
	const actual = await derive(password, unb64(salt), Number(iter));
	return timingSafeEqual(actual, unb64(hash));
}

// ユーザー不在時にも同程度の計算を行い、タイミング差からの存在推測を防ぐ
export async function dummyVerify(password: string): Promise<void> {
	await derive(password, new Uint8Array(16), ITERATIONS);
}

export function validatePassword(pw: unknown): string {
	if (typeof pw !== 'string' || pw.length < 10 || pw.length > 128) {
		throw new HttpError(400, 'INVALID_PASSWORD', 'パスワードは10〜128文字で指定してください');
	}
	return pw;
}
