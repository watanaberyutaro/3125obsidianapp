const webpush = require("web-push");

webpush.setVapidDetails(
  "mailto:secretary@3125company.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function getSubscription() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(".company/secretary/push-subscription.json")}`;

  const res = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error("No subscription found");

  const data = await res.json();
  return JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
}

async function sendPush(title, body, url = "/") {
  const subscription = await getSubscription();
  await webpush.sendNotification(
    subscription,
    JSON.stringify({ title, body, url, badge: 1 })
  );
}

module.exports = { sendPush };

// APIエンドポイントとしても使用可能
module.exports.default = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { title, body } = req.body;
  try {
    await sendPush(title || "秘書室", body || "タスクが完了しました");
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Notify error:", err);
    return res.status(500).json({ error: err.message });
  }
};
