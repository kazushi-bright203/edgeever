# 取得・起動・検証・接続・復元

コマンドは必要な段階だけ実行します。最初に現在のGit差分・接続先・実行プロセスを確認してください。

## 1. 同じPCで引き継ぐ

作業ルート：`C:\Users\kazuk\Documents\ChatGPT\スーパーメモ`

Gitリポジトリ：`C:\Users\kazuk\Documents\ChatGPT\スーパーメモ\research\edgeever`

```powershell
Set-Location 'C:\Users\kazuk\Documents\ChatGPT\スーパーメモ\research\edgeever'
git status --short
git remote -v
git log -5 --oneline
```

`origin` は本人の `kazushi-bright203/edgeever`、`upstream` は `tianma-if/edgeever`。外側の空リポジトリへ誤ってコミットしないでください。未コミット変更を発見したら内容を把握してから進め、reset/cleanで消さないでください。

## 2. 別PCでコードを取得する

Git、Bun 1.3.14、Node.js、必要ならChromeを準備し、空の作業先で実行します。

```powershell
git clone https://github.com/kazushi-bright203/edgeever.git edgeever
Set-Location edgeever
git switch main
bun install --frozen-lockfile
```

オフライン用Git bundleがある場合は、最初の行を `git clone --branch main <bundleのパス> edgeever` に置き換えられます。その場合、originはbundleのローカルパスなので、ネット接続後に `git remote set-url origin https://github.com/kazushi-bright203/edgeever.git` で本人Forkへ変更し、確認します。

元のWindows補助スクリプトも使う場合は、新しい空の作業ルートを作り、その下の `research/edgeever` にcloneしてください。`docs/supermemo-handoff/workspace/` の中身をその外側の作業ルートへコピーすると、元の構成になります。既存ファイルへの上書きは事前に差分を確認してください。

```text
作業ルート/
  research/edgeever/     # 本体のGit
  連携/                  # 元の補助スクリプト
  skills/supermemo/      # スキルソース
  *.txt / *.cmd          # 計画とランチャー
  .tools/                # ローカル実行環境・秘密・ログ。Git対象外
  backups/               # 非公開バックアップ。Git対象外
```

補助スクリプトの一部は `.tools/bun/bun-windows-x64/bun.exe` の配置を前提とします。BunをPATHへ入れただけでは旧ランチャーの全機能が使えるとは限りません。まずリポジトリ標準コマンドで起動し、補助スクリプトのパスを新環境に合わせます。

## 3. 起動と基本チェック

リポジトリ直下で実行します。通常の起動はWebとAPIを含む `dev` です。

```powershell
bun run dev
```

- Web：`http://127.0.0.1:5173/memo`
- API：`http://127.0.0.1:8787/api/health`
- 元PCのBun：`C:\Users\kazuk\Documents\ChatGPT\スーパーメモ\.tools\bun\bun-windows-x64\bun.exe`

別PCのlocalhostは新しいローカルデータです。本番・元PCと自動的に同じ正本にはなりません。ユーザーの実データを二か所で更新し続ける構成にしないでください。

型・ビルド検査：

```powershell
bun run typecheck
bun run typecheck:mobile
bun run build:web
```

メモ関連の代表的な自動検査：

```powershell
bun test tests/personal-memo-domain.test.ts tests/personal-memo-drafts.test.ts tests/personal-memo-privacy.test.ts tests/memo-concurrent-save.test.ts apps/api/src/memo-tags-migration.test.mjs scripts/edgeever-mcp-stdio.test.mjs
```

このコマンドは代表例で、過去の142件をそのまま再現する全リストではありません。変更箇所に応じて対象を追加します。

画面検査はWeb/APIとChromeが必要です。メモの作成・更新を行うため、実データの本番へ向けず、検査用のローカル環境を用意します。

```powershell
bunx playwright test --config tests/personal-memo.playwright.config.ts
```

狭いChrome画面の合格はiPhoneの合格ではありません。音声操作も文字ツール試験で代用しません。

## 4. 個人データを保全・移す

元PCの最新検証済みバックアップ：`backups/2026-10-06T17-13-42-099Z`。

内容は `database.sqlite`、`resources/`、`memos.json`、`manifest.json`。93メモ・6リソースです。DBには認証や私的設定を含み得るため非公開で扱います。`.dev.vars`、Cookie、DPAPI、Cloudflare/GitHub認証ファイルをこの公開Gitへ追加してはいけません。

元の配置で新しいバックアップを作る場合、アプリリポジトリ直下で実行します。

```powershell
bun scripts/supermemo-backup.ts
```

このスクリプトは作業ディレクトリの `.wrangler/state/v3` を読み、`../../backups/<日時>` へ出力します。配置を変えた場合は出力先を事前に確認してください。稼働中SQLiteのファイルだけをコピーせず、SQLiteのスナップショットを使います。

別環境への引き継ぎでは、次の順序を守ります。

1. 元データを触らず、バックアップを別ディレクトリへ複製する。
2. SQLite整合性、外部キー、メモID/本文/revision/タグ/削除状態、添付ハッシュを確認する。
3. 新しい認証環境との対応を設計する。ローカルのユーザー・セッション・APIトークンを本番へそのまま移さない。
4. ID・履歴・タグID・ごみ箱を保持する移行処理を別コピーで検証する。
5. 本番へ移す段階で書き込みを整理し、移行後の件数・参照・ハッシュを検査する。
6. すべての入口を本番へ切り替え、元PCの古い下書きで本番を上書きしないことを確認する。

`連携/verify-cloud-account-rehearsal.ts` は別コピーの認証切替を試す検査で、本番移行コマンドではありません。過去のリハーサル成功だけで移行済みと扱わないでください。完成した一括復元・本番移行コマンドはまだありません。

## 5. Codex・別AIのMCP接続

既存の `連携/start-supermemo-mcp.mjs` は元のWindowsアカウントでDPAPI保護したトークンを復号し、localhost:8787へ接続するランチャーです。DPAPIファイルは `作業ルート/.tools/secrets/supermemo-token.dpapi` にあります。内容をログ・チャットへ出力しないでください。旧トークンは2026年11月3日までの有効期限という記録がありますが、接続時に有効性を再確認します。

別PC・別AIではアプリの認証画面から必要範囲の新しいトークンを作り、クライアント側の秘密管理へ登録します。ブリッジの起動は `bun scripts/edgeever-mcp-stdio.mjs`、設定名は `EDGEEVER_URL` と `EDGEEVER_TOKEN` です。秘密の値をコマンド履歴や文書へ直書きしないでください。

最初は `get_current_user` で接続先と所有者を確認し、検索/取得の後、明示した検査用メモで作成・再送・revision付き更新を確認します。作成後は同じIDを再取得します。`verify-supermemo-mcp.mjs` は検査メモを作るため、読み取り専用検査ではありません。

スキルソースは `workspace/skills/supermemo/`。現在のローカルURLやタグ分類前提は、Ver.2実装・本番切替時に更新が必要です。今回の文書保存だけでグローバルスキルや接続先は変更していません。

ChatGPTではローカルCodex接続をそのまま流用できると仮定せず、リモート接続・認証・アカウントの利用可否・音声中の操作を検証します。要件と公式資料への参照はVer.2計画案にあります。

## 6. CloudflareとGitの運用

既存Worker・D1・R2を使います。`docs/agent-deploy-cloudflare.md` を読んでから作業し、アカウントやリソースを再作成しないでください。

- Workers Builds：リポジトリルート、main、Deploy commandは `npx wrangler deploy`。リポジトリ内の配備処理へつながる設定です。
- 管理者パスワードはWorker runtime Secret。GitHubやBuilds変数へコピーしない。
- 追跡済みwrangler.tomlのD1 IDがプレースホルダーなのは仕様。対象解決は生成設定で行います。
- `EDGE_EVER_PRESERVE_FORK_CHANGES=true` を維持。上流同期は未検証のまま実行しない。
- mainへのpushがビルドにつながるため、結果を確認し、アプリの成功とGit push成功を区別する。
- 通常の引き継ぎ保存のためにRelease・タグ発行、ネイティブ配布を行う必要はない。

本番の匿名アクセス拒否が正常でも、ユーザーの認証済み利用・データ移行は別に確認します。GitHub/Cloudflareのログイン期限が切れたら、その環境で再認証してください。認証成功を推測せず、秘密の値を新しいAIへの依頼文へ貼り付けないでください。
