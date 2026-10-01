# kitesurf-mcp

Kitesurf（ブラウザ操作）を MCP で出す Cloudflare Worker。

## 開発フロー（tskf `01-operations/playbooks/infra/dev-flow.md`）

- **git 方針**: `pr` — `tskf/<項目 id>` ブランチ → PR → CI が緑なら自分で squash merge（`gh pr checks <PR> --watch --fail-fast && gh pr merge <PR> --squash --delete-branch`。tskf BDR-0024。1 人運用でレビュー相手がいない）
- **デプロイ**: main への merge で GitHub Actions `Deploy`（`.github/workflows/deploy.yml` → tskf の `worker-deploy.yml`）。手で出す予備は `npm run deploy`
- **本番デプロイは事前承認済み**（承認ゲートで止めるのは 外部送信・削除・課金・アプリの外部配信 だけ）
