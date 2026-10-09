// LINE Login（驗證球友身分）與 Messaging API（從官方帳號推播）

export interface LineProfile {
  userId: string;
  name: string;
}

/** 驗證 LIFF 取得的 ID token，成功回傳 LINE 使用者 */
export async function verifyIdToken(idToken: string, channelId: string): Promise<LineProfile | null> {
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { sub?: string; name?: string };
  return data.sub ? { userId: data.sub, name: data.name ?? '' } : null;
}

/** 推播文字訊息。沒設定 token、或球友沒加官方帳號好友時會靜靜失敗，不影響報名。 */
export async function pushText(token: string | undefined, to: string, text: string): Promise<void> {
  if (!token) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
  } catch {
    // 通知失敗不影響主流程
  }
}
