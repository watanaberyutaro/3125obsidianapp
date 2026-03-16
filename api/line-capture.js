// api/line-capture.js
// MacroDroidからLINE通知を受信し、GitHub（Obsidian Vault）にJSON形式で蓄積する
//
// POST /api/line-capture
// Headers: Authorization: Bearer <MACRODROID_SECRET>
// Body: { sender: "相手の名前", message: "メッセージ内容", roomName?: "グループ名" }
//
// 蓄積先: line-messages/YYYY-MM-DD.json（1日1ファイル、配列で追記）

async function ghGet(path) {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const res = await fetch(
    `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(path)}`,
    { headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function ghPut(path, content, sha) {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  await fetch(
    `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `line-capture: ${new Date().toISOString()}`,
        content: Buffer.from(content).toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    }
  );
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // 簡易認証
  const secret = process.env.MACRODROID_SECRET;
  if (secret) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const { sender, message, roomName } = req.body || {};
  if (!sender || !message) {
    return res.status(400).json({ error: "sender and message are required" });
  }

  // 日本時間で今日の日付を取得
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const ts    = new Date().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  const path  = `line-messages/${today}.json`;

  // 既存データ読み込み
  const existing = await ghGet(path);
  let messages = [];
  let sha;
  if (existing) {
    try {
      messages = JSON.parse(Buffer.from(existing.content, "base64").toString("utf-8"));
      sha = existing.sha;
    } catch {
      messages = [];
    }
  }

  // 新しいメッセージを追記
  messages.push({
    ts,
    sender: sender.trim(),
    roomName: roomName?.trim() || null,
    message: message.trim(),
  });

  await ghPut(path, JSON.stringify(messages, null, 2), sha);

  return res.status(200).json({ ok: true, count: messages.length, date: today });
};
