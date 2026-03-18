// api/calendar-delete.js
// 指定日のカレンダーイベントを一括削除するエンドポイント
// DELETE /api/calendar-delete?date=2026-03-18&keepAllDay=true
// keepAllDay=true の場合、終日イベントは削除しない

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
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "DELETE") return res.status(405).json({ error: "DELETE only" });

  const dateISO = req.query?.date;
  if (!dateISO) return res.status(400).json({ error: "date query param required" });

  const keepAllDay = req.query?.keepAllDay === "true";

  try {
    const token = await getGoogleToken();
    const calendarId = process.env.GOOGLE_CALENDAR_ID_SCHEDULE || process.env.GOOGLE_CALENDAR_ID;
    const timeMin = new Date(dateISO + "T00:00:00+09:00").toISOString();
    const timeMax = new Date(dateISO + "T23:59:59+09:00").toISOString();

    // Get events
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "50");

    const listRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = await listRes.json();
    const items = data.items || [];

    const deleted = [];
    const skipped = [];

    for (const event of items) {
      const isAllDay = !event.start?.dateTime;
      if (keepAllDay && isAllDay) {
        skipped.push(event.summary || "(no title)");
        continue;
      }

      const deleteUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${event.id}`;
      const delRes = await fetch(deleteUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (delRes.ok || delRes.status === 204) {
        deleted.push(event.summary || "(no title)");
      } else {
        skipped.push(`${event.summary} (error: ${delRes.status})`);
      }
    }

    return res.status(200).json({ ok: true, date: dateISO, deleted: deleted.length, skipped: skipped.length, deletedEvents: deleted, skippedEvents: skipped });
  } catch (e) {
    console.error("calendar-delete error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
