const crypto = require("crypto");

// LINE署名検証
function validateSignature(body, secret, signature) {
  const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return hash === signature;
}

// LINEへの返信
async function replyMessage(replyToken, text, accessToken) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// Claude APIを呼び出す
async function callClaude(userMessage) {
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
今日の日付：${new Date().toLocaleDateString("ja-JP",{timeZone:"Asia/Tokyo"})}

【重要】あなたは会話ではなく「処理して報告する」エージェントです。
オーナーのメッセージを受け取ったら、即座に適切な部署に振り分けて処理し、完了を報告してください。

## 振り分けルール
- アイデア・企画・新サービス案 → save_idea（3125企画開発事業部）
- 調査・リサーチ・市場分析依頼 → save_research（3125市場調査事業部）
- 予定・スケジュール・会議 → add_calendar（Googleカレンダー）
- メモ・覚書・情報 → save_memo（3125情報受付事業部）
- 雑談・質問・相談のみ → アクションなし、返答のみ

## 出力フォーマット
必ずアクションJSONを含めてください（雑談以外）：
<action>{"type":"save_idea"|"save_research"|"save_memo"|"add_calendar","title":"タイトル（簡潔に）","content":"内容（要点をまとめて）","datetime":"YYYY-MM-DDTHH:MM:SS"}</action>

add_calendarのdatetimeは必須。時刻のみの場合は今日の日付と組み合わせること。

## 返答スタイル
- 処理が発生する場合：「〇〇部署に保存しました」「カレンダーに登録しました」など1〜2行の完了報告のみ
- 長い説明・提案・深掘りは不要
- 処理完了後は必ず「処理完了です✓」で締める
- 雑談・相談のみの場合は普通に返答`,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.content) {
    console.error("Claude API error:", JSON.stringify(data));
    throw new Error(`Claude API error: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data.content[0].text;
}

// GitHubにファイルを保存（Obsidian vault）
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
    if (getRes.ok) {
      const d = await getRes.json();
      sha = d.sha;
    }
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

// Googleカレンダーに予定を追加
async function addCalendarEvent(title, description, datetime) {
  try {
    const token = await getGoogleToken();
    const startTime = datetime ? new Date(datetime) : new Date(Date.now() + 10 * 60 * 1000);
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
  } catch (e) {
    console.error("Calendar error:", e);
  }
}

async function getGoogleToken() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY || "";
  // PEMヘッダー・フッターを除いたbase64のみ抽出して再構築
  const base64 = rawKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\n/g, "")
    .replace(/\r/g, "")
    .replace(/\s/g, "")
    .trim();
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })).toString("base64url");

  const keyObject = crypto.createPrivateKey({ key: privateKey, format: "pem", type: "pkcs8" });
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(keyObject, "base64url");

  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

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

    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    try {
      const claudeReply = await callClaude(userMessage);

      // アクションを抽出
      const actionMatch = claudeReply.match(/<action>([\s\S]*?)<\/action>/);
      const replyText = claudeReply.replace(/<action>[\s\S]*?<\/action>/g, "").trim();

      if (actionMatch) {
        const action = JSON.parse(actionMatch[1]);
        const today = new Date().toISOString().split("T")[0];

        if (action.type === "save_idea") {
          await saveToObsidian(
            `3125企画開発事業部/${today}-${action.title}.md`,
            `---\ncreated: ${today}\ncategory: アイデア\nsource: LINE\n---\n\n# 💡 ${action.title}\n\n${action.content}\n`
          );
        } else if (action.type === "save_research") {
          await saveToObsidian(
            `3125市場調査事業部/${action.title}.md`,
            `---\ncreated: ${today}\ncategory: リサーチ\nsource: LINE\n---\n\n# ${action.title}\n\n${action.content}\n`
          );
        } else if (action.type === "save_memo") {
          await saveToObsidian(
            `3125情報受付事業部/${today}-${action.title}.md`,
            `---\ncreated: ${today}\nsource: LINE\n---\n\n# ${action.title}\n\n${action.content}\n`
          );
        } else if (action.type === "add_calendar") {
          await addCalendarEvent(action.title, action.content, action.datetime);
        }
      }

      await replyMessage(replyToken, replyText || "承知しました！", process.env.LINE_CHANNEL_ACCESS_TOKEN);
    } catch (err) {
      console.error(err);
      await replyMessage(replyToken, "申し訳ありません。処理中にエラーが発生しました。", process.env.LINE_CHANNEL_ACCESS_TOKEN);
    }
  }

  res.status(200).json({ status: "ok" });
};
