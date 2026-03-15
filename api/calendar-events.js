// api/calendar-events.js
// Claude Code から curl で叩いてカレンダーイベントを取得するエンドポイント
// GET /api/calendar-events?date=2026-03-15

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
    scope: "https://www.googleapis.com/auth/calendar.readonly",
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
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const dateISO = req.query?.date || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

  try {
    const token   = await getGoogleToken();
    const calendarId = process.env.GOOGLE_CALENDAR_ID_SCHEDULE || process.env.GOOGLE_CALENDAR_ID;
    const timeMin = new Date(dateISO + "T00:00:00+09:00").toISOString();
    const timeMax = new Date(dateISO + "T23:59:59+09:00").toISOString();

    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "20");

    const gcalRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = await gcalRes.json();
    const items = (data.items || []).map(e => {
      const startRaw = e.start?.dateTime || e.start?.date || "";
      const endRaw   = e.end?.dateTime   || e.end?.date   || "";
      const isAllDay = !e.start?.dateTime;
      const startTime = isAllDay ? "終日" : new Date(startRaw).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
      const endTime   = isAllDay ? ""     : new Date(endRaw).toLocaleTimeString("ja-JP",   { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
      return { title: e.summary || "(タイトルなし)", startTime, endTime, isAllDay, startRaw, endRaw };
    });

    return res.status(200).json({ date: dateISO, events: items, count: items.length });
  } catch (e) {
    console.error("calendar-events error:", e.message);
    return res.status(500).json({ error: e.message, events: [], count: 0 });
  }
};
