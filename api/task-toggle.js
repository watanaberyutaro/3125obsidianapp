// api/task-toggle.js
// チェックボックストグル: - [ ] ↔ - [x] をGitHub上のTODOファイルで切り替える
// POST { date: "YYYY-MM-DD", taskLine: "- [ ] タスク内容..." }

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
        message: `秘書: タスク更新 ${path}`,
        content: Buffer.from(content).toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    }
  );
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { date, taskLine } = req.body || {};
  if (!date || !taskLine) return res.status(400).json({ error: "date and taskLine required" });

  const path = `.company/secretary/todos/${date}.md`;
  const existing = await ghGet(path);
  if (!existing) return res.status(404).json({ error: "TODO file not found" });

  const content = Buffer.from(existing.content, "base64").toString("utf-8");

  const isCompleted = taskLine.startsWith("- [x] ");
  const newLine = isCompleted
    ? taskLine.replace(/^- \[x\] /, "- [ ] ")
    : taskLine.replace(/^- \[ \] /, "- [x] ");

  // 完全一致で置換（最初の1件のみ）
  const newContent = content.replace(taskLine, newLine);
  if (newContent === content) {
    return res.status(400).json({ error: "taskLine not found in file" });
  }

  await ghPut(path, newContent, existing.sha);

  return res.status(200).json({ ok: true, completed: !isCompleted, newLine });
};
