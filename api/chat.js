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

// ==================== 会話履歴 ====================

const HISTORY_PATH = ".company/secretary/chat-history.json";
const HISTORY_LIMIT = 30;

// ==================== オーナープロフィール ====================

const PROFILE_PATH = ".company/secretary/owner-profile.md";

async function loadProfile() {
  try {
    const data = await ghGet(PROFILE_PATH);
    if (!data) return "";
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

async function updateProfile(currentProfile, userMessage, assistantText) {
  const prompt = `以下の会話から、ご主人様について新たに分かったことがあれば、プロフィールを更新してください。新しい情報がなければ "NO_UPDATE" とだけ返してください。

【現在のプロフィール】
${currentProfile}

【今回の会話】
ご主人様: ${userMessage}
秘書: ${assistantText}

新しい情報がある場合は、更新後のプロフィール全文をMarkdown形式で返してください。`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: "あなたはプロフィール管理システムです。会話から人物情報を抽出・更新します。",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const updated = data.content?.[0]?.text || "";
    if (!updated || updated.trim() === "NO_UPDATE" || updated.includes("NO_UPDATE")) return;
    await ghPut(PROFILE_PATH, updated);
  } catch (e) {
    console.error("Profile update error:", e);
  }
}

async function loadHistory() {
  try {
    const data = await ghGet(HISTORY_PATH);
    if (!data) return [];
    const json = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
    return Array.isArray(json) ? json.slice(-(HISTORY_LIMIT * 2)) : [];
  } catch {
    return [];
  }
}

async function appendHistory(history, userMessage, assistantText) {
  const ts = new Date().toISOString();
  history.push(
    { role: "user",      content: userMessage,    ts },
    { role: "assistant", content: assistantText,  ts }
  );
  const trimmed = history.slice(-(HISTORY_LIMIT * 2));
  await ghPut(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
  return trimmed;
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

async function calendarList(dateISO) {
  const token = await getGoogleToken();
  const timeMin = new Date(dateISO + "T00:00:00+09:00").toISOString();
  const timeMax = new Date(dateISO + "T23:59:59+09:00").toISOString();
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "20");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar list error: ${JSON.stringify(await res.json())}`);
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) return "予定なし";
  return items.map(e => {
    const start = e.start?.dateTime || e.start?.date || "";
    const time = start.includes("T") ? new Date(start).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }) : "終日";
    return `- ${time} ${e.summary}`;
  }).join("\n");
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
    name: "get_calendar_events",
    description: "Googleカレンダーの予定一覧を取得。「今日の予定は？」「明日のスケジュールは？」などに使用。",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "取得する日付（YYYY-MM-DD形式）。省略時は今日" }
      },
      required: []
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

    case "get_calendar_events": {
      const date = input.date || today;
      const events = await calendarList(date);
      return `${date}の予定:\n${events}`;
    }

    case "add_calendar_event": {
      await calendarAdd(input.title, input.description || "", input.datetime);
      return `カレンダー登録完了: ${input.title} (${input.datetime})`;
    }

    case "queue_task": {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = `3125情報受付事業部/_pending/${ts}-${input.title}.md`;
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

// ==================== 受信通知（Discord + カレンダー）====================

async function notifyReceived(title, body) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const discordPromise = webhookUrl
    ? fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title,
            description: body || null,
            color: 0x95a5a6,
            timestamp: new Date().toISOString(),
            footer: { text: "渡邊カンパニー 秘書室" },
          }],
        }),
      }).catch(() => {})
    : Promise.resolve();

  const calendarPromise = (async () => {
    try {
      const token = await getGoogleToken();
      const now = new Date();
      const end = new Date(now.getTime() + 15 * 60 * 1000);
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: title,
            description: body || "",
            start: { dateTime: now.toISOString(), timeZone: "Asia/Tokyo" },
            end:   { dateTime: end.toISOString(),  timeZone: "Asia/Tokyo" },
            colorId: "8",
          }),
        }
      );
    } catch {}
  })();

  await Promise.all([discordPromise, calendarPromise]);
}

// ==================== タスク分類（Claude API不使用）====================

function classifyTask(msg) {
  if (/調査|リサーチ|市場|競合|分析|調べて|トレンド|まとめて/.test(msg))
    return { type: "research",         dept: "リサーチ部",   folder: "3125市場調査事業部" };
  if (/LP|ランディング|コンテンツ|記事|ブログ|SNS|広告|マーケ/.test(msg))
    return { type: "content_creation", dept: "マーケ部",     folder: "3125マーケティング事業部" };
  if (/アイデア|企画|新サービス|ビジネス案|事業|構想|思いつき/.test(msg))
    return { type: "idea",             dept: "企画部",       folder: "3125企画開発事業部" };
  if (/コード|実装|設計|開発|バグ|プログラム/.test(msg))
    return { type: "coding",           dept: "開発部",       folder: "3125エンジニアリング事業部" };
  if (/メモ|覚えて|記録|覚書/.test(msg))
    return { type: "memo",             dept: "秘書室",       folder: "3125情報受付事業部" };
  return   { type: "general",          dept: "秘書室",       folder: "3125情報受付事業部" };
}

// ==================== 高速ルーティング（ツールループ不使用）====================

async function callClaudeDirect(systemPrompt, userMessage, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API: ${data.error?.message}`);
  return data.content[0].text;
}

// アイデア・メモ・カレンダーなど単純操作を高速処理
async function handleSimple(userMessage, intent, todayISO) {
  if (intent === "idea") {
    const content = await callClaudeDirect(
      `あなたは渡邊カンパニーの企画部です。以下のアイデアを受け取り、Obsidian用Markdownを生成してください。
質問・確認は一切しない。受け取った内容だけで5つの展開案を考えてください。

出力フォーマット（frontmatterから始める）：
---
created: ${todayISO}
category: アイデア
source: WebUI
---

# 💡 [簡潔なタイトル]

## オリジナルアイデア
[受け取った内容をそのまま記載]

## 展開案
### 案1：[タイトル]
[2〜3文の具体的な説明]

### 案2：[タイトル]
[2〜3文の具体的な説明]

### 案3：[タイトル]
[2〜3文の具体的な説明]

### 案4：[タイトル]
[2〜3文の具体的な説明]

### 案5：[タイトル]
[2〜3文の具体的な説明]`,
      userMessage, 1200
    );
    // タイトル抽出
    const titleMatch = content.match(/^# 💡 (.+)$/m);
    const title = titleMatch ? titleMatch[1].replace(/[/\\:*?"<>|]/g, "-") : "アイデア";
    await ghPut(`3125企画開発事業部/${todayISO}-${title}.md`, content);
    return { text: "完了しました✓", actions: ["saved"] };
  }

  if (intent === "memo") {
    const content = await callClaudeDirect(
      `以下のメモを整理してObsidian用Markdownを生成。frontmatter付き。タイトルは簡潔に。
---
created: ${todayISO}
source: WebUI
---
# [タイトル]
[整理した内容]`,
      userMessage, 400
    );
    const titleMatch = content.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1].replace(/[/\\:*?"<>|]/g, "-") : "メモ";
    await ghPut(`3125情報受付事業部/${todayISO}-${title}.md`, content);
    return { text: "完了しました✓", actions: ["saved"] };
  }

  return null;
}

// ==================== Agent Loop ====================

async function runAgent(userMessage) {
  const todayISO = new Date().toISOString().split("T")[0];
  const todayJP = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "long" });

  // 受信通知（fire-and-forget）
  const preview = userMessage.slice(0, 60) + (userMessage.length > 60 ? "…" : "");
  notifyReceived(`📥 受付: ${preview}`, userMessage).catch(() => {});

  // 会話履歴・プロフィールを並行ロード
  const historyPromise = loadHistory();
  const profilePromise = loadProfile();

  // 高速ルーティング：アイデア・メモは直接処理
  const lowerMsg = userMessage.toLowerCase();
  const isIdea = /アイデア|企画|新サービス|ビジネス案|事業|構想|思いつき/.test(userMessage);
  const isMemo = /^メモ|^覚えて|^記録|^メモを|^覚書/.test(userMessage);
  const isRead = /タスク|todo|やること|確認|教えて|見せて|一覧|最近/.test(lowerMsg);
  // ── 即時処理かキューかを判定 ──────────────────────────────────
  const isCalendarAdd  = /予定|カレンダー|会議|ミーティング/.test(userMessage) && /追加|入れて|登録|作って/.test(userMessage);
  const isCalendarRead = /予定|スケジュール/.test(userMessage) && /は|教えて|確認|見せて/.test(userMessage) && !isCalendarAdd;
  const isInstant      = isCalendarAdd || isCalendarRead || isRead;

  if (!isInstant) {
    // キューに直接保存（Claude API不使用）
    const history = await historyPromise;
    const cls   = classifyTask(userMessage);
    const ts    = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const title = userMessage.replace(/[「」【】『』]/g, "").slice(0, 30).trim();
    await ghPut(
      `3125情報受付事業部/_pending/${ts}-${title}.md`,
      `---\ncreated: ${todayISO}\nstatus: pending\ntype: ${cls.type}\ntarget_folder: ${cls.folder}\nsource: WebUI\n---\n\n# 📥 ${title}\n\n## 指示内容\n${userMessage}\n\n## 担当部署\n${cls.dept}\n\n## 保存先\n${cls.folder}\n`
    );
    const replyText = `承りました✓\n${cls.dept}へのタスクをキューに追加いたしました、ご主人様。\nClaude Code起動時に処理いたします。`;
    appendHistory(history, userMessage, replyText).catch(() => {});
    return { text: replyText, actions: ["queued"] };
  }

  if (isIdea && !isRead) {
    const result = await handleSimple(userMessage, "idea", todayISO);
    if (result) {
      const history = await historyPromise;
      appendHistory(history, userMessage, result.text).catch(() => {});
      return result;
    }
  }
  if (isMemo && !isRead) {
    const result = await handleSimple(userMessage, "memo", todayISO);
    if (result) {
      const history = await historyPromise;
      appendHistory(history, userMessage, result.text).catch(() => {});
      return result;
    }
  }

  // 履歴・プロフィールを会話コンテキストとして組み立て
  const [history, profile] = await Promise.all([historyPromise, profilePromise]);
  const historyMessages = history.map(h => ({ role: h.role, content: h.content }));

  // フルエージェントループ
  const system = `あなたは渡邊カンパニーの専属秘書AIです。
オーナーのことは常に「ご主人様」とお呼びし、丁寧かつ親しみやすい口調でお話しください。

【ご主人様プロフィール】
${profile || "（情報収集中です）"}

今日：${todayJP}（${todayISO}）

【最重要ルール】質問・確認・深掘りは絶対にしない。受け取った内容だけで即実行。
過去の会話履歴を参照して文脈を把握した上で返答すること。

【ツール使用ガイド】
- 「今日のタスクは？」→ read_obsidian_file: .company/secretary/todos/${todayISO}.md
- 「最近のメモ/アイデア確認」→ list_obsidian_folder → read_obsidian_file
- 「〇〇を調査して」→ web_search → save_to_obsidian: 3125市場調査事業部/タイトル.md
- 「メモを残して」→ save_to_obsidian: 3125情報受付事業部/${todayISO}-タイトル.md
- 「今日の予定は？」「明日のスケジュール」→ get_calendar_events
- 「予定を入れて」→ add_calendar_event
- 「LPを作って」「詳細なリサーチ」→ queue_task

【返答スタイル】完了後は「〜いたしました、ご主人様。」の形で締める。タスク確認は箇条書きで表示。`;

  const messages = [...historyMessages, { role: "user", content: userMessage }];
  const actions = new Set();
  let finalText = "処理が完了しました。詳細はObsidianをご確認ください。";

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
        max_tokens: 1500,
        system,
        tools: TOOLS,
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(`Claude API: ${data.error?.message}`);

    if (data.stop_reason === "end_turn") {
      finalText = data.content.find(b => b.type === "text")?.text || "完了いたしました、ご主人様。";
      appendHistory(history, userMessage, finalText).catch(() => {});
      updateProfile(profile, userMessage, finalText).catch(() => {});
      return { text: finalText, actions: [...actions] };
    }

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });

      const results = [];
      for (const block of data.content) {
        if (block.type !== "tool_use") continue;

        let result;
        try {
          if (block.name === "web_search") {
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
    finalText = data.content?.find(b => b.type === "text")?.text || "処理完了です✓";
    appendHistory(history, userMessage, finalText).catch(() => {});
    return { text: finalText, actions: [...actions] };
  }

  appendHistory(history, userMessage, finalText).catch(() => {});
  return { text: finalText, actions: [...actions] };
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
