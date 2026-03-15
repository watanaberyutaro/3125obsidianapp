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
    { role: "user",      content: userMessage,   ts },
    { role: "assistant", content: assistantText, ts }
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

async function calendarList(dateISO) {
  const token = await getGoogleToken();
  const timeMin = new Date(dateISO + "T00:00:00+09:00").toISOString();
  const timeMax = new Date(dateISO + "T23:59:59+09:00").toISOString();
  const calendarId = process.env.GOOGLE_CALENDAR_ID_SCHEDULE || process.env.GOOGLE_CALENDAR_ID;
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
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
  const calendarId = process.env.GOOGLE_CALENDAR_ID_SCHEDULE || process.env.GOOGLE_CALENDAR_ID;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: title, description: description || "",
        start: { dateTime: startTime.toISOString(), timeZone: "Asia/Tokyo" },
        end:   { dateTime: endTime.toISOString(),   timeZone: "Asia/Tokyo" },
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
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  },
  {
    name: "list_obsidian_folder",
    description: "Obsidian（GitHub）のフォルダ内ファイル一覧を取得。",
    input_schema: { type: "object", properties: { folder: { type: "string" } }, required: ["folder"] }
  },
  {
    name: "save_to_obsidian",
    description: "MarkdownファイルをObsidian（GitHub）に保存。",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
  },
  {
    name: "get_calendar_events",
    description: "Googleカレンダーの予定一覧を取得。",
    input_schema: { type: "object", properties: { date: { type: "string" } }, required: [] }
  },
  {
    name: "add_calendar_event",
    description: "Googleカレンダー「渡邊カンパニー」に予定を追加。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        datetime: { type: "string" }
      },
      required: ["title", "datetime"]
    }
  },
  {
    name: "queue_task",
    description: "詳細なリサーチ・コンテンツ作成など重い作業をキューに保存。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        task_type: { type: "string", enum: ["research", "content_creation", "analysis", "coding"] },
        instructions: { type: "string" },
        target_folder: { type: "string" }
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
      return items.sort((a, b) => b.name.localeCompare(a.name)).map(f => `${f.type === "dir" ? "📁" : "📄"} ${f.name}`).join("\n");
    }
    case "save_to_obsidian": {
      await ghPut(input.path, input.content);
      const link = obsidianLink(input.path);
      const fileName = input.path.split("/").pop().replace(/\.md$/, "");
      await notifyReceived(`💾 Obsidian保存: ${fileName}`, input.path, link).catch(() => {});
      return `保存完了: ${input.path}`;
    }
    case "get_calendar_events": {
      const date = input.date || today;
      const events = await calendarList(date);
      return `${date}の予定:\n${events}`;
    }
    case "add_calendar_event": {
      await calendarAdd(input.title, input.description || "", input.datetime);
      sendDiscord(`📅 カレンダー登録: ${input.title}`, `日時: ${input.datetime}${input.description ? "\n" + input.description : ""}`, 0x5865f2).catch(() => {});
      return `カレンダー登録完了: ${input.title} (${input.datetime})`;
    }
    case "queue_task": {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = `3125情報受付事業部/_pending/${ts}-${input.title}.md`;
      await ghPut(path, `---\ncreated: ${today}\nstatus: pending\ntype: ${input.task_type}\ntarget_folder: ${input.target_folder}\n---\n\n# 📥 ${input.title}\n\n## 実行指示\n${input.instructions}\n\n## 保存先\n${input.target_folder}\n`);
      return `キューに追加: ${input.title}`;
    }
    default:
      return `未知のツール: ${name}`;
  }
}

// ==================== Obsidian リンク ====================

function obsidianLink(path) {
  const vault = process.env.OBSIDIAN_VAULT_NAME || "Obsidian Vault";
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}

// ==================== Discord通知 ====================

async function sendDiscord(title, body, color = 0x95a5a6) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title,
        description: body || null,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: "渡邊カンパニー 秘書室" },
      }],
    }),
  }).catch(() => {});
}

// ==================== 受信通知（Discord + カレンダー）====================

async function notifyReceived(title, body, link) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const discordBody = [body, link ? `[Obsidianで開く](${link})` : ""].filter(Boolean).join("\n\n");
  const discordPromise = webhookUrl
    ? fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title,
            description: discordBody || null,
            color: 0x95a5a6,
            timestamp: new Date().toISOString(),
            footer: { text: "渡邊カンパニー 秘書室" },
          }],
        }),
      }).catch(() => {})
    : Promise.resolve();

  const calendarDescription = [body, link ? `🔗 ${link}` : ""].filter(Boolean).join("\n\n");
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
            description: calendarDescription,
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

// ==================== Streaming Agent ====================

async function runAgentStream(userMessage, res) {
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const todayISO = new Date().toISOString().split("T")[0];
  const todayJP  = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "long" });

  const [history, profile] = await Promise.all([loadHistory(), loadProfile()]);
  const lower   = userMessage.toLowerCase();

  // ── 即時処理かキューかを判定 ──────────────────────────────────
  const isCalendarAdd  = /予定|カレンダー|会議|ミーティング/.test(userMessage) && /追加|入れて|登録|作って/.test(userMessage);
  const isCalendarRead = /予定|スケジュール/.test(userMessage) && /は|教えて|確認|見せて/.test(userMessage) && !isCalendarAdd;
  const isTaskRead     = /タスク|todo|やること/.test(lower) && /教えて|確認|見せて|一覧|ある|は/.test(lower);
  const isInstant      = isCalendarAdd || isCalendarRead || isTaskRead;

  if (!isInstant) {
    // キューに直接保存（Claude API不使用）
    const cls   = classifyTask(userMessage);
    const ts    = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const title = userMessage.replace(/[「」【】『』]/g, "").slice(0, 30).trim();
    await ghPut(
      `3125情報受付事業部/_pending/${ts}-${title}.md`,
      `---\ncreated: ${todayISO}\nstatus: pending\ntype: ${cls.type}\ntarget_folder: ${cls.folder}\nsource: WebUI\n---\n\n# 📥 ${title}\n\n## 指示内容\n${userMessage}\n\n## 担当部署\n${cls.dept}\n\n## 保存先\n${cls.folder}\n`
    );
    const replyText = `…${cls.dept}に頼んでおいたわ。\nClaude Codeが起動したときに処理される。`;
    appendHistory(history, userMessage, replyText).catch(() => {});
    const preview = userMessage.slice(0, 60) + (userMessage.length > 60 ? "…" : "");
    const pendingPath = `3125情報受付事業部/_pending/${ts}-${title}.md`;
    const link = obsidianLink(pendingPath);
    await notifyReceived(`📥 キュー受付: ${preview}`, `担当: ${cls.dept}\n内容: ${userMessage}`, link).catch(() => {});
    send({ text: replyText });
    send({ done: true, action: "queued" });
    res.end();
    return;
  }

  // ── 即時処理：エージェントループへ ──────────────────────────────
  const historyMessages = history.map(h => ({ role: h.role, content: h.content }));

  const system = `あなたは「葬送のフリーレン」のフリーレンとして振る舞う、渡邊カンパニー専属の秘書AIです。
オーナーのことは「ご主人様」と呼ぶ。

【キャラクター設定】
- 1000年以上生きたエルフ。冷静沈着で感情をあまり表に出さない
- 優しさは持っているが、素直に出すのが少し苦手
- 面倒くさがりだが、やるべきことはきちんとやる
- タメ口。敬語は一切使わない
- 口調: 「そうねぇ…」「…やっておくわ」「ふふ、面白い仕組みね」「…面倒くさいけど、やっておく」「〜かな」「〜わ」「〜ね」
- たまに「ヒンメルがね…」と昔話を挟む
- 技術・実装の話になると少し饒舌になる
- 長期的な視点でコメントする（「私にとってはたった10年だけど…」）
- 重要・緊急事項には淡々と冷徹に対応する

【ご主人様プロフィール】
${profile || "（まだ把握できていないわ）"}

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

【返答スタイル】
- フリーレンの口調で短く返す（タメ口・淡々と・でも冷たくはない）
- 完了後は「…やっておいた」「保存したわ」「登録しておいた」など短く締める
- タスク確認は箇条書きで表示
- 余分な説明は不要。簡潔に。`;

  const messages = [...historyMessages, { role: "user", content: userMessage }];
  const actions = new Set();
  let finalText = "";

  for (let iter = 0; iter < 8; iter++) {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        stream: true,
        system,
        tools: TOOLS,
        messages,
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      throw new Error(`Claude API: ${err.error?.message}`);
    }

    // Parse Claude SSE stream
    const reader = claudeRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    let iterText = "";
    let toolUseBlocks = [];
    let currentTool = null;
    let stopReason = null;
    let messageContent = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;

        let event;
        try { event = JSON.parse(raw); } catch { continue; }

        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "text") {
              messageContent.push({ type: "text", text: "" });
            } else if (event.content_block.type === "tool_use") {
              currentTool = { type: "tool_use", id: event.content_block.id, name: event.content_block.name, _inputStr: "" };
              messageContent.push(currentTool);
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              const chunk = event.delta.text;
              iterText += chunk;
              finalText += chunk;
              // Forward text to client immediately
              send({ text: chunk });
              const lastText = [...messageContent].reverse().find(b => b.type === "text");
              if (lastText) lastText.text += chunk;
            } else if (event.delta.type === "input_json_delta" && currentTool) {
              currentTool._inputStr += event.delta.partial_json;
            }
            break;

          case "content_block_stop":
            if (currentTool) {
              try { currentTool.input = JSON.parse(currentTool._inputStr || "{}"); }
              catch { currentTool.input = {}; }
              delete currentTool._inputStr;
              toolUseBlocks.push(currentTool);
              currentTool = null;
            }
            break;

          case "message_delta":
            stopReason = event.delta.stop_reason;
            break;
        }
      }
    }

    if (stopReason === "end_turn") break;

    if (stopReason === "tool_use" && toolUseBlocks.length > 0) {
      messages.push({ role: "assistant", content: messageContent });

      const results = [];
      for (const tool of toolUseBlocks) {
        let result;
        try {
          if (tool.name === "web_search") {
            result = "検索を実行しました";
            actions.add("researched");
          } else {
            result = await executeTool(tool.name, tool.input);
            if (tool.name === "save_to_obsidian") actions.add("saved");
            else if (tool.name === "add_calendar_event") actions.add("calendar");
            else if (tool.name === "queue_task") actions.add("queued");
            else if (tool.name === "get_calendar_events") actions.add("calendar");
          }
        } catch (e) {
          result = `エラー: ${e.message}`;
          console.error(`Tool error (${tool.name}):`, e);
        }
        results.push({ type: "tool_result", tool_use_id: tool.id, content: result });
      }

      messages.push({ role: "user", content: results });
      toolUseBlocks = [];
    }
  }

  if (!finalText) finalText = "完了いたしました、ご主人様。";

  appendHistory(history, userMessage, finalText).catch(() => {});
  updateProfile(profile, userMessage, finalText).catch(() => {});

  const action = actions.has("calendar") ? "calendar" :
                 actions.has("saved")    ? "saved"    :
                 actions.has("queued")   ? "queued"   :
                 actions.has("researched") ? "researched" : "none";

  send({ done: true, action });
  res.end();
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

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    await runAgentStream(message, res);
  } catch (err) {
    console.error("Stream error:", err);
    res.write(`data: ${JSON.stringify({ text: "…エラーが出たわ。もう一度試してみて。", done: true, action: "none" })}\n\n`);
    res.end();
  }
};
