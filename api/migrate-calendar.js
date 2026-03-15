// api/migrate-calendar.js
// 一時的な移行エンドポイント
// 旧カレンダー（GOOGLE_CALENDAR_ID）からスケジュール系イベント（colorId != "8"）を
// 新カレンダー（GOOGLE_CALENDAR_ID_SCHEDULE）にコピー＆削除する

const crypto = require("crypto");

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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const srcId  = process.env.GOOGLE_CALENDAR_ID;
  const destId = process.env.GOOGLE_CALENDAR_ID_SCHEDULE;

  if (!destId) return res.status(400).json({ error: "GOOGLE_CALENDAR_ID_SCHEDULE not set" });

  try {
    const token = await getGoogleToken();

    // 旧カレンダーからイベントを取得（直近30日分）
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const listRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(srcId)}/events?timeMin=${encodeURIComponent(timeMin)}&maxResults=100&singleEvents=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listData = await listRes.json();
    const events = listData.items || [];

    // colorId が "8"（グレー）以外 = スケジュール系イベント
    const scheduleEvents = events.filter(e => e.colorId !== "8" && e.status !== "cancelled");

    const migrated = [];
    const failed = [];

    for (const event of scheduleEvents) {
      try {
        // 新カレンダーにコピー
        const newEvent = {
          summary: event.summary,
          description: event.description,
          start: event.start,
          end: event.end,
        };
        await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(destId)}/events`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(newEvent),
          }
        );

        // 旧カレンダーから削除
        await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(srcId)}/events/${event.id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
        );

        migrated.push(event.summary);
      } catch (e) {
        failed.push(event.summary);
      }
    }

    return res.status(200).json({ ok: true, migrated, failed, total: scheduleEvents.length });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
