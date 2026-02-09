# Setup Instructions

## 環境変数の設定

このプロジェクトは環境変数を使用しています。以下の手順で設定してください：

### 1. ローカル開発環境

```bash
# .env ファイルを作成
cp .env.example .env

# .env ファイルを編集して、YOUR_**** の部分に実際の値を入れてください
# ⚠️ .env ファイルは絶対に Git にコミットしないでください
```

### 2. 本番環境 / GitHub Actions

**GitHub Secrets に設定します（推奨）：**

GitHub リポジトリ → Settings → Secrets and variables → Actions → New repository secret

以下のキーを追加：
- `BANK_URL`
- `BANK_PASSWORD`
- `SPREADSHEET_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- その他の必要なキー

ワークフロー (.github/workflows/deploy.yml) で参照：

```yaml
env:
  BANK_PASSWORD: ${{ secrets.BANK_PASSWORD }}
  GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
```

### 3. セキュリティ

⚠️ **重要事項：**
- `.env` ファイルを Git にコミットしないでください
- `.env` を他人と共有しないでください
- 本番環境では環境変数または GitHub Secrets を使用してください
- 定期的に API キーをローテーションしてください

---

## トラブルシューティング

**Q: `.env ファイルが見つからない`**
```
A: 上記の手順で .env.example から .env を作成してください
```

**Q: 環境変数が読み込まれない**
```
A: アプリケーション再起動後に反映されます
```
