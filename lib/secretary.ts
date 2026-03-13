import Anthropic from "@anthropic-ai/sdk";
import { saveToObsidian } from "./github";
import { addCalendarEvent } from "./calendar";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const SYSTEM_PROMPT = `あなたは渡邊カンパニーの秘書AIです。
オーナーは営業会社の取締役・AI企業の社長・個人開発者です。
ミッション：AI事業の拡大・収益化。

【あなたの役割】
ユーザーのメッセージを受け取り、以下のアクションを判断して実行します：

1. アイデア → Obsidianの「3125企画開発事業部」に保存
2. リサーチ依頼 → 調査してObsidianの「3125市場調査事業部」に保存
3. 予定・タスク → Googleカレンダー「渡邊カンパニー」に登録
4. メモ・覚書 → Obsidianの「3125情報受付事業部」に保存
5. 雑談・相談 → そのまま返答

【応答形式】
- 何をしたか簡潔に報告する
- 丁寧だが堅すぎない口調
- 保存・登録した場合はその旨を伝える

【判断】
メッセージを読んで最適なアクションを1つ選び実行してください。
アクションが必要な場合は以下のJSONを含めてください：

<action>
{
  "type": "save_idea" | "save_research" | "save_memo" | "add_calendar",
  "title": "タイトル",
  "content": "内容",
  "datetime": "YYYY-MM-DDTHH:mm:ss（予定の場合のみ）"
}
</action>`;

export async function processMessage(userMessage: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // アクションを抽出
  const actionMatch = text.match(/<action>([\s\S]*?)<\/action>/);
  let replyText = text.replace(/<action>[\s\S]*?<\/action>/g, "").trim();

  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);
      await executeAction(action);
    } catch (e) {
      console.error("Action parse error:", e);
    }
  }

  return replyText || "承知しました！";
}

async function executeAction(action: {
  type: string;
  title: string;
  content: string;
  datetime?: string;
}) {
  const today = new Date().toISOString().split("T")[0];

  switch (action.type) {
    case "save_idea":
      await saveToObsidian(
        `3125企画開発事業部/${today}-${action.title}.md`,
        buildIdeaContent(action.title, action.content, today)
      );
      break;

    case "save_research":
      await saveToObsidian(
        `3125市場調査事業部/${action.title}.md`,
        buildResearchContent(action.title, action.content, today)
      );
      break;

    case "save_memo":
      await saveToObsidian(
        `3125情報受付事業部/${today}-${action.title}.md`,
        buildMemoContent(action.title, action.content, today)
      );
      break;

    case "add_calendar":
      await addCalendarEvent(action.title, action.content, action.datetime || "");
      break;
  }
}

function buildIdeaContent(title: string, content: string, date: string): string {
  return `---
created: ${date}
category: アイデア
tags: []
status: raw
source: LINE
---

# 💡 ${title}

## 内容
${content}

## ネクストアクション
- [ ]
`;
}

function buildResearchContent(title: string, content: string, date: string): string {
  return `---
created: ${date}
category: リサーチ
tags: []
status: completed
source: LINE
---

# 調査: ${title}

## サマリー
${content}

## ネクストアクション
- [ ]
`;
}

function buildMemoContent(title: string, content: string, date: string): string {
  return `---
created: ${date}
category: メモ
source: LINE
---

# ${title}

${content}
`;
}
