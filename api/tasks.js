// api/tasks.js
// 今日（または指定日）のTODOファイルをJSONで返す
// GET /api/tasks?date=2026-03-15

async function ghGet(path) {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const res = await fetch(
    `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(path)}`,
    { headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) return null;
  return res.json();
}

function parseTodoFile(content, date) {
  const result = {
    date,
    stats: { total: 0, done: 0, undone: 0, rate: 0 },
    sections: {
      high:   { label: "優先度: 高",  emoji: "🔴", tasks: [] },
      normal: { label: "優先度: 通常", emoji: "🟡", tasks: [] },
      done:   { label: "本日完了",     emoji: "✅", tasks: [] },
    },
  };

  let currentSection = null;

  for (const line of content.split("\n")) {
    if (line.includes("優先度: 高") && line.startsWith("#"))   { currentSection = "high";   continue; }
    if (line.includes("優先度: 通常") && line.startsWith("#")) { currentSection = "normal"; continue; }
    if (line.includes("本日完了") && line.startsWith("#"))     { currentSection = "done";   continue; }

    const taskMatch = line.match(/^- \[([ x])\] (.+)/);
    if (!taskMatch || !currentSection) continue;

    const completed = taskMatch[1] === "x";
    const rawText   = taskMatch[2];

    // "タスク名 | 優先度: 通常 | 追加: 2026-03-15" をパース
    const parts = rawText.split(" | ");
    const title = parts[0].trim();
    const meta  = {};
    for (const p of parts.slice(1)) {
      const idx = p.indexOf(": ");
      if (idx !== -1) meta[p.slice(0, idx).trim()] = p.slice(idx + 2).trim();
    }

    result.sections[currentSection].tasks.push({
      id:        Buffer.from(line).toString("base64").slice(0, 16),
      title,
      completed,
      priority:  meta["優先度"] ?? null,
      addedAt:   meta["追加"]   ?? null,
      doneAt:    meta["完了"]   ?? null,
      rawLine:   line,
    });

    result.stats.total++;
    if (completed) result.stats.done++;
    else           result.stats.undone++;
  }

  result.stats.rate = result.stats.total > 0
    ? Math.round((result.stats.done / result.stats.total) * 100)
    : 0;

  return result;
}

function emptyData(date) {
  return {
    date,
    stats: { total: 0, done: 0, undone: 0, rate: 0 },
    sections: {
      high:   { label: "優先度: 高",  emoji: "🔴", tasks: [] },
      normal: { label: "優先度: 通常", emoji: "🟡", tasks: [] },
      done:   { label: "本日完了",     emoji: "✅", tasks: [] },
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const date = req.query?.date || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const path = `📋 タスク/${date}.md`;

  const data = await ghGet(path);
  if (!data) return res.status(200).json(emptyData(date));

  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return res.status(200).json(parseTodoFile(content, date));
};
