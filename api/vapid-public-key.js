module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
};
