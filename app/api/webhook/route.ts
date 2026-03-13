import { NextRequest, NextResponse } from "next/server";
import * as line from "@line/bot-sdk";
import { processMessage } from "@/lib/secretary";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-line-signature") || "";

  // 署名検証
  if (!line.validateSignature(body, config.channelSecret, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const events: line.WebhookEvent[] = JSON.parse(body).events;
  const client = new line.messagingApi.MessagingApiClient(config);

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    try {
      // 秘書が処理
      const reply = await processMessage(userMessage);

      await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text: reply }],
      });
    } catch (err) {
      console.error(err);
      await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text: "申し訳ありません。処理中にエラーが発生しました。" }],
      });
    }
  }

  return NextResponse.json({ status: "ok" });
}
