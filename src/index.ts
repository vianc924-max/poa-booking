import { Hono, type Context, type Next } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import {
  BookingError,
  cancel,
  confirmPayment,
  dueReminders,
  expireUnpaid,
  generateEvents,
  getEvent,
  promoteWaitlist,
  register,
  reportPayment,
  roster,
  rosterText,
  type EventRow,
  type Registration,
  type Rules,
} from './booking';
import { pushText, verifyIdToken, type LineProfile } from './line';
import { eventLabel, paymentDeadline, taipeiParts, taipeiToIso } from './time';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LIFF_ID?: string;
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  ADMIN_PASSWORD?: string;
  PAYMENT_INFO?: string;
  LATE_PAY_HOURS?: string;
  MAX_SEATS_PER_PERSON?: string;
  DEV_FAKE_LOGIN?: string;
}

interface Player {
  id: number;
  line_user_id: string;
  line_name: string;
  name: string;
  phone: string;
}

type App = { Bindings: Env; Variables: { player: Player } };

const app = new Hono<App>();

const rules = (env: Env): Rules => ({
  maxSeatsPerPerson: Number(env.MAX_SEATS_PER_PERSON ?? 2),
  latePayHours: Number(env.LATE_PAY_HOURS ?? 12),
});

const when = (iso: string) => {
  const p = taipeiParts(iso);
  return `${p.month}/${p.day}（${p.weekdayLabel}）${p.time}`;
};

app.onError((err, c) => {
  if (err instanceof BookingError) return c.json({ error: err.message }, 400);
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: '系統忙碌，請稍後再試' }, 500);
});

// ---------- 通知 ----------

async function notify(env: Env, regs: Registration[], text: (r: Registration, e: EventRow) => string) {
  for (const r of regs) {
    if (r.player_id === null) continue;
    const p = await env.DB.prepare('SELECT line_user_id FROM players WHERE id = ?').bind(r.player_id).first<{ line_user_id: string }>();
    const e = await getEvent(env.DB, r.event_id);
    if (p && e) await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, p.line_user_id, text(r, e));
  }
}

const title = (e: EventRow) => `【${e.location}】${eventLabel(e.starts_at, e.ends_at)} 球敘`;
const payText = (env: Env, r: Registration) =>
  `請於 ${when(r.pay_by!)} 前繳費 $${r.amount}。\n${env.PAYMENT_INFO ?? ''}\n繳費後請回報名頁填寫帳號末五碼。`;

const msg = {
  registered: (env: Env) => (r: Registration, e: EventRow) =>
    r.status === 'waitlist'
      ? `${title(e)}\n${r.attendee_name} 已排入候補，候補請勿繳費，遞補時會再通知你。`
      : `${title(e)}\n${r.attendee_name} 報名成功（正取）。\n${payText(env, r)}`,
  promoted: (env: Env) => (r: Registration, e: EventRow) =>
    `${title(e)}\n${r.attendee_name} 候補遞補成功，已轉為正取！\n${payText(env, r)}`,
  reminder: (env: Env) => (r: Registration, e: EventRow) =>
    `${title(e)}\n提醒：${r.attendee_name} 還沒有收到繳費。\n${payText(env, r)}\n逾期名額會釋出給候補。`,
  expired: () => (r: Registration, e: EventRow) =>
    `${title(e)}\n${r.attendee_name} 未在期限內收到繳費，名額已釋出給候補。`,
  confirmed: () => (r: Registration, e: EventRow) =>
    `${title(e)}\n已確認 ${r.attendee_name} 的繳費，期待球場見！${e.meeting_note ? `\n集合資訊：${e.meeting_note}` : ''}`,
  eventCancelled: () => (r: Registration, e: EventRow) =>
    `${title(e)}\n很抱歉，本場球敘取消。已繳費的朋友請私訊 POA 官方 LINE 處理退費。`,
};

// ---------- 球友端 ----------

app.get('/api/config', (c) => c.json({ liffId: c.env.LIFF_ID ?? '', devLogin: c.env.DEV_FAKE_LOGIN === 'true' }));

const tokenCache = new Map<string, { profile: LineProfile; until: number }>();

async function playerAuth(c: Context<App>, next: Next) {
  let profile: LineProfile | null = null;
  const devUser = c.req.header('x-dev-user');
  if (c.env.DEV_FAKE_LOGIN === 'true' && devUser) {
    profile = { userId: `dev-${devUser}`, name: devUser };
  } else {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '');
    if (token && c.env.LINE_LOGIN_CHANNEL_ID) {
      const cached = tokenCache.get(token);
      if (cached && cached.until > Date.now()) profile = cached.profile;
      else {
        profile = await verifyIdToken(token, c.env.LINE_LOGIN_CHANNEL_ID);
        if (profile) tokenCache.set(token, { profile, until: Date.now() + 10 * 60_000 });
      }
    }
  }
  if (!profile) return c.json({ error: '請重新用 LINE 登入' }, 401);

  const player = await c.env.DB.prepare(
    `INSERT INTO players (line_user_id, line_name, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(line_user_id) DO UPDATE SET line_name = ?2
     RETURNING id, line_user_id, line_name, name, phone`,
  )
    .bind(profile.userId, profile.name, new Date().toISOString())
    .first<Player>();
  c.set('player', player!);
  await next();
}

app.get('/api/events', async (c) => {
  const now = new Date();
  const until = new Date(now.getTime() + 21 * 86400_000);
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.location, e.starts_at, e.ends_at, e.capacity, e.price, e.rental_fee, e.payment_deadline, e.level_note,
       (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('pending','reported','confirmed')) AS seated,
       (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'waitlist') AS waitlist
     FROM events e WHERE e.status = 'open' AND e.starts_at > ? AND e.starts_at < ? ORDER BY e.starts_at`,
  )
    .bind(now.toISOString(), until.toISOString())
    .all();
  return c.json({ events: results });
});

app.use('/api/me', playerAuth);
app.use('/api/me/*', playerAuth);
app.use('/api/events/:id/register', playerAuth);
app.use('/api/registrations/*', playerAuth);

app.get('/api/me', async (c) => {
  const player = c.get('player');
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.event_id, r.attendee_name, r.rent_racket, r.amount, r.status, r.pay_by, r.payment_last5,
       e.location, e.starts_at, e.ends_at, e.level_note,
       CASE WHEN r.status = 'confirmed' THEN e.meeting_note ELSE '' END AS meeting_note,
       CASE WHEN r.status = 'waitlist' THEN
         (SELECT COUNT(*) FROM registrations w WHERE w.event_id = r.event_id AND w.status = 'waitlist'
            AND (w.created_at < r.created_at OR (w.created_at = r.created_at AND w.id <= r.id)))
       END AS waitlist_position
     FROM registrations r JOIN events e ON e.id = r.event_id
     WHERE r.player_id = ? AND e.starts_at > ? ORDER BY e.starts_at, r.id`,
  )
    .bind(player.id, since)
    .all();
  return c.json({ player, registrations: results, paymentInfo: c.env.PAYMENT_INFO ?? '' });
});

app.put('/api/me', async (c) => {
  const body = await c.req.json<{ name?: string; phone?: string }>();
  const player = await c.env.DB.prepare(
    'UPDATE players SET name = ?, phone = ? WHERE id = ? RETURNING id, line_user_id, line_name, name, phone',
  )
    .bind((body.name ?? '').trim().slice(0, 40), (body.phone ?? '').trim().slice(0, 20), c.get('player').id)
    .first<Player>();
  return c.json({ player });
});

app.post('/api/events/:id/register', async (c) => {
  const body = await c.req.json<{ attendees: { name: string; rentRacket: boolean }[] }>();
  const regs = await register(c.env.DB, {
    eventId: Number(c.req.param('id')),
    playerId: c.get('player').id,
    attendees: (body.attendees ?? []).map((a) => ({ name: String(a.name ?? ''), rentRacket: !!a.rentRacket })),
    now: new Date(),
    rules: rules(c.env),
  });
  c.executionCtx.waitUntil(notify(c.env, regs, msg.registered(c.env)));
  return c.json({ registrations: regs });
});

app.post('/api/registrations/:id/report', async (c) => {
  const body = await c.req.json<{ last5: string }>();
  const reg = await reportPayment(c.env.DB, {
    registrationId: Number(c.req.param('id')),
    playerId: c.get('player').id,
    last5: String(body.last5 ?? '').trim(),
    now: new Date(),
  });
  return c.json({ registration: reg });
});

app.post('/api/registrations/:id/cancel', async (c) => {
  const result = await cancel(c.env.DB, {
    registrationId: Number(c.req.param('id')),
    byPlayerId: c.get('player').id,
    now: new Date(),
    rules: rules(c.env),
  });
  c.executionCtx.waitUntil(notify(c.env, result.promoted, msg.promoted(c.env)));
  return c.json(result);
});

// ---------- 後台 ----------

async function adminAuth(c: Context<App>, next: Next) {
  if (!c.env.ADMIN_PASSWORD) return c.text('ADMIN_PASSWORD 尚未設定', 503);
  return basicAuth({ username: 'admin', password: c.env.ADMIN_PASSWORD, realm: 'POA admin' })(c, next);
}
app.use('/admin', adminAuth);
app.use('/admin/*', adminAuth);
app.use('/api/admin/*', adminAuth);

app.get('/admin', (c) => c.env.ASSETS.fetch(new URL('/admin/', c.req.url)));
app.get('/admin/*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.get('/api/admin/events', async (c) => {
  const from = new Date(Date.now() - Number(c.req.query('pastDays') ?? 1) * 86400_000);
  const until = new Date(Date.now() + Number(c.req.query('days') ?? 21) * 86400_000);
  const { results } = await c.env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('pending','reported','confirmed')) AS seated,
       (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'reported') AS reported,
       (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'pending') AS unpaid,
       (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'waitlist') AS waitlist
     FROM events e WHERE e.starts_at > ? AND e.starts_at < ? ORDER BY e.starts_at`,
  )
    .bind(from.toISOString(), until.toISOString())
    .all();
  return c.json({ events: results });
});

app.get('/api/admin/events/:id', async (c) => {
  const event = await getEvent(c.env.DB, Number(c.req.param('id')));
  if (!event) return c.json({ error: '找不到場次' }, 404);
  const r = await roster(c.env.DB, event.id);
  const withPlayer = async (regs: Registration[]) =>
    Promise.all(
      regs.map(async (x) => ({
        ...x,
        player: x.player_id
          ? await c.env.DB.prepare('SELECT name, line_name, phone FROM players WHERE id = ?').bind(x.player_id).first()
          : null,
      })),
    );
  const signupUrl = c.env.LIFF_ID ? `https://liff.line.me/${c.env.LIFF_ID}` : new URL('/', c.req.url).toString();
  return c.json({
    event,
    seated: await withPlayer(r.seated),
    waitlist: await withPlayer(r.waitlist),
    rosterText: rosterText(event, r, signupUrl),
  });
});

app.post('/api/admin/events', async (c) => {
  const b = await c.req.json<{
    date: string;
    start: string;
    end: string;
    location: string;
    capacity: number;
    price?: number;
    rentalFee?: number;
    levelNote?: string;
    meetingNote?: string;
  }>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end) || !b.location) {
    throw new BookingError('請填日期、時間與地點');
  }
  const startsAt = taipeiToIso(b.date, b.start);
  const event = await c.env.DB.prepare(
    `INSERT INTO events (location, starts_at, ends_at, capacity, price, rental_fee, payment_deadline, level_note, meeting_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(
      b.location,
      startsAt,
      taipeiToIso(b.date, b.end),
      Number(b.capacity) || 7,
      Number(b.price ?? 250),
      Number(b.rentalFee ?? 50),
      paymentDeadline(startsAt),
      b.levelNote ?? '',
      b.meetingNote ?? '',
      new Date().toISOString(),
    )
    .first<EventRow>();
  return c.json({ event });
});

app.patch('/api/admin/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const before = await getEvent(c.env.DB, id);
  if (!before) return c.json({ error: '找不到場次' }, 404);
  const b = await c.req.json<Partial<{ capacity: number; status: EventRow['status']; levelNote: string; meetingNote: string }>>();
  const event = await c.env.DB.prepare(
    'UPDATE events SET capacity = ?, status = ?, level_note = ?, meeting_note = ? WHERE id = ? RETURNING *',
  )
    .bind(
      b.capacity !== undefined ? Number(b.capacity) : before.capacity,
      b.status ?? before.status,
      b.levelNote ?? before.level_note,
      b.meetingNote ?? before.meeting_note,
      id,
    )
    .first<EventRow>();
  const now = new Date();
  if (event!.status === 'cancelled' && before.status !== 'cancelled') {
    const r = await roster(c.env.DB, id);
    c.executionCtx.waitUntil(notify(c.env, [...r.seated, ...r.waitlist], msg.eventCancelled()));
  } else {
    const promoted = await promoteWaitlist(c.env.DB, id, now, rules(c.env));
    c.executionCtx.waitUntil(notify(c.env, promoted, msg.promoted(c.env)));
  }
  return c.json({ event });
});

app.post('/api/admin/events/:id/registrations', async (c) => {
  const b = await c.req.json<{ name: string; rentRacket?: boolean; paid?: boolean }>();
  const now = new Date();
  const [reg] = await register(c.env.DB, {
    eventId: Number(c.req.param('id')),
    playerId: null,
    attendees: [{ name: String(b.name ?? ''), rentRacket: !!b.rentRacket }],
    now,
    rules: rules(c.env),
  });
  const result = b.paid && reg.status === 'pending' ? await confirmPayment(c.env.DB, reg.id, now) : reg;
  return c.json({ registration: result });
});

app.post('/api/admin/registrations/:id/confirm', async (c) => {
  const reg = await confirmPayment(c.env.DB, Number(c.req.param('id')), new Date());
  c.executionCtx.waitUntil(notify(c.env, [reg], msg.confirmed()));
  return c.json({ registration: reg });
});

app.post('/api/admin/registrations/:id/cancel', async (c) => {
  const result = await cancel(c.env.DB, {
    registrationId: Number(c.req.param('id')),
    byPlayerId: null,
    now: new Date(),
    rules: rules(c.env),
  });
  c.executionCtx.waitUntil(notify(c.env, result.promoted, msg.promoted(c.env)));
  return c.json(result);
});

app.post('/api/admin/registrations/:id/attended', async (c) => {
  const b = await c.req.json<{ attended: boolean | null }>();
  const reg = await c.env.DB.prepare('UPDATE registrations SET attended = ? WHERE id = ? RETURNING *')
    .bind(b.attended === null ? null : b.attended ? 1 : 0, Number(c.req.param('id')))
    .first();
  return c.json({ registration: reg });
});

app.post('/api/admin/generate', async (c) => {
  const b = await c.req.json<{ days?: number }>().catch(() => ({ days: undefined }));
  const now = new Date();
  const created = await generateEvents(c.env.DB, taipeiParts(now.toISOString()).date, Number(b.days ?? 14), now);
  return c.json({ created });
});

app.get('/api/admin/slots', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM slots ORDER BY weekday, start_time').all();
  return c.json({ slots: results });
});

app.patch('/api/admin/slots/:id', async (c) => {
  const b = await c.req.json<Partial<{ capacity: number; active: boolean; levelNote: string; meetingNote: string }>>();
  const id = Number(c.req.param('id'));
  const before = await c.env.DB.prepare('SELECT * FROM slots WHERE id = ?').bind(id).first<{
    capacity: number;
    active: number;
    level_note: string;
    meeting_note: string;
  }>();
  if (!before) return c.json({ error: '找不到時段' }, 404);
  const slot = await c.env.DB.prepare(
    'UPDATE slots SET capacity = ?, active = ?, level_note = ?, meeting_note = ? WHERE id = ? RETURNING *',
  )
    .bind(
      b.capacity !== undefined ? Number(b.capacity) : before.capacity,
      b.active !== undefined ? (b.active ? 1 : 0) : before.active,
      b.levelNote ?? before.level_note,
      b.meetingNote ?? before.meeting_note,
      id,
    )
    .first();
  return c.json({ slot });
});

// ---------- 排程：逾期釋出、遞補、提醒、每天產生場次 ----------

export async function runScheduled(env: Env, now: Date) {
  const r = rules(env);
  const { expired, promoted } = await expireUnpaid(env.DB, now, r);
  await notify(env, expired, msg.expired());
  await notify(env, promoted, msg.promoted(env));
  await notify(env, await dueReminders(env.DB, now, 6), msg.reminder(env));
  const t = taipeiParts(now.toISOString());
  if (t.time < '00:15') await generateEvents(env.DB, t.date, 14, now);
}

export default {
  fetch: app.fetch,
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(env, new Date()));
  },
} satisfies ExportedHandler<Env>;
