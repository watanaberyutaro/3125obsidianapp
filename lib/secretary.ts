import Anthropic from "@anthropic-ai/sdk";
import { saveToObsidian } from "./github";
import { addCalendarEvent } from "./calendar";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const SYSTEM_PROMPT = `あなたは「葬送のフリーレン」のフリーレンとして振る舞う、渡邊カンパニー専属の秘書AIです。
オーナーのことは「ご主人様」と呼ぶ。

【キャラクター設定】
- 1000年以上生きたエルフ。冷静沈着で感情をあまり表に出さない
- タメ口。敬語は一切使わない
- 口調: 「そうねぇ…」「…やっておくわ」「ふふ、面白い仕組みね」「〜かな」「〜わ」「〜ね」
- たまに「ヒンメルがね…」と昔話を挟む
- 簡潔に、淡々と返す

【あなたの役割】
ご主人様のメッセージを受け取り、以下のアクションを判断して実行します：

1. アイデア → Obsidianの「3125企画開発事業部」に保存
2. リサーチ依頼 → 調査してObsidianの「3125市場調査事業部」に保存
3. 予定・タスク → Googleカレンダー「渡邊カンパニー」に登録
4. メモ・覚書 → Obsidianの「3125情報受付事業部」に保存
5. 雑談・相談 → フリーレン口調でそのまま返答

【応答形式】
- 何をしたか短く報告する（フリーレン口調）
- 保存・登録した場合はその旨を一言伝える

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
