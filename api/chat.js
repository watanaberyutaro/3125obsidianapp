const crypto = require("crypto");

// 即時処理タスクかキュータスクかを判断
const IMMEDIATE_TYPES = ["save_memo", "save_idea", "add_calendar"];
const QUEUE_TYPES = ["save_research", "create_content"];

async function callClaude(userMessage) {
  const now = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `あなたは渡邊カンパニーの秘書AIです。
オーナーは営業会社の取締役・AI企業の社長・個人開発者です。
今日の日付：${now}

【処理ルール】
以下のJSON形式でアクションを判断してください：

■ 即時処理（すぐに実行）
- メモ・覚書・情報 → save_memo → 3125情報受付事業部
- アイデア・企画・新サービス → save_idea → 3125企画開発事業部
- 予定・スケジュール・会議 → add_calendar → Googleカレンダー

■ キュー処理（Claude Code起動時に実行）
- 市場調査・リサーチ・競合分析 → save_research → 3125市場調査事業部
- LP・コンテンツ・文章作成 → create_content → 3125制作・納品事業部

■ 雑談・質問 → none

【出力フォーマット】
返答の末尾に必ず以下を含めること：
<action>{"type":"save_memo"|"save_idea"|"add_calendar"|"save_research"|"create_content"|"none","title":"タイトル","content":"内容","datetime":"YYYY-MM-DDTHH:MM:SS"}</action>

【返答スタイル】
- 即時処理：「〇〇に保存します」など1行 + 「処理完了です✓」
- キュー処理：「承知しました。次にClaude Codeを起動した際に処理します。」
- add_calendarのdatetimeは必須。時刻のみなら今日の日付と組み合わせる
- 雑談：普通に返答`,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.content) {
    throw new Error(`Claude API error: ${data.error?.message || "Unknown"}`);
  }
  return data.content[0].text;
}

async function saveToObsidian(filePath, content) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;
  const encodedContent = Buffer.from(content).toString("base64");

  let sha;
  try {
    const getRes = await fetch(url, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
    });
    if (getRes.ok) sha = (await getRes.json()).sha;
  } catch {}

  await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `秘書: ${filePath}`,
      content: encodedContent,
      ...(sha ? { sha } : {}),
    }),
  });
}

function toJSTDate(datetime) {
  if (!datetime) return new Date(Date.now() + 10 * 60 * 1000);
  // タイムゾーン指定がない場合はJST（+09:00）として解釈
  if (!datetime.includes("+") && !datetime.includes("Z")) {
    return new Date(datetime + "+09:00");
  }
  return new Date(datetime);
}

async function addCalendarEvent(title, description, datetime) {
  const token = await getGoogleToken();
  const startTime = toJSTDate(datetime);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);

  await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: title,
      description,
      start: { dateTime: startTime.toISOString(), timeZone: "Asia/Tokyo" },
      end: { dateTime: endTime.toISOString(), timeZone: "Asia/Tokyo" },
    }),
  });
}

async function getGoogleToken() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY || "";
  const base64 = rawKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "").replace(/\n/g, "").replace(/\r/g, "").replace(/\s/g, "").trim();
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: clientEmail,
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

module.exports = async (req, res) => {
  // CORS（ブラウザからのアクセスを許可）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  try {
    const claudeReply = await callClaude(message);

    const actionMatch = claudeReply.match(/<action>([\s\S]*?)<\/action>/);
    const replyText = claudeReply.replace(/<action>[\s\S]*?<\/action>/g, "").trim();

    let actionResult = "none";

    if (actionMatch) {
      const action = JSON.parse(actionMatch[1]);
      const today = new Date().toISOString().split("T")[0];

      if (action.type === "save_idea") {
        await saveToObsidian(
          `3125企画開発事業部/${today}-${action.title}.md`,
          `---\ncreated: ${today}\ncategory: アイデア\nsource: WebUI\n---\n\n# 💡 ${action.title}\n\n${action.content}\n`
        );
        actionResult = "saved";

      } else if (action.type === "save_memo") {
        await saveToObsidian(
          `3125情報受付事業部/${today}-${action.title}.md`,
          `---\ncreated: ${today}\nsource: WebUI\n---\n\n# ${action.title}\n\n${action.content}\n`
        );
        actionResult = "saved";

      } else if (action.type === "add_calendar") {
        await addCalendarEvent(action.title, action.content, action.datetime);
        actionResult = "calendar";

      } else if (action.type === "save_research" || action.type === "create_content") {
        // キュー処理：inbox に保存してClaude Code起動時に処理
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const dept = action.type === "save_research" ? "3125市場調査事業部" : "3125制作・納品事業部";
        await saveToObsidian(
          `.company/secretary/inbox/${ts}-${action.title}.md`,
          `---\ncreated: ${today}\nstatus: pending\ntype: ${action.type}\ntarget_dept: ${dept}\n---\n\n# 📥 ${action.title}\n\n## 依頼内容\n${action.content}\n\n## オリジナルメッセージ\n${message}\n`
        );
        actionResult = "queued";
      }
    }

    return res.status(200).json({ reply: replyText || "承知しました！", action: actionResult });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ reply: "申し訳ありません。エラーが発生しました。", action: "none" });
  }
};
