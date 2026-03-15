// 一時デバッグ用: 環境変数確認
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).end();
  return res.status(200).json({
    GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID ? "set" : "missing",
    GOOGLE_CALENDAR_ID_SCHEDULE: process.env.GOOGLE_CALENDAR_ID_SCHEDULE
      ? process.env.GOOGLE_CALENDAR_ID_SCHEDULE.slice(0, 8) + "..."
      : "missing",
    GOOGLE_CALENDAR_ID_LOG: process.env.GOOGLE_CALENDAR_ID_LOG ? "set" : "missing",
  });
};
