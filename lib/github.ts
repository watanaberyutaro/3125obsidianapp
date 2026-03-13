export async function saveToObsidian(filePath: string, content: string): Promise<void> {
  const owner = process.env.GITHUB_OWNER!;
  const repo = process.env.GITHUB_REPO!;
  const token = process.env.GITHUB_TOKEN!;

  const encodedContent = Buffer.from(content).toString("base64");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;

  // ファイルが既に存在するか確認（更新の場合はSHAが必要）
  let sha: string | undefined;
  try {
    const getRes = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
  } catch {}

  // ファイルを作成または更新
  await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `秘書: ${filePath}`,
      content: encodedContent,
      ...(sha ? { sha } : {}),
    }),
  });
}
