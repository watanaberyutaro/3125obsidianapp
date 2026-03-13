const webpush = require("web-push");
const keys = webpush.generateVAPIDKeys();
console.log("\n=== VAPID Keys ===");
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("\nこれらをVercelの環境変数に追加してください。\n");
