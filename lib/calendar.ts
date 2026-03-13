export async function addCalendarEvent(
  title: string,
  description: string,
  datetime: string
): Promise<void> {
  // サービスアカウントでJWTトークンを取得
  const token = await getAccessToken();

  // 開始時刻（指定がなければ10分後）
  let startTime: Date;
  if (datetime) {
    startTime = new Date(datetime);
  } else {
    startTime = new Date(Date.now() + 10 * 60 * 1000);
  }
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID!);

  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: title,
        description: description,
        start: { dateTime: startTime.toISOString(), timeZone: "Asia/Tokyo" },
        end: { dateTime: endTime.toISOString(), timeZone: "Asia/Tokyo" },
      }),
    }
  );
}

async function getAccessToken(): Promise<string> {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL!;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  // JWTを作成してGoogleのOAuth2トークンエンドポイントに送信
  const jwt = await createJWT(payload, privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  return data.access_token;
}

async function createJWT(payload: object, privateKeyPem: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Node.js crypto でRS256署名
  const crypto = await import("crypto");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(privateKeyPem, "base64url");

  return `${signingInput}.${signature}`;
}
