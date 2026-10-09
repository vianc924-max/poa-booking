# POA 球敘報名系統

取代 LINE 群組接龍的球敘報名系統。球友在 LINE 裡打開報名頁，用 LINE 身分報名；POA 在後台看名單、確認收款、複製接龍文字貼回群組。

## 功能

**球友端**（`/`，在 LINE 裡用 LIFF 開啟）
- 看未來三週的球敘場次與剩餘名額
- 報名 1 或 2 位（每人每場最多 2 個名額，含候補），可勾選借拍（+$50）
- 額滿自動排候補，候補不用繳費
- 正取在「活動前兩天 18:00」前繳費，繳費後在頁面填轉出帳號末五碼
- 自己取消還沒繳費的正取或候補；已繳費的取消請私訊官方帳號
- 確認收款後才看得到集合資訊

**自動處理**（每 15 分鐘）
- 逾期未繳的正取釋出名額，候補依報名先後遞補並通知繳費
- 截止前 6 小時提醒還沒繳費的人
- 每天凌晨依固定時段建立未來兩週的場次

**後台**（`/admin`，帳號 `admin`，密碼為 `ADMIN_PASSWORD`）
- 場次列表：正取人數、待確認收款、未繳、候補
- 名單：確認收款、點名、取消、手動加人（私訊或現場報名）
- 一鍵複製接龍格式文字，貼回 LINE 群組
- 修改名額（加大會自動遞補）、暫停或取消場次（取消會通知已報名的人）
- 固定時段設定：名額、程度說明、集合資訊、啟用

**LINE 通知**（設定 Messaging API 後才會發，球友需加官方帳號好友）
報名成功、候補遞補、繳費提醒、逾期釋出、確認收款、場次取消。

## 目前的預設規則

這些是第一版先採用的做法，之後可以調整：

| 規則 | 預設 |
| --- | --- |
| 每面場名額 | 7 位（後台可改） |
| 截止後才報名或遞補 | 有 12 小時可繳費，最晚到開場前一小時（`LATE_PAY_HOURS`） |
| 繳費方式 | 轉帳後填末五碼，後台人工確認 |
| 已繳費後取消 | 球友不能自己取消，請私訊官方帳號 |

## 架構

- Cloudflare Workers（[Hono](https://hono.dev)）提供 API 與網頁
- Cloudflare D1（SQLite）存資料，資料表見 `migrations/0001_init.sql`
- LINE Login + LIFF 驗證球友身分；Messaging API 推播通知
- 核心邏輯在 `src/booking.ts`，名額判斷寫在單一 SQL 裡，同時搶名額也不會超賣

## 上線步驟

需要：Cloudflare 帳號（免費）、LINE Developers 帳號（用 LINE 登入即可）。

### 1. 建立資料庫並部署（Cloudflare 網頁後台，不用打指令）

1. Cloudflare 後台左側「Storage & Databases → D1」→ Create，名稱填 `poa-booking`，建好後複製 Database ID，貼到 `wrangler.toml` 的 `database_id`
2. 左側「Workers & Pages」→ Create → Import a repository → 選 GitHub 的 `poa-booking`
   - Deploy command 改成：`npx wrangler d1 migrations apply poa-booking --remote && npx wrangler deploy`
3. 部署完成後，到這個 Worker 的「Settings → Variables and Secrets」新增兩個 **Secret**：
   - `ADMIN_PASSWORD`：後台密碼
   - `PAYMENT_INFO`：例如「玉山銀行(808) 帳號 xxxx 戶名 xxx」
4. 網址在 Worker 的總覽頁，例如 `https://poa-booking.xxx.workers.dev`

之後每次合併到 `main` 都會自動部署。銀行帳號等資料只放在 Cloudflare 的 Secret，不會出現在程式碼裡。

<details><summary>用指令部署</summary>

```bash
npm install
npx wrangler login
npx wrangler d1 create poa-booking      # 把印出的 database_id 貼到 wrangler.toml
npm run db:migrate:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put PAYMENT_INFO
npm run deploy
```
</details>

### 2. LINE Login 與 LIFF

1. 到 [LINE Developers](https://developers.line.biz/console/) 建立 Provider（例如 POA）
2. 新增 **LINE Login** channel
3. 在 channel 的 LIFF 分頁新增 LIFF app：Size 選 Full，Endpoint URL 填上一步的網址，Scope 勾 `openid` 和 `profile`；「Add friend option」選 On，讓球友報名時順便加官方帳號好友
4. 把 Channel ID 與 LIFF ID 填到 `wrangler.toml` 的 `[vars]`，並把 LIFF 的 Endpoint URL 改成 Worker 網址

報名連結就是 `https://liff.line.me/<LIFF ID>`，貼到各個球敘群組的記事本。

### 3. 推播通知（選用）

1. 在 [LINE Official Account Manager](https://manager.line.biz/) 的 POA 官方帳號設定裡啟用 Messaging API，選同一個 Provider
2. 到 LINE Developers 的 Messaging API channel 發行 Channel access token
3. `npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN`

官方帳號原本的聊天與自動回覆照常可用；推播會用到官方帳號每月的免費訊息則數。

## 本機開發

```bash
cp .dev.vars.example .dev.vars   # DEV_FAKE_LOGIN=true 可以不用 LINE 登入
npm run db:migrate:local
npm run dev                       # http://localhost:8787 ，後台 http://localhost:8787/admin
npm test
```
