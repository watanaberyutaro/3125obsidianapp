const crypto = require("crypto");

// ==================== GitHub API ====================

async function ghGet(path) {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const res = await fetch(
    `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(path)}`,
    { headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function ghList(folder) {
  const { GITHUB_TOKEN: t, GITHUB_OWNER: o, GITHUB_REPO: r } = process.env;
  const res = await fetch(
    `https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(folder)}`,
    { headers: { Authorization: `token ${t}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
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
    body: JSON.stringify({ message: `秘書: ${path}`, content: Buffer.from(content).toString("base64"), ...(sha ? { sha } : {}) }),
  });
}

// ==================== Google Calendar ====================

function toJSTDate(datetime) {
  if (!datetime) return new Date(Date.now() + 10 * 60 * 1000);
  if (!datetime.includes("+") && !datetime.includes("Z")) return new Date(datetime + "+09:00");
  return new Date(datetime);
}

async function getGoogleToken() {
  const rawKey = process.env.GOOGLE_PRIVATE_KEY || "";
  const base64 = rawKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "").replace(/\n/g, "").replace(/\r/g, "").replace(/\s/g, "").trim();
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
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

async function calendarAdd(title, description, datetime) {
  const token = await getGoogleToken();
  const startTime = toJSTDate(datetime);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: title, description: description || "",
        start: { dateTime: startTime.toISOString(), timeZone: "Asia/Tokyo" },
        end: { dateTime: endTime.toISOString(), timeZone: "Asia/Tokyo" },
      }),
    }
  );
  if (!res.ok) throw new Error(`Calendar error: ${JSON.stringify(await res.json())}`);
}

// ==================== Tool Definitions ====================

const TOOLS = [
  { type: "web_search_20250305", name: "web_search" },
  {
    name: "read_obsidian_file",
    description: "Obsidian（GitHub）からファイルを読む。タスク確認・メモ参照・過去データ参照に使用。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "ファイルパス（例: .company/secretary/todos/2026-03-13.md）" }
      },
      required: ["path"]
    }
  },
  {
    name: "list_obsidian_folder",
    description: "Obsidian（GitHub）のフォルダ内ファイル一覧を取得。最近のファイルを確認したいときに使用。",
    input_schema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "フォルダパス（例: .company/secretary/todos、3125情報受付事業部）" }
      },
      required: ["folder"]
    }
  },
  {
    name: "save_to_obsidian",
    description: "MarkdownファイルをObsidian（GitHub）に保存。メモ・アイデア・リサーチ結果・成果物の保存に使用。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "保存先パス" },
        content: { type: "string", description: "Markdownコンテンツ（frontmatterを含む）" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "add_calendar_event",
    description: "Googleカレンダー「渡邊カンパニー」に予定を追加。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "予定のタイトル" },
        description: { type: "string", description: "詳細（省略可）" },
        datetime: { type: "string", description: "ISO8601形式（例: 2026-03-14T14:00:00）タイムゾーン未指定の場合JSTとして処理" }
      },
      required: ["title", "datetime"]
    }
  },
  {
    name: "queue_task",
    description: "詳細なリサーチ・LP制作・長文コンテンツ作成など重い作業をキューに保存。Claude Code起動時に処理される。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        task_type: { type: "string", enum: ["research", "content_creation", "analysis", "coding"] },
        instructions: { type: "string", description: "Claude Codeへの詳細な実行指示" },
        target_folder: { type: "string", description: "成果物の保存先フォルダ（例: 3125市場調査事業部）" }
      },
      required: ["title", "task_type", "instructions", "target_folder"]
    }
  }
];

// ==================== Tool Executor ====================

async function executeTool(name, input) {
  const today = new Date().toISOString().split("T")[0];

  switch (name) {
    case "read_obsidian_file": {
      const data = await ghGet(input.path);
      if (!data) return `ファイルが見つかりません: ${input.path}`;
      return Buffer.from(data.content, "base64").toString("utf-8");
    }

    case "list_obsidian_folder": {
      const items = await ghList(input.folder);
      if (!items.length) return `フォルダが空か存在しません: ${input.folder}`;
      return items
        .sort((a, b) => b.name.localeCompare(a.name))
        .map(f => `${f.type === "dir" ? "📁" : "📄"} ${f.name}`)
        .join("\n");
    }

    case "save_to_obsidian": {
      await ghPut(input.path, input.content);
      return `保存完了: ${input.path}`;
    }

    case "add_calendar_event": {
      await calendarAdd(input.title, input.description || "", input.datetime);
      return `カレンダー登録完了: ${input.title} (${input.datetime})`;
    }

    case "queue_task": {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = `.company/secretary/inbox/${ts}-${input.title}.md`;
      await ghPut(path, `---
created: ${today}
status: pending
type: ${input.task_type}
target_folder: ${input.target_folder}
---

# 📥 ${input.title}

## 実行指示
${input.instructions}

## 保存先
${input.target_folder}
`);
      return `キューに追加: ${input.title} → Claude Code起動時に処理されます`;
    }

    default:
      return `未知のツール: ${name}`;
  }
}

// ==================== Agent Loop ====================

async function runAgent(userMessage) {
  const todayISO = new Date().toISOString().split("T")[0];
  const todayJP = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "long" });

  const system = `あなたは渡邊カンパニーの秘書AIです。
オーナーは営業会社の取締役・AI企業の社長・個人開発者です。
今日：${todayJP}（${todayISO}）

【役割】ツールを使って実際に仕事をする。会話だけで終わらせない。

【ツール使用ガイド】
- 「今日のタスクは？」→ read_obsidian_file: .company/secretary/todos/${todayISO}.md
- 「最近のメモ/アイデア確認」→ list_obsidian_folder → read_obsidian_file
- 「〇〇を調査して」→ web_search で調査 → save_to_obsidian: 3125市場調査事業部/タイトル.md
- 「メモを残して」→ save_to_obsidian: 3125情報受付事業部/${todayISO}-タイトル.md
- 「アイデアを保存」→ save_to_obsidian: 3125企画開発事業部/${todayISO}-タイトル.md
- 「予定を入れて」→ add_calendar_event
- 「LPを作って」「詳細なリサーチ」→ queue_task（Claude Codeで処理）

【保存フォーマット（必ずfrontmatterを付ける）】
---
created: ${todayISO}
category: カテゴリ
source: WebUI
---

# タイトル

内容

【返答スタイル】
- 処理したら簡潔に報告（1〜3行）
- 「処理完了です✓」で締める
- タスク一覧は箇条書きで
- ファイルがなければ正直に伝える`;

  const messages = [{ role: "user", content: userMessage }];
  const actions = new Set();

  for (let i = 0; i < 8; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system,
        tools: TOOLS,
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(`Claude API: ${data.error?.message}`);

    if (data.stop_reason === "end_turn") {
      const text = data.content.find(b => b.type === "text")?.text || "処理完了です✓";
      return { text, actions: [...actions] };
    }

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });

      const results = [];
      for (const block of data.content) {
        if (block.type !== "tool_use") continue;

        let result;
        try {
          if (block.name === "web_search") {
            // Anthropicがサーバーサイドで実行
            result = "検索を実行しました";
            actions.add("researched");
          } else {
            result = await executeTool(block.name, block.input);
            if (block.name === "save_to_obsidian") actions.add("saved");
            else if (block.name === "add_calendar_event") actions.add("calendar");
            else if (block.name === "queue_task") actions.add("queued");
          }
        } catch (e) {
          result = `エラー: ${e.message}`;
          console.error(`Tool error (${block.name}):`, e);
        }

        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      messages.push({ role: "user", content: results });
      continue;
    }

    // 予期しない終了
    const text = data.content?.find(b => b.type === "text")?.text || "処理完了です✓";
    return { text, actions: [...actions] };
  }

  return { text: "処理が完了しました。詳細はObsidianをご確認ください。", actions: [...actions] };
}

// ==================== Main Handler ====================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  try {
    const { text, actions } = await runAgent(message);

    let action = "none";
    if (actions.includes("calendar")) action = "calendar";
    else if (actions.includes("saved")) action = "saved";
    else if (actions.includes("queued")) action = "queued";
    else if (actions.includes("researched")) action = "researched";

    return res.status(200).json({ reply: text, action });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({ reply: "申し訳ありません。エラーが発生しました。", action: "none" });
  }
};
