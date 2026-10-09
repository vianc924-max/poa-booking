// 球友報名頁：在 LINE 裡用 LIFF 開啟，用 LINE 身分報名
const app = document.getElementById('app');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const STATUS = {
  pending: ['正取・待繳費', 'warn'],
  reported: ['已回報繳費・確認中', ''],
  confirmed: ['已確認', ''],
  waitlist: ['候補', 'off'],
  cancelled: ['已取消', 'off'],
  expired: ['逾期未繳・已釋出', 'off'],
};

let auth = {};
let state = { tab: 'events', events: [], me: null };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function tp(iso) {
  const t = new Date(Date.parse(iso) + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    key: t.toISOString().slice(0, 10),
    date: `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${WEEKDAYS[t.getUTCDay()]}）`,
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
  };
}
const when = (iso) => `${tp(iso).date} ${tp(iso).time}`;
const span = (e) => `${tp(e.starts_at).date} ${tp(e.starts_at).time}-${tp(e.ends_at).time}`;

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...auth, ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && window.liff?.isLoggedIn?.()) {
    liff.logout();
    liff.login({ redirectUri: location.href });
  }
  if (!res.ok) throw new Error(data.error || '發生錯誤，請稍後再試');
  return data;
}

async function login() {
  const config = await fetch('/api/config').then((r) => r.json());
  if (config.liffId) {
    await liff.init({ liffId: config.liffId });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return false;
    }
    auth = { authorization: `Bearer ${liff.getIDToken()}` };
    return true;
  }
  if (config.devLogin) {
    let name = localStorage.getItem('devUser');
    if (!name) {
      name = prompt('（本機測試）輸入一個測試名字') || 'tester';
      localStorage.setItem('devUser', name);
    }
    auth = { 'x-dev-user': name };
    return true;
  }
  app.innerHTML = '<p class="empty">報名系統尚未設定完成</p>';
  return false;
}

async function load() {
  const [events, me] = await Promise.all([api('/api/events'), api('/api/me')]);
  state.events = events.events;
  state.me = me;
  render();
}

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  if (!state.me.player.name) return renderProfile();
  app.innerHTML = state.tab === 'events' ? eventsHtml() : mineHtml();
}

function renderProfile() {
  const p = state.me.player;
  app.innerHTML = `
    <div class="card">
      <div class="title">第一次使用，請留下聯絡資料</div>
      <label>名字（會顯示在名單上）</label>
      <input id="pname" value="${esc(p.name || p.line_name)}" maxlength="40">
      <label>手機</label>
      <input id="pphone" value="${esc(p.phone)}" inputmode="tel" maxlength="20">
      <div class="inline"><button class="primary" data-action="save-profile">儲存</button></div>
    </div>`;
}

function seatText(e) {
  const left = e.capacity - e.seated;
  if (left > 0) return `<span class="badge">剩 ${left} 位</span>`;
  return `<span class="badge warn">額滿・候補 ${e.waitlist} 人</span>`;
}

function eventsHtml() {
  if (state.events.length === 0) return '<p class="empty">目前沒有開放報名的場次</p>';
  let html = '';
  let day = '';
  for (const e of state.events) {
    const d = tp(e.starts_at);
    if (d.key !== day) {
      day = d.key;
      html += `<h2>${d.date}</h2>`;
    }
    html += `
      <div class="card">
        <div class="row">
          <div>
            <div class="title">${esc(e.location)}　${d.time}-${tp(e.ends_at).time}</div>
            <div class="muted">${esc(e.level_note)}${e.level_note ? '・' : ''}$${e.price}／人</div>
          </div>
          ${seatText(e)}
        </div>
        <div class="inline"><button class="primary" data-action="open-register" data-id="${e.id}">${e.capacity - e.seated > 0 ? '報名' : '排候補'}</button></div>
      </div>`;
  }
  return html;
}

function mineHtml() {
  const regs = state.me.registrations.filter((r) => r.status !== 'cancelled');
  if (regs.length === 0) return '<p class="empty">還沒有報名紀錄</p>';
  return regs
    .map((r) => {
      const [label, cls] = STATUS[r.status];
      let body = '';
      if (r.status === 'pending') {
        body = `
          <div class="pay">請於 ${when(r.pay_by)} 前繳費 $${r.amount}${r.rent_racket ? '（含借拍 $50）' : ''}
${esc(state.me.paymentInfo)}
繳費後請填寫轉出帳號末五碼。逾期名額會釋出給候補。</div>
          <div class="inline">
            <input id="last5-${r.id}" inputmode="numeric" maxlength="5" placeholder="帳號末五碼">
            <button class="primary" data-action="report" data-id="${r.id}">回報</button>
          </div>`;
      } else if (r.status === 'reported') {
        body = `<div class="muted">已回報末五碼 ${esc(r.payment_last5)}，確認後會通知你。</div>`;
      } else if (r.status === 'confirmed') {
        body = r.meeting_note ? `<div class="pay">集合資訊：${esc(r.meeting_note)}</div>` : '';
      } else if (r.status === 'waitlist') {
        body = `<div class="muted">候補第 ${r.waitlist_position} 位，請勿繳費，遞補時會通知你。</div>`;
      }
      const canCancel = r.status === 'pending' || r.status === 'waitlist';
      return `
        <div class="card">
          <div class="row">
            <div>
              <div class="title">${esc(r.location)}　${span(r)}</div>
              <div class="muted">${esc(r.attendee_name)}${r.rent_racket ? '（借拍）' : ''}</div>
            </div>
            <span class="badge ${cls}">${label}</span>
          </div>
          ${body}
          ${canCancel ? `<div class="inline"><button class="danger" data-action="cancel" data-id="${r.id}">取消這個名額</button></div>` : ''}
          ${r.status === 'reported' || r.status === 'confirmed' ? '<div class="muted" style="margin-top:8px">已繳費如需取消，請私訊 POA 官方 LINE。</div>' : ''}
        </div>`;
    })
    .join('');
}

function openRegister(id) {
  const e = state.events.find((x) => x.id === id);
  const full = e.capacity - e.seated <= 0;
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `
    <div class="sheet">
      <div class="title">${esc(e.location)}　${span(e)}</div>
      <div class="muted">${esc(e.level_note)}</div>
      ${full ? '<div class="notice" style="margin-top:10px">目前額滿，報名會排入候補，候補請勿繳費。</div>' : ''}
      <label>報名人數（每人最多 2 位）</label>
      <select id="seats"><option value="1">1 位</option><option value="2">2 位</option></select>
      <div id="attendees"></div>
      <div class="pay" id="total"></div>
      <ul class="rules">
        <li>正取請於活動前兩天 18:00 前繳費，逾期名額會釋出給候補</li>
        <li>借拍每次 $${e.rental_fee}</li>
        <li>繳費後的取消請私訊 POA 官方 LINE</li>
      </ul>
      <div class="inline">
        <button data-action="close">返回</button>
        <button class="primary" data-action="submit-register" data-id="${e.id}" style="flex:1">${full ? '排候補' : '送出報名'}</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  const draw = () => {
    const n = Number(bg.querySelector('#seats').value);
    const old = [...bg.querySelectorAll('.attendee')].map((el) => ({
      name: el.querySelector('input[type=text]').value,
      rent: el.querySelector('input[type=checkbox]').checked,
    }));
    bg.querySelector('#attendees').innerHTML = Array.from({ length: n }, (_, i) => {
      const prev = old[i] || { name: i === 0 ? state.me.player.name : '', rent: false };
      return `
        <div class="attendee">
          <label>${i === 0 ? '第 1 位' : '第 2 位（同行朋友）'}</label>
          <input type="text" value="${esc(prev.name)}" maxlength="40" placeholder="名字">
          <label class="check"><input type="checkbox" ${prev.rent ? 'checked' : ''}> 借拍（+$${e.rental_fee}）</label>
        </div>`;
    }).join('');
    updateTotal();
  };
  const updateTotal = () => {
    const rents = [...bg.querySelectorAll('.attendee input[type=checkbox]')].filter((c) => c.checked).length;
    const n = bg.querySelectorAll('.attendee').length;
    bg.querySelector('#total').textContent = full
      ? '候補不用繳費，遞補成功會通知你'
      : `正取應繳 $${n * e.price + rents * e.rental_fee}（報名後再繳費）`;
  };
  bg.querySelector('#seats').addEventListener('change', draw);
  bg.addEventListener('change', (ev) => ev.target.type === 'checkbox' && updateTotal());
  bg.addEventListener('click', (ev) => ev.target === bg && bg.remove());
  draw();
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action], .tab');
  if (!btn) return;
  if (btn.classList.contains('tab')) {
    state.tab = btn.dataset.tab;
    return render();
  }
  const id = Number(btn.dataset.id);
  const action = btn.dataset.action;
  if (action === 'open-register') return openRegister(id);
  if (action === 'close') return btn.closest('.sheet-bg').remove();
  btn.disabled = true;
  try {
    if (action === 'save-profile') {
      const name = document.getElementById('pname').value.trim();
      if (!name) throw new Error('請填名字');
      const { player } = await api('/api/me', {
        method: 'PUT',
        body: { name, phone: document.getElementById('pphone').value },
      });
      state.me.player = player;
      render();
    } else if (action === 'submit-register') {
      const sheet = btn.closest('.sheet-bg');
      const attendees = [...sheet.querySelectorAll('.attendee')].map((el) => ({
        name: el.querySelector('input[type=text]').value.trim(),
        rentRacket: el.querySelector('input[type=checkbox]').checked,
      }));
      if (attendees.some((a) => !a.name)) throw new Error('請填寫每一位的名字');
      const { registrations } = await api(`/api/events/${id}/register`, { method: 'POST', body: { attendees } });
      sheet.remove();
      toast(registrations.every((r) => r.status === 'waitlist') ? '已排入候補' : '報名成功，請記得繳費');
      state.tab = 'mine';
      await load();
    } else if (action === 'report') {
      const last5 = document.getElementById(`last5-${id}`).value.trim();
      await api(`/api/registrations/${id}/report`, { method: 'POST', body: { last5 } });
      toast('已回報，確認後會通知你');
      await load();
    } else if (action === 'cancel') {
      if (!confirm('確定取消這個名額嗎？')) return;
      await api(`/api/registrations/${id}/cancel`, { method: 'POST' });
      toast('已取消');
      await load();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

login()
  .then((ok) => ok && load())
  .catch((err) => {
    app.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  });
