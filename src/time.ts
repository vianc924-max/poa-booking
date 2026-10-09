// 台北時間 (UTC+8，沒有日光節約) 與 UTC 之間的轉換

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 台北的日期 YYYY-MM-DD 與時間 HH:MM 轉成 UTC ISO 字串 */
export function taipeiToIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - TAIPEI_OFFSET_MS).toISOString();
}

/** UTC ISO 字串在台北的日期、時間、星期 */
export function taipeiParts(iso: string) {
  const t = new Date(Date.parse(iso) + TAIPEI_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    weekday: t.getUTCDay(),
    weekdayLabel: WEEKDAYS[t.getUTCDay()],
  };
}

/** 繳費截止：活動日前兩天的 18:00（台北） */
export function paymentDeadline(startsAt: string): string {
  const { date } = taipeiParts(startsAt);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 2, 18, 0) - TAIPEI_OFFSET_MS).toISOString();
}

/** 從某個台北日期開始往後 days 天，每一天的 YYYY-MM-DD 與星期 */
export function taipeiDates(fromDate: string, days: number) {
  const [y, m, d] = fromDate.split('-').map(Number);
  return Array.from({ length: days }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    return { date: t.toISOString().slice(0, 10), weekday: t.getUTCDay() };
  });
}

/** 例如「10/16（五）19:00-21:00」 */
export function eventLabel(startsAt: string, endsAt: string): string {
  const s = taipeiParts(startsAt);
  const e = taipeiParts(endsAt);
  return `${s.month}/${s.day}（${s.weekdayLabel}）${s.time}-${e.time}`;
}
