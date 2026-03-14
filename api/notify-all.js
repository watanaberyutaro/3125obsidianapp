// api/notify-all.js
// 全チャンネル同時通知：Web Push + LINE（将来: Slack / Discord）
// Claude Code から WebFetch で呼ばれる

const webpush = require("web-push");

webpush.setVapidDetails(
  "mailto:secretary@3125company.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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

// ==================== Web Push ====================

async function sendWebPush(title, body) {
  const data = await ghGet(".company/secretary/push-subscription.json");
  if (!data) throw new Error("Push subscription not found");
  const sub = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
  await webpush.sendNotification(sub, JSON.stringify({ title, body, url: "/" }));
}

// ==================== LINE ====================

async function sendLine(title, body) {
  const data = await ghGet(".company/secretary/line-config.json");
  if (!data) throw new Error("LINE config not found");
  const { userId } = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text: `${title}\n${body}` }] }),
  });
}

// ==================== Slack（将来用） ====================
// async function sendSlack(title, body) {
//   const webhookUrl = process.env.SLACK_WEBHOOK_URL;
//   if (!webhookUrl) throw new Error("SLACK_WEBHOOK_URL not set");
//   await fetch(webhookUrl, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ text: `*${title}*\n${body}` }),
//   });
// }

// ==================== Discord（将来用） ====================
// async function sendDiscord(title, body) {
//   const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
//   if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL not set");
//   await fetch(webhookUrl, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ embeds: [{ title, description: body }] }),
//   });
// }

// ==================== Main Handler ====================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { title, body = "" } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });

  const results = { push: false, line: false };

  try { await sendWebPush(title, body); results.push = true; }
  catch (e) { console.error("Push error:", e.message); }

  try { await sendLine(title, body); results.line = true; }
  catch (e) { console.error("LINE error:", e.message); }

  // 将来: Slack/Discordを追加する場合はここに追記
  // try { await sendSlack(title, body); results.slack = true; } catch(e) {}

  return res.status(200).json({ ok: true, ...results });
};
