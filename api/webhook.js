const crypto = require("crypto");

// ==================== LINE ====================

function validateSignature(body, secret, signature) {
  const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
}

// ==================== GitHub ====================

async function ghGet(path) {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const res = await fetch(
    `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(path)}`,
    { headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function ghPut(path, content) {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const url = `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(path)}`;
  let sha;
  try { const ex = await ghGet(path); if (ex) sha = ex.sha; } catch {}
  await fetch(url, {
    method: "PUT",
    headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message: `秘書: ${path}`, content: Buffer.from(content).toString("base64"), ...(sha ? { sha } : {}) }),
  });
}

// LINE userId を保存（初回メッセージ時）
async function saveLineUserId(userId) {
  const path = ".company/secretary/line-config.json";
  const existing = await ghGet(path);
  if (existing) return; // 既存なら上書きしない
  await ghPut(path, JSON.stringify({ userId }, null, 2));
}

// ==================== Google Calendar ====================

async function getGoogleToken() {
  const rawKey = process.env.GOOGLE_PRIVATE_KEY || "";
  const base64 = rawKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "").replace(/\n/g, "").replace(/\r/g, "").replace(/\s/g, "").trim();
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: process.env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  })).toString("base64url");
  const keyObject = crypto.createPrivateKey({ key: privateKey, format: "pem", type: "pkcs8" });
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(keyObject, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${payload}.${sig}`,
  });
  return (await res.json()).access_token;
}

// 自然言語から日時を簡易パース（Claude不要）
function parseJapaneseDateTime(msg) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const d = new Date(now);

  if (/明後日/.test(msg))       d.setDate(d.getDate() + 2);
  else if (/明日/.test(msg))    d.setDate(d.getDate() + 1);
  else if (/来週月曜/.test(msg)) { d.setDate(d.getDate() + ((1 + 7 - d.getDay()) % 7 || 7)); }

  const timeMatch = msg.match(/(\d{1,2})[:時](\d{2})?/);
  if (timeMatch) {
    d.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2] || 0), 0, 0);
  } else {
    d.setHours(10, 0, 0, 0);
  }
  return d.toISOString();
}

function extractTitle(msg) {
  return msg
    .replace(/明後日|明日|今日|本日|\d{1,2}[:時]\d{0,2}分?|の?予定を?|を?入れて|登録して|追加して|カレンダーに/g, "")
    .replace(/[、。\s]+/g, " ").trim().slice(0, 30) || "予定";
}

async function addCalendarEvent(title, datetime) {
  const token = await getGoogleToken();
  const start = new Date(datetime);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: title,
        start: { dateTime: start.toISOString(), timeZone: "Asia/Tokyo" },
        end:   { dateTime: end.toISOString(),   timeZone: "Asia/Tokyo" },
      }),
    }
  );
}

async function getCalendarEvents(dateISO) {
  const token   = await getGoogleToken();
  const timeMin = new Date(dateISO + "T00:00:00+09:00").toISOString();
  const timeMax = new Date(dateISO + "T23:59:59+09:00").toISOString();
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "15");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) return "予定はありません";
  return items.map(e => {
    const start = e.start?.dateTime || e.start?.date || "";
    const time = start.includes("T") ? new Date(start).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }) : "終日";
    return `${time} ${e.summary}`;
  }).join("\n");
}

// ==================== タスク振り分け ====================

function classifyTask(msg) {
  if (/調査|リサーチ|市場|競合|分析|調べて|トレンド|まとめて/.test(msg))
    return { type: "research",         dept: "リサーチ部",   folder: "3125市場調査事業部" };
  if (/LP|ランディング|コンテンツ|記事|ブログ|SNS|広告|マーケ/.test(msg))
    return { type: "content_creation", dept: "マーケ部",     folder: "3125マーケティング事業部" };
  if (/アイデア|企画|新サービス|ビジネス案|事業|構想|思いつき/.test(msg))
    return { type: "idea",             dept: "企画部",       folder: "3125企画開発事業部" };
  if (/コード|実装|設計|開発|バグ|プログラム/.test(msg))
    return { type: "coding",           dept: "開発部",       folder: "3125エンジニアリング事業部" };
  if (/メモ|覚えて|記録|覚書/.test(msg))
    return { type: "memo",             dept: "秘書室",       folder: "3125情報受付事業部" };
  return   { type: "general",          dept: "秘書室",       folder: "3125情報受付事業部" };
}

const typeLabel = {
  research: "リサーチ", content_creation: "コンテンツ作成",
  idea: "アイデア企画", coding: "開発", memo: "メモ", general: "タスク",
};

// ==================== Main Handler ====================

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const signature = req.headers["x-line-signature"] || "";

  if (!validateSignature(body, process.env.LINE_CHANNEL_SECRET, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const events = (typeof req.body === "string" ? JSON.parse(req.body) : req.body).events || [];

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const msg        = event.message.text;
    const replyToken = event.replyToken;
    const userId     = event.source?.userId;
    const todayISO   = new Date().toISOString().split("T")[0];
    const lower      = msg.toLowerCase();

    // 初回: LINE userId を保存
    if (userId) saveLineUserId(userId).catch(() => {});

    try {
      // ── カレンダー追加 ──────────────────────────────
      const isCalendarAdd = /予定|カレンダー|会議|ミーティング/.test(msg) && /追加|入れて|登録|作って/.test(msg);
      if (isCalendarAdd) {
        const title    = extractTitle(msg);
        const datetime = parseJapaneseDateTime(msg);
        await addCalendarEvent(title, datetime);
        const d = new Date(datetime);
        const timeStr = d.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
        const dateStr = d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric" });
        await replyMessage(replyToken, `📅 ${dateStr} ${timeStr}「${title}」をカレンダーに登録しました✓`);
        continue;
      }

      // ── 予定確認 ────────────────────────────────────
      const isCalendarRead = /予定|スケジュール/.test(msg) && /は|教えて|確認|見せて/.test(msg);
      if (isCalendarRead) {
        let targetDate = todayISO;
        if (/明日/.test(msg)) {
          const d = new Date(); d.setDate(d.getDate() + 1);
          targetDate = d.toISOString().split("T")[0];
        }
        const events2 = await getCalendarEvents(targetDate);
        const label = /明日/.test(msg) ? "明日" : "今日";
        await replyMessage(replyToken, `📅 ${label}の予定:\n${events2}`);
        continue;
      }

      // ── タスク確認 ──────────────────────────────────
      const isTaskRead = /タスク|todo|やること/.test(lower) && /教えて|確認|見せて|一覧|ある|は/.test(lower);
      if (isTaskRead) {
        const file = await ghGet(`.company/secretary/todos/${todayISO}.md`);
        if (!file) {
          await replyMessage(replyToken, "✅ 本日のタスクはありません");
          continue;
        }
        const content = Buffer.from(file.content, "base64").toString("utf-8");
        const pending = (content.match(/^- \[ \] .+/gm) || []).join("\n");
        const done    = (content.match(/^- \[x\] .+/gm) || []).join("\n");
        let reply = `📋 本日のタスク (${todayISO})`;
        if (pending) reply += `\n\n未完了:\n${pending}`;
        if (done)    reply += `\n\n完了:\n${done}`;
        if (!pending && !done) reply += "\nタスクはありません";
        await replyMessage(replyToken, reply);
        continue;
      }

      // ── その他 → キューに保存 ───────────────────────
      const cls  = classifyTask(msg);
      const ts   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const title = msg.replace(/[「」【】『』]/g, "").slice(0, 30).trim();
      await ghPut(
        `3125情報受付事業部/_pending/${ts}-${title}.md`,
        `---\ncreated: ${todayISO}\nstatus: pending\ntype: ${cls.type}\ntarget_folder: ${cls.folder}\nsource: LINE\n---\n\n# 📥 ${title}\n\n## 指示内容\n${msg}\n\n## 担当部署\n${cls.dept}\n\n## 保存先\n${cls.folder}\n`
      );
      await replyMessage(replyToken, `承りました✓\n${cls.dept}へのタスクをキューに追加しました。\nClaude Code起動時に処理します。`);

    } catch (err) {
      console.error("Webhook error:", err);
      await replyMessage(replyToken, "エラーが発生しました。しばらく後にお試しください。");
    }
  }

  res.status(200).json({ status: "ok" });
};
