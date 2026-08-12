# kitesurf-mcp

Kitesurf（Cloudflareのエージェント専用ブラウザ）を claude.ai / Claude Code などのMCPクライアントから使うための**リモートMCPサーバー**。Cloudflare Workers上で稼働し、browser binding経由でKitesurfを起動するため**Cloudflare APIトークンは一切不要**。

```
MCPクライアント（claude.ai等）
  → https://kitesurf-mcp.<あなたのサブドメイン>.workers.dev/mcp-<secret>   （Streamable HTTP）
    → Worker（agents SDK / McpAgent + Durable Object）
      → browser binding（@cloudflare/puppeteer, browser: "kitesurf"）→ 対象サイト
```

- 認証: URLパスの128bitシークレット（OAuth不要の最小構成）
- スタック: `agents`(McpAgent) + `@modelcontextprotocol/sdk` + `@cloudflare/puppeteer`

## ツール

| tool | 内容 |
|---|---|
| `fetch_page` | URLをレンダリングして本文テキストを返す |
| `get_html` | レンダリング後HTML（selector絞り込み可） |
| `screenshot` | スクリーンショット（JPEG/PNG、full_page対応） |
| `extract_links` | ページ内リンク一覧 |
| `evaluate` | ページコンテキストでJS式を実行 |
| `interact` | click/fill/select/press/wait_for/wait_ms/goto の逐次実行→最終ページテキスト |

各ツールは呼び出しごとに使い捨てKitesurfセッションを起動する（起動130〜530msなので実用上問題ない）。ログイン状態は呼び出し間で持続しない。Basic認証は `https://user:pass@host/...` 形式で渡せる（Authorizationヘッダに変換して送信）。

## 事前準備

必要なのは以下の3つ。**Cloudflare APIトークンの発行は不要**（デプロイはOAuthログイン、Kitesurf起動はbinding経由のため）。

1. **Cloudflareアカウント**（無料プランでOK）
   - 未登録なら https://dash.cloudflare.com/sign-up から作成（メールアドレスのみで可、ドメイン追加は不要）
2. **Node.js 18以上**（wrangler CLIの動作要件）
3. **workers.dev サブドメイン**
   - Workersを初めて使うアカウントは、初回デプロイ時にサブドメイン名（`<name>.workers.dev`）の登録を求められるので、案内に従って設定する

料金の目安: Workers無料枠（10万リクエスト/日）でMCP用途には十分。Kitesurf自体は**ベータ中は無料**。ただしFreeプランのBrowser Run制限（ブラウザ時間10分/日・同時3ブラウザ等）があり、Kitesurfセッションがこの枠にカウントされるかは明文化されていない。ヘビーに使う場合はWorkers Paid（$5/月〜）を検討。

## セットアップ

```sh
git clone https://github.com/bytask/kitesurf-mcp.git
cd kitesurf-mcp
npm install

# 1. Cloudflareにログイン（ブラウザが開いてOAuth認可）
npx wrangler login

# 2. URLシークレットを生成して登録（ローカル控え + Worker側secret）
openssl rand -hex 16 > .mcp-path-secret
tr -d '\n' < .mcp-path-secret | npx wrangler secret put MCP_PATH_SECRET
#    → 「Worker kitesurf-mcp が存在しないので作成するか」と聞かれたら Yes でOK

# 3. デプロイ
npx wrangler deploy
#    → 出力される https://kitesurf-mcp.<サブドメイン>.workers.dev を控える
```

MCPエンドポイントURLは次の形になる:

```
https://kitesurf-mcp.<サブドメイン>.workers.dev/mcp-<.mcp-path-secretの中身>
```

疎通確認（`serverInfo` が返ればOK）:

```sh
curl -s -X POST "<エンドポイントURL>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

## MCPクライアントへの登録

**claude.ai（Web/モバイル）**

設定 → コネクタ → カスタムコネクタを追加 → エンドポイントURLを貼って追加 → 「連携」。6ツールが認識されれば完了（ツール権限は既定で「承認が必要」）。

**Claude Code**

```sh
claude mcp add --transport http kitesurf "<エンドポイントURL>"
```

**その他のクライアント**

Streamable HTTP対応のMCPクライアントならURLを設定するだけで使える（認証ヘッダ等の追加設定は不要。シークレットはURLパスに含まれている）。

## 運用

- **シークレットのローテーション**（URLを知られた・共有をやめたい場合）:
  `openssl rand -hex 16 > .mcp-path-secret` → `tr -d '\n' < .mcp-path-secret | npx wrangler secret put MCP_PATH_SECRET` → クライアント側のURLを更新。旧URLは即404になる
- **エンドポイントURLの扱い**: URL自体がアクセス権。共有した相手は誰でもこのWorker（＝あなたのCloudflareクォータ）でブラウザを使えるので、扱いはAPIキーに準じる
- 削除するときは `npx wrangler delete kitesurf-mcp`

## Kitesurfベータの落とし穴（実測で判明、このコードで吸収済み）

- `waitForSelector` / CDP Input domain が未実装 → DOM evaluateベースのポーリングで代替
- DOM駆動ナビゲーション（`el.click()`のリンク遷移）は `location` だけ変わりdocumentが入れ替わらない → location変化を検知して `page.goto()` で実ナビゲーションに変換
- `form.requestSubmit()` は完全no-op → FormDataからGET送信URLを合成して `goto`（**POSTフォームはGET化される制限あり**）
- URL埋め込みBasic認証が送られない → Authorizationヘッダへ変換
- ベータ起因の `error code: 1042` → launch時1回リトライ

公式の制限（動画・WebGL・bot対策回避・永続認証セッションは非対応）は [Kitesurf docs](https://developers.cloudflare.com/browser-run/kitesurf/) を参照。これらが必要な場合は `browser: "kitesurf"` を外せば同じコードがChromium版Browser Runで動く。
