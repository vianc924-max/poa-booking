import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancel,
  confirmPayment,
  dueReminders,
  expireUnpaid,
  generateEvents,
  getEvent,
  register,
  reportPayment,
  roster,
  rosterText,
  type Rules,
} from '../src/booking';
import { paymentDeadline, taipeiToIso } from '../src/time';
import { createTestDb } from './d1';

const rules: Rules = { maxSeatsPerPerson: 2, latePayHours: 12 };
// 2026-10-12（一）12:00 台北
const now = new Date(taipeiToIso('2026-10-12', '12:00'));
const hoursLater = (h: number) => new Date(now.getTime() + h * 3600_000);

let db: D1Database;

async function addPlayer(name: string) {
  const row = await db
    .prepare('INSERT INTO players (line_user_id, line_name, created_at) VALUES (?, ?, ?) RETURNING id')
    .bind(`U-${name}`, name, now.toISOString())
    .first<{ id: number }>();
  return row!.id;
}

/** 週五 10/16 雙連 19:00，容量 capacity */
async function addEvent(capacity = 3) {
  const startsAt = taipeiToIso('2026-10-16', '19:00');
  const row = await db
    .prepare(
      `INSERT INTO events (location, starts_at, ends_at, capacity, payment_deadline, created_at)
       VALUES ('雙連', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(startsAt, taipeiToIso('2026-10-16', '21:00'), capacity, paymentDeadline(startsAt), now.toISOString())
    .first<{ id: number }>();
  return row!.id;
}

const one = (name: string, rentRacket = false) => [{ name, rentRacket }];

beforeEach(() => {
  db = createTestDb();
});

describe('時間', () => {
  it('繳費截止是活動前兩天 18:00（台北）', () => {
    expect(paymentDeadline(taipeiToIso('2026-10-16', '19:00'))).toBe(taipeiToIso('2026-10-14', '18:00'));
    // 跨月
    expect(paymentDeadline(taipeiToIso('2026-11-01', '19:00'))).toBe(taipeiToIso('2026-10-30', '18:00'));
  });
});

describe('報名', () => {
  it('有名額是正取待繳費，額滿進候補且不用繳費', async () => {
    const eventId = await addEvent(2);
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(addPlayer));
    const [ra] = await register(db, { eventId, playerId: a, attendees: one('A', true), now, rules });
    const [rb] = await register(db, { eventId, playerId: b, attendees: one('B'), now, rules });
    const [rc] = await register(db, { eventId, playerId: c, attendees: one('C'), now, rules });

    expect(ra.status).toBe('pending');
    expect(ra.amount).toBe(300); // 250 + 借拍 50
    expect(ra.pay_by).toBe(taipeiToIso('2026-10-14', '18:00'));
    expect(rb.status).toBe('pending');
    expect(rc.status).toBe('waitlist');
    expect(rc.pay_by).toBeNull();
  });

  it('一次報兩位時，滿了的那位進候補', async () => {
    const eventId = await addEvent(1);
    const a = await addPlayer('A');
    const regs = await register(db, {
      eventId,
      playerId: a,
      attendees: [
        { name: 'A', rentRacket: false },
        { name: 'A 的朋友', rentRacket: false },
      ],
      now,
      rules,
    });
    expect(regs.map((r) => r.status)).toEqual(['pending', 'waitlist']);
  });

  it('每人每場最多 2 個名額（含候補）', async () => {
    const eventId = await addEvent(5);
    const a = await addPlayer('A');
    await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    await register(db, { eventId, playerId: a, attendees: one('A2'), now, rules });
    await expect(register(db, { eventId, playerId: a, attendees: one('A3'), now, rules })).rejects.toThrow('最多報名 2');
    await expect(
      register(db, {
        eventId: await addEvent(5),
        playerId: a,
        attendees: [one('x')[0], one('y')[0], one('z')[0]],
        now,
        rules,
      }),
    ).rejects.toThrow('最多報名 2');
  });

  it('取消後的名額不算在上限內', async () => {
    const eventId = await addEvent(5);
    const a = await addPlayer('A');
    const [r1] = await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    await register(db, { eventId, playerId: a, attendees: one('A2'), now, rules });
    await cancel(db, { registrationId: r1.id, byPlayerId: a, now, rules });
    const [r3] = await register(db, { eventId, playerId: a, attendees: one('A3'), now, rules });
    expect(r3.status).toBe('pending');
  });

  it('截止後才報名，給 12 小時繳費，最晚到開場前一小時', async () => {
    const eventId = await addEvent(3);
    const a = await addPlayer('A');
    const late = new Date(taipeiToIso('2026-10-15', '09:00'));
    const [r] = await register(db, { eventId, playerId: a, attendees: one('A'), now: late, rules });
    expect(r.pay_by).toBe(taipeiToIso('2026-10-15', '21:00'));

    const veryLate = new Date(taipeiToIso('2026-10-16', '15:00'));
    const b = await addPlayer('B');
    const [rb] = await register(db, { eventId, playerId: b, attendees: one('B'), now: veryLate, rules });
    expect(rb.pay_by).toBe(taipeiToIso('2026-10-16', '18:00'));
  });

  it('暫停或已開始的場次不能報名', async () => {
    const eventId = await addEvent(3);
    const a = await addPlayer('A');
    await db.prepare(`UPDATE events SET status = 'closed' WHERE id = ?`).bind(eventId).run();
    await expect(register(db, { eventId, playerId: a, attendees: one('A'), now, rules })).rejects.toThrow('不開放');
    const started = await addEvent(3);
    await expect(
      register(db, { eventId: started, playerId: a, attendees: one('A'), now: hoursLater(24 * 5), rules }),
    ).rejects.toThrow('已經開始');
  });
});

describe('取消與遞補', () => {
  it('正取取消後，候補第一位自動遞補成待繳費', async () => {
    const eventId = await addEvent(1);
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(addPlayer));
    const [ra] = await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    await register(db, { eventId, playerId: b, attendees: one('B'), now, rules });
    await register(db, { eventId, playerId: c, attendees: one('C'), now: hoursLater(1), rules });

    const { promoted } = await cancel(db, { registrationId: ra.id, byPlayerId: a, now: hoursLater(2), rules });
    expect(promoted.map((r) => r.attendee_name)).toEqual(['B']);
    expect(promoted[0].status).toBe('pending');
    expect(promoted[0].pay_by).toBe(taipeiToIso('2026-10-14', '18:00'));
    const r = await roster(db, eventId);
    expect(r.seated.map((x) => x.attendee_name)).toEqual(['B']);
    expect(r.waitlist.map((x) => x.attendee_name)).toEqual(['C']);
  });

  it('球友不能自己取消已繳費的報名，也不能取消別人的', async () => {
    const eventId = await addEvent(3);
    const [a, b] = await Promise.all(['A', 'B'].map(addPlayer));
    const [ra] = await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    await expect(cancel(db, { registrationId: ra.id, byPlayerId: b, now, rules })).rejects.toThrow('找不到');
    await reportPayment(db, { registrationId: ra.id, playerId: a, last5: '12345', now });
    await expect(cancel(db, { registrationId: ra.id, byPlayerId: a, now, rules })).rejects.toThrow('官方 LINE');
    // 後台可以
    const { cancelled } = await cancel(db, { registrationId: ra.id, byPlayerId: null, now, rules });
    expect(cancelled.status).toBe('cancelled');
  });

  it('加大名額後依序遞補', async () => {
    const eventId = await addEvent(1);
    const players = await Promise.all(['A', 'B', 'C'].map(addPlayer));
    for (const [i, p] of players.entries()) {
      await register(db, { eventId, playerId: p, attendees: one('ABC'[i]), now: hoursLater(i), rules });
    }
    await db.prepare('UPDATE events SET capacity = 3 WHERE id = ?').bind(eventId).run();
    const { promoteWaitlist } = await import('../src/booking');
    const promoted = await promoteWaitlist(db, eventId, hoursLater(5), rules);
    expect(promoted.map((r) => r.attendee_name)).toEqual(['B', 'C']);
  });
});

describe('繳費', () => {
  it('回報末五碼後由後台確認', async () => {
    const eventId = await addEvent(3);
    const a = await addPlayer('A');
    const [r] = await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    await expect(reportPayment(db, { registrationId: r.id, playerId: a, last5: '12a45', now })).rejects.toThrow('末五碼');
    const reported = await reportPayment(db, { registrationId: r.id, playerId: a, last5: '54321', now });
    expect(reported.status).toBe('reported');
    expect(reported.payment_last5).toBe('54321');
    const confirmed = await confirmPayment(db, r.id, now);
    expect(confirmed.status).toBe('confirmed');
  });

  it('候補不能回報繳費', async () => {
    const eventId = await addEvent(1);
    const [a, b] = await Promise.all(['A', 'B'].map(addPlayer));
    await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    const [rb] = await register(db, { eventId, playerId: b, attendees: one('B'), now, rules });
    await expect(reportPayment(db, { registrationId: rb.id, playerId: b, last5: '11111', now })).rejects.toThrow(
      '不需要繳費',
    );
  });
});

describe('逾期', () => {
  it('截止未繳費釋出名額並遞補；已回報末五碼的不會被釋出', async () => {
    const eventId = await addEvent(2);
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(addPlayer));
    const [ra] = await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    const [rb] = await register(db, { eventId, playerId: b, attendees: one('B'), now, rules });
    await register(db, { eventId, playerId: c, attendees: one('C'), now, rules });
    await reportPayment(db, { registrationId: rb.id, playerId: b, last5: '22222', now });

    const beforeDeadline = new Date(taipeiToIso('2026-10-14', '17:59'));
    expect((await expireUnpaid(db, beforeDeadline, rules)).expired).toHaveLength(0);

    const afterDeadline = new Date(taipeiToIso('2026-10-14', '18:15'));
    const { expired, promoted } = await expireUnpaid(db, afterDeadline, rules);
    expect(expired.map((r) => r.id)).toEqual([ra.id]);
    expect(promoted.map((r) => r.attendee_name)).toEqual(['C']);
    // 截止後才遞補上的人有 12 小時
    expect(promoted[0].pay_by).toBe(taipeiToIso('2026-10-15', '06:15'));
  });

  it('截止前 6 小時提醒一次', async () => {
    const eventId = await addEvent(2);
    const a = await addPlayer('A');
    await register(db, { eventId, playerId: a, attendees: one('A'), now, rules });
    expect(await dueReminders(db, new Date(taipeiToIso('2026-10-14', '11:00')), 6)).toHaveLength(0);
    expect(await dueReminders(db, new Date(taipeiToIso('2026-10-14', '12:30')), 6)).toHaveLength(1);
    expect(await dueReminders(db, new Date(taipeiToIso('2026-10-14', '13:00')), 6)).toHaveLength(0);
  });
});

describe('場次產生與接龍文字', () => {
  it('依每週時段產生場次，重跑不重複', async () => {
    const created = await generateEvents(db, '2026-10-12', 7, now);
    // 一 2 個、三 1 個、五 2 個、六 2 個、日 1 個
    expect(created).toBe(8);
    expect(await generateEvents(db, '2026-10-12', 7, now)).toBe(0);
    const fri = await db
      .prepare(`SELECT * FROM events WHERE location = '雙連' AND starts_at = ?`)
      .bind(taipeiToIso('2026-10-16', '19:00'))
      .first<{ payment_deadline: string; capacity: number }>();
    expect(fri?.payment_deadline).toBe(taipeiToIso('2026-10-14', '18:00'));
    expect(fri?.capacity).toBe(7);
  });

  it('接龍文字列出正取空位與候補', async () => {
    const eventId = await addEvent(3);
    const [a, b] = await Promise.all(['A', 'B'].map(addPlayer));
    await register(db, { eventId, playerId: a, attendees: [{ name: 'Joe', rentRacket: true }, { name: 'Dell', rentRacket: false }], now, rules });
    await register(db, { eventId, playerId: b, attendees: [{ name: 'Jerry', rentRacket: false }, { name: 'Amy', rentRacket: false }], now, rules });
    const event = (await getEvent(db, eventId))!;
    const text = rosterText(event, await roster(db, eventId), 'https://liff.line.me/x');
    expect(text).toBe(
      [
        '【雙連】 10/16（五）19:00-21:00球敘',
        '',
        '✅ 正取 3/3',
        '1. Joe（借拍）',
        '2. Dell',
        '3. Jerry',
        '',
        '候補：',
        '1. Amy',
        '',
        '報名請點：https://liff.line.me/x',
      ].join('\n'),
    );
  });
});
