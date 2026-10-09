// 報名、候補、遞補、逾期的核心邏輯。只依賴 D1，方便測試。

import { eventLabel, paymentDeadline, taipeiDates, taipeiToIso } from './time';

export type RegStatus = 'pending' | 'reported' | 'confirmed' | 'waitlist' | 'cancelled' | 'expired';

export interface EventRow {
  id: number;
  slot_id: number | null;
  location: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  price: number;
  rental_fee: number;
  payment_deadline: string;
  level_note: string;
  meeting_note: string;
  status: 'open' | 'closed' | 'cancelled';
}

export interface Registration {
  id: number;
  event_id: number;
  player_id: number | null;
  attendee_name: string;
  rent_racket: number;
  amount: number;
  status: RegStatus;
  pay_by: string | null;
  payment_last5: string | null;
  created_at: string;
  promoted_at: string | null;
  attended: number | null;
}

export interface Rules {
  maxSeatsPerPerson: number;
  latePayHours: number;
}

export class BookingError extends Error {}

/** 佔名額的狀態 */
const SEATED = `'pending','reported','confirmed'`;
/** 計入每人上限的狀態 */
const HOLDING = `'pending','reported','confirmed','waitlist'`;

export async function getEvent(db: D1Database, id: number) {
  return db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
}

/**
 * 正取的繳費期限。平常是活動前兩天 18:00；
 * 若已經過了（例如截止後才報名或才遞補），就給 latePayHours 小時，最晚到活動開始前一小時。
 */
export function payByFor(event: EventRow, now: Date, rules: Rules): string {
  if (Date.parse(event.payment_deadline) > now.getTime()) return event.payment_deadline;
  const late = now.getTime() + rules.latePayHours * 3600_000;
  const latest = Date.parse(event.starts_at) - 3600_000;
  return new Date(Math.max(now.getTime(), Math.min(late, latest))).toISOString();
}

export interface Attendee {
  name: string;
  rentRacket: boolean;
}

/**
 * 報名一或多個名額。每個名額一筆紀錄；有空位就是正取待繳費，沒有就進候補。
 * 判斷名額與每人上限都寫在同一個 SQL 裡，D1 會依序執行 batch，所以同時報名也不會超賣。
 */
export async function register(
  db: D1Database,
  input: { eventId: number; playerId: number | null; attendees: Attendee[]; now: Date; rules: Rules },
): Promise<Registration[]> {
  const { eventId, playerId, attendees, now, rules } = input;
  if (attendees.length === 0) throw new BookingError('請至少填一位');
  if (attendees.some((a) => !a.name.trim())) throw new BookingError('請填寫每一位的名字');

  const event = await getEvent(db, eventId);
  if (!event) throw new BookingError('找不到這個場次');
  if (event.status !== 'open') throw new BookingError('這個場次目前不開放報名');
  if (Date.parse(event.starts_at) <= now.getTime()) throw new BookingError('活動已經開始了');

  if (playerId !== null) {
    const held = await db
      .prepare(`SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND player_id = ? AND status IN (${HOLDING})`)
      .bind(eventId, playerId)
      .first<{ n: number }>();
    if ((held?.n ?? 0) + attendees.length > rules.maxSeatsPerPerson) {
      throw new BookingError(`每人每場最多報名 ${rules.maxSeatsPerPerson} 個名額`);
    }
  }

  const createdAt = now.toISOString();
  const payBy = payByFor(event, now, rules);
  const stmts = attendees.map((a) =>
    db
      .prepare(
        `INSERT INTO registrations (event_id, player_id, attendee_name, rent_racket, amount, status, pay_by, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5,
           CASE WHEN (SELECT COUNT(*) FROM registrations WHERE event_id = ?1 AND status IN (${SEATED})) < ?6
             THEN 'pending' ELSE 'waitlist' END,
           CASE WHEN (SELECT COUNT(*) FROM registrations WHERE event_id = ?1 AND status IN (${SEATED})) < ?6
             THEN ?7 ELSE NULL END,
           ?8
         WHERE ?2 IS NULL
            OR (SELECT COUNT(*) FROM registrations WHERE event_id = ?1 AND player_id = ?2 AND status IN (${HOLDING})) < ?9
         RETURNING *`,
      )
      .bind(
        eventId,
        playerId,
        a.name.trim().slice(0, 40),
        a.rentRacket ? 1 : 0,
        event.price + (a.rentRacket ? event.rental_fee : 0),
        event.capacity,
        payBy,
        createdAt,
        rules.maxSeatsPerPerson,
      ),
  );
  const results = await db.batch<Registration>(stmts);
  const rows = results.flatMap((r) => r.results ?? []);
  if (rows.length < attendees.length) {
    throw new BookingError(`每人每場最多報名 ${rules.maxSeatsPerPerson} 個名額`);
  }
  return rows;
}

/** 有空位就把候補依報名先後遞補成正取待繳費，回傳被遞補的人 */
export async function promoteWaitlist(db: D1Database, eventId: number, now: Date, rules: Rules) {
  const event = await getEvent(db, eventId);
  if (!event || event.status === 'cancelled' || Date.parse(event.starts_at) <= now.getTime()) return [];
  const payBy = payByFor(event, now, rules);
  const promoted: Registration[] = [];
  for (;;) {
    const row = await db
      .prepare(
        `UPDATE registrations SET status = 'pending', pay_by = ?1, promoted_at = ?2
         WHERE id = (SELECT id FROM registrations WHERE event_id = ?3 AND status = 'waitlist' ORDER BY created_at, id LIMIT 1)
           AND (SELECT COUNT(*) FROM registrations WHERE event_id = ?3 AND status IN (${SEATED}))
             < (SELECT capacity FROM events WHERE id = ?3)
         RETURNING *`,
      )
      .bind(payBy, now.toISOString(), eventId)
      .first<Registration>();
    if (!row) return promoted;
    promoted.push(row);
  }
}

async function getRegistration(db: D1Database, id: number) {
  return db.prepare('SELECT * FROM registrations WHERE id = ?').bind(id).first<Registration>();
}

/**
 * 取消一個名額。球友自己只能取消還沒繳費的正取或候補；
 * 已回報或已確認繳費的要找官方帳號處理（退費規則還沒定）。
 */
export async function cancel(
  db: D1Database,
  input: { registrationId: number; byPlayerId: number | null; now: Date; rules: Rules },
) {
  const reg = await getRegistration(db, input.registrationId);
  if (!reg) throw new BookingError('找不到這筆報名');
  if (input.byPlayerId !== null) {
    if (reg.player_id !== input.byPlayerId) throw new BookingError('找不到這筆報名');
    if (reg.status !== 'pending' && reg.status !== 'waitlist') {
      throw new BookingError('已繳費的報名請私訊 POA 官方 LINE 取消');
    }
  }
  if (reg.status === 'cancelled' || reg.status === 'expired') return { cancelled: reg, promoted: [] };
  const cancelled = await db
    .prepare(`UPDATE registrations SET status = 'cancelled', cancelled_at = ? WHERE id = ? RETURNING *`)
    .bind(input.now.toISOString(), reg.id)
    .first<Registration>();
  const promoted = await promoteWaitlist(db, reg.event_id, input.now, input.rules);
  return { cancelled: cancelled!, promoted };
}

/** 球友回報轉帳末五碼 */
export async function reportPayment(
  db: D1Database,
  input: { registrationId: number; playerId: number; last5: string; now: Date },
) {
  if (!/^\d{5}$/.test(input.last5)) throw new BookingError('請輸入帳號末五碼（5 個數字）');
  const row = await db
    .prepare(
      `UPDATE registrations SET status = 'reported', payment_last5 = ?, reported_at = ?
       WHERE id = ? AND player_id = ? AND status IN ('pending','reported') RETURNING *`,
    )
    .bind(input.last5, input.now.toISOString(), input.registrationId, input.playerId)
    .first<Registration>();
  if (!row) throw new BookingError('這筆報名目前不需要繳費');
  return row;
}

/** 後台確認收款 */
export async function confirmPayment(db: D1Database, registrationId: number, now: Date) {
  const row = await db
    .prepare(
      `UPDATE registrations SET status = 'confirmed', confirmed_at = ?
       WHERE id = ? AND status IN ('pending','reported','expired') RETURNING *`,
    )
    .bind(now.toISOString(), registrationId)
    .first<Registration>();
  if (!row) throw new BookingError('這筆報名不是待繳費狀態');
  return row;
}

/** 逾期未繳的正取釋出名額，並遞補候補。回傳兩組人，方便發通知。 */
export async function expireUnpaid(db: D1Database, now: Date, rules: Rules) {
  const { results: expired } = await db
    .prepare(
      `UPDATE registrations SET status = 'expired'
       WHERE status = 'pending' AND pay_by IS NOT NULL AND pay_by < ? RETURNING *`,
    )
    .bind(now.toISOString())
    .all<Registration>();
  const eventIds = [...new Set(expired.map((r) => r.event_id))];
  const promoted: Registration[] = [];
  for (const id of eventIds) promoted.push(...(await promoteWaitlist(db, id, now, rules)));
  return { expired, promoted };
}

/** 繳費期限前 hours 小時內、還沒提醒過的待繳費正取；回傳後標記為已提醒 */
export async function dueReminders(db: D1Database, now: Date, hours: number) {
  const { results } = await db
    .prepare(
      `UPDATE registrations SET reminded_at = ?1
       WHERE status = 'pending' AND reminded_at IS NULL AND pay_by IS NOT NULL AND pay_by > ?1 AND pay_by <= ?2
       RETURNING *`,
    )
    .bind(now.toISOString(), new Date(now.getTime() + hours * 3600_000).toISOString())
    .all<Registration>();
  return results;
}

/** 依每週時段產生 fromDate 起 days 天內的場次，已存在的不重複建立 */
export async function generateEvents(db: D1Database, fromDate: string, days: number, now: Date) {
  const { results: slots } = await db.prepare('SELECT * FROM slots WHERE active = 1').all<{
    id: number;
    weekday: number;
    location: string;
    start_time: string;
    end_time: string;
    capacity: number;
    level_note: string;
    meeting_note: string;
  }>();
  const stmts: D1PreparedStatement[] = [];
  for (const { date, weekday } of taipeiDates(fromDate, days)) {
    for (const s of slots.filter((s) => s.weekday === weekday)) {
      const startsAt = taipeiToIso(date, s.start_time);
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO events
               (slot_id, location, starts_at, ends_at, capacity, payment_deadline, level_note, meeting_note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            s.id,
            s.location,
            startsAt,
            taipeiToIso(date, s.end_time),
            s.capacity,
            paymentDeadline(startsAt),
            s.level_note,
            s.meeting_note,
            now.toISOString(),
          ),
      );
    }
  }
  if (stmts.length === 0) return 0;
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

export interface RosterEntry extends Registration {
  waitlist_position?: number;
}

/** 一個場次的名單：正取（含待繳費）與候補，依報名先後 */
export async function roster(db: D1Database, eventId: number) {
  const { results } = await db
    .prepare(
      `SELECT * FROM registrations WHERE event_id = ? AND status IN (${HOLDING}) ORDER BY created_at, id`,
    )
    .bind(eventId)
    .all<Registration>();
  const seated = results.filter((r) => r.status !== 'waitlist');
  const waitlist = results.filter((r) => r.status === 'waitlist');
  return { seated, waitlist };
}

/** 產生貼到 LINE 群組用的接龍文字 */
export function rosterText(event: EventRow, r: { seated: Registration[]; waitlist: Registration[] }, signupUrl?: string) {
  const name = (x: Registration) => `${x.attendee_name}${x.rent_racket ? '（借拍）' : ''}`;
  const lines = [`【${event.location}】 ${eventLabel(event.starts_at, event.ends_at)}球敘`];
  if (event.level_note) lines.push(`（${event.level_note}）`);
  lines.push('', `✅ 正取 ${r.seated.length}/${event.capacity}`);
  for (let i = 0; i < Math.max(event.capacity, r.seated.length); i++) lines.push(`${i + 1}. ${r.seated[i] ? name(r.seated[i]) : ''}`);
  lines.push('', '候補：');
  if (r.waitlist.length === 0) lines.push('1.');
  r.waitlist.forEach((x, i) => lines.push(`${i + 1}. ${name(x)}`));
  if (signupUrl) lines.push('', `報名請點：${signupUrl}`);
  return lines.join('\n');
}
