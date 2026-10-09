-- 所有時間欄位都存 UTC ISO 字串（例如 2026-10-16T11:00:00.000Z），畫面再轉成台北時間

CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL UNIQUE,
  line_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 每週固定的球敘時段，後台用它一次產生好幾週的場次
CREATE TABLE slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL,            -- 0=週日 … 6=週六
  location TEXT NOT NULL,
  start_time TEXT NOT NULL,            -- 台北時間 HH:MM
  end_time TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  level_note TEXT NOT NULL DEFAULT '',
  meeting_note TEXT NOT NULL DEFAULT '', -- 繳費確認後才顯示給球友
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER REFERENCES slots(id),
  location TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  price INTEGER NOT NULL DEFAULT 250,
  rental_fee INTEGER NOT NULL DEFAULT 50,
  payment_deadline TEXT NOT NULL,
  level_note TEXT NOT NULL DEFAULT '',
  meeting_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', -- open / closed / cancelled
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX events_slot_start ON events(slot_id, starts_at);
CREATE INDEX events_starts_at ON events(starts_at);

-- 一筆報名 = 一個名額。狀態：
--   pending   正取，待繳費
--   reported  正取，球友已回報末五碼，等後台確認
--   confirmed 已確認收款
--   waitlist  候補（不用繳費）
--   cancelled 取消
--   expired   逾期未繳，名額已釋出
CREATE TABLE registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  player_id INTEGER REFERENCES players(id), -- 後台手動加的人可以是空的
  attendee_name TEXT NOT NULL,
  rent_racket INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  pay_by TEXT,
  payment_last5 TEXT,
  reported_at TEXT,
  confirmed_at TEXT,
  promoted_at TEXT,
  reminded_at TEXT,
  cancelled_at TEXT,
  attended INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX registrations_event ON registrations(event_id, status);
CREATE INDEX registrations_player ON registrations(player_id);
CREATE INDEX registrations_pay_by ON registrations(status, pay_by);

-- 目前的球敘時段（取自記事本，名額先預設一面場 7 位，可在後台修改）
INSERT INTO slots (weekday, location, start_time, end_time, capacity, level_note) VALUES
  (1, '板橋', '18:30', '20:30', 7, '新手友善'),
  (1, '大直', '18:40', '20:40', 7, '新手友善'),
  (3, '東湖', '18:50', '20:50', 7, '限程度2.0以上'),
  (5, '雙連', '19:00', '21:00', 7, '新手友善'),
  (5, '東湖', '18:50', '20:50', 7, '新手友善'),
  (6, '大直', '18:00', '20:00', 7, '新手友善'),
  (6, '大直', '20:00', '22:00', 7, '新手友善'),
  (0, '雙連', '19:00', '21:00', 7, '新手友善');
