# CloudFlare Storage App

仕様: [CloudFlareStorageApp.md](CloudFlareStorageApp.md)　構成: Workers(Hono) + Static Assets + D1 + R2 + KV

## ローカル開発

```bash
npm install
npm run db:migrate:local
npm run -s admin:create -- admin@example.com 'long-password-123' 管理者 > .admin.sql
npx wrangler d1 execute DB --local --file .admin.sql && rm .admin.sql
npm run dev        # http://localhost:8787
```

## デプロイ

```bash
npx wrangler d1 create storage-app-db          # database_id を wrangler.jsonc に設定
npx wrangler r2 bucket create storage-app-files
npx wrangler kv namespace create SESSIONS      # id を wrangler.jsonc に設定
npm run db:migrate:remote
npm run -s admin:create -- admin@example.com '強いパスワード' > .admin.sql
npx wrangler d1 execute DB --remote --file .admin.sql && rm .admin.sql
npm run deploy
```

## 仕様からの差異・簡略化

- 管理者のユーザー一覧のページングは未実装（最大500件）。
- 画面の未ログイン時リダイレクトは静的ページのため、API 401 を検知したクライアント側 JS で行う（データ保護は API 側で担保）。
- サムネイルは元画像を CSS で縮小表示（画像リサイズ未使用）。
- 自動テストは未整備。API はローカルで curl により、画面はブラウザで動作確認済み。
