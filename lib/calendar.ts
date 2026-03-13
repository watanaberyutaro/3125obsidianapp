import { google } from "googleapis";

export async function addCalendarEvent(
  title: string,
  description: string,
  datetime: string
): Promise<void> {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL!,
      private_key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  // 開始時刻（指定がなければ10分後）
  let startTime: Date;
  if (datetime) {
    startTime = new Date(datetime);
  } else {
    startTime = new Date(Date.now() + 10 * 60 * 1000);
  }
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1時間後

  await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID!,
    requestBody: {
      summary: title,
      description: description,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: "Asia/Tokyo",
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: "Asia/Tokyo",
      },
    },
  });
}
