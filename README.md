# kitesurf-mcp

Kitesurf（Cloudflareのエージェント専用ブラウザ）を claude.ai / Claude Code などのMCPクライアントから使うためのリモートMCPサーバー。Cloudflare Workers上で稼働し、browser binding経由でKitesurfを起動するためAPIトークン不要。

- URL: `https://<your-worker>.workers.dev/mcp-<secret>`（Streamable HTTP）
- 認証: URLパスの128bitシークレット（`wrangler secret put MCP_PATH_SECRET`。ローカルは `.mcp-path-secret`、git管理外）
- スタック: `agents`(McpAgent) + `@modelcontextprotocol/sdk` + `@cloudflare/puppeteer`（`browser: "kitesurf"`）

## ツール

| tool | 内容 |
|---|---|
| `fetch_page` | URLをレンダリングして本文テキストを返す |
| `get_html` | レンダリング後HTML（selector絞り込み可） |
| `screenshot` | スクリーンショット（JPEG/PNG、full_page対応） |
| `extract_links` | ページ内リンク一覧 |
| `evaluate` | ページコンテキストでJS式を実行 |
| `interact` | click/fill/select/press/wait_for/wait_ms/goto の逐次実行→最終ページテキスト |

各ツールは呼び出しごとに使い捨てKitesurfセッションを起動する（起動130〜530msなので実用上問題なし）。

## Kitesurfの落とし穴（実測で判明、コードで吸収済み）

- `waitForSelector` / Input domain が未実装 → DOM evaluateベースのポーリングで代替
- DOM駆動ナビゲーション（`el.click()`のリンク遷移）は `location` だけ変わりdocumentが入れ替わらない → location変化を検知して `page.goto()` で実ナビゲーションに変換
- `form.requestSubmit()` は完全no-op → FormDataからGET送信URLを合成して `goto`（POSTフォームはGET化される制限あり）
- ベータ起因の `error code: 1042` → launch時1回リトライ

## デプロイ

```sh
npm install
npx wrangler deploy
```

claude.ai側: 設定 → コネクタ → カスタムコネクタを追加 → 上記URL（シークレット込み）を登録。
