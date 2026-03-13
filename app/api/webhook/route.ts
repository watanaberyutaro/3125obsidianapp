import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { processMessage } from "../../../lib/secretary";

// LINE署名検証（@line/bot-sdk不使用）
function validateSignature(body: string, secret: string, signature: string): boolean {
  const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return hash === signature;
}

// LINEへの返信
async function replyMessage(replyToken: string, text: string, accessToken: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-line-signature") || "";
  const secret = process.env.LINE_CHANNEL_SECRET!;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

  if (!validateSignature(body, secret, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const events = JSON.parse(body).events;

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userMessage: string = event.message.text;
    const replyToken: string = event.replyToken;

    try {
      const reply = await processMessage(userMessage);
      await replyMessage(replyToken, reply, accessToken);
    } catch (err) {
      console.error(err);
      await replyMessage(replyToken, "申し訳ありません。処理中にエラーが発生しました。", accessToken);
    }
  }

  return NextResponse.json({ status: "ok" });
}
