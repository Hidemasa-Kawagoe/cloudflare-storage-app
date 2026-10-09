# CloudFlareStorageApp 実装仕様書

Cloudflare 上で動作する、ユーザー別クラウドストレージ Web アプリの実装仕様。

- 版: 1.0（初版）
- 作成日: 2026-10-09

---

## 1. 概要

ユーザーがテキストファイル・画像ファイルを保存・閲覧・編集できるクラウドストレージ。管理者は専用の管理画面からユーザーとファイルを管理する。

### 1.1 スコープ

| 区分 | 内容 |
|---|---|
| ファイル種別 | テキスト（作成・編集・保存・アップロード・ダウンロード）、画像（アップロード・ダウンロード） |
| 付随情報 | 所有者、作成日時、更新日時、変更禁止フラグ |
| 整理 | グループフォルダの作成、ファイルのフォルダ配置 |
| 画面 | 静的トップ、ログイン、一覧、プレビュー/編集、管理画面 |
| 管理機能 | ユーザー管理（登録・変更・削除）、ユーザーファイル管理（ダウンロード・削除・編集ロック） |

### 1.2 前提・解釈した事項（要確認）

仕様書に明記のなかった点を以下のとおり決定した。変更したい場合は該当箇所を修正する。

1. **グループフォルダ** は、ユーザーがファイルを整理するための「フォルダ」と解釈する。所有者のみがアクセスでき、**他ユーザーとの共有は v1 では行わない**。階層はネスト可（最大深さ 5）。共有は将来拡張（§13）。
2. **管理者** は `users.is_admin = 1` のユーザー。管理画面ログインは管理者のみ許可する。管理者も自身のストレージを持てるが、通常ログイン画面からのログインは不要（管理者は管理画面を使う）。通常ログイン画面から管理者がログインすることも妨げない。
3. **「変更禁止フラグ」** が立ったファイルは、内容の更新・上書き・リネーム・移動・削除をすべて禁止する（管理者の「編集ロック（削除・変更の禁止）」と同義）。
4. **変更禁止フラグの操作権限**: 管理者は任意のファイルで ON/OFF 可。一般ユーザーは自分のファイルのフラグを ON にできるが、**OFF にできるのは管理者のみ**とする（管理者ロックをユーザーが解除できないようにするため）。
5. 画像形式は JPEG / PNG / GIF / WebP のみ。SVG は XSS 危険性があるため v1 では不可。
6. 1 ファイルの最大サイズは 25 MB（Workers のリクエスト上限に余裕を持たせる。拡張時は §13）。

---

## 2. 技術構成とストレージ選定

### 2.1 採用サービス

| コンポーネント | Cloudflare サービス | 用途 |
|---|---|---|
| アプリ本体/API | Workers（Hono フレームワーク、TypeScript） | API、認証、R2 アクセス |
| 静的ページ/SPA | Workers Static Assets | トップ、ログイン、一覧、管理画面の HTML/JS/CSS |
| 管理情報 | **D1**（SQLite） | ユーザー、フォルダ、ファイルメタデータ |
| ファイル本体 | **R2** | テキスト・画像のバイナリ/本文 |
| セッション | **Workers KV** | ログインセッション（TTL 付き） |

### 2.2 ストレージ選定理由

| データ | 保存先 | 理由 |
|---|---|---|
| ユーザー情報 | D1 | メールアドレスの一意制約、管理画面での一覧・検索・更新・削除とリレーション（ファイルの所有者）が必要。強い整合性が要る |
| ファイル/フォルダのメタデータ | D1 | 所有者・フォルダ単位の一覧、ソート、集計、外部キーによるカスケード削除などリレーショナルな操作が中心。KV は一覧・絞り込みが弱く、結果整合のため不適 |
| ファイル本体 | R2 | 大きなオブジェクト向け。エグレス無料、Workers からストリーム入出力できる |
| セッション | KV | キー参照のみ、読み取り多数、TTL による自動失効が標準機能。結果整合（最大約 60 秒）でも、セッション用途では許容できる |

> 注: KV は結果整合性のため、ユーザー削除・パスワード変更時のセッション失効は「KV からの削除」＋「リクエスト毎の D1 によるユーザー存在確認」の二段で担保する（§6.4）。

### 2.3 リポジトリ構成

```
cloudflare-storage-app/
├─ wrangler.jsonc
├─ package.json
├─ tsconfig.json
├─ migrations/
│   ├─ 0001_init.sql
│   └─ 0002_seed_note.md        # 初期管理者作成手順
├─ src/
│   ├─ index.ts                 # Hono アプリのエントリ
│   ├─ env.ts                   # Bindings 型定義
│   ├─ middleware/
│   │   ├─ auth.ts              # セッション検証、requireUser / requireAdmin
│   │   └─ csrf.ts
│   ├─ routes/
│   │   ├─ auth.ts              # /api/auth/*
│   │   ├─ files.ts             # /api/files/*
│   │   ├─ folders.ts           # /api/folders/*
│   │   └─ admin.ts             # /api/admin/*
│   ├─ lib/
│   │   ├─ password.ts          # PBKDF2 ハッシュ
│   │   ├─ session.ts           # KV セッション
│   │   ├─ mime.ts              # 種別判定・検証
│   │   └─ validate.ts
│   └─ scripts/create-admin.ts  # 初期管理者作成
└─ public/                      # 静的アセット
    ├─ index.html               # 静的トップ
    ├─ login.html
    ├─ app.html                 # 一覧画面（ユーザー）
    ├─ admin/
    │   ├─ login.html
    │   └─ index.html
    └─ assets/ (js, css)
```

### 2.4 wrangler.jsonc（要点）

```jsonc
{
  "name": "cloudflare-storage-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "storage-app-db", "database_id": "<id>" }
  ],
  "r2_buckets": [
    { "binding": "FILES", "bucket_name": "storage-app-files" }
  ],
  "kv_namespaces": [
    { "binding": "SESSIONS", "id": "<id>" }
  ]
}
```

R2 バケットは **非公開**（パブリックアクセス無効）。すべて Worker 経由で配信し、認可を必ず通す。

---

## 3. データモデル

### 3.1 D1 スキーマ（migrations/0001_init.sql）

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,                 -- GUID (crypto.randomUUID())
  display_name  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                    -- "pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>"
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  created_at    TEXT NOT NULL,                    -- ISO 8601 UTC
  updated_at    TEXT NOT NULL
);

CREATE TABLE folders (
  id          TEXT PRIMARY KEY,                   -- GUID
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = トップ
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- 同一親内での名前重複を禁止（parent_id が NULL の場合も一意にするため COALESCE）
CREATE UNIQUE INDEX ux_folders_name
  ON folders(owner_id, COALESCE(parent_id, ''), name);

CREATE TABLE files (
  id          TEXT PRIMARY KEY,                   -- GUID（R2 キーにも使用）
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = トップ
  name        TEXT NOT NULL,                      -- ファイル名（拡張子含む）
  kind        TEXT NOT NULL CHECK (kind IN ('text','image')),
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  is_locked   INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0,1)),  -- 変更禁止フラグ
  locked_by_admin INTEGER NOT NULL DEFAULT 0 CHECK (locked_by_admin IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_files_name
  ON files(owner_id, COALESCE(folder_id, ''), name);
CREATE INDEX ix_files_owner_folder ON files(owner_id, folder_id);
```

- 日時は UTC の ISO 8601 文字列（例 `2026-10-09T03:21:00.000Z`）。画面側で JST 等に変換表示する。
- `locked_by_admin` は §1.2-4 のため、管理者が立てたロックをユーザーが解除できないよう区別する。
- 外部キーのカスケードで D1 行は消えるが、**R2 オブジェクトは自動で消えない**。削除は §9 の手順で行う。

### 3.2 R2 オブジェクトキー

```
users/<owner_id>/files/<file_id>
```

- ファイル名ではなく GUID をキーにする（リネーム時に R2 の操作が不要。パス・文字種の問題を回避）。
- R2 の `httpMetadata.contentType` に MIME を設定、`customMetadata` に `ownerId`, `fileId` を持たせる（整合性チェック用）。

### 3.3 KV セッション

- キー: `sess:<session_id>`（`session_id` は 32 バイト乱数の base64url）
- 値(JSON): `{ "userId": "...", "isAdmin": true|false, "csrf": "<token>", "createdAt": "..." }`
- TTL: 通常ユーザー 7 日（`expirationTtl: 604800`）、管理画面は 8 時間。
- 補助キー: `usess:<userId>:<session_id>` → 空文字。ユーザーごとのセッション一括失効に使用（`list({prefix})` で列挙して削除）。

---

## 4. 認証・認可

### 4.1 パスワード

- WebCrypto の **PBKDF2-HMAC-SHA256**、反復 100,000 回（Workers の WebCrypto 上限）、ソルト 16 バイト。形式: `pbkdf2$sha256$100000$<salt>$<hash>`。
- 比較は定数時間（`crypto.subtle.timingSafeEqual` 相当、もしくは自前の XOR 比較）。
- 最小 10 文字。ログイン失敗時のメッセージは「メールアドレスまたはパスワードが違います」で統一（ユーザー存在の漏洩防止）。

### 4.2 セッション

- ログイン成功で乱数のセッション ID を発行し KV 保存、Cookie に設定:
  `__Host-sid=<id>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...`
- CSRF 対策: 状態変更系リクエスト（POST/PUT/PATCH/DELETE）は `X-CSRF-Token` ヘッダ必須。トークンは `GET /api/auth/me` で返す。加えて `Origin` ヘッダが自ホストであることを検証する。
- ログイン試行制限: メールアドレス＋IP ごとに KV で失敗回数を数え、15 分間に 5 回失敗でロック（`rl:login:<hash>`、TTL 900 秒）。Cloudflare の WAF レートリミットルールも併用推奨。

### 4.3 ロール別アクセス

| 対象 | 未認証 | 一般ユーザー | 管理者 |
|---|---|---|---|
| `/`, `/login`, `/admin/login` | ○ | ○ | ○ |
| `/app`（一覧画面）と `/api/files`, `/api/folders` | × | 自分の資源のみ | 自分の資源のみ |
| `/admin`, `/api/admin/*` | × | × | ○ |

- 全 API は D1 クエリに `owner_id = :sessionUserId` を必ず付与（IDOR 防止）。他人のリソース ID は 404 を返す。
- 画面アクセス時、未認証なら対応するログイン画面へ 302。

### 4.4 リクエスト毎の検証（middleware/auth.ts）

1. Cookie から session_id 取得 → KV 読み取り。無ければ 401。
2. D1 で `users` を引き、存在しなければ 401＋セッション削除（削除済みユーザー対策）。
3. 管理者 API は D1 の最新の `is_admin` を確認（降格直後の反映）。

### 4.5 初期管理者

`scripts/create-admin.ts`（`wrangler d1 execute` で実行する SQL を生成）または環境 Secret `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` を使い、初回デプロイ後に管理者 1 名を作成する手順を README に記載する。パスワードをリポジトリへ置かない。

---

## 5. 画面仕様

### 5.1 静的トップページ `/`

- 静的 HTML（Workers Static Assets で配信）。
- 要素: アプリ名・概要、**「ログイン」リンク → `/login`**、**「管理画面」リンク → `/admin/login`**。
- 認証不要、JS 不要。

### 5.2 ログイン画面 `/login`

- 入力: メールアドレス、パスワード。「ログイン」ボタン。
- `POST /api/auth/login` 成功で `/app`（一覧画面）へ遷移。失敗時はエラー表示。
- 既にログイン済みなら `/app` へリダイレクト。

### 5.3 一覧画面 `/app`

ログインユーザーのストレージの **トップフォルダ**を表示。フォルダ移動可能（`/app?folder=<id>`）。

**共通ヘッダ**: 表示名、ログアウト、パンくずリスト（トップ > フォルダ > …）。

**ツールバー**
- アップロード（ボタン＋ドラッグ＆ドロップ、複数選択可）。テキスト・画像以外の拡張子/MIME は拒否。
- 新規テキストファイル作成（ファイル名入力 → 空ファイルを作成して編集画面へ）。
- 新規フォルダ作成。
- 表示切り替え: **詳細一覧（リスト）** / **サムネイル**（選択状態は `localStorage` に保持）。
- 並び替え: 名前・更新日時・サイズ（昇順/降順）。

**詳細一覧**: 列＝アイコン(種別)、ファイル名、種別、サイズ、作成日時、更新日時、🔒（変更禁止）。フォルダは先頭に表示。
**サムネイル**: 画像ファイルは縮小表示（`/api/files/:id/content` を `<img loading="lazy">` で `object-fit: cover`）。テキストはテキストアイコン＋ファイル名。フォルダはフォルダアイコン。
> v1 は元画像を CSS で縮小するだけ。大容量画像での負荷が問題となれば Cloudflare Images / Image Resizing を導入（§13）。

**行/カードの操作**: ファイル名またはサムネイルのクリック → プレビュー表示。コンテキストメニュー: ダウンロード、名前変更、移動、削除、変更禁止 ON（ユーザーが OFF できるのは管理者ロックでない場合のみ。§1.2-4 で「管理者のみ」としたが、ユーザー自身が立てたロックは解除可）。
- ロック中のファイルは名前変更・移動・削除メニューを無効化し、🔒を表示。

### 5.4 プレビュー画面（モーダルまたは `/app/file/:id`）

- **画像**: 拡大表示＋「ダウンロード」ボタン。ファイル情報（名前、所有者表示名、サイズ、作成/更新日時、ロック状態）。
- **テキスト**:
  - 変更禁止でない場合 → **編集画面**（`<textarea>`、等幅フォント）。「保存」「ダウンロード」「閉じる」。未保存変更がある状態で閉じる場合は確認ダイアログ。
  - 変更禁止の場合 → 読み取り専用表示。「ダウンロード」のみ。
  - 保存は `PUT /api/files/:id/content`。競合防止のため、取得時の `updated_at` を `If-Unmodified-Since` 相当（`expectedUpdatedAt`）で送り、サーバー側で不一致なら 409。
  - 編集可能な最大サイズ: 1 MB（超える場合は読み取り専用＋ダウンロードのみ）。
- 文字コードは UTF-8 固定。アップロード時に UTF-8 として不正なバイト列を含むテキストは拒否（`TextDecoder` の `fatal: true` で検証）。

### 5.5 管理画面ログイン `/admin/login`

- 管理者のメールアドレス・パスワードでログイン。`POST /api/auth/admin-login`。`is_admin = 0` のユーザーは、パスワードが正しくても失敗メッセージ（§4.1 と同一）を返す。
- 成功で `/admin` へ遷移。

### 5.6 管理画面 `/admin`

タブ: **ユーザー管理** / **ファイル管理**

**ユーザー管理**
- 一覧: 表示名、メールアドレス、管理者フラグ、作成日時、ファイル数/使用容量。
- 新規登録: 表示名、メールアドレス、パスワード、管理者フラグ（GUID は自動採番）。
- 変更: 表示名、メールアドレス、管理者フラグ、パスワード再設定（空欄なら変更しない）。
- 削除: 確認ダイアログで「ユーザーとその全ファイルが削除されます」と明示。
- 制約: 自分自身の削除・自分自身の管理者権限の剥奪は不可。最後の管理者は削除/降格不可。

**ファイル管理**
- ユーザーを選択 → そのユーザーのフォルダ/ファイルのツリーまたは一覧。
- 各ファイルの操作: **ダウンロード**、**削除**、**編集ロック ON/OFF**（変更禁止フラグ。ON 時 `locked_by_admin=1`）。
- 管理者は内容の編集はしない（要件外）。

---

## 6. API 仕様

共通事項:
- ベースパス `/api`、リクエスト/レスポンスは JSON（コンテンツ送受信を除く）。
- エラー形式: `{ "error": { "code": "string", "message": "string" } }`
- ステータス: 400 入力不正 / 401 未認証 / 403 権限なし / 404 無し / 409 競合・重複 / 413 サイズ超過 / 415 非対応種別 / 429 試行過多。
- 状態変更系は `X-CSRF-Token` 必須（§4.2）。

### 6.1 認証

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → セッション Cookie 発行、`{user}` |
| POST | `/api/auth/admin-login` | 同上。`is_admin=1` のみ許可 |
| POST | `/api/auth/logout` | セッション削除 |
| GET | `/api/auth/me` | `{user:{id,displayName,email,isAdmin}, csrfToken}` |

### 6.2 フォルダ（一般ユーザー）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/folders/:id/children` | 子フォルダ＋ファイル一覧。`:id` は `root` でトップ。クエリ `sort`, `order` |
| POST | `/api/folders` | `{name, parentId|null}` 作成 |
| PATCH | `/api/folders/:id` | `{name?, parentId?}` 名前変更/移動（循環移動は 400） |
| DELETE | `/api/folders/:id` | 配下を再帰削除。**配下にロック中ファイルがある場合は 409 で拒否** |

### 6.3 ファイル（一般ユーザー）

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/files` | multipart/form-data（`file`, `folderId?`）でアップロード。同名があれば 409（`?overwrite=true` で上書き。ロック中は 403） |
| POST | `/api/files/text` | `{name, folderId?, content?}` 新規テキスト作成 |
| GET | `/api/files/:id` | メタデータ |
| GET | `/api/files/:id/content` | 本体配信。`?download=1` で `Content-Disposition: attachment`（RFC 5987 エンコード） |
| PUT | `/api/files/:id/content` | テキスト保存 `{content, expectedUpdatedAt}`。ロック中 403、不一致 409 |
| PATCH | `/api/files/:id` | `{name?, folderId?, isLocked?}`。ロック中は `name`/`folderId` 変更不可（403）。`isLocked=false` は §1.2-4 に従う |
| DELETE | `/api/files/:id` | 削除。ロック中 403 |

- 配信ヘッダ: 画像は実 MIME、テキストは `text/plain; charset=utf-8`。`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cache-Control: private, no-store`。
- `Range` リクエストは R2 の `range` オプションで対応（任意）。

### 6.4 管理者 API（`requireAdmin`）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/admin/users` | 一覧（`q` 検索、ページング `limit`/`cursor`） |
| POST | `/api/admin/users` | `{displayName,email,password,isAdmin}` 登録 |
| PATCH | `/api/admin/users/:id` | `{displayName?,email?,password?,isAdmin?}` 変更。パスワード/権限変更時は当該ユーザーのセッションを全失効 |
| DELETE | `/api/admin/users/:id` | ユーザー削除（§9 の手順で R2 も削除。セッション失効） |
| GET | `/api/admin/users/:id/tree` | 当該ユーザーのフォルダ/ファイル一覧（`folderId` 指定） |
| GET | `/api/admin/files/:id/content?download=1` | ダウンロード |
| DELETE | `/api/admin/files/:id` | 削除（ロック中でも管理者は削除できるが、**ロック ON のファイルは先にロック解除が必要**とする運用に統一し、ロック中は 409 を返す） |
| PATCH | `/api/admin/files/:id/lock` | `{isLocked: boolean}` 編集ロック。ON で `locked_by_admin=1` |

---

## 7. 主要処理フロー

### 7.1 アップロード
1. 認証・CSRF 検証 → サイズ検査（`Content-Length` ≤ 25 MB、実読み込み後も確認）。
2. 拡張子 + MIME 判定（`lib/mime.ts`）。許可リスト:
   - text: `.txt .md .csv .json .log .xml .yaml .yml`（`text/plain` として保存）
   - image: `.jpg .jpeg .png .gif .webp`。**先頭バイト（マジックナンバー）**で実形式を検証し、拡張子と不一致なら 415。
3. フォルダ所有確認、同名衝突確認。
4. `file_id = randomUUID()`。**R2 に先に put** → 成功後 D1 へ INSERT。D1 失敗時は R2 の put を delete して補償。
5. 作成・更新日時を同一の現在時刻で記録。

### 7.2 テキスト保存
1. 対象取得（`owner_id` 一致）→ `is_locked=1` なら 403。
2. `expectedUpdatedAt` と `updated_at` を比較、不一致なら 409。
3. R2 に put（同キー上書き）→ D1 の `size_bytes`, `updated_at` を更新。`created_at` は不変。

### 7.3 変更禁止（ロック）判定の集約
`assertMutable(file)`: `is_locked=1` なら 403 `FILE_LOCKED`。更新/リネーム/移動/削除/上書きアップロードの全経路で必ず呼ぶ。

---

## 8. セキュリティ要件

- 認可: 全クエリで `owner_id` を強制（§4.3）。管理 API は `requireAdmin`。
- XSS: ユーザー由来の文字列（ファイル名・表示名・テキスト内容）は textContent で描画し `innerHTML` を使わない。コンテンツ配信は `nosniff` ＋ CSP sandbox ＋ 上記の許可 MIME のみ（SVG・HTML は保存不可）。
- ファイル名検証: 1〜255 文字、`/ \ \0` と制御文字を禁止、`.` `..` 禁止、前後空白トリム。Unicode は NFC 正規化。
- SQL: すべて `prepare().bind()` のプリペアドステートメント。
- 通信: HTTPS のみ（Cloudflare 側で Always Use HTTPS）。HSTS ヘッダ付与。
- ヘッダ（全レスポンス）: `X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、HTML には `Content-Security-Policy: default-src 'self'; img-src 'self' data:; frame-ancestors 'none'`。
- 監査ログ（管理操作）: `console.log` の構造化 JSON（Workers Logs）に、管理者 ID・操作・対象 ID・時刻を出力。個人情報（パスワード等）は出力しない。
- シークレットは `wrangler secret` を使用し、リポジトリへコミットしない。

---

## 9. 削除時の整合性

D1 と R2 は分散トランザクションできないため、以下の順序で実施する。

- **ファイル削除**: D1 から DELETE → R2 から delete。R2 削除に失敗した場合は `console.error` を出し、次の GC で回収（孤児オブジェクト）。
- **フォルダ/ユーザー削除**: 先に配下の `files` の ID を列挙（D1）→ D1 の DELETE（カスケード）→ R2 を `delete([keys])`（1000 キーずつ）でバッチ削除。大量の場合は Queues か Cron で非同期化（v1 は最大 1,000 ファイルまで同期処理、超過は複数回に分割して実行）。
- **孤児 GC**（Cron Trigger、毎日 1 回）: R2 の `users/` を `list` し、D1 に無い `file_id` のオブジェクトを削除。D1 に行があるのに R2 に無い場合はログ出力のみ。

---

## 10. 制限値

| 項目 | 値 |
|---|---|
| 1 ファイル最大サイズ | 25 MB |
| テキスト編集可能サイズ | 1 MB |
| フォルダ階層の深さ | 5 |
| 1 ユーザーの使用容量上限 | 1 GB（アップロード時に `SUM(size_bytes)` で検査。超過は 413） |
| ファイル名/フォルダ名 | 1〜255 文字 |
| 表示名 | 1〜50 文字 |
| パスワード | 10〜128 文字 |
| 一覧ページング | 1 ページ 100 件（`cursor` 方式） |

---

## 11. 非機能要件

- 可用性・スケール: Cloudflare 管理サービスに依存（追加の冗長化は不要）。
- パフォーマンス: 一覧 API は `ix_files_owner_folder` を利用して 100ms 以内（D1 レイテンシ別）を目標。
- ブラウザ: 最新の Chrome / Edge / Safari / Firefox。
- アクセシビリティ: キーボード操作可能なフォーム、ボタンに `aria-label`、十分なコントラスト。
- i18n: UI 文言は日本語固定（文言を `public/assets/i18n.js` に集約し、将来の多言語化に備える）。
- バックアップ: D1 Time Travel（30 日）を利用。R2 は誤削除対策としてオブジェクトのバージョニング機能が使えない場合、重要運用ではバケットレプリケーションを検討。

---

## 12. 実装手順（推奨）

1. `npm create cloudflare` で Workers + Hono のプロジェクト作成。`wrangler d1 create` / `r2 bucket create` / `kv namespace create` で資源作成し、`wrangler.jsonc` に反映。
2. `migrations/0001_init.sql` を `wrangler d1 migrations apply` で適用。初期管理者を作成（§4.5）。
3. `lib/password.ts`, `lib/session.ts`, `middleware/auth.ts`, `middleware/csrf.ts` を実装し、`routes/auth.ts` でログイン/ログアウト/me を動かす。
4. `routes/folders.ts`, `routes/files.ts`（アップロード・取得・保存・ロック判定）を実装。
5. `routes/admin.ts` を実装。
6. 静的ページ（トップ、ログイン、一覧、プレビュー/編集、管理）を実装。
7. Cron による孤児 GC、レート制限、セキュリティヘッダを追加。
8. テスト（§14）を実施し、`wrangler deploy`。

---

## 13. 将来拡張（v1 対象外）

- グループフォルダの **ユーザー間共有**（`folder_members` テーブル、権限 read/write）。
- 大容量ファイル対応（R2 マルチパートアップロード、署名付き URL による直接アップロード）。
- サムネイル生成（Cloudflare Images / Image Resizing）、画像形式の拡張。
- ごみ箱（論理削除）、ファイルバージョン管理。
- MFA、パスワードリセットメール（Email Routing / 外部メールサービス）。
- 検索（ファイル名、テキスト全文）。

---

## 14. テスト観点（受け入れ基準）

| # | 観点 | 期待結果 |
|---|---|---|
| 1 | トップから各リンク | `/login`、`/admin/login` に遷移する |
| 2 | 一般ユーザーが管理画面ログイン | 失敗する（管理者のみ許可） |
| 3 | ログイン後の遷移 | 自分のトップフォルダの一覧が表示される |
| 4 | テキスト作成→編集→保存 | 更新日時が更新され、作成日時は不変 |
| 5 | テキストのアップロード/ダウンロード | 内容が一致する（UTF-8） |
| 6 | 画像のアップロード/ダウンロード | バイナリが一致する。拡張子偽装（PNG 名の HTML 等）は拒否 |
| 7 | 一覧/サムネイル切替 | 表示が切り替わり、リロード後も維持 |
| 8 | 変更禁止ファイル | 編集・保存・名前変更・移動・削除がすべて拒否され、ダウンロードは可能 |
| 9 | 管理者ロックのファイル | 一般ユーザーは解除できない。管理者は解除可能 |
| 10 | フォルダへのファイル配置 | 指定フォルダ内に表示される。同名は拒否 |
| 11 | 他ユーザーのリソース ID を直接指定 | 404（情報漏洩なし） |
| 12 | 管理者によるユーザー登録/変更/削除 | 反映される。削除時に D1 と R2 の両方から消える。最後の管理者は削除不可 |
| 13 | 管理者によるファイル DL/削除/ロック | 動作する。ロック中ファイルの削除は 409 |
| 14 | 同時編集 | 古い `expectedUpdatedAt` での保存は 409 |
| 15 | CSRF トークン無しの POST | 403 |
| 16 | ログイン連続失敗 | 5 回目以降は 429 |
| 17 | 上限超過（25MB、容量 1GB、階層 5） | 413 / 400 で拒否 |
