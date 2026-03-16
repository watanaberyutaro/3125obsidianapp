// api/line-summary.js
// 蓄積したLINEメッセージをClaude APIで要約し、Obsidianに保存する
//
// POST /api/line-summary
// Body: { date?: "YYYY-MM-DD" }  ← 省略時は今日
// GET  /api/line-summary?date=YYYY-MM-DD

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
  try {
    const existing = await ghGet(path);
    if (existing) sha = existing.sha;
  } catch {}
  await fetch(url, {
    method: "PUT",
    headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `line-summary: ${path}`,
      content: Buffer.from(content).toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
}

async function sendDiscord(webhookUrl, embed) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  }).catch(() => {});
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const date = (req.method === "GET" ? req.query?.date : req.body?.date)
    || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

  // メッセージ読み込み
  const msgPath = `line-messages/${date}.json`;
  const msgFile = await ghGet(msgPath);
  if (!msgFile) {
    return res.status(404).json({ error: `No messages found for ${date}` });
  }

  let messages;
  try {
    messages = JSON.parse(Buffer.from(msgFile.content, "base64").toString("utf-8"));
  } catch {
    return res.status(500).json({ error: "Failed to parse messages" });
  }

  if (!messages.length) {
    return res.status(200).json({ ok: true, summary: "メッセージなし", date });
  }

  // Claude API で要約
  const messagesText = messages.map(m => {
    const room = m.roomName ? `[${m.roomName}] ` : "";
    return `${m.ts} ${room}${m.sender}: ${m.message}`;
  }).join("\n");

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: `あなたはビジネスマンの秘書です。LINEのトーク履歴を簡潔に要約します。
以下の観点でまとめてください:
- 重要な連絡・依頼事項
- 決定事項・確認事項
- 対応が必要なもの（期限があれば明記）
- その他（雑談は省略可）
口調: フェルン（丁寧な敬語・冷静）。「…承りました」「ご確認ください」。`,
      messages: [{ role: "user", content: `${date}のLINEメッセージ履歴を要約してください:\n\n${messagesText}` }],
    }),
  });

  const claudeData = await claudeRes.json();
  const summary = claudeData.content?.[0]?.text || "要約できませんでした";

  // Obsidianに保存
  const savePath = `02_3125経営日誌事業部（フェルン）/line-summary/${date}-LINEサマリー.md`;
  const fileContent = `- [ ] 振り分け
- [ ] 閲覧済み

---
target_folder: 02_3125経営日誌事業部（フェルン）/line-summary
date: "${date}"
type: line-summary
author: フェルン
message_count: ${messages.length}
---

> …${date}のLINEをまとめました。ご確認をお願いします。— フェルン

# LINE サマリー ${date}

**メッセージ数**: ${messages.length}件
**生成**: フェルン（経営日誌事業部）

---

## 要約

${summary}

---

## 原文ログ

${messages.map(m => {
  const room = m.roomName ? ` [${m.roomName}]` : "";
  return `**${m.ts}${room} ${m.sender}**: ${m.message}`;
}).join("\n\n")}
`;

  await ghPut(savePath, fileContent);

  // Discord通知
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const discordWebhookPath = "02_3125経営日誌事業部（フェルン）/discord-webhook.txt";
  const webhookFile = await ghGet(discordWebhookPath);
  if (webhookFile) {
    const webhookUrl = Buffer.from(webhookFile.content, "base64").toString("utf-8").trim();
    await sendDiscord(webhookUrl, {
      title: `LINE サマリー ${date} 完了`,
      description: `${summary.slice(0, 400)}${summary.length > 400 ? "…" : ""}\n\n保存先: ${savePath}`,
      color: 3447003,
      footer: { text: "フェルン（経営日誌事業部）" },
    });
  }

  return res.status(200).json({ ok: true, date, messageCount: messages.length, summary, savedTo: savePath });
};
