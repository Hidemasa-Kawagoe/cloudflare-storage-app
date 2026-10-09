// 使い方: node scripts/create-admin.mjs <email> <password> [表示名] | wrangler d1 execute DB --local --command "$(...)"
// 例:     npm run -s admin:create -- admin@example.com 'long-password' 管理者 > /tmp/admin.sql
//         npx wrangler d1 execute DB --local --file /tmp/admin.sql   (本番は --remote)
import { webcrypto as crypto } from "node:crypto";

const [email, password, name = "管理者"] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error("usage: create-admin.mjs <email> <password(10+ chars)> [displayName]");
  process.exit(1);
}
const ITER = 100000;
const b64 = (buf) => Buffer.from(buf).toString("base64");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
const hash = `pbkdf2$sha256$${ITER}$${b64(salt)}$${b64(bits)}`;
const q = (s) => `'${s.replaceAll("'", "''")}'`;
const now = new Date().toISOString();
console.log(
  `INSERT INTO users (id, display_name, email, password_hash, is_admin, created_at, updated_at) VALUES (${q(crypto.randomUUID())}, ${q(name)}, ${q(email)}, ${q(hash)}, 1, ${q(now)}, ${q(now)});`,
);
