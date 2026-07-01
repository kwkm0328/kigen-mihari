# 書面提出期限 見張り — 公開＆通知セット

このフォルダの中身を、そのままGitHubのリポジトリに置くと動きます。

```
index.html                         ← アプリ本体（GitHub Pagesで公開）
notify-config.json                 ← 担当弁護士のメール・通知条件
scripts/notify.mjs                 ← 期限チェック＆メール送信（自動）
.github/workflows/deadline-notify.yml  ← 毎朝8時に自動実行
```

---

## 全体の流れ（初回だけ）

1. **Firebase を用意**（アプリの⚙設定画面の手順どおり。共有ID・PINを決める）
2. **GitHubリポジトリを作り、このフォルダの中身を全部アップロード**
3. **GitHub Pages を有効化** → 発行URLをPC・スマホで開く（⚙設定に同じ共有ID・PINを入力）
4. **通知用の「Secrets」を登録**（下記）
5. できあがり。毎朝8時に、期限が近い書面が担当弁護士のメールへ届きます

---

## 通知の設定

### 通知の条件（公開OK）
`notify-config.json` は公開しても安全な条件だけです。

```json
{ "thresholdDays": 7, "notifyOverdue": true }
```

### Secrets（秘密の設定値）を登録
GitHubリポジトリの `Settings → Secrets and variables → Actions → New repository secret` で、次を登録します。**宛先メールもここに入れる**ので、公開リポジトリでも漏れません。

| 名前 | 値 |
|---|---|
| `FIREBASE_PROJECT_ID` | Firebaseの projectId |
| `FIREBASE_API_KEY` | Firebaseの apiKey |
| `WORKSPACE_ID` | アプリで決めた共有ID |
| `DATA_PIN` | 暗証番号（PINなしなら登録不要） |
| `NOTIFY_EMAILS` | 担当弁護士→メールのJSON（下記） |
| `SMTP_USER` | 送信元Gmailアドレス |
| `SMTP_PASS` | Gmailの「アプリ パスワード」（16桁） |
| `SMTP_FROM` | 差出人表示（任意。未登録なら SMTP_USER） |

`NOTIFY_EMAILS` の値（JSON）の例：
```json
{"川上":"k.kawakami@c-law.jp","fallbackEmail":"k.kawakami@c-law.jp"}
```
※ `"川上"` の部分は、アプリの「担当弁護士」欄の**表記とぴったり同じ**に。弁護士を増やすときはこのJSONに追記します。`fallbackEmail` は担当未登録のときの送り先です。

- **Gmailのアプリ パスワード**：Googleアカウントで2段階認証をON →「アプリ パスワード」を作成（16桁）。通常のログインパスワードではありません。
- Gmail以外（会社メール等）を使う場合は `SMTP_HOST` と `SMTP_PORT` も追加してください。

### ③ 動作テスト
`Actions` タブ →「期限リマインド通知」→「Run workflow」で今すぐ実行できます。ログで送信結果を確認できます。

---

## 通知が来る条件
- **未完了** の書面で、
- 提出期限まで **7日以内**（`thresholdDays`）、または **期限切れ**（`notifyOverdue`）
- 担当弁護士ごとに1通にまとめて、毎朝8時（日本時間）に送信

## 安全性
- PINをONにしていれば、データは暗号化されたまま保存され、この通知スクリプトだけが `DATA_PIN` を使って読み取ります。
- PINはGitHubのSecretsに暗号化保管され、ログにも表示されません。
