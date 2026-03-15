// api/log.js
// キュータスクの進捗・完了マイルストーンをカレンダーにログ＋Push通知
// Claude Code から WebFetch で呼ばれる

const crypto  = require("crypto");
const webpush = require("web-push");

webpush.setVapidDetails(
  "mailto:secretary@3125company.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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

async function addCalendarLog(title, description, link, startTime, endTime, colorId) {
  const token = await getGoogleToken();
  const start = startTime ? new Date(startTime) : new Date();
  const end   = endTime   ? new Date(endTime)   : new Date(start.getTime() + 15 * 60 * 1000);
  const fullDescription = [description, link ? `🔗 ${link}` : ""].filter(Boolean).join("\n\n");

  // startTime あり → 予定カレンダー / なし → ログカレンダー
  // 専用環境変数が未設定の場合は GOOGLE_CALENDAR_ID にフォールバック
  const isSchedule = !!startTime;
  const calendarId = isSchedule
    ? (process.env.GOOGLE_CALENDAR_ID_SCHEDULE || process.env.GOOGLE_CALENDAR_ID)
    : (process.env.GOOGLE_CALENDAR_ID_LOG      || process.env.GOOGLE_CALENDAR_ID);

  const eventBody = {
    summary: title,
    description: fullDescription,
    start: { dateTime: start.toISOString(), timeZone: "Asia/Tokyo" },
    end:   { dateTime: end.toISOString(),   timeZone: "Asia/Tokyo" },
  };
  if (colorId) {
    eventBody.colorId = String(colorId);
  } else if (!isSchedule) {
    eventBody.colorId = "8"; // ログはグレー
  }

  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(eventBody),
    }
  );
}

// ==================== Push通知 ====================

async function getSubscription() {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const res = await fetch(
    `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(".company/secretary/push-subscription.json")}`,
    { headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) throw new Error("No subscription found");
  const data = await res.json();
  return JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
}

async function sendPush(title, body) {
  const subscription = await getSubscription();
  await webpush.sendNotification(subscription, JSON.stringify({ title, body, url: "/" }));
}

// ==================== Main Handler ====================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const { title, description, notify = false, link, startTime, endTime, colorId } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });

  const results = { calendar: false, push: false };

  // カレンダーログ（失敗してもPushは試みる）
  try {
    await addCalendarLog(title, description || "", link, startTime, endTime, colorId);
    results.calendar = true;
  } catch (e) {
    console.error("Calendar log error:", e.message);
  }

  // Push通知（notify=trueのみ）
  if (notify) {
    try {
      await sendPush(title, description || "作業が完了しました");
      results.push = true;
    } catch (e) {
      console.error("Push error:", e.message);
    }
  }

  return res.status(200).json({ ok: true, ...results });
};
