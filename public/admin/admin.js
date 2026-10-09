// 後台：場次、名單、對帳、接龍文字、固定時段
const app = document.getElementById('app');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const STATUS = {
  pending: ['待繳費', 'warn'],
  reported: ['已回報・待確認', 'warn'],
  confirmed: ['已確認', ''],
  waitlist: ['候補', 'off'],
  expired: ['逾期', 'off'],
  cancelled: ['取消', 'off'],
};
const EVENT_STATUS = { open: '開放報名', closed: '暫停報名', cancelled: '取消' };

let state = { tab: 'events', eventId: null };

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
const when = (iso) => (iso ? `${tp(iso).date} ${tp(iso).time}` : '');

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
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '發生錯誤');
  return data;
}

async function render() {
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  if (state.tab === 'slots') return renderSlots();
  if (state.eventId) return renderEvent(state.eventId);
  return renderEvents();
}

async function renderEvents() {
  const { events } = await api('/api/admin/events?days=21');
  let html = `
    <div class="toolbar">
      <button class="primary" data-action="generate">產生未來兩週場次</button>
      <button data-action="toggle-new">新增單一場次</button>
    </div>
    <div class="card" id="new-event" hidden>
      <div class="grid">
        <div><label>日期</label><input type="date" id="ne-date"></div>
        <div><label>開始</label><input type="time" id="ne-start" value="19:00"></div>
        <div><label>結束</label><input type="time" id="ne-end" value="21:00"></div>
        <div><label>地點</label><input id="ne-location" placeholder="雙連"></div>
        <div><label>名額</label><input type="number" id="ne-capacity" value="7" min="1"></div>
        <div><label>費用</label><input type="number" id="ne-price" value="250"></div>
        <div><label>程度說明</label><input id="ne-level" value="新手友善"></div>
      </div>
      <label>集合資訊（繳費確認後才給球友看）</label><input id="ne-meeting">
      <div class="inline"><button class="primary" data-action="create-event">建立</button></div>
    </div>`;
  if (events.length === 0) html += '<p class="empty">還沒有場次，按「產生未來兩週場次」開始</p>';
  let day = '';
  for (const e of events) {
    const d = tp(e.starts_at);
    if (d.key !== day) {
      day = d.key;
      html += `<h2>${d.date}</h2>`;
    }
    html += `
      <div class="card clickable" data-action="open-event" data-id="${e.id}">
        <div class="row">
          <div class="title">${esc(e.location)}　${d.time}-${tp(e.ends_at).time}</div>
          <span class="badge ${e.status === 'open' ? '' : 'off'}">${EVENT_STATUS[e.status]}</span>
        </div>
        <div class="stats">
          <span class="badge">正取 ${e.seated}/${e.capacity}</span>
          ${e.reported ? `<span class="badge warn">待確認收款 ${e.reported}</span>` : ''}
          ${e.unpaid ? `<span class="badge warn">未繳 ${e.unpaid}</span>` : ''}
          ${e.waitlist ? `<span class="badge off">候補 ${e.waitlist}</span>` : ''}
        </div>
      </div>`;
  }
  app.innerHTML = html;
}

function personCell(r) {
  const p = r.player;
  const sub = p ? [p.name !== r.attendee_name ? `報名人 ${p.name || p.line_name}` : '', p.phone].filter(Boolean).join('・') : '後台新增';
  return `<div>${esc(r.attendee_name)}${r.rent_racket ? '（借拍）' : ''}</div><div class="muted">${esc(sub)}</div>`;
}

async function renderEvent(id) {
  const { event: e, seated, waitlist, rosterText } = await api(`/api/admin/events/${id}`);
  const rows = seated
    .map((r, i) => {
      const [label, cls] = STATUS[r.status];
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${personCell(r)}</td>
          <td>$${r.amount}</td>
          <td><span class="badge ${cls}">${label}</span>
            ${r.payment_last5 ? `<div class="muted">末五碼 ${esc(r.payment_last5)}</div>` : ''}
            ${r.status === 'pending' ? `<div class="muted">期限 ${when(r.pay_by)}</div>` : ''}</td>
          <td><div class="actions">
            ${r.status !== 'confirmed' ? `<button class="primary" data-action="confirm" data-id="${r.id}">確認收款</button>` : ''}
            <button data-action="attended" data-id="${r.id}" data-value="${r.attended === 1 ? 'null' : 'true'}">${r.attended === 1 ? '✓ 已出席' : '點名'}</button>
            <button class="danger" data-action="cancel-reg" data-id="${r.id}">取消</button>
          </div></td>
        </tr>`;
    })
    .join('');
  const wrows = waitlist
    .map(
      (r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${personCell(r)}</td>
          <td><div class="actions"><button class="danger" data-action="cancel-reg" data-id="${r.id}">取消</button></div></td>
        </tr>`,
    )
    .join('');
  app.innerHTML = `
    <div class="toolbar"><button data-action="back">← 回場次列表</button></div>
    <div class="card">
      <div class="title">${esc(e.location)}　${tp(e.starts_at).date} ${tp(e.starts_at).time}-${tp(e.ends_at).time}</div>
      <div class="muted">繳費截止 ${when(e.payment_deadline)}・$${e.price}／人・借拍 $${e.rental_fee}</div>
      <div class="grid">
        <div><label>名額</label><input type="number" id="ev-capacity" value="${e.capacity}" min="0"></div>
        <div><label>狀態</label><select id="ev-status">
          ${Object.entries(EVENT_STATUS).map(([k, v]) => `<option value="${k}" ${k === e.status ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div><label>程度說明</label><input id="ev-level" value="${esc(e.level_note)}"></div>
      </div>
      <label>集合資訊（繳費確認後才給球友看）</label><input id="ev-meeting" value="${esc(e.meeting_note)}">
      <div class="inline"><button class="primary" data-action="save-event" data-id="${e.id}">儲存</button></div>
    </div>

    <h2>正取 ${seated.length}/${e.capacity}</h2>
    <div class="card table-wrap">
      ${seated.length ? `<table><tr><th>#</th><th>名字</th><th>金額</th><th>繳費</th><th></th></tr>${rows}</table>` : '<div class="muted">還沒有人報名</div>'}
    </div>

    <h2>候補 ${waitlist.length}</h2>
    <div class="card table-wrap">
      ${waitlist.length ? `<table><tr><th>#</th><th>名字</th><th></th></tr>${wrows}</table>` : '<div class="muted">沒有候補</div>'}
    </div>

    <h2>手動加人（私訊或現場報名）</h2>
    <div class="card">
      <div class="grid">
        <div><label>名字</label><input id="add-name"></div>
        <div><label class="check"><input type="checkbox" id="add-rent"> 借拍</label>
             <label class="check"><input type="checkbox" id="add-paid"> 已收款</label></div>
      </div>
      <div class="inline"><button class="primary" data-action="add-person" data-id="${e.id}">加入</button></div>
    </div>

    <h2>貼到 LINE 群組的接龍文字</h2>
    <div class="card">
      <textarea id="roster-text" readonly>${esc(rosterText)}</textarea>
      <div class="inline"><button class="primary" data-action="copy">複製</button></div>
    </div>`;
}

async function renderSlots() {
  const { slots } = await api('/api/admin/slots');
  app.innerHTML = `
    <p class="muted">每天凌晨會依這些時段自動建立未來兩週的場次。改名額只影響之後新建立的場次。</p>
    <div class="card table-wrap"><table>
      <tr><th>時段</th><th>名額</th><th>程度</th><th>集合資訊</th><th>啟用</th><th></th></tr>
      ${slots
        .map(
          (s) => `
        <tr>
          <td>週${WEEKDAYS[s.weekday]} ${esc(s.location)}<div class="muted">${s.start_time}-${s.end_time}</div></td>
          <td><input type="number" id="s-cap-${s.id}" value="${s.capacity}" min="1" style="width:70px"></td>
          <td><input id="s-level-${s.id}" value="${esc(s.level_note)}"></td>
          <td><input id="s-meet-${s.id}" value="${esc(s.meeting_note)}"></td>
          <td><input type="checkbox" id="s-active-${s.id}" ${s.active ? 'checked' : ''} style="width:auto"></td>
          <td><button class="primary" data-action="save-slot" data-id="${s.id}">儲存</button></td>
        </tr>`,
        )
        .join('')}
    </table></div>`;
}

const val = (id) => document.getElementById(id).value;

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action], .tab');
  if (!btn) return;
  if (btn.classList.contains('tab')) {
    state = { tab: btn.dataset.tab, eventId: null };
    return render().catch((e) => toast(e.message));
  }
  const id = Number(btn.dataset.id);
  try {
    switch (btn.dataset.action) {
      case 'open-event':
        state.eventId = id;
        return await render();
      case 'back':
        state.eventId = null;
        return await render();
      case 'toggle-new':
        document.getElementById('new-event').hidden ^= true;
        return;
      case 'generate': {
        const { created } = await api('/api/admin/generate', { method: 'POST', body: { days: 14 } });
        toast(created ? `新增了 ${created} 個場次` : '場次都已經建立了');
        return await render();
      }
      case 'create-event':
        await api('/api/admin/events', {
          method: 'POST',
          body: {
            date: val('ne-date'),
            start: val('ne-start'),
            end: val('ne-end'),
            location: val('ne-location').trim(),
            capacity: Number(val('ne-capacity')),
            price: Number(val('ne-price')),
            levelNote: val('ne-level'),
            meetingNote: val('ne-meeting'),
          },
        });
        toast('已建立');
        return await render();
      case 'save-event':
        if (val('ev-status') === 'cancelled' && !confirm('確定取消這場？已報名的人會收到通知。')) return;
        await api(`/api/admin/events/${id}`, {
          method: 'PATCH',
          body: {
            capacity: Number(val('ev-capacity')),
            status: val('ev-status'),
            levelNote: val('ev-level'),
            meetingNote: val('ev-meeting'),
          },
        });
        toast('已儲存');
        return await render();
      case 'confirm':
        await api(`/api/admin/registrations/${id}/confirm`, { method: 'POST' });
        toast('已確認收款');
        return await render();
      case 'cancel-reg':
        if (!confirm('確定取消這個名額？有候補的話會自動遞補。')) return;
        await api(`/api/admin/registrations/${id}/cancel`, { method: 'POST' });
        toast('已取消');
        return await render();
      case 'attended':
        await api(`/api/admin/registrations/${id}/attended`, {
          method: 'POST',
          body: { attended: btn.dataset.value === 'true' ? true : null },
        });
        return await render();
      case 'add-person':
        if (!val('add-name').trim()) throw new Error('請填名字');
        await api(`/api/admin/events/${id}/registrations`, {
          method: 'POST',
          body: {
            name: val('add-name').trim(),
            rentRacket: document.getElementById('add-rent').checked,
            paid: document.getElementById('add-paid').checked,
          },
        });
        toast('已加入');
        return await render();
      case 'copy':
        await navigator.clipboard.writeText(val('roster-text'));
        toast('已複製，可以貼到 LINE 群組');
        return;
      case 'save-slot':
        await api(`/api/admin/slots/${id}`, {
          method: 'PATCH',
          body: {
            capacity: Number(val(`s-cap-${id}`)),
            levelNote: val(`s-level-${id}`),
            meetingNote: val(`s-meet-${id}`),
            active: document.getElementById(`s-active-${id}`).checked,
          },
        });
        toast('已儲存');
        return;
    }
  } catch (err) {
    toast(err.message);
  }
});

render().catch((e) => {
  app.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
});
