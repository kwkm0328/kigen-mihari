// 期限リマインド通知スクリプト（GitHub Actions から毎日実行）
// Firestore から期限データを読み、担当弁護士ごとに「期限が近い書面」をメール送信する。
// アプリ本体は一切変更せず、保存済みデータを読むだけ。

import fs from "node:fs";
import crypto from "node:crypto";
import nodemailer from "nodemailer";

// ===== 環境変数（GitHub Secrets） =====
const {
  FIREBASE_PROJECT_ID,
  FIREBASE_API_KEY,
  WORKSPACE_ID,
  DATA_PIN,            // 暗証番号（PINなしなら空でよい）
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  SMTP_HOST,
  SMTP_PORT,
} = process.env;

function need(name, v) { if (!v) { console.error(`環境変数 ${name} が未設定です。`); process.exit(1); } }
need("FIREBASE_PROJECT_ID", FIREBASE_PROJECT_ID);
need("FIREBASE_API_KEY", FIREBASE_API_KEY);
need("WORKSPACE_ID", WORKSPACE_ID);
need("SMTP_USER", SMTP_USER);
need("SMTP_PASS", SMTP_PASS);

// ===== 設定ファイル（公開しても安全な条件だけ） =====
const config = JSON.parse(fs.readFileSync(new URL("../notify-config.json", import.meta.url), "utf8"));
const thresholdDays = Number(config.thresholdDays ?? 7);
const notifyOverdue = config.notifyOverdue !== false;

// ===== 宛先メール（Secret NOTIFY_EMAILS を優先／なければ設定ファイル） =====
// NOTIFY_EMAILS 例: {"川上":"k.kawakami@c-law.jp","fallbackEmail":"..."}
let emailMap = {};
if (process.env.NOTIFY_EMAILS) {
  try { emailMap = JSON.parse(process.env.NOTIFY_EMAILS); }
  catch { console.error("Secret NOTIFY_EMAILS のJSONが不正です。"); process.exit(1); }
} else {
  emailMap = { ...(config.lawyers || {}), fallbackEmail: config.fallbackEmail || "" };
}
const fallbackEmail = emailMap.fallbackEmail || "";
const lawyers = { ...emailMap };
delete lawyers.fallbackEmail;

// ===== Firestore から1件のドキュメントを取得（REST・APIキーのみ） =====
async function fetchDoc() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/deadlineWatch/${encodeURIComponent(WORKSPACE_ID)}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) { console.log("データがまだありません（ドキュメント未作成）。"); process.exit(0); }
  if (!res.ok) { console.error("Firestore 取得失敗:", res.status, await res.text()); process.exit(1); }
  const json = await res.json();
  return unwrapFields(json.fields || {});
}

// Firestore REST の型付き値をふつうの値に変換
function unwrapFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = unwrapValue(v);
  return out;
}
function unwrapValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue !== undefined) return unwrapFields(v.mapValue.fields || {});
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(unwrapValue);
  return null;
}

// ===== 復号（アプリの Web Crypto と同じ方式: PBKDF2-SHA256 120k → AES-256-GCM） =====
function decryptItems(doc) {
  const salt = Buffer.from(doc.salt, "base64");
  const iv = Buffer.from(doc.iv, "base64");
  const blob = Buffer.from(doc.ct, "base64");
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(0, blob.length - 16);
  const key = crypto.pbkdf2Sync(Buffer.from(DATA_PIN || "", "utf8"), salt, 120000, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}

// ===== 残り日数（日本時間基準） =====
function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
}
function daysUntil(dateText) {
  if (!dateText) return null;
  const due = Date.parse(dateText + "T00:00:00Z");
  if (Number.isNaN(due)) return null;
  return Math.round((due - todayJST()) / 86400000);
}
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function fmtDate(dateText) {
  if (!dateText) return "";
  const d = new Date(dateText + "T00:00:00Z");
  return `${dateText}（${WD[d.getUTCDay()]}）`;
}
function leftText(days) {
  if (days === null) return "期限未設定";
  if (days < 0) return `${Math.abs(days)}日超過`;
  if (days === 0) return "本日";
  return `あと${days}日`;
}

// ===== メイン =====
(async () => {
  const doc = await fetchDoc();
  let items;
  try {
    if (doc.enc) {
      if (!DATA_PIN) { console.error("データは暗号化されています。Secret DATA_PIN を設定してください。"); process.exit(1); }
      items = decryptItems(doc);
    } else {
      items = JSON.parse(doc.plain || "[]");
    }
  } catch (e) {
    console.error("データの読み取り/復号に失敗:", e.message);
    process.exit(1);
  }
  if (!Array.isArray(items)) items = [];

  // 対象: 未完了 かつ 期限が閾値以内（超過も含む=通知設定による）
  const targets = items.filter(it => {
    if (it.done) return false;
    const d = daysUntil(it.dueDate);
    if (d === null) return false;
    if (d < 0) return notifyOverdue;
    return d <= thresholdDays;
  });

  if (targets.length === 0) { console.log("通知対象の期限はありません。"); return; }

  // 担当弁護士ごとにまとめる
  const byLawyer = new Map();
  for (const it of targets) {
    const name = (it.lawyer || "").trim() || "（担当未設定）";
    if (!byLawyer.has(name)) byLawyer.set(name, []);
    byLawyer.get(name).push(it);
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST || "smtp.gmail.com",
    port: Number(SMTP_PORT || 465),
    secure: Number(SMTP_PORT || 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  let sent = 0, skipped = 0;
  for (const [name, list] of byLawyer) {
    const to = lawyers[name] || fallbackEmail;
    if (!to) { console.log(`宛先不明のためスキップ: ${name}（notify-config.json に登録するか fallbackEmail を設定してください）`); skipped++; continue; }

    list.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
    const overdue = list.filter(it => daysUntil(it.dueDate) < 0).length;

    const lines = list.map(it => {
      const d = daysUntil(it.dueDate);
      const mark = d < 0 ? "🔴" : d <= 3 ? "🟠" : "🟡";
      const parts = [
        `${mark} ${leftText(d)}  ｜  提出期限 ${fmtDate(it.dueDate)}`,
        `    ${it.kind || ""}${it.title ? "：" + it.title : ""}`,
        `    事件：${it.caseName || ""}${it.courtCase ? "（" + it.courtCase + "）" : ""}`,
      ];
      if (it.memo) parts.push(`    メモ：${it.memo}`);
      return parts.join("\n");
    });

    const subject = `【期限リマインド】${name}先生 — 期限が近い書面 ${list.length}件${overdue ? `（うち超過 ${overdue}件）` : ""}`;
    const body =
`${name} 先生

期限が近づいている書面（未完了）のお知らせです。

${lines.join("\n\n")}

――――――――――――
このメールは「書面提出期限 見張り」から自動送信されています。
一覧の確認・編集はアプリからどうぞ。`;

    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to,
      subject,
      text: body,
    });
    console.log(`送信: ${name} → ${to}（${list.length}件）`);
    sent++;
  }
  console.log(`完了。送信 ${sent}件 / スキップ ${skipped}件。`);
})().catch(e => { console.error(e); process.exit(1); });
