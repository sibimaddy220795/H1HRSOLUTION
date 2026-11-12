function mount(html) {
  const root = document.getElementById('view');
  root.innerHTML = html;
  return root;
}

async function load(path, options) {
  const ticket = S1.ticket;
  const result = await UI.api(path, options);
  if (ticket !== S1.ticket) return null;
  return result;
}

function head(title, text, actions = '') {
  return `<header class="page-head"><div><p>${text}</p></div><div class="page-actions">${actions}</div></header>`;
}

const PAY_METHODS = ['UPI', 'Bank transfer', 'Card', 'Net banking', 'Cheque'];
function payFields(method, reference) {
  const choices = { select: PAY_METHODS.map((item) => ({ value: item, label: item })) };
  return `${UI.field('paymentMethod', 'Payment method', method || 'UPI', choices)}${UI.field('paymentReference', 'Payment reference', reference || '')}`;
}

function captureBox(self, punch) {
  const punchedIn = punch && punch.inTime && !punch.outTime;
  const punchedOut = punch && punch.outTime;
  const statusClass = punchedIn ? 'punched-in' : punchedOut ? 'punched-out' : '';
  const statusText = punchedIn ? '● On duty' : punchedOut ? '✓ Done for today' : '○ Not punched';
  const inBtn = `<button class="att-punch-btn punch-in" type="button" data-cap="in" data-method="Manual" ${punchedIn || punchedOut ? 'disabled' : ''}>⬆ Punch In</button>`;
  const outBtn = `<button class="att-punch-btn punch-out" type="button" data-cap="out" data-method="Manual" ${!punchedIn || punchedOut ? 'disabled' : ''}>⬇ Punch Out</button>`;
  const qrBtn = `<button class="att-punch-btn qr-btn" type="button" data-cap="qr" data-method="QR">📱 Scan QR</button>`;
  if (self) {
    return `<div class="capture" data-self="yes">
      <div class="att-punch-actions">${inBtn}${outBtn}${qrBtn}</div>
      <label class="field" style="margin-top:10px">ID card scan<input data-id-scan placeholder="Click here, then scan the ID card barcode" autocomplete="off"/></label>
    </div>`;
  }
  return `<div class="capture" data-self="no">
    <div class="att-punch-actions" style="flex-direction:row;gap:10px;flex-wrap:wrap;">
      <button class="btn primary" type="button" data-cap="in" data-method="Manual">⬆ Punch In</button>
      <button class="btn" type="button" data-cap="out" data-method="Manual">⬇ Punch Out</button>
      <button class="btn" type="button" data-cap="qr" data-method="QR">📱 Scan QR</button>
    </div>
    <label class="field" style="margin-top:10px">ID card scan<input data-id-scan placeholder="Click here, then scan the ID card barcode" autocomplete="off"/></label>
    <p class="muted" style="margin-top:8px">Manual punch uses the buttons above. QR and ID card scan auto-detect punch in or punch out.</p>
  </div>`;
}

async function sendCapture(body) {
  let place = {};
  try { place = await UI.locate() || {}; } catch (_) { place = {}; }
  const result = await UI.api('/api/attendance/capture', { method: 'POST', body: { ...body, ...place } });
  const row = result.data;
  UI.toast(`${row.mode} ${row.outTime ? 'punch out' : 'punch in'} · ${row.employeeName}`);
  S1.go();
}

function bindCapture(root, people) {
  const box = root.querySelector('.capture');
  if (!box) return;
  const self = box.dataset.self === 'yes';
  const employeeId = () => {
    const select = root.querySelector('[data-cap-employee]');
    return select ? select.value : '';
  };
  box.querySelectorAll('[data-cap="in"], [data-cap="out"]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await sendCapture({ method: 'Manual', action: button.dataset.cap, employeeId: self ? '' : employeeId() });
      } catch (error) {
        UI.toast(error.message, 'bad');
        button.disabled = false;
      }
    };
  });
  const scan = box.querySelector('[data-id-scan]');
  scan.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const code = scan.value.trim();
    if (!code) return;
    scan.disabled = true;
    try {
      await sendCapture({ method: 'ID card', code, employeeId: '' });
    } catch (error) {
      UI.toast(error.message, 'bad');
      scan.disabled = false;
    }
  });
  box.querySelector('[data-cap="qr"]').onclick = () => openQrScan(self);
  if (!self && people) {
    const holder = document.createElement('div');
    holder.innerHTML = UI.field('employeeId', 'Employee for a manual punch', people[0] ? people[0].value : '', { select: people });
    holder.querySelector('select').dataset.capEmployee = 'yes';
    box.appendChild(holder);
  }
}

function showMyQr(employeeId) {
  const query = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
  UI.api('/api/attendance/my-qr' + query).then((res) => {
    const data = res.data;
    UI.openModal({
      title: 'Attendance QR Code',
      html: `
        <div style="text-align:center;padding:12px 16px;">
          <img src="${data.qrDataUrl}" alt="QR Code" style="width:230px;height:230px;margin:0 auto 12px;border:1px solid var(--line);border-radius:14px;display:block;box-shadow:0 4px 16px rgba(0,0,0,0.06);" />
          <h3 style="margin:4px 0;font-size:18px;">${UI.esc(data.fullName)}</h3>
          <p class="muted" style="margin:3px 0;font-size:13.5px;"><strong>${UI.esc(data.employeeCode)}</strong> · ${UI.esc(data.companyName)}</p>
          <p style="margin:8px 0 0;font-size:12px;color:var(--muted);background:rgba(0,0,0,0.03);padding:6px 12px;border-radius:8px;">Scan this QR code using a mobile device camera or barcode scanner to mark attendance automatically.</p>
        </div>`,
      submitLabel: 'Close'
    });
  }).catch((err) => {
    UI.toast(err.message || 'Could not load QR code', 'bad');
  });
}

function openQrScan(self) {
  let stream;
  const stop = () => { if (stream) stream.getTracks().forEach((track) => track.stop()); };
  UI.openModal({
    title: 'Scan QR Code for Attendance',
    html: `
      <div style="margin-bottom:12px">
        <video id="qr-video" class="scan-video" autoplay playsinline muted style="width:100%;max-height:240px;border-radius:12px;background:#111;"></video>
        <p class="muted" id="qr-status" style="margin:6px 0 0;font-size:12.5px;">Point your camera at an employee QR code or ID card.</p>
      </div>
      ${UI.field('code', 'Or enter / paste employee code (e.g. EMP-2026-0001)', '')}
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button class="btn ghost small" type="button" id="modal-my-qr-btn">🪪 Show My QR Code</button>
      </div>`,
    submitLabel: 'Confirm Punch',
    onReady(form) {
      form.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', stop));
      const video = form.querySelector('#qr-video');
      const status = form.querySelector('#qr-status');
      const myQrBtn = form.querySelector('#modal-my-qr-btn');
      if (myQrBtn) myQrBtn.onclick = () => { stop(); showMyQr(); };

      if (!navigator.mediaDevices || !window.BarcodeDetector) {
        status.textContent = 'Camera scanner not supported in this browser. Enter the employee code below:';
        if (video) video.style.display = 'none';
        return;
      }
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((opened) => {
        stream = opened;
        video.srcObject = stream;
        const watch = async () => {
          if (!stream || !form.isConnected) return;
          try {
            const codes = await detector.detect(video);
            if (codes[0] && codes[0].rawValue) {
              stop();
              form.code.value = codes[0].rawValue;
              status.textContent = 'QR recognized! Confirming punch...';
              await sendCapture({ method: 'QR', code: codes[0].rawValue });
              return;
            }
          } catch (_) {}
          requestAnimationFrame(watch);
        };
        video.onloadedmetadata = () => watch();
      }).catch(() => {
        status.textContent = 'Camera access denied or unavailable. Enter employee code below:';
        if (video) video.style.display = 'none';
      });
    },
    onSubmit: async (data) => {
      stop();
      await sendCapture({ method: 'QR', code: data.get('code') });
    }
  });
}

function safeUrl(url) {
  if (!url || /["'()\s]/.test(url)) return '';
  if (url.startsWith('/uploads/')) return url;
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
  } catch (_) { return ''; }
  return '';
}

function sliderHtml(slides) {
  if (!slides.length) return '';
  return `<section class="slider" id="slider"><div class="slider-nav"><button type="button" id="slide-prev">Previous</button><button type="button" id="slide-next">Next</button></div><div id="slides"></div><div class="slide-progress" id="slide-progress"></div></section>`;
}

function startSlider(root, slides) {
  if (!slides.length || !root.querySelector('#slides')) return;
  let index = 0;
  const paint = () => {
    const slide = slides[index];
    const media = safeUrl(slide.mediaUrl);
    const style = media ? ` style="background-image:linear-gradient(rgba(12,24,34,.55), rgba(12,24,34,.62)), url('${media}')"` : '';
    const link = safeUrl(slide.link) ? `<a class="btn" href="${UI.esc(safeUrl(slide.link))}" target="_blank" rel="noreferrer">Open link</a>` : '';
    root.querySelector('#slides').innerHTML = `<article class="slide on"${style}><p class="kicker">${UI.esc(slide.companyName)} · 30 seconds</p><h2>${UI.esc(slide.title)}</h2><p>${UI.esc(slide.description)}</p>${link}</article>`;
    root.querySelector('#slide-progress').innerHTML = '<span></span>';
  };
  paint();
  const timer = setInterval(() => { index = (index + 1) % slides.length; paint(); }, 30000);
  S1.addStop(() => clearInterval(timer));
  root.querySelector('#slide-prev').onclick = () => { index = (index - 1 + slides.length) % slides.length; paint(); };
  root.querySelector('#slide-next').onclick = () => { index = (index + 1) % slides.length; paint(); };
}

function chart(rows) {
  if (!rows.length) return '<p class="muted">Scorecards appear after a company is approved.</p>';
  const max = Math.max(...rows.map((row) => Math.max(row.target, row.achieved, 1)));
  return rows.map((row) => {
    const gap = row.target - row.achieved;
    return `<div class="bar-row"><div class="bar-label"><strong>${UI.esc(row.name)}</strong><span>${gap > 0 ? `Deficit ${gap}` : `Ahead ${Math.abs(gap)}`}</span></div>
      <div class="bar"><span style="width:${Math.round(row.target / max * 100)}%"></span></div>
      <div class="bar actual ${gap > 0 ? 'deficit' : ''}"><span style="width:${Math.round(row.achieved / max * 100)}%"></span></div></div>`;
  }).join('') + '<p class="muted">Upper bar is the target. Lower bar is achieved.</p>';
}

function kpis(items) {
  return `<section class="kpis">${items.map((item) => `<article class="kpi"><span>${UI.esc(item.label)}</span><strong>${item.money ? UI.inr(item.value) : UI.esc(item.value)}</strong><em>${UI.esc(item.note)}</em></article>`).join('')}</section>`;
}

const Pages = {
  async dashboard() {
    const data = S1.boot.dashboard;
    const slides = S1.boot.advertisements || [];
    const punch = data.punch;
    const canPunch = S1.user.role === 'employee' || !!S1.user.employeeId;
    const punchBlock = canPunch ? `
      <article class="card punch-card"><div>
        <p class="kicker">Attendance</p>
        <div class="clock" id="live-clock"></div>
        <p>${UI.esc(S1.user.companyName)} · ${punch ? UI.badge(punch.status) : UI.badge('Not punched')}</p>
        <p class="muted">${punch && punch.inTime ? `In ${UI.clock(punch.inTime)}` : 'In time is still open.'} ${punch && punch.outTime ? `· Out ${UI.clock(punch.outTime)}` : ''}</p>
        <p class="muted">${punch ? UI.esc(punch.locationNote) : 'Punch in and punch out are manual. A device can also scan the ID card QR or the employee ID.'}</p>
        ${captureBox(true, punch)}
      </div><div>
        <h3>Today’s flag</h3>
        <p>${punch ? `<span class="flag ${punch.flag}"></span>${UI.esc(punch.flag === 'red' ? 'Red flag' : 'Green flag')}` : 'Waiting for the first punch.'}</p>
        ${punch && punch.penalty ? `<p>Penalty ${UI.inr(punch.penalty)} · ${UI.esc(punch.penaltyRemarks)}</p>` : ''}
      </div></article>` : '';
    const company = data.company && S1.user.role === 'client' ? `
      <article class="card"><div class="card-head"><h3>Storage</h3><span>${data.company.storageUsedMb.toFixed(1)} / ${data.company.storageLimitMb} MB</span></div>
        <div class="meter"><span style="width:${Math.min(100, data.company.storageUsedMb / data.company.storageLimitMb * 100)}%"></span></div>
        <p>${UI.badge(data.company.status)} ${UI.esc(data.company.rating)}</p></article>` : '';
    const plan = data.company && data.company.planDetail && S1.user.role === 'client' && !S1.user.isHrAdmin ? data.company.planDetail : null;
    const planCard = plan ? `
      <article class="card"><div class="card-head"><h3>${UI.esc(plan.name)}</h3><a href="#/plans">Change plan</a></div>
        <p>${UI.esc(plan.family)} · ${UI.esc(plan.clientLabel)}</p>
        <p class="muted">${data.company.clientUsers} of ${plan.clients} company panels · ${data.company.employeeCount} of ${plan.employees == null ? 'unlimited' : plan.employees} employees</p>
        <p class="muted">${UI.esc((data.company.onboarding && data.company.onboarding.paymentMethod) || 'Bank transfer')}${data.company.onboarding && data.company.onboarding.paymentReference ? ` · ${UI.esc(data.company.onboarding.paymentReference)}` : ''} · ${UI.esc((data.company.onboarding && data.company.onboarding.cycle) || 'Monthly')} · ${UI.esc((data.company.onboarding && data.company.onboarding.paymentStatus) || 'Unpaid')}</p></article>` : '';
    const root = mount(`
      ${head(S1.user.isHrAdmin ? 'Admin desk' : S1.user.role === 'employee' ? 'My day' : S1.user.role === 'client' ? 'Client admin' : 'Super admin', 'The live desk for this portal.')}
      ${sliderHtml(slides)}
      ${kpis(data.kpis)}
      ${punchBlock}
      ${planCard}
      <div class="grid-2" style="margin-top:12px">
        <article class="card"><div class="card-head"><h3>Growth and deficit</h3><span>Target against achieved</span></div>${chart(data.chart)}</article>
        <article class="card"><div class="card-head"><h3>Flags</h3><span>Red needs a look. Green is on time.</span></div>
          ${(data.flags || []).map((flag) => `<div class="flag-row"><span><span class="flag ${flag.tone}"></span>${UI.esc(flag.title)}</span><span class="muted">${UI.esc(flag.detail)}</span></div>`).join('') || '<p class="muted">No flags yet.</p>'}
        </article>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <article class="card"><div class="card-head"><h3>${S1.user.role === 'admin' ? 'Waiting on you' : 'Company score'}</h3></div>
          ${S1.user.role === 'admin' ? (data.queue || []).map((item) => `<a class="queue-row" href="${UI.esc(item.href)}"><span>${UI.esc(item.title)}</span><span class="muted">${UI.esc(item.meta)}</span></a>`).join('') || '<p class="muted">The queue is clear.</p>' : company || '<p class="muted">Scorecards sit on the company record.</p>'}
        </article>
        <article class="card"><div class="card-head"><h3>Priority calls</h3></div>
          ${(data.calls || []).map((lead) => `<a class="link-row" href="tel:${UI.esc(String(lead.phone).replace(/[^\d+]/g, ''))}"><span><strong>${UI.esc(lead.companyName)}</strong><br><span class="muted">${UI.esc(lead.contactName)} · ${UI.esc(lead.phone)}</span></span><span>Call</span></a>`).join('') || '<p class="muted">No priority calls on this desk.</p>'}
        </article>
      </div>`);
    startSlider(root, slides);
    bindCapture(root);
    const clock = root.querySelector('#live-clock');
    if (clock) {
      const tick = () => { clock.textContent = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
      tick();
      const timer = setInterval(tick, 1000);
      S1.addStop(() => clearInterval(timer));
    }
    const punchBtn = root.querySelector('#punch-btn');
    if (punchBtn) punchBtn.onclick = async () => {
      punchBtn.disabled = true;
      try {
        const place = await UI.locate();
        await UI.api('/api/attendance/punch', { method: 'POST', body: place || {} });
        UI.toast(place ? 'Punch saved with location' : 'Punch saved. Location was not shared.');
        S1.go();
      } catch (error) {
        UI.toast(error.message, 'bad');
        punchBtn.disabled = false;
      }
    };
  },

  async plans() {
    const catalog = S1.ref.plans || [];
    const families = [...new Set(catalog.map((plan) => plan.family))];
    const mine = S1.user.role === 'client' && !S1.user.isHrAdmin;
    const current = mine ? await load(`/api/clients/${S1.user.clientId}`) : null;
    const company = current ? current.data : null;
    const currentId = company && company.planDetail ? company.planDetail.id : '';
    const staffCap = company && company.planDetail && company.planDetail.employees == null ? 'unlimited' : (company && company.planDetail ? company.planDetail.employees : '');
    const banner = company && company.planDetail ? `<article class="card"><div class="card-head"><h3>Current subscription</h3>${UI.badge(company.planDetail.name)}</div><p>${UI.esc(company.planDetail.family)} · ${company.clientUsers} of ${company.planDetail.clients} company panels · ${company.employeeCount} of ${staffCap} employees</p><form id="plan-request" class="fields" style="margin-top:12px">${UI.field('plan', 'Requested plan', currentId || 'hr-select', { select: catalog.map((item) => ({ value: item.id, label: `${item.family} · ${item.name}` })) })}${UI.field('fee', 'Fee', (company.onboarding && company.onboarding.fee) || 0, { type: 'number' })}${UI.field('cycle', 'Cycle', (company.onboarding && company.onboarding.cycle) || 'Monthly', { select: ['Monthly', 'Quarterly', 'Yearly'].map((item) => ({ value: item, label: item })) })}${payFields(company.onboarding && company.onboarding.paymentMethod, company.onboarding && company.onboarding.paymentReference)}${UI.field('detail', 'Why', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Request plan change</button></form><p class="muted">The super administrator verifies the request, then approves it.</p></article>` : '';
    const cards = families.map((family) => `<section style="margin-top:16px"><h3>${UI.esc(family)}</h3><div class="grid-2">${catalog.filter((plan) => plan.family === family).map((plan) => `<article class="card"><div class="card-head"><h3>${UI.esc(plan.name)}</h3>${currentId === plan.id ? UI.badge('Active') : ''}</div><p>${UI.esc(plan.clientLabel)}${plan.note ? ` · ${UI.esc(plan.note)}` : ''}</p><ul>${plan.features.map((item) => `<li>${UI.esc(item.name)}${item.access === 'limited' ? ' <span class="muted">Limited</span>' : ''}</li>`).join('')}</ul></article>`).join('')}</div></section>`).join('');
    const root = mount(`${head('Plans', mine ? 'Your company subscription. Seat limits apply when a company panel or an employee is added.' : 'Small, medium, and large subscriptions. Seat limits apply when a company panel or an employee is added.')}${banner}${cards}`);
    const planRequest = root.querySelector('#plan-request');
    if (planRequest) planRequest.onsubmit = async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(planRequest).entries());
      payload.clientId = S1.user.clientId;
      payload.kind = 'Plan change';
      await UI.api('/api/client-requests', { method: 'POST', body: payload });
      UI.toast('Plan change sent');
      S1.go();
    };
  },

  async clients() {
    const res = await load('/api/clients');
    if (!res) return;
    const rows = res.data.map((client) => `<tr>
      <td><a href="#/client/${UI.esc(client.id)}"><strong>${UI.esc(client.companyName)}</strong></a><br><span class="muted">${UI.esc(client.applicationNumber)}</span></td>
      <td>${UI.esc(client.businessType)}</td><td>${UI.badge(client.status)}</td>
      <td>${client.branches.length}</td><td>${client.employeeCount}</td>
      <td class="num">${UI.inr(client.totalBudget)}</td><td>${UI.esc(client.rating)}</td></tr>`).join('');
    const root = mount(`${head('Clients', 'Register a company here, or review a self-registration before verification and activation.', `
      ${S1.user.role === 'admin' ? '<button class="btn primary" type="button" data-act="register">Register company</button>' : ''}
      <button class="btn" type="button" data-act="xlsx">Excel</button><button class="btn ghost" type="button" data-act="csv">CSV</button>`)}
      <div class="table-wrap"><table><thead><tr><th>Company</th><th>Business</th><th>Status</th><th>Branches</th><th>Staff</th><th class="num">Budget</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    UI.bind(root, {
      register: () => UI.openModal({
        title: 'Register a company',
        html: `<div class="fields">${UI.field('companyName', 'Company', '', { required: true })}${UI.field('businessType', 'Business', '', { required: true })}${UI.field('officialMail', 'Official mail', '', { type: 'email', required: true })}${UI.field('phone', 'Phone', '', { required: true })}${UI.field('website', 'Website')}${UI.field('address', 'Address', '', { type: 'textarea' })}${UI.field('plan', 'Subscription plan', 'hr-easy', { select: (S1.ref.plans || []).map((plan) => ({ value: plan.id, label: `${plan.family} · ${plan.name} · ${plan.clientLabel}` })) })}${payFields('UPI', '')}</div>`,
        onSubmit: async (data) => {
          const created = await UI.api('/api/clients', { method: 'POST', body: Object.fromEntries(data.entries()) });
          UI.toast('Company registered');
          location.hash = `#/client/${created.data.id}`;
        }
      }),
      xlsx: () => UI.download('/api/export/clients?format=xlsx', 's1-clients.xlsx'),
      csv: () => UI.download('/api/export/clients?format=csv', 's1-clients.csv')
    });
  },

  async client(route) {
    const res = await load(`/api/clients/${route.id}`);
    if (!res) return;
    const client = res.data;
    const admin = S1.user.role === 'admin';
    const hrDesk = !!S1.user.isHrAdmin;
    const canEdit = S1.user.role !== 'employee';
    const [requests, seats, places] = await Promise.all([load('/api/client-requests'), load('/api/requisitions'), load('/api/locations')]);
    if (!requests || !seats || !places) return;
    const pack = client.onboarding || {};
    const plans = (S1.ref.plans || []).map((plan) => ({ value: plan.id, label: `${plan.name} · ${plan.clientLabel}` }));
    const cycles = ['Monthly', 'Quarterly', 'Yearly'].map((item) => ({ value: item, label: item }));
    const companyRequests = requests.data.filter((row) => row.clientId === client.id);
    const companySeats = seats.data.filter((row) => row.clientId === client.id);
    const companyPlaces = places.data.filter((row) => row.clientId === client.id);
    const docs = client.documents || {};
    const docCard = (label, key, file) => `<article><span class="muted">${UI.esc(label)}</span><strong>${UI.esc(file && file.name ? file.name : 'Not on file')}</strong><p>${file && file.url ? `<a href="${UI.esc(file.url)}" target="_blank" rel="noreferrer">Open</a>` : ''} ${file && file.verified ? UI.badge('Approved') : UI.badge('Pending')}</p>${admin && file && file.name ? `<button class="btn small" type="button" data-act="doc" data-key="${key}" data-verified="${file.verified ? 'no' : 'yes'}">${file.verified ? 'Unverify' : 'Verify'}</button>` : ''}${admin ? `<form class="doc-upload" data-key="${key}"><input name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"/><button class="btn small" type="submit">Upload</button></form>` : ''}</article>`;
    const root = mount(`
      <div class="detail-hero"><div><p class="kicker">${UI.esc(client.applicationNumber)}</p><h1>${UI.esc(client.companyName)}</h1><p class="muted">${UI.esc(client.businessType)} · ${UI.esc(client.officialMail)}</p></div>
        <div class="page-actions">${UI.badge(client.status)} ${admin && client.status === 'Pending' ? '<button class="btn primary" type="button" data-act="approve">Approve</button><button class="btn danger" type="button" data-act="reject">Reject</button>' : ''} ${admin && client.status === 'Approved' ? '<button class="btn" type="button" data-act="access">Issue client login</button>' : ''} ${(admin || (S1.user.role === 'client' && !hrDesk)) && client.status === 'Approved' ? '<button class="btn" type="button" data-act="admin-portal">Issue admin portal</button>' : ''}</div></div>
      <div class="grid-2">
        <article class="card"><div class="card-head"><h3>Mandatory documents</h3><span>Incorporation, GST, MSME, PAN, trade licence</span></div>
          <div class="doc-grid">${docCard('Incorporation', 'incorporation', docs.incorporation)}${docCard('GST', 'gst', docs.gst)}${docCard('MSME', 'msme', docs.msme)}${docCard('PAN', 'pan', docs.pan)}${docCard('Trade licence', 'trade', docs.trade)}${(docs.extra || []).map((file) => docCard('Additional', '', file)).join('')}</div>
        </article>
        <article class="card"><div class="card-head"><h3>Storage and slides</h3><span>${client.adSlots} slide slots</span></div>
          <div class="meter"><span style="width:${Math.min(100, client.storageUsedMb / client.storageLimitMb * 100)}%"></span></div>
          <p>${client.storageUsedMb.toFixed(1)} MB of ${client.storageLimitMb} MB</p>
          ${admin ? `<form id="slot-form" class="stack"><label class="field">Slide cap<input name="adSlots" type="number" value="${client.adSlots}"/></label><button class="btn" type="submit">Save cap</button></form>` : ''}
          <p class="muted">${UI.esc(client.address)}</p>
          <p class="muted">${UI.esc(client.phone)} · ${UI.esc(client.website || 'No website')}</p>
        </article>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <article class="card"><div class="card-head"><h3>Branches</h3>${canEdit ? '<button class="btn small" type="button" data-act="branch">Add branch</button>' : ''}</div>
          ${client.branches.map((branch) => `<div class="flag-row"><span><strong>${UI.esc(branch.name)}</strong><br><span class="muted">${UI.esc(branch.city)} · ${UI.esc(branch.address)}</span></span><span>${branch.staffCount} staff</span></div>`).join('') || '<p class="muted">No branches yet.</p>'}
        </article>
        <article class="card"><div class="card-head"><h3>Admin portal</h3><span>${(client.admins || []).filter((person) => person.active).length} active</span></div>
          <p class="muted">The super admin and the client admin both create this login. One starts it, and the other confirms it.</p>
          ${(client.admins || []).map((person) => {
            const waitingClient = person.statusText === 'Pending client admin';
            const waitingSuper = person.statusText === 'Pending super admin';
            const label = waitingClient ? 'Waiting for the client admin' : (waitingSuper ? 'Waiting for the super admin' : (person.active ? 'Active' : 'Off'));
            const confirm = (admin && waitingSuper) || (!hrDesk && S1.user.role === 'client' && waitingClient);
            return `<div class="flag-row"><span><strong>${UI.esc(person.name)}</strong><br><span class="muted">${UI.esc(person.email)} · ${UI.esc(person.title || 'HR admin')}</span></span><span>${UI.badge(label)}${confirm ? ` <button class="btn small" type="button" data-act="confirm-admin" data-id="${UI.esc(person.id)}">Confirm</button>` : ''}</span></div>`;
          }).join('') || '<p class="muted">No company admin yet.</p>'}
        </article>
        <article class="card"><div class="card-head"><h3>Scorecard</h3><span>${UI.esc(client.rating)}</span></div>
          ${canEdit ? `<form id="score-form" class="fields">${UI.field('target', 'Target', client.scoreTarget, { type: 'number' })}${UI.field('achieved', 'Achieved', client.scoreAchieved, { type: 'number' })}${UI.field('notes', 'Notes', client.scoreNotes, { type: 'textarea' })}<button class="btn span-2" type="submit">Save scorecard</button></form>` : `<p>${client.scoreAchieved} / ${client.scoreTarget}</p><p>${UI.esc(client.scoreNotes)}</p>`}
        </article>
      </div>
      <article class="card" style="margin-top:12px"><div class="card-head"><h3>Position budgets</h3><span>${UI.inr(client.totalBudget)}</span>${canEdit ? '<button class="btn small" type="button" data-act="budget">Edit budgets</button>' : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>Position</th><th class="num">Budget</th><th class="num">Allocated</th></tr></thead><tbody>
          ${client.positionBudgets.map((row) => `<tr><td>${UI.esc(row.position)}</td><td class="num">${UI.inr(row.budget)}</td><td class="num">${UI.inr(row.allocated)}</td></tr>`).join('') || '<tr><td colspan="3">No positions yet.</td></tr>'}
        </tbody></table></div></article>
      <article class="card" style="margin-top:12px"><div class="card-head"><h3>Onboarding · ${UI.esc(pack.stage || 'Registered')}</h3>${UI.badge(client.status)}</div>
        <p class="muted">Registration, documents, approval, activation, implementation, handover, and closure. A plan change is verified and then approved.</p>
        ${admin ? `<div class="page-actions">
          <button class="btn small" type="button" data-act="verify-stage">Mark documents verified</button>
          <button class="btn small" type="button" data-act="approve-stage">Approve company</button>
          <button class="btn small" type="button" data-act="implement">Start implementation</button>
          <button class="btn small" type="button" data-act="handover">Complete handover</button>
          <button class="btn small danger" type="button" data-act="close">Close account</button>
        </div>
        <form id="master-form" class="fields" style="margin-top:12px">${UI.field('companyName', 'Company', client.companyName)}${UI.field('businessType', 'Business', client.businessType)}${UI.field('officialMail', 'Official mail', client.officialMail)}${UI.field('phone', 'Phone', client.phone)}${UI.field('website', 'Website', client.website || '')}${UI.field('address', 'Address', client.address, { type: 'textarea' })}<button class="btn span-2" type="submit">Save master</button></form>` : ''}
      </article>
      <div class="grid-2" style="margin-top:12px">
        <form id="org-form" class="card fields"><h3 class="span-2">Organization</h3>${UI.field('legalName', 'Legal name', pack.legalName || client.companyName)}${UI.field('industry', 'Industry', pack.industry || client.businessType)}${UI.field('cin', 'CIN', pack.cin || '')}${UI.field('gstin', 'GSTIN', pack.gstin || '')}${UI.field('pan', 'PAN', pack.pan || '')}${canEdit ? '<button class="btn span-2" type="submit">Save organization</button>' : ''}</form>
        <form id="bill-form" class="card fields"><h3 class="span-2">Contact and billing</h3>${UI.field('billingName', 'Billing contact', pack.billingName || '')}${UI.field('billingEmail', 'Billing mail', pack.billingEmail || client.officialMail)}${UI.field('billingPhone', 'Billing phone', pack.billingPhone || client.phone)}${UI.field('paymentMode', 'Payment', pack.paymentMode || 'Bank transfer', { select: PAY_METHODS.map((item) => ({ value: item, label: item })) })}${UI.field('billingAddress', 'Billing address', pack.billingAddress || client.address, { type: 'textarea' })}${canEdit ? '<button class="btn span-2" type="submit">Save billing</button>' : ''}</form>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <form id="contract-form" class="card fields"><h3 class="span-2">Service and contract</h3>${UI.field('service', 'Service', pack.service || '')}${UI.field('contractStart', 'Start', pack.contractStart || '', { type: 'date' })}${UI.field('contractEnd', 'End', pack.contractEnd || '', { type: 'date' })}${UI.field('contractValue', 'Value', pack.contractValue || 0, { type: 'number' })}${UI.field('terms', 'Terms', pack.terms || '', { type: 'textarea' })}${canEdit ? '<button class="btn span-2" type="submit">Save contract</button>' : ''}</form>
        ${hrDesk ? `<article class="card"><h3>Subscription</h3><p><strong>${UI.esc(client.planDetail.name)}</strong> · ${UI.esc(client.planDetail.family)} · ${UI.esc(client.planDetail.clientLabel)}</p><p class="muted">${client.planDetail.features.map((item) => `${UI.esc(item.name)}${item.access === 'limited' ? ' (limited)' : ''}`).join(' · ')}</p><p class="muted">${UI.esc(pack.paymentMethod || 'Bank transfer')}${pack.paymentReference ? ` · ${UI.esc(pack.paymentReference)}` : ''} · ${UI.esc(pack.cycle || 'Monthly')} · ${UI.esc(pack.paymentStatus || 'Unpaid')}</p><p class="muted">The client admin owns plan changes.</p></article>` : `<form id="plan-form" class="card fields"><h3 class="span-2">Subscription and payment</h3>${UI.field('plan', 'Plan', (client.planDetail && client.planDetail.id) || 'hr-easy', { select: plans })}${UI.field('fee', 'Fee', pack.fee || 0, { type: 'number' })}${UI.field('cycle', 'Cycle', pack.cycle || 'Monthly', { select: cycles })}${payFields(pack.paymentMethod, pack.paymentReference)}${UI.field('paymentStatus', 'Payment', pack.paymentStatus || 'Unpaid', { select: ['Unpaid', 'Part paid', 'Paid'].map((item) => ({ value: item, label: item })) })}${admin ? '<button class="btn span-2" type="submit">Set plan</button>' : '<p class="muted span-2">Ask for a plan change below. The super administrator verifies it, then approves it.</p>'}<div class="span-2"><p><strong>${UI.esc(client.planDetail.name)}</strong> · ${UI.esc(client.planDetail.family)} · ${UI.esc(client.planDetail.clientLabel)}</p><p class="muted">${client.planDetail.features.map((item) => `${UI.esc(item.name)}${item.access === 'limited' ? ' (limited)' : ''}`).join(' · ')}</p></div></form>`}
      </div>
      <article class="card" style="margin-top:12px"><h3>Plan change requests</h3>
        ${hrDesk ? '' : `<form id="plan-request" class="fields">${UI.field('plan', 'Requested plan', 'hr-select', { select: plans })}${UI.field('fee', 'Fee', pack.fee || 0, { type: 'number' })}${UI.field('cycle', 'Cycle', pack.cycle || 'Monthly', { select: cycles })}${payFields(pack.paymentMethod, pack.paymentReference)}${UI.field('detail', 'Why', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Request plan change</button></form>`}
        ${companyRequests.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.planName || row.plan)}</strong> · ${UI.inr(row.fee)} ${UI.esc(row.cycle)} · ${UI.esc(row.paymentMethod || '')}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.detail)}</span></span><span>${UI.badge(row.status)}${admin && row.status === 'Pending verification' ? ` <button class="btn small" type="button" data-act="plan-yes" data-id="${row.id}">Verify</button>` : ''}${admin && row.status === 'Pending approval' ? ` <button class="btn small" type="button" data-act="plan-yes" data-id="${row.id}">Approve</button>` : ''}${admin && ['Pending verification', 'Pending approval'].includes(row.status) ? ` <button class="btn small danger" type="button" data-act="plan-no" data-id="${row.id}">Reject</button>` : ''}</span></div>`).join('') || '<p class="muted">No plan changes yet.</p>'}
      </article>
      <div class="grid-2" style="margin-top:12px">
        <article class="card"><h3>Manpower</h3>${companySeats.map((row) => `<div class="flag-row"><span>${UI.esc(row.position)} · ${row.openings} seats<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.kind)}</span></span>${UI.badge(row.status)}</div>`).join('') || '<p class="muted">No manpower requests for this company.</p>'}<p><a href="#/hiring">Open hiring</a></p></article>
        <article class="card"><h3>Locations and sites</h3>${companyPlaces.map((row) => `<div class="flag-row"><span>${UI.esc(row.kind)} · ${UI.esc(row.name)}<br><span class="muted">${UI.esc(row.branchName)}</span></span></div>`).join('') || '<p class="muted">No offices or sites yet.</p>'}<p><a href="#/places">Open locations</a></p></article>
      </div>
      <article class="card" style="margin-top:12px"><h3>Handover and closure</h3>
        <p>Owner ${UI.esc(pack.handoverOwner || '—')} · started ${UI.esc(pack.handoverStart || '—')} · handed over ${UI.esc(pack.handoverDone || '—')}</p>
        <p class="muted">${UI.esc(pack.handoverNotes || '')}</p>
        ${pack.closureReason ? `<p>Closed ${UI.esc(pack.closedOn || '')}: ${UI.esc(pack.closureReason)}</p>` : ''}
        ${(pack.history || []).slice(0, 8).map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.action)}</strong><br><span class="muted">${UI.esc(row.detail)} · ${UI.esc(row.actor)}</span></span><span class="muted">${UI.when(row.at)}</span></div>`).join('') || '<p class="muted">No onboarding history yet.</p>'}
      </article>`);
    const score = root.querySelector('#score-form');
    if (score) score.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(score);
      await UI.api(`/api/clients/${client.id}/scorecard`, { method: 'PUT', body: { target: data.get('target'), achieved: data.get('achieved'), notes: data.get('notes') } });
      UI.toast('Scorecard saved');
      S1.go();
    };
    const slots = root.querySelector('#slot-form');
    if (slots) slots.onsubmit = async (event) => {
      event.preventDefault();
      await UI.api(`/api/clients/${client.id}/slots`, { method: 'PUT', body: { adSlots: new FormData(slots).get('adSlots') } });
      UI.toast('Slide cap saved');
      S1.go();
    };
    const saveCase = (form, section) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        const payload = Object.fromEntries(new FormData(form).entries());
        payload.section = section;
        await UI.api(`/api/clients/${client.id}/case`, { method: 'PUT', body: payload });
        UI.toast('Saved');
        S1.go();
      };
    };
    [['master-form', 'master'], ['org-form', 'organization'], ['bill-form', 'billing'], ['contract-form', 'contract'], ['plan-form', 'plan']].forEach(([id, section]) => {
      const form = root.querySelector(`#${id}`);
      if (form) saveCase(form, section);
    });
    const planRequest = root.querySelector('#plan-request');
    if (planRequest) planRequest.onsubmit = async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(planRequest).entries());
      payload.clientId = client.id;
      payload.kind = 'Plan change';
      await UI.api('/api/client-requests', { method: 'POST', body: payload });
      UI.toast('Plan change sent');
      S1.go();
    };
    root.querySelectorAll('.doc-upload').forEach((form) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        const data = new FormData();
        data.append('key', form.dataset.key);
        if (form.file.files[0]) data.append('file', form.file.files[0]);
        await UI.api(`/api/clients/${client.id}/documents`, { method: 'POST', body: data });
        UI.toast('Document uploaded');
        S1.go();
      };
    });
    UI.bind(root, {
      approve: async () => { await UI.api(`/api/clients/${client.id}/status`, { method: 'PUT', body: { status: 'Approved', notes: 'Documents verified. Portal access can now be issued.' } }); UI.toast('Company approved'); S1.go(); },
      reject: () => UI.openModal({
        title: 'Reject registration',
        html: UI.field('notes', 'Reason', '', { type: 'textarea' }),
        submitLabel: 'Reject',
        onSubmit: async (data) => { await UI.api(`/api/clients/${client.id}/status`, { method: 'PUT', body: { status: 'Rejected', notes: data.get('notes') } }); UI.toast('Registration rejected'); S1.go(); }
      }),
      access: () => UI.openModal({
        title: 'Issue client login',
        html: `${UI.field('name', 'Person name', '', { required: true })}${UI.field('email', 'Email', client.officialMail, { type: 'email', required: true })}${UI.field('title', 'Title', 'Client admin')}${UI.field('password', 'Temporary password', '', { type: 'password', required: true })}${UI.field('plan', 'Subscription plan', (client.planDetail && client.planDetail.id) || 'hr-easy', { select: plans })}`,
        submitLabel: 'Issue access',
        onSubmit: async (data) => { await UI.api(`/api/clients/${client.id}/access`, { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Client login issued'); }
      }),
      'admin-portal': () => UI.openModal({
        title: 'Issue admin portal',
        html: `${UI.field('name', 'Person name', '', { required: true })}${UI.field('email', 'Email', '', { type: 'email', required: true })}${UI.field('phone', 'Phone')}${UI.field('title', 'Title', 'HR admin')}${UI.field('password', 'Temporary password', '', { type: 'password', required: true })}<p class="muted">You start the admin portal. ${admin ? 'The client admin confirms it' : 'The super admin confirms it'} before that person can sign in.</p>`,
        submitLabel: 'Start admin portal',
        onSubmit: async (data) => { await UI.api(`/api/clients/${client.id}/admin-access`, { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast(admin ? 'Waiting for the client admin to confirm' : 'Waiting for the super admin to confirm'); S1.go(); }
      }),
      'confirm-admin': async (node) => {
        await UI.api(`/api/clients/${client.id}/admin-access/${node.dataset.id}`, { method: 'PUT', body: {} });
        UI.toast('Admin portal is active');
        S1.go();
      },
      branch: () => UI.openModal({
        title: 'Add branch',
        html: `${UI.field('name', 'Branch name', '', { required: true })}${UI.field('city', 'City', '', { required: true })}${UI.field('address', 'Address', '', { span: true })}`,
        onSubmit: async (data) => { await UI.api(`/api/clients/${client.id}/branches`, { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Branch added'); S1.go(); }
      }),
      budget: () => UI.openModal({
        title: 'Position budgets',
        wide: true,
        html: `<div class="fields">${client.positionBudgets.concat([{ position: '', budget: '', allocated: '' }]).map((row) => `${UI.field('position', 'Position', row.position)}${UI.field('budget', 'Budget', row.budget, { type: 'number' })}${UI.field('allocated', 'Allocated', row.allocated, { type: 'number' })}`).join('')}</div>`,
        onSubmit: async (data) => {
          const positions = data.getAll('position');
          const budgets = data.getAll('budget');
          const allocated = data.getAll('allocated');
          const positionBudgets = positions.map((position, index) => ({ position, budget: budgets[index], allocated: allocated[index] })).filter((row) => String(row.position).trim());
          await UI.api(`/api/clients/${client.id}/budgets`, { method: 'PUT', body: { positionBudgets } });
          UI.toast('Budgets saved');
          S1.go();
        }
      }),
      doc: async (node) => { await UI.api(`/api/clients/${client.id}/documents/${node.dataset.key}`, { method: 'PUT', body: { verified: node.dataset.verified } }); UI.toast('Document updated'); S1.go(); },
      'verify-stage': async () => { await UI.api(`/api/clients/${client.id}/onboarding`, { method: 'PUT', body: { step: 'verify' } }); UI.toast('Documents marked verified'); S1.go(); },
      'approve-stage': async () => { await UI.api(`/api/clients/${client.id}/onboarding`, { method: 'PUT', body: { step: 'approve' } }); UI.toast('Company approved'); S1.go(); },
      implement: async () => { await UI.api(`/api/clients/${client.id}/onboarding`, { method: 'PUT', body: { step: 'implement', handoverOwner: 'Ravi Menon' } }); UI.toast('Implementation started'); S1.go(); },
      handover: async () => { await UI.api(`/api/clients/${client.id}/onboarding`, { method: 'PUT', body: { step: 'handover', handoverNotes: 'Portal and payroll handed to the company desk.' } }); UI.toast('Handover complete'); S1.go(); },
      close: () => UI.openModal({
        title: 'Close the company',
        html: `${UI.field('reason', 'Reason', '', { type: 'textarea' })}${UI.field('closedOn', 'Closed on', '', { type: 'date' })}`,
        submitLabel: 'Close',
        onSubmit: async (data) => { await UI.api(`/api/clients/${client.id}/onboarding`, { method: 'PUT', body: { step: 'close', reason: data.get('reason'), closedOn: data.get('closedOn') } }); UI.toast('Company closed'); S1.go(); }
      }),
      'plan-yes': async (node) => { await UI.api(`/api/client-requests/${node.dataset.id}`, { method: 'PUT', body: { status: 'Approved' } }); UI.toast('Plan step recorded'); S1.go(); },
      'plan-no': async (node) => { await UI.api(`/api/client-requests/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Plan change rejected'); S1.go(); }
    });
  },

  async join() {
    const admin = S1.user.role === 'admin';
    const companies = S1.ref.companies.filter((company) => company.status === 'Approved');
    const root = mount(`${head('Join employee', 'Create the workforce record. The administrator can issue the portal login from this form.')}
      <form id="join-form" class="card fields">
        ${admin ? UI.field('clientId', 'Company', '', { select: companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}
        ${UI.field('branchId', 'Branch', '', { select: [] })}
        ${UI.field('fullName', 'Full name', '', { required: true })}
        ${UI.field('email', 'Email', '', { type: 'email', required: true })}
        ${UI.field('phone', 'Phone')}
        ${UI.field('emergencyName', 'Emergency contact')}
        ${UI.field('emergencyPhone', 'Emergency number')}
        ${UI.field('department', 'Department', '', { select: S1.ref.departments.map((item) => ({ value: item.name, label: item.name })) })}
        ${UI.field('levelName', 'Designation', '', { select: [] })}
        ${UI.field('roleTitle', 'Role title')}
        ${UI.field('shiftId', 'Shift', '', { select: S1.ref.shifts.map((shift) => ({ value: shift.id, label: `${shift.name} ${shift.start}–${shift.end}` })) })}
        ${UI.field('reportingManager', 'Reporting manager')}
        ${UI.field('hiringSource', 'Hiring source', 'Direct', { select: ['Direct', 'Assigned', 'Sourcing company'].map((item) => ({ value: item, label: item })) })}
        ${UI.field('sourceCompany', 'Assigned / sourcing company')}
        ${UI.field('reputedCompany', 'Reputed company')}
        ${UI.field('joinedOn', 'Joined on', '', { type: 'date' })}
        ${UI.field('basicSalary', 'Basic', '', { type: 'number' })}
        ${UI.field('hra', 'HRA', '', { type: 'number' })}
        ${UI.field('employeePf', 'PF', '', { type: 'number' })}
        ${UI.field('employeeEsic', 'ESIC', '', { type: 'number' })}
        ${UI.field('tds', 'TDS', '', { type: 'number' })}
        ${UI.field('otRate', 'OT rate / hour', '', { type: 'number' })}
        ${UI.field('pfUan', 'PF UAN')}
        ${UI.field('panNumber', 'PAN')}
        ${UI.field('bloodGroup', 'Blood group')}
        ${admin ? '<label class="checkline span-2"><input type="checkbox" name="hasLogin" value="yes"/> Issue portal login</label>' : '<p class="muted span-2">Portal login is issued by the administrator after joining.</p>'}
        ${admin ? UI.field('password', 'Password', '', { type: 'password' }) : ''}
        <label class="field span-2">Photo<input name="photo" type="file" accept=".jpg,.jpeg,.png,.webp"/></label>
        <button class="btn primary span-2" type="submit">Create record</button>
      </form>`);
    const form = root.querySelector('#join-form');
    const fillBranches = () => {
      const companyId = admin ? form.clientId.value : S1.user.clientId;
      const company = S1.ref.companies.find((item) => item.id === companyId);
      form.branchId.innerHTML = (company ? company.branches : []).map((branch) => `<option value="${UI.esc(branch.id)}">${UI.esc(branch.name)}</option>`).join('');
    };
    const fillLevels = () => {
      const department = S1.ref.departments.find((item) => item.name === form.department.value);
      form.levelName.innerHTML = (department ? department.levels : []).map((level) => `<option value="${UI.esc(level)}">${UI.esc(level)}</option>`).join('');
    };
    if (form.clientId) form.clientId.onchange = fillBranches;
    form.department.onchange = fillLevels;
    fillBranches();
    fillLevels();
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const body = Object.fromEntries(data.entries());
      if (!admin) body.clientId = S1.user.clientId;
      body.hasLogin = data.get('hasLogin') === 'yes';
      const file = form.photo.files[0];
      if (file) body.photoUrl = (await UI.upload(file)).url;
      delete body.photo;
      const created = await UI.api('/api/employees', { method: 'POST', body });
      UI.toast(`${created.data.employeeCode} created`);
      location.hash = `#/employee/${created.data.id}`;
    };
  },

  async workforce() {
    const res = await load('/api/employees');
    if (!res) return;
    const rows = res.data.map((person) => `<tr>
      <td><a href="#/employee/${UI.esc(person.id)}"><strong>${UI.esc(person.fullName)}</strong></a><br><span class="muted">${UI.esc(person.employeeCode)} · ${UI.esc(person.applicationNumber)}</span></td>
      <td>${UI.esc(person.companyName)}<br><span class="muted">${UI.esc(person.branchName)}</span></td>
      <td>${UI.esc(person.roleTitle)}<br><span class="muted">${UI.esc(person.department)} · ${UI.esc(person.levelName)}</span></td>
      <td>${UI.esc(person.shiftName)}<br><span class="muted">${UI.esc(person.hiringSource)}</span></td>
      <td>${UI.badge(person.status)}<br><span class="muted">${UI.esc(person.workflow && person.workflow.current ? person.workflow.current : '')}</span></td>
      <td>${UI.badge(person.bgvStatus)}</td><td class="num">${UI.inr(person.pay.net)}</td><td>${person.hasLogin ? 'Yes' : 'No'}</td></tr>`).join('');
    const desk = S1.user.role !== 'employee';
    const root = mount(`${head('Workforce', 'Onboarding, probation, confirmation, movement, and exit continue on each profile.', desk ? `
      <button class="btn" type="button" data-act="dept">Add department</button>
      <button class="btn" type="button" data-act="designation">Add designation</button>
      <button class="btn ghost" type="button" data-act="xlsx">Excel</button>` : '')}
      <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Company</th><th>Designation</th><th>Shift / source</th><th>Process</th><th>BGV</th><th class="num">Net</th><th>Login</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No employees on this desk.</td></tr>'}</tbody></table></div>`);
    UI.bind(root, {
      xlsx: () => UI.download('/api/export/employees?format=xlsx', 's1-employees.xlsx'),
      dept: () => UI.openModal({
        title: 'Add department',
        html: `<div class="fields">${UI.field('employeeId', 'Employee ID', '', { select: res.data.map((person) => ({ value: person.employeeCode, label: `${person.employeeCode} · ${person.fullName}` })) })}${UI.field('department', 'Department', '', { select: [{ value: '', label: 'Type a new name below' }].concat(S1.ref.departments.map((item) => ({ value: item.name, label: item.name }))) })}${UI.field('newDepartment', 'New department name')}</div>`,
        onSubmit: async (data) => {
          const created = await UI.api('/api/departments/assign', { method: 'POST', body: Object.fromEntries(data.entries()) });
          S1.ref = (await UI.api('/api/reference')).data;
          UI.toast(`${created.data.employeeCode} is in ${created.data.department}`);
          S1.go();
        }
      }),
      designation: () => UI.openModal({
        title: 'Designation',
        html: `${UI.field('departmentId', 'Department', '', { select: S1.ref.departments.map((item) => ({ value: item.id, label: item.name })) })}${UI.field('name', 'Designation', '', { required: true })}`,
        onSubmit: async (data) => {
          await UI.api('/api/designations', { method: 'POST', body: Object.fromEntries(data.entries()) });
          S1.ref = (await UI.api('/api/reference')).data;
          UI.toast('Designation added');
        }
      })
    });
  },

  async employee(route) {
    const res = await load(`/api/employees/${route.id}`);
    if (!res) return;
    const person = res.data;
    const admin = S1.user.role === 'admin';
    const canEdit = admin || S1.user.role === 'client';
    const docs = person.documents || {};
    const exitCase = person.exitCase || {};
    const steps = (person.workflow && person.workflow.steps) || [];
    const card = (label, file) => `<article><span class="muted">${label}</span><strong>${UI.esc(file && file.name ? file.name : 'Not uploaded')}</strong>${file && file.url ? `<p><a href="${UI.esc(file.url)}" target="_blank" rel="noreferrer">Open</a></p>` : ''}</article>`;
    const company = S1.ref.companies.find((item) => item.id === person.clientId) || { branches: [] };
    const root = mount(`
      <div class="detail-hero"><div style="display:flex;gap:14px;align-items:center">${person.photoUrl ? `<img src="${UI.esc(person.photoUrl)}" alt="" style="width:64px;height:64px;border-radius:50%;object-fit:cover"/>` : `<span class="avatar-lg">${UI.esc(UI.initials(person.fullName))}</span>`}<div>
        <p class="kicker">${UI.esc(person.employeeCode)} · ${UI.esc(person.applicationNumber)}</p>
        <h1>${UI.esc(person.fullName)}</h1>
        <p class="muted">${UI.esc(person.roleTitle)} · ${UI.esc(person.department)} · ${UI.esc(person.levelName)}</p>
      </div></div><div class="page-actions">${UI.badge(person.status)} ${UI.badge(person.bgvStatus)} ${person.hasLogin ? UI.badge('Login on') : UI.badge('No login')}</div></div>
      <div class="grid-3">
        <article class="card"><h3>Master data</h3><p>${UI.esc(person.companyName)}<br>${UI.esc(person.branchName)}, ${UI.esc(person.branchCity)}</p><p class="muted">${UI.esc(person.shiftName)} ${UI.esc(person.shiftStart)}–${UI.esc(person.shiftEnd)}<br>Reports to ${UI.esc(person.reportingManager || '—')}</p><p>Hiring ${UI.esc(person.hiringSource)}${person.sourceCompany ? ` · ${UI.esc(person.sourceCompany)}` : ''}</p>${canEdit ? '<button class="btn small" type="button" data-act="master">Edit master data</button>' : ''}</article>
        <article class="card"><h3>Profile</h3><p>${UI.esc(person.email)}<br>${UI.esc(person.phone || 'No phone')}</p><p class="muted">Emergency ${UI.esc(person.emergencyName || '—')} · ${UI.esc(person.emergencyPhone || '—')}</p><p>Joined ${UI.esc(person.joinedOn)}</p></article>
        <article class="card"><h3>Statutory</h3><p>UAN ${UI.esc(person.statutory.pfUan || '—')}<br>ESIC ${UI.esc(person.statutory.esicNumber || '—')}<br>PAN ${UI.esc(person.statutory.panNumber || '—')}<br>Blood ${UI.esc(person.statutory.bloodGroup || '—')}</p><p><strong>${UI.inr(person.pay.net)}</strong> net</p></article>
      </div>
      <div class="page-actions" style="margin:14px 0">
        <button class="btn" type="button" data-act="payslip">Payslip</button>
        ${canEdit ? '<button class="btn ghost" type="button" data-act="offer">Offer letter</button><button class="btn ghost" type="button" data-act="appointment">Appointment</button><button class="btn ghost" type="button" data-act="idcard">ID card</button><button class="btn ghost" type="button" data-act="experience">Experience</button><button class="btn ghost" type="button" data-act="salarycert">Salary certificate</button><button class="btn ghost" type="button" data-act="relieving">Relieving letter</button>' : '<a class="btn ghost" href="#/documents">Ask HR for a letter</a>'}
        ${admin ? '<button class="btn" type="button" data-act="pay">Payroll card</button><button class="btn ghost" type="button" data-act="login">Portal access</button>' : ''}
        ${canEdit ? '<button class="btn ghost" type="button" data-act="warn">Add warning</button>' : ''}
      </div>
      <div class="grid-2">
        <article class="card"><div class="card-head"><h3>Employee documents</h3>${canEdit ? '<button class="btn small" type="button" data-act="upload">Upload</button>' : ''}</div><div class="doc-grid">${card('Aadhaar', docs.aadhaar)}${card('PAN', docs.pan)}${card('Marksheet', docs.marksheet)}${card('Bank', docs.bank)}${card('Offer', docs.offer)}${card('Appointment', docs.appointment)}${card('Relieving', docs.relieving)}${(docs.extra || []).map((file) => card('Other', file)).join('')}</div></article>
        <article class="card"><h3>Warnings</h3>${person.warnings.length ? person.warnings.map((warning) => `<div class="flag-row"><span><span class="flag red"></span>${UI.esc(warning.message)}</span><span class="muted">${UI.when(warning.at)}</span></div>`).join('') : '<p class="muted">No warnings on this record.</p>'}</article>
      </div>
      <article class="card" style="margin-top:12px"><div class="card-head"><h3>Employment process</h3><span>Onboarding through exit</span></div>
        ${steps.map((step) => `<div class="flag-row"><span><strong>${UI.esc(step.name)}</strong><br><span class="muted">${UI.esc(step.date || 'Not dated')}${step.by ? ` · ${UI.esc(step.by)}` : ''} ${UI.esc(step.notes || '')}${step.fromValue || step.toValue ? ` · ${UI.esc(step.fromValue || '')}${step.toValue ? ` → ${UI.esc(step.toValue)}` : ''}` : ''}</span></span><span>${UI.badge(step.status)}${canEdit ? ` <button class="btn small" type="button" data-act="step" data-step="${UI.esc(step.name)}">Update</button>` : ''}</span></div>`).join('') || '<p class="muted">The process appears after joining.</p>'}
      </article>
      ${canEdit ? `<form id="exit-form" class="card stack" style="margin-top:12px"><h3>Exit and full-and-final</h3><div class="fields">
        ${UI.field('lastWorkingDay', 'Last working day', exitCase.lastWorkingDay || '', { type: 'date' })}
        ${UI.field('reason', 'Reason for leaving', exitCase.reason || '', { required: true })}
        ${UI.field('noticeServed', 'Notice served', exitCase.noticeServed || 'No', { select: ['Yes', 'No'].map((item) => ({ value: item, label: item })) })}
        ${UI.field('assetClearance', 'Asset clearance', exitCase.assetClearance || 'Pending', { select: ['Pending', 'Done'].map((item) => ({ value: item, label: item })) })}
        ${UI.field('documentHandover', 'Document handover', exitCase.documentHandover || 'Pending', { select: ['Pending', 'Done'].map((item) => ({ value: item, label: item })) })}
        ${UI.field('payrollClearance', 'Payroll clearance', exitCase.payrollClearance || 'Pending', { select: ['Pending', 'Done'].map((item) => ({ value: item, label: item })) })}
        ${UI.field('fnfStatus', 'F&F status', exitCase.fnfStatus || 'Draft', { select: ['Draft', 'In review', 'Settled'].map((item) => ({ value: item, label: item })) })}
        ${UI.field('notes', 'Settlement notes', exitCase.notes || '', { type: 'textarea' })}
      </div><button class="btn primary" type="submit">Save exit</button></form>` : `<article class="card" style="margin-top:12px"><h3>Exit and full-and-final</h3><p>${exitCase.reason ? `${UI.esc(exitCase.reason)} · last day ${UI.esc(exitCase.lastWorkingDay || '—')} · ${UI.badge(exitCase.fnfStatus || 'Draft')}` : 'No exit case on this record.'}</p></article>`}<div id="dossier"></div>`);
    const open = (kind) => UI.openDoc(`/api/documents/${kind}/${person.id}`);
    const dossier = root.querySelector('#dossier');
    if (dossier && S1.user.role !== 'employee') {
      const pack = await load(`/api/employees/${person.id}/360`);
      if (pack) {
        const file = pack.data;
        const line = (rows, render) => rows.length ? rows.slice(0, 5).map(render).join('') : '<p class="muted">None on file.</p>';
        dossier.innerHTML = `<article class="card" style="margin-top:12px"><div class="card-head"><h3>Employee 360</h3><span>${UI.esc(file.key)} · ${UI.esc(file.applicationNumber)}</span></div>
          <div class="grid-2">
            <div><h3>Attendance</h3>${line(file.attendance, (row) => `<div class="flag-row"><span>${UI.esc(row.workDate)} · ${UI.esc(row.mode)}</span>${UI.badge(row.status)}</div>`)}</div>
            <div><h3>Leave</h3>${line(file.leaves, (row) => `<div class="flag-row"><span>${UI.esc(row.leaveType)} · ${UI.esc(row.fromDate)}</span>${UI.badge(row.status)}</div>`)}</div>
            <div><h3>Payroll</h3><p>Net ${UI.inr(file.employee.pay.net)} · gross ${UI.inr(file.employee.pay.earnTotal)}</p></div>
            <div><h3>Documents</h3><p>${['aadhaar', 'pan', 'marksheet', 'bank', 'offer', 'appointment'].filter((key) => file.employee.documents[key] && file.employee.documents[key].name).join(', ') || 'No identity papers uploaded.'}</p></div>
            <div><h3>Assets</h3>${line(file.assets, (row) => `<div class="flag-row"><span>${UI.esc(row.name)}</span>${UI.badge(row.status)}</div>`)}</div>
            <div><h3>Tasks</h3>${line(file.tasks, (row) => `<div class="flag-row"><span>${UI.esc(row.title)}</span>${UI.badge(row.status)}</div>`)}</div>
            <div><h3>Performance</h3>${line(file.goals, (row) => `<div class="flag-row"><span>${UI.esc(row.title)}</span><span>${row.attainment}%</span></div>`)}${line(file.reviews, (row) => `<div class="flag-row"><span>${UI.esc(row.period)} · ${row.rating}/5</span>${UI.badge(row.status)}</div>`)}</div>
            <div><h3>Reimbursements</h3>${line(file.claims, (row) => `<div class="flag-row"><span>${UI.esc(row.category)} · ${UI.inr(row.amount)}</span>${UI.badge(row.status)}</div>`)}</div>
          </div></article>`;
      }
    }
    const exitForm = root.querySelector('#exit-form');
    if (exitForm) exitForm.onsubmit = async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(exitForm).entries());
      data.noticeServed = data.noticeServed === 'Yes' ? 'yes' : 'no';
      await UI.api(`/api/employees/${person.id}/exit`, { method: 'PUT', body: data });
      UI.toast('Exit case saved');
      S1.go();
    };
    UI.bind(root, {
      payslip: () => open('payslip'), offer: () => open('offer'), appointment: () => open('appointment'), idcard: () => open('idcard'), experience: () => open('experience'), salarycert: () => open('salarycert'), relieving: () => open('relieving'),
      master: () => UI.openModal({
        title: 'Master data',
        wide: true,
        html: `<div class="fields">
          ${UI.field('branchId', 'Branch', person.branchId, { select: company.branches.map((branch) => ({ value: branch.id, label: branch.name })) })}
          ${UI.field('department', 'Department', person.department, { select: S1.ref.departments.map((item) => ({ value: item.name, label: item.name })) })}
          ${UI.field('levelName', 'Designation', person.levelName, { select: [] })}
          ${UI.field('roleTitle', 'Role title', person.roleTitle)}
          ${UI.field('shiftId', 'Shift', person.shiftId, { select: S1.ref.shifts.map((shift) => ({ value: shift.id, label: `${shift.name} ${shift.start}–${shift.end}` })) })}
          ${UI.field('reportingManager', 'Reporting manager', person.reportingManager)}
          ${UI.field('phone', 'Phone', person.phone)}
          ${UI.field('emergencyName', 'Emergency contact', person.emergencyName)}
          ${UI.field('emergencyPhone', 'Emergency number', person.emergencyPhone)}
          ${UI.field('hiringSource', 'Hiring source', person.hiringSource, { select: ['Direct', 'Assigned', 'Sourcing company'].map((item) => ({ value: item, label: item })) })}
          ${UI.field('sourceCompany', 'Assigned / sourcing company', person.sourceCompany)}
          ${UI.field('bgvStatus', 'BGV', person.bgvStatus, { select: ['Not started', 'Processing', 'Positive', 'Negative'].map((item) => ({ value: item, label: item })) })}
          ${UI.field('pfUan', 'PF UAN', person.statutory.pfUan || '')}
          ${UI.field('esicNumber', 'ESIC', person.statutory.esicNumber || '')}
          ${UI.field('panNumber', 'PAN', person.statutory.panNumber || '')}
          ${UI.field('bloodGroup', 'Blood group', person.statutory.bloodGroup || '')}
        </div>`,
        onReady: (form) => {
          const fillLevels = () => {
            const department = S1.ref.departments.find((item) => item.name === form.department.value);
            const levels = department ? department.levels : [];
            form.levelName.innerHTML = levels.map((level) => `<option value="${UI.esc(level)}" ${level === person.levelName ? 'selected' : ''}>${UI.esc(level)}</option>`).join('');
          };
          form.department.onchange = fillLevels;
          fillLevels();
        },
        onSubmit: async (data) => {
          const body = Object.fromEntries(data.entries());
          body.statutory = { pfUan: body.pfUan, esicNumber: body.esicNumber, panNumber: body.panNumber, bloodGroup: body.bloodGroup };
          await UI.api(`/api/employees/${person.id}`, { method: 'PUT', body });
          UI.toast('Master data saved');
          S1.go();
        }
      }),
      upload: () => UI.openModal({
        title: 'Employee document',
        html: `${UI.field('kind', 'Type', 'aadhaar', { select: ['aadhaar', 'pan', 'marksheet', 'bank', 'offer', 'appointment', 'relieving', 'other'].map((item) => ({ value: item, label: item })) })}${UI.field('name', 'Document name')}<label class="field">File<input name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx"/></label>`,
        onSubmit: async (data, form) => {
          const file = form.file.files[0];
          if (!file) throw new Error('Choose a file');
          const uploaded = await UI.upload(file);
          await UI.api(`/api/employees/${person.id}/documents`, { method: 'POST', body: { kind: data.get('kind'), name: data.get('name') || file.name, url: uploaded.url } });
          UI.toast('Document saved');
          S1.go();
        }
      }),
      step: (node) => {
        const step = steps.find((item) => item.name === node.dataset.step) || { name: node.dataset.step, status: 'In progress' };
        UI.openModal({
          title: step.name,
          html: `${UI.field('status', 'Status', step.status || 'In progress', { select: ['Pending', 'In progress', 'Completed'].map((item) => ({ value: item, label: item })) })}${UI.field('date', 'Date', step.date || '', { type: 'date' })}${step.name === 'Transfer' ? UI.field('branchId', 'Move to branch', person.branchId, { select: company.branches.map((branch) => ({ value: branch.id, label: branch.name })) }) : ''}${UI.field('fromValue', 'From', step.fromValue || '')}${UI.field('toValue', 'To', step.name === 'Promotion' ? person.roleTitle : (step.toValue || ''))}${UI.field('notes', 'Notes', step.notes || '', { type: 'textarea' })}`,
          submitLabel: 'Save step',
          onSubmit: async (data) => {
            const body = Object.fromEntries(data.entries());
            body.step = step.name;
            await UI.api(`/api/employees/${person.id}/workflow`, { method: 'PUT', body });
            UI.toast(`${step.name} updated`);
            S1.go();
          }
        });
      },
      warn: () => UI.openModal({
        title: 'Warning',
        html: UI.field('message', 'What happened', '', { type: 'textarea' }),
        submitLabel: 'Add warning',
        onSubmit: async (data) => { await UI.api(`/api/employees/${person.id}/warnings`, { method: 'POST', body: { message: data.get('message') } }); UI.toast('Warning added'); S1.go(); }
      }),
      login: () => UI.openModal({
        title: 'Portal access',
        html: `<label class="checkline"><input type="checkbox" name="hasLogin" value="yes" ${person.hasLogin ? 'checked' : ''}/> Allow this employee to sign in</label>${UI.field('password', 'New password', '', { type: 'password' })}`,
        onSubmit: async (data) => { await UI.api(`/api/employees/${person.id}/login`, { method: 'PUT', body: { hasLogin: data.get('hasLogin') === 'yes', password: data.get('password') } }); UI.toast('Portal access updated'); S1.go(); }
      }),
      pay: () => UI.openModal({
        title: 'Payroll components',
        wide: true,
        html: `<div class="fields">${S1.ref.payrollCatalog.map((group) => `<h3 class="span-2">${UI.esc(group.title)}</h3>${group.fields.map(([key, label]) => UI.field(key, label, person.payroll[key] ?? '', { type: 'number' })).join('')}`).join('')}</div>`,
        submitLabel: 'Save payroll',
        onSubmit: async (data, form) => {
          const body = {};
          form.querySelectorAll('input[type=number]').forEach((input) => { body[input.name] = input.value === '' ? 0 : Number(input.value); });
          await UI.api(`/api/employees/${person.id}/payroll`, { method: 'PUT', body });
          UI.toast('Payroll saved');
          S1.go();
        }
      })
    });
  },

  async organization() {
    const tab = S1.memory.orgTab || 'chart';
    const tabs = ['chart', 'teams', 'assign', 'access', 'policies', 'review'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('Organisation', 'Departments, teams, reporting lines, shifts, portal access, and the policies that the administrator reviews.')}<div class="tabs">${tabs}</div><div id="org-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.orgTab = button.dataset.tab; Pages.organization(); }; });
    const body = root.querySelector('#org-body');
    const res = await load('/api/organization');
    if (!res) return;
    const { departments, people, teams, policies, reviews, roles, portals } = res.data;
    const admin = S1.user.role === 'admin';
    const personOptions = people.map((person) => ({ value: person.id, label: `${person.fullName} · ${person.companyName}` }));
    if (tab === 'chart') {
      const roots = people.filter((person) => !people.some((other) => other.fullName === person.reportingManager));
      const draw = (person) => {
        const reports = people.filter((other) => other.reportingManager === person.fullName);
        const face = person.photoUrl
          ? `<img src="${UI.esc(person.photoUrl)}" alt=""/>`
          : `<span class="avatar">${UI.esc(UI.initials(person.fullName))}</span>`;
        return `<li><div class="org-person">${face}<span><strong><a href="#/employee/${UI.esc(person.id)}">${UI.esc(person.fullName)}</a></strong><br><span class="muted">${UI.esc(person.deskRole || person.roleTitle)} · ${UI.esc(person.department)} · ${UI.esc(person.branchName)}</span></span></div>${reports.length ? `<ul>${reports.map(draw).join('')}</ul>` : ''}</li>`;
      };
      body.innerHTML = `<div class="grid-2"><article class="card"><h3>Reporting chart</h3><ul class="org-chart">${roots.map(draw).join('') || '<li>No reporting lines yet.</li>'}</ul></article>
        <article class="card"><h3>Departments</h3>${departments.map((department) => `<div class="flag-row"><span><strong>${UI.esc(department.name)}</strong><br><span class="muted">${department.levels.map((level) => UI.esc(level)).join(' · ') || 'No designations'}</span></span><span>${department.headcount}</span></div>`).join('') || '<p class="muted">Add a department from Workforce.</p>'}</article></div>`;
    }
    if (tab === 'teams') {
      body.innerHTML = `<form id="team-form" class="fields" style="margin-bottom:12px">${admin ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('name', 'Team', '', { required: true })}${UI.field('department', 'Department')}${UI.field('leadId', 'Lead', '', { select: [{ value: '', label: 'No lead yet' }].concat(personOptions) })}<button class="btn span-2" type="submit">Form team</button></form>
        ${teams.map((team) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(team.name)}</h3>${UI.badge(team.status)}</div><p>Lead ${UI.esc(team.leadName || '—')} · ${UI.esc(team.department || 'No department')} · ${UI.esc(team.branchName || 'No branch')}</p><p class="muted">${team.members.map((member) => UI.esc(member.fullName)).join(', ') || 'No members yet'}</p></article>`).join('') || ''}`;
      body.querySelector('#team-form').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/teams', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Team formed');
        S1.go();
      };
    }
    if (tab === 'assign') {
      body.innerHTML = `<form id="assign-org" class="fields">${UI.field('employeeId', 'Employee', '', { select: personOptions })}${UI.field('department', 'Department', '', { select: [{ value: '', label: 'Keep' }].concat(departments.map((department) => ({ value: department.name, label: department.name }))) })}${UI.field('levelName', 'Designation')}${UI.field('reportingManager', 'Reports to', '', { select: [{ value: '', label: 'Keep' }].concat(people.map((person) => ({ value: person.fullName, label: person.fullName }))) })}${UI.field('teamId', 'Team', '', { select: [{ value: '', label: 'Keep' }].concat(teams.map((team) => ({ value: team.id, label: team.name }))) })}${UI.field('shiftId', 'Shift', '', { select: [{ value: '', label: 'Keep' }].concat(S1.ref.shifts.map((shift) => ({ value: shift.id, label: shift.name }))) })}${UI.field('branchId', 'Branch', '', { select: [{ value: '', label: 'Keep' }].concat((S1.ref.companies.find((company) => company.id === (admin ? '' : S1.user.clientId)) || { branches: S1.ref.companies.flatMap((company) => company.branches) }).branches.map((branch) => ({ value: branch.id, label: branch.name }))) })}${UI.field('deskRole', 'Company role')}<button class="btn span-2" type="submit">Assign</button></form>
        <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Person</th><th>Reports to</th><th>Team</th><th>Shift</th><th>Branch</th><th>Role</th></tr></thead><tbody>
          ${people.map((person) => `<tr><td>${UI.esc(person.fullName)}</td><td>${UI.esc(person.reportingManager || '—')}</td><td>${UI.esc((teams.find((team) => team.id === person.teamId) || {}).name || '—')}</td><td>${UI.esc(person.shiftName)}</td><td>${UI.esc(person.branchName)}</td><td>${UI.esc(person.deskRole || person.roleTitle)}</td></tr>`).join('')}
        </tbody></table></div>`;
      body.querySelector('#assign-org').onsubmit = async (event) => {
        event.preventDefault();
        const payload = Object.fromEntries(new FormData(event.target).entries());
        Object.keys(payload).forEach((key) => { if (!payload[key]) delete payload[key]; });
        await UI.api('/api/organization/assign', { method: 'POST', body: payload });
        UI.toast('Assignment saved');
        S1.go();
      };
    }
    if (tab === 'access') {
      body.innerHTML = `<article class="card" style="margin-bottom:12px"><h3>Portal access</h3>${portals.map((role) => `<div class="flag-row"><span><strong>${UI.esc(role.name)}</strong><br><span class="muted">${UI.esc(role.access)}</span></span></div>`).join('')}</article>
        <article class="card" style="margin-bottom:12px"><h3>Company roles</h3><form id="role-form" class="fields">${admin ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('name', 'Role')}${UI.field('permissions', 'Permissions', 'people, attendance, hiring')}<button class="btn span-2" type="submit">Save role</button></form>
          ${roles.map((role) => `<div class="flag-row"><span><strong>${UI.esc(role.name)}</strong><br><span class="muted">${role.permissions.map((item) => UI.esc(item)).join(', ')}</span></span></div>`).join('') || ''}
        </article>
        <div class="table-wrap"><table><thead><tr><th>Person</th><th>Login</th><th>Role</th></tr></thead><tbody>${people.map((person) => `<tr><td>${UI.esc(person.fullName)}</td><td>${person.hasLogin ? 'Issued' : 'No login'}</td><td>${UI.esc(person.deskRole || '—')}</td></tr>`).join('')}</tbody></table></div>`;
      body.querySelector('#role-form').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/org-roles', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Role saved');
        S1.go();
      };
    }
    if (tab === 'policies') {
      body.innerHTML = `<form id="policy-form" class="fields" style="margin-bottom:12px">${admin ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('name', 'Policy', '', { required: true })}${UI.field('detail', 'Rule', '', { type: 'textarea' })}<button class="btn span-2" type="submit">${admin ? 'Publish policy' : 'Send for approval'}</button></form>
        ${policies.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.name)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.detail)}</p>${admin && row.status === 'Pending admin' ? `<button class="btn small" type="button" data-act="yes" data-id="${row.id}">Activate</button> <button class="btn small danger" type="button" data-act="no" data-id="${row.id}">Reject</button>` : ''}</article>`).join('') || ''}`;
      body.querySelector('#policy-form').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/org-policies', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Policy saved');
        S1.go();
      };
      UI.bind(body, {
        yes: async (node) => { await UI.api(`/api/org-policies/${node.dataset.id}`, { method: 'PUT', body: { status: 'Active' } }); UI.toast('Policy active'); S1.go(); },
        no: async (node) => { await UI.api(`/api/org-policies/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Policy rejected'); S1.go(); }
      });
    }
    if (tab === 'review') {
      body.innerHTML = `${admin ? `<form id="review-form" class="fields" style="margin-bottom:12px">${UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) })}${UI.field('period', 'Period', '2026-Q4')}${UI.field('rating', 'Rating', 4, { type: 'number' })}${UI.field('notes', 'Review', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Record review</button></form>` : '<p class="muted">The administrator records the organisation review.</p>'}
        ${reviews.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.period)} · ${UI.esc(row.companyName)}</h3>${UI.badge(row.status)}</div><p>Rating ${row.rating}/5</p><p class="muted">${UI.esc(row.notes)}</p></article>`).join('') || ''}`;
      const form = body.querySelector('#review-form');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/org-reviews', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Review recorded');
        S1.go();
      };
    }
  },

  async places() {
    const tab = S1.memory.placeTab || 'places';
    const tabs = ['places', 'people', 'attendance', 'rules', 'requests'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('Locations', 'Keep every branch, office, site, unit, and floor. People, attendance, leave caps, and location allowance follow the place.')}<div class="tabs">${tabs}</div><div id="place-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.placeTab = button.dataset.tab; Pages.places(); }; });
    const body = root.querySelector('#place-body');
    const canDesk = S1.user.role !== 'employee';
    const [places, people, rules] = await Promise.all([
      load('/api/locations'),
      canDesk ? load('/api/employees') : Promise.resolve({ data: [] }),
      load('/api/location-rules')
    ]);
    if (!places || !people || !rules) return;
    const kinds = ['Office', 'Site', 'Unit', 'Floor'].map((item) => ({ value: item, label: item }));
    const branches = [];
    places.data.forEach((place) => { if (!branches.some((branch) => branch.id === place.branchId)) branches.push({ id: place.branchId, name: place.branchName }); });
    if (canDesk) {
      const companies = S1.user.role === 'admin' ? S1.ref.companies : S1.ref.companies.filter((company) => company.id === S1.user.clientId);
      companies.forEach((company) => (company.branches || []).forEach((branch) => {
        if (!branches.some((item) => item.id === branch.id)) branches.push({ id: branch.id, name: branch.name });
      }));
    }
    const branchOptions = branches.map((branch) => ({ value: branch.id, label: branch.name }));
    const placeOptions = places.data.map((place) => ({ value: place.id, label: `${place.branchName} · ${place.kind} · ${place.name}` }));
    if (tab === 'places') {
      body.innerHTML = `${canDesk ? `<form id="place-form" class="fields" style="margin-bottom:12px">${UI.field('branchId', 'Branch', '', { select: branchOptions })}${UI.field('kind', 'Kind', 'Office', { select: kinds })}${UI.field('parentId', 'Parent place', '', { select: [{ value: '', label: 'None, for an office or site' }].concat(placeOptions) })}${UI.field('name', 'Name', '', { required: true })}${UI.field('code', 'Code')}${UI.field('address', 'Address')}<button class="btn span-2" type="submit">Add place</button></form>` : '<p class="muted">You can see the places on your company and ask to move.</p>'}
        <div class="page-actions" style="margin-bottom:12px"><button class="btn ghost" type="button" data-act="xlsx">Excel</button></div>
        <div class="table-wrap"><table><thead><tr><th>Branch</th><th>Kind</th><th>Place</th><th>Under</th><th>Code</th></tr></thead><tbody>
          ${places.data.map((place) => `<tr><td>${UI.esc(place.branchName)}</td><td>${UI.esc(place.kind)}</td><td><strong>${UI.esc(place.name)}</strong><br><span class="muted">${UI.esc(place.address)}</span></td><td>${UI.esc(place.parentName || '—')}</td><td>${UI.esc(place.code || '—')}</td></tr>`).join('') || '<tr><td colspan="5">No places yet.</td></tr>'}
        </tbody></table></div>`;
      const form = body.querySelector('#place-form');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/locations', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Place added');
        S1.go();
      };
      UI.bind(body, { xlsx: () => UI.download('/api/export/locations?format=xlsx', 's1-locations.xlsx') });
    }
    if (tab === 'people') {
      const rows = canDesk ? people.data : [];
      const mine = canDesk ? null : await load(`/api/employees/${S1.user.employeeId}`);
      if (!canDesk && !mine) return;
      const list = canDesk ? rows : [mine.data];
      body.innerHTML = `${canDesk ? `<form id="assign-form" class="fields" style="margin-bottom:12px">${UI.field('employeeId', 'Employee', '', { select: people.data.map((person) => ({ value: person.id, label: person.fullName })) })}${UI.field('locationId', 'Place', '', { select: placeOptions })}<button class="btn span-2" type="submit">Assign</button></form>` : ''}
        <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Branch</th><th>Place</th><th>Role</th></tr></thead><tbody>
          ${list.map((person) => `<tr><td>${UI.esc(person.fullName)}</td><td>${UI.esc(person.branchName)}</td><td>${person.locationName ? `${UI.esc(person.locationKind)} · ${UI.esc(person.locationName)}` : '—'}</td><td>${UI.esc(person.roleTitle)}</td></tr>`).join('') || '<tr><td colspan="4">No people on this desk.</td></tr>'}
        </tbody></table></div>`;
      const form = body.querySelector('#assign-form');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/locations/assign', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Person assigned');
        S1.go();
      };
    }
    if (tab === 'attendance') {
      const placeId = S1.memory.placeAttendance || (places.data[0] && places.data[0].id) || '';
      const rows = placeId ? await load(`/api/attendance?locationId=${encodeURIComponent(placeId)}`) : { data: [] };
      if (!rows) return;
      body.innerHTML = `<label class="field">Place<select id="place-attendance">${placeOptions.map((item) => `<option value="${UI.esc(item.value)}" ${item.value === placeId ? 'selected' : ''}>${UI.esc(item.label)}</option>`).join('')}</select></label>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>In</th><th>Out</th><th>Status</th></tr></thead><tbody>
          ${rows.data.map((row) => `<tr><td>${UI.esc(row.workDate)}</td><td>${UI.esc(row.employeeName)}</td><td>${UI.clock(row.inTime)}</td><td>${UI.clock(row.outTime)}</td><td>${UI.badge(row.status)}</td></tr>`).join('') || '<tr><td colspan="5">No attendance at this place.</td></tr>'}
        </tbody></table></div>`;
      body.querySelector('#place-attendance').onchange = (event) => { S1.memory.placeAttendance = event.target.value; Pages.places(); };
    }
    if (tab === 'rules') {
      body.innerHTML = `${canDesk ? `<form id="rule-form" class="fields" style="margin-bottom:12px">${UI.field('locationId', 'Place', '', { select: placeOptions })}${UI.field('kind', 'Rule', 'Leave', { select: [{ value: 'Leave', label: 'Leave' }, { value: 'Payroll', label: 'Payroll' }] })}${UI.field('leaveType', 'Leave type', 'Casual')}${UI.field('yearlyQuota', 'Yearly days', 12, { type: 'number' })}${UI.field('monthlyAccrual', 'Monthly accrual', 1, { type: 'number' })}${UI.field('allowance', 'Location allowance', 0, { type: 'number' })}${UI.field('notes', 'Notes', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Save rule</button></form>` : '<p class="muted">These rules apply to the place, and to a unit or floor under it.</p>'}
        <div class="table-wrap"><table><thead><tr><th>Place</th><th>Rule</th><th>Leave</th><th>Quota</th><th>Allowance</th><th>Notes</th></tr></thead><tbody>
          ${rules.data.map((row) => `<tr><td>${UI.esc(row.branchName)} · ${UI.esc(row.locationName)}</td><td>${UI.esc(row.kind)}</td><td>${UI.esc(row.leaveType || '—')}</td><td>${row.yearlyQuota || '—'}</td><td>${row.allowance ? UI.inr(row.allowance) : '—'}</td><td>${UI.esc(row.notes)}</td></tr>`).join('') || '<tr><td colspan="6">No location rules yet.</td></tr>'}
        </tbody></table></div>`;
      const form = body.querySelector('#rule-form');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/location-rules', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Rule saved');
        S1.go();
      };
    }
    if (tab === 'requests') {
      const requests = await load('/api/location-requests');
      if (!requests) return;
      body.innerHTML = `<form id="place-request" class="fields" style="margin-bottom:12px">${UI.field('action', 'Request', 'Assign', { select: canDesk ? [{ value: 'Assign', label: 'Move a person' }, { value: 'Open', label: 'Open a place' }] : [{ value: 'Assign', label: 'Move me' }] })}${canDesk ? UI.field('employeeId', 'Employee', '', { select: [{ value: '', label: 'Not needed to open a place' }].concat(people.data.map((person) => ({ value: person.id, label: person.fullName }))) }) : ''}${UI.field('locationId', 'Existing place', '', { select: [{ value: '', label: 'Not needed to open a place' }].concat(placeOptions) })}${canDesk ? UI.field('branchId', 'Branch for a new place', '', { select: [{ value: '', label: 'Not needed for a move' }].concat(branchOptions) }) : ''}${canDesk ? UI.field('kind', 'Kind', 'Site', { select: kinds }) : ''}${canDesk ? UI.field('placeName', 'New place name') : ''}${UI.field('detail', 'Why', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Send for approval</button></form>
        ${requests.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.action)} · ${UI.esc(row.placeName || row.locationName)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.applicationNumber)} · ${UI.esc(row.employeeName || row.raisedBy)} · ${UI.esc(row.kind)}</p><p class="muted">${UI.esc(row.detail)}</p></article>`).join('') || ''}`;
      body.querySelector('#place-request').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/location-requests', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Request sent');
        S1.go();
      };
    }
  },

  async attendance() {
    const isEmp = S1.user.role === 'employee';
    const isAdmin = S1.user.role === 'admin';
    const isClient = S1.user.role === 'client';
    const tab = S1.memory.attTab || (isEmp ? 'punch' : 'register');

    /* ═════════════════════════════════════════════════════════════════
       EMPLOYEE DESK ATTENDANCE
    ═════════════════════════════════════════════════════════════════ */
    if (isEmp) {
      const month = S1.memory.attMonth || new Date().toISOString().slice(0, 7);
      const [res, holidays, sheet, roster, rules, policies, board] = await Promise.all([
        load('/api/attendance'), load('/api/holidays'), load(`/api/attendance/timesheet?month=${month}`),
        load(`/api/roster?from=${month}-01&to=${month}-31`), load('/api/attendance/rules'), load('/api/leave-policies'), load('/api/leave-accrual')
      ]);
      if (!res || !holidays || !sheet || !roster || !rules || !policies || !board) return;
      const rule = rules.data[0];
      const mine = (board.data && board.data[0]) || { types: [] };
      const todayDate = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
      const punch = res.data.find((r) => r.workDate === todayDate);
      const punchedIn = punch && punch.inTime && !punch.outTime;
      const punchedOut = punch && punch.outTime;

      const empTabs = [
        ['punch', '⏱ Attendance'],
        ['history', '📋 My Record'],
        ['timesheet', '📊 Timesheet'],
        ['leave', '🌿 Leave & Holidays']
      ].map(([t, label]) =>
        `<button class="att-tab-btn ${tab === t ? 'on' : ''}" type="button" data-att-tab="${t}">${label}</button>`
      ).join('');

      const root = mount(`${head('My Attendance', 'Punch in/out manually or scan your QR code. View live duty status and timesheet.')}
        <div class="att-tabs-nav">${empTabs}</div>
        <div id="att-body"></div>`);

      root.querySelectorAll('[data-att-tab]').forEach((btn) => {
        btn.onclick = () => { S1.memory.attTab = btn.dataset.attTab; Pages.attendance(); };
      });
      const body = root.querySelector('#att-body');

      if (tab === 'punch') {
        const statusClass = punchedIn ? 'punched-in' : (punchedOut ? 'punched-out' : '');
        const statusText = punchedIn ? '● On duty' : (punchedOut ? '✓ Done for today' : '○ Not punched yet');

        body.innerHTML = `
          <div class="att-hero">
            <div>
              <div class="att-date" id="att-date-live"></div>
              <div class="att-clock" id="att-clock-live"></div>
              <div class="att-shift">${UI.esc(S1.user.companyName)} · ${punch ? UI.esc(punch.shiftName) : 'General Shift'}</div>
              <div class="att-status">
                <span class="att-status-pill ${statusClass}">${statusText}</span>
              </div>
              ${punch && punch.inTime ? `<div class="att-time-row" style="margin-top:8px;">Punched in at: <strong>${UI.clock(punch.inTime)}</strong>${punch.outTime ? ` · Punched out at: <strong>${UI.clock(punch.outTime)}</strong>` : ''}</div>` : ''}
              ${punch && punch.mode ? `<div class="att-time-row">Punch mode: <strong>${UI.esc(punch.mode)}</strong></div>` : ''}
              ${punch && punch.penalty ? `<div class="att-time-row" style="color:#fca5a5;">Penalty: ${UI.inr(punch.penalty)} · ${UI.esc(punch.penaltyRemarks)}</div>` : ''}
            </div>
            <div class="att-punch-actions">
              <button class="att-punch-btn punch-in" id="att-punch-in-btn" type="button" ${punchedIn || punchedOut ? 'disabled' : ''}>⬆ Punch In</button>
              <button class="att-punch-btn punch-out" id="att-punch-out-btn" type="button" ${!punchedIn || punchedOut ? 'disabled' : ''}>⬇ Punch Out</button>
              <button class="att-punch-btn qr-btn" id="att-qr-scan-btn" type="button">📱 Scan QR</button>
              <button class="att-punch-btn qr-btn" id="att-my-qr-btn" type="button">🪪 My QR Code</button>
            </div>
          </div>

          <div class="today-status-bar">
            <div class="today-stat">
              <div class="today-stat-icon">⏰</div>
              <div><div class="today-stat-label">In time</div>
              <div class="today-stat-value">${punch && punch.inTime ? UI.clock(punch.inTime) : '—'}</div></div>
            </div>
            <div class="today-stat">
              <div class="today-stat-icon">🏁</div>
              <div><div class="today-stat-label">Out time</div>
              <div class="today-stat-value">${punch && punch.outTime ? UI.clock(punch.outTime) : '—'}</div></div>
            </div>
            <div class="today-stat">
              <div class="today-stat-icon">📍</div>
              <div><div class="today-stat-label">Attendance status</div>
              <div class="today-stat-value">${punch ? punch.status : 'Not in'}</div></div>
            </div>
          </div>

          <article class="card" style="margin-bottom:14px">
            <h3 style="margin:0 0 10px;font-size:16px;">Quick ID Card / Barcode Punch</h3>
            <label class="field"><input data-id-scan placeholder="Click here and scan or type your employee code (e.g. EMP-2026-0001)" autocomplete="off" style="font-size:14px"/></label>
            <p class="muted" style="margin-top:8px;font-size:12px;">Type your employee code or scan your ID barcode and press Enter to instantly punch in or out.</p>
          </article>

          ${rule ? `<article class="card"><h3>Shift & Overtime Rules</h3><p>Late grace <strong>${rule.lateGrace} minutes</strong> · Early-out grace <strong>${rule.earlyGrace} minutes</strong> · Overtime starts <strong>${rule.otAfter} minutes</strong> after shift end.</p><p class="muted">Supported check-in modes: ${(rule.modes || []).map((m) => UI.esc(m)).join(', ')}.</p></article>` : ''}`;

        // Live clock
        const clockEl = body.querySelector('#att-clock-live');
        const dateEl = body.querySelector('#att-date-live');
        const tick = () => {
          const now = new Date();
          clockEl.textContent = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          dateEl.textContent = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        };
        tick();
        const timer = setInterval(tick, 1000);
        S1.addStop(() => clearInterval(timer));

        // Manual Punch In
        body.querySelector('#att-punch-in-btn').onclick = async (e) => {
          e.target.disabled = true;
          try {
            let place = {};
            try { place = await UI.locate() || {}; } catch (_) {}
            await UI.api('/api/attendance/punch', { method: 'POST', body: { action: 'in', method: 'Manual', ...place } });
            UI.toast('Punched in successfully!');
            S1.go();
          } catch (err) { UI.toast(err.message, 'bad'); e.target.disabled = false; }
        };

        // Manual Punch Out
        body.querySelector('#att-punch-out-btn').onclick = async (e) => {
          e.target.disabled = true;
          try {
            let place = {};
            try { place = await UI.locate() || {}; } catch (_) {}
            await UI.api('/api/attendance/punch', { method: 'POST', body: { action: 'out', method: 'Manual', ...place } });
            UI.toast('Punched out successfully!');
            S1.go();
          } catch (err) { UI.toast(err.message, 'bad'); e.target.disabled = false; }
        };

        // Scan QR
        body.querySelector('#att-qr-scan-btn').onclick = () => openQrScan(true);

        // My QR
        body.querySelector('#att-my-qr-btn').onclick = () => showMyQr();

        // Barcode input
        const idScan = body.querySelector('[data-id-scan]');
        if (idScan) {
          idScan.addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const code = idScan.value.trim();
            if (!code) return;
            idScan.disabled = true;
            try {
              await sendCapture({ method: 'ID card', code });
            } catch (err) { UI.toast(err.message, 'bad'); idScan.disabled = false; }
          });
        }
      }

      if (tab === 'history') {
        const calMonth = S1.memory.attMonth || new Date().toISOString().slice(0, 7);
        const dateMap = {};
        res.data.forEach((r) => { dateMap[r.workDate] = r; });
        holidays.data.forEach((h) => { if (!dateMap[h.date]) dateMap[h.date] = { holiday: h.name }; });
        const firstDay = new Date(calMonth + '-01');
        const daysInMonth = new Date(firstDay.getFullYear(), firstDay.getMonth() + 1, 0).getDate();
        const startDow = firstDay.getDay();
        const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        let calHtml = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:12px">
          ${DOW.map((d) => `<div style="text-align:center;font-size:11px;font-weight:700;color:var(--muted);padding:4px">${d}</div>`).join('')}
          ${Array(startDow).fill('<div></div>').join('')}`;
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = calMonth + '-' + String(d).padStart(2, '0');
          const row = dateMap[dateStr];
          const isToday = dateStr === todayDate;
          const dow = new Date(dateStr).getDay();
          const isWeekend = dow === 0 || dow === 6;
          let cls = 'att-cal-day'; let dot = '';
          if (row && row.holiday) { cls += ' holiday'; dot = '<div style="font-size:10px;color:#7c3aed">🎉</div>'; }
          else if (isWeekend) cls += ' weekend';
          else if (row && row.status === 'Present') { cls += ' present'; dot = '<div class="att-cal-dot present"></div>'; }
          else if (row && row.status === 'Late') { cls += ' late'; dot = '<div class="att-cal-dot late"></div>'; }
          else if (row && row.status === 'Absent') { cls += ' absent'; dot = '<div class="att-cal-dot absent"></div>'; }
          if (isToday) cls += ' today';
          calHtml += `<div class="${cls}" title="${row ? (row.holiday || (row.status + ' ' + (UI.clock(row.inTime) || ''))) : ''}">
            <div class="cal-date">${d}</div>${dot}</div>`;
        }
        calHtml += '</div>';

        body.innerHTML = `
          <form class="att-filter-bar" id="cal-month-form">
            <input type="month" name="month" value="${UI.esc(calMonth)}" />
            <button class="att-search-btn" type="submit">Show Month</button>
          </form>
          <article class="card" style="margin-bottom:14px">
            <h3 style="margin:0 0 12px;font-size:16px;">Monthly Attendance Calendar · ${UI.esc(calMonth)}</h3>
            ${calHtml}
            <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;padding-top:8px;border-top:1px solid var(--line);">
              <span><span class="att-cal-dot present" style="display:inline-block;vertical-align:middle;margin-right:4px"></span> Present</span>
              <span><span class="att-cal-dot late" style="display:inline-block;vertical-align:middle;margin-right:4px"></span> Late</span>
              <span><span class="att-cal-dot absent" style="display:inline-block;vertical-align:middle;margin-right:4px"></span> Absent</span>
              <span>🎉 Holiday</span>
            </div>
          </article>
          <div class="att-table-wrap">
            <div class="att-table-head"><h3>Attendance Log</h3><span class="muted" style="font-size:12px;">${res.data.length} records</span></div>
            <div class="table-wrap"><table><thead><tr><th>Date</th><th>Shift</th><th>In</th><th>Out</th><th>Mode</th><th>Status</th><th class="num">OT Hours</th></tr></thead><tbody>
            ${res.data.map((row) => `<tr>
              <td>${UI.esc(row.workDate)}</td><td>${UI.esc(row.shiftName)}</td>
              <td>${UI.clock(row.inTime)}</td><td>${UI.clock(row.outTime)}</td>
              <td><span class="att-mode-icon ${(row.mode || '').toLowerCase()}">${UI.esc(row.mode)}</span></td>
              <td>${UI.badge(row.status)}</td>
              <td class="num">${row.otHours || '—'}</td>
            </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted)">No punch records yet.</td></tr>'}
            </tbody></table></div>
          </div>`;

        body.querySelector('#cal-month-form').onsubmit = (e) => {
          e.preventDefault();
          S1.memory.attMonth = new FormData(e.target).get('month');
          Pages.attendance();
        };
      }

      if (tab === 'timesheet') {
        const calMonth = S1.memory.attMonth || new Date().toISOString().slice(0, 7);
        const sheetRes = await load(`/api/attendance/timesheet?month=${calMonth}`);
        if (!sheetRes) return;
        const t = sheetRes.data.totals;
        body.innerHTML = `
          <form class="att-filter-bar" id="ts-month-form">
            <input type="month" name="month" value="${UI.esc(calMonth)}" />
            <button class="att-search-btn" type="submit">Show Timesheet</button>
          </form>
          <div class="att-stats-row">
            <div class="att-stat-card"><div class="stat-label">Total hours</div><div class="stat-value">${t.hours}</div><div class="stat-sub">Logged work</div></div>
            <div class="att-stat-card"><div class="stat-label">Overtime hours</div><div class="stat-value">${t.otHours}</div><div class="stat-sub">Extra hours</div></div>
            <div class="att-stat-card"><div class="stat-label">Late arrivals</div><div class="stat-value" style="color:#f97316">${t.late}</div><div class="stat-sub">Past grace period</div></div>
            <div class="att-stat-card"><div class="stat-label">Early departures</div><div class="stat-value" style="color:#ef4444">${t.early}</div><div class="stat-sub">Before shift end</div></div>
          </div>
          <div class="att-table-wrap">
            <div class="att-table-head"><h3>Timesheet · ${UI.esc(sheetRes.data.month)}</h3></div>
            <div class="table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>In</th><th>Out</th><th>Hours</th><th>OT</th><th>Mode</th><th>Status</th></tr></thead><tbody>
            ${sheetRes.data.rows.map((row) => `<tr>
              <td>${UI.esc(row.workDate)}</td><td>${UI.esc(row.employeeName)}</td>
              <td>${UI.clock(row.inTime)}</td><td>${UI.clock(row.outTime)}</td>
              <td>${row.hours}</td><td>${row.otHours}</td>
              <td>${UI.esc(row.mode)}</td><td>${UI.badge(row.status)}</td>
            </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted)">No timesheet entries for this month.</td></tr>'}
            </tbody></table></div>
          </div>`;

        body.querySelector('#ts-month-form').onsubmit = (e) => {
          e.preventDefault();
          S1.memory.attMonth = new FormData(e.target).get('month');
          Pages.attendance();
        };
      }

      if (tab === 'leave') {
        body.innerHTML = `
          <div class="att-stats-row">
            ${mine.types.length ? mine.types.map((type) => `
              <div class="att-stat-card">
                <div class="stat-label">${UI.esc(type.leaveType)} Leave</div>
                <div class="stat-value">${type.balance}</div>
                <div class="stat-sub">Accrued ${type.accrued} · Used ${type.used}</div>
              </div>`).join('') : policies.data.map((row) => `
              <div class="att-stat-card">
                <div class="stat-label">${UI.esc(row.leaveType)} Leave</div>
                <div class="stat-value">${row.yearlyQuota}</div>
                <div class="stat-sub">${row.paid ? 'Paid' : 'Unpaid'} quota</div>
              </div>`).join('')}
          </div>
          <article class="card"><h3>Official Holiday Calendar</h3>
            ${holidays.data.map((day) => `<div class="flag-row"><span>🎉 ${UI.esc(day.date)} · ${UI.esc(day.name)}</span><span class="muted">${UI.esc(day.companyName)}</span></div>`).join('') || '<p class="muted">No holidays listed.</p>'}
          </article>`;
      }
      return;
    }

    /* ═════════════════════════════════════════════════════════════════
       ADMIN & HR DESK ATTENDANCE (Super Admin, Client Admin, HR Admin)
    ═════════════════════════════════════════════════════════════════ */
    const deskTabs = [
      ['register', '📋 Register'],
      ['today', '🟢 Today\'s Duty'],
      ['timesheet', '📊 Timesheet'],
      ['roster', '📅 Roster'],
      ['shifts', '⏰ Shifts'],
      ['rules', '⚙ Rules'],
      ['leave', '🌿 Leave'],
      ['holidays', '🎉 Holidays']
    ];
    const tabsHtml = deskTabs.map(([t, label]) =>
      `<button class="att-tab-btn ${tab === t ? 'on' : ''}" type="button" data-att-tab="${t}">${label}</button>`
    ).join('');

    const subtitle = isAdmin
      ? 'Manage attendance across all companies. Manual punch in/out, QR scanner, and live workforce duty logs.'
      : 'Track attendance for your company staff, manual punch, QR code check-in, and duty status.';

    const root = mount(`${head('Attendance & Duty Tracking', subtitle)}
      <div class="att-tabs-nav">${tabsHtml}</div>
      <div id="att-body"></div>`);

    root.querySelectorAll('[data-att-tab]').forEach((btn) => {
      btn.onclick = () => { S1.memory.attTab = btn.dataset.attTab; Pages.attendance(); };
    });
    const body = root.querySelector('#att-body');
    const people = await load('/api/employees');
    if (!people) return;
    const personOptions = people.data.map((p) => ({ value: p.id, label: `${p.fullName} (${p.employeeCode})` }));

    if (tab === 'register') {
      const dateFilter = S1.memory.attDate || '';
      const empFilter = S1.memory.attEmp || '';
      const companyFilter = S1.memory.attCompany || '';
      let url = '/api/attendance?';
      const q = [];
      if (dateFilter) q.push('date=' + encodeURIComponent(dateFilter));
      if (empFilter) q.push('employeeId=' + encodeURIComponent(empFilter));
      if (companyFilter && isAdmin) q.push('clientId=' + encodeURIComponent(companyFilter));
      url += q.join('&');

      const res = await load(url);
      if (!res) return;
      const rows = res.data;
      const presentCount = rows.filter((r) => r.status === 'Present').length;
      const lateCount = rows.filter((r) => r.status === 'Late').length;
      const otHoursTotal = rows.reduce((acc, r) => acc + (Number(r.otHours) || 0), 0);

      body.innerHTML = `
        <div class="att-stats-row">
          <div class="att-stat-card"><div class="stat-label">Total records</div><div class="stat-value">${rows.length}</div><div class="stat-sub">Current filter</div></div>
          <div class="att-stat-card"><div class="stat-label">Present (On time)</div><div class="stat-value" style="color:#15803d;">${presentCount}</div><div class="stat-sub">Normal punch</div></div>
          <div class="att-stat-card"><div class="stat-label">Late arrivals</div><div class="stat-value" style="color:#c2410c;">${lateCount}</div><div class="stat-sub">Past grace time</div></div>
          <div class="att-stat-card"><div class="stat-label">Overtime hours</div><div class="stat-value" style="color:#2563eb;">${Math.round(otHoursTotal * 10) / 10}</div><div class="stat-sub">Total OT</div></div>
        </div>

        <!-- HR & Admin Punch Station (Manual & QR for HR and Staff) -->
        <article class="card" style="margin-bottom:14px;border:1.5px solid var(--accent);background:linear-gradient(to right, #fffcf8, #f8fcf9);">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px;">
            <h3 style="margin:0;font-size:16px;">⏱ HR & Staff Attendance Station</h3>
            <span class="muted" style="font-size:12.5px;">Punch in / out manually or with QR scan for HR or any staff</span>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <select id="hr-punch-emp-select" style="padding:9px 14px;border-radius:10px;border:1px solid var(--line);background:white;font-size:13.5px;min-width:240px;">
              ${S1.user.employeeId ? `<option value="${S1.user.employeeId}">Self: ${UI.esc(S1.user.name)}</option>` : ''}
              ${personOptions.map((p) => `<option value="${UI.esc(p.value)}">${UI.esc(p.label)}</option>`).join('')}
            </select>
            <button class="att-punch-btn punch-in" id="hr-punch-in-btn" type="button" style="padding:9px 18px;min-width:auto;font-size:13.5px;">⬆ Punch In</button>
            <button class="att-punch-btn punch-out" id="hr-punch-out-btn" type="button" style="padding:9px 18px;min-width:auto;font-size:13.5px;">⬇ Punch Out</button>
            <button class="btn" id="hr-scan-qr-btn" type="button" style="padding:9px 16px;">📱 Scan Staff QR</button>
            <button class="btn ghost" id="hr-view-qr-btn" type="button" style="padding:9px 16px;">🪪 View Staff QR</button>
          </div>
        </article>

        <!-- Filter bar -->
        <form class="att-filter-bar" id="att-filter-form">
          <input type="date" name="date" value="${UI.esc(dateFilter)}" placeholder="Filter by date"/>
          <select name="empId"><option value="">All employees</option>${personOptions.map((p) => `<option value="${UI.esc(p.value)}" ${empFilter === p.value ? 'selected' : ''}>${UI.esc(p.label)}</option>`).join('')}</select>
          ${isAdmin ? `<select name="companyId"><option value="">All companies</option>${S1.ref.companies.map((c) => `<option value="${UI.esc(c.id)}" ${companyFilter === c.id ? 'selected' : ''}>${UI.esc(c.name)}</option>`).join('')}</select>` : ''}
          <button class="att-search-btn" type="submit">Filter</button>
          <button class="btn ghost" type="button" id="att-clear-filter">Reset</button>
          <button class="btn primary" type="button" data-act="mark">+ Mark Attendance</button>
          <button class="btn ghost" type="button" data-act="xlsx">Excel</button>
        </form>

        <div class="att-table-wrap">
          <div class="att-table-head">
            <h3>Attendance Register</h3>
            <span class="muted" style="font-size:13px;">Showing ${rows.length} entries</span>
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th>Date</th>
            <th>Employee</th>
            ${isAdmin ? '<th>Company</th>' : ''}
            <th>Shift</th>
            <th>In Time</th>
            <th>Out Time</th>
            <th>Mode</th>
            <th>Status</th>
            <th class="num">OT Hours</th>
            <th>Notes / Penalty</th>
            <th>Action</th>
          </tr></thead><tbody>
          ${rows.map((row) => `<tr>
            <td><strong>${UI.esc(row.workDate)}</strong></td>
            <td><strong>${UI.esc(row.employeeName)}</strong><br><span class="muted" style="font-size:11px;">${UI.esc(row.employeeCode)}</span></td>
            ${isAdmin ? `<td>${UI.esc(row.companyName)}</td>` : ''}
            <td>${UI.esc(row.shiftName)}</td>
            <td>${row.inTime ? `<strong>${UI.clock(row.inTime)}</strong>` : '<span class="muted">—</span>'}</td>
            <td>${row.outTime ? `<strong>${UI.clock(row.outTime)}</strong>` : '<span class="muted">—</span>'}</td>
            <td><span class="att-mode-icon ${(row.mode || '').toLowerCase()}">${UI.esc(row.mode)}</span></td>
            <td><span class="att-emp-pill ${(row.status || '').toLowerCase().replace(/ /g, '-')}">${UI.esc(row.status)}</span></td>
            <td class="num">${row.otHours || '—'}</td>
            <td style="font-size:12px;">${UI.esc(row.penaltyRemarks || row.locationNote || '—')}</td>
            <td><button class="btn small" type="button" data-act="edit" data-id="${UI.esc(row.id)}" data-penalty="${row.penalty}" data-ot="${row.otAmount}" data-lop="${row.lopDays}" data-notes="${UI.esc(row.penaltyRemarks)}">Adjust</button></td>
          </tr>`).join('') || '<tr><td colspan="11" style="text-align:center;padding:28px;color:var(--muted)">No attendance records found for this filter.</td></tr>'}
          </tbody></table></div>
        </div>`;

      // Filter submit
      body.querySelector('#att-filter-form').onsubmit = (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        S1.memory.attDate = data.get('date') || '';
        S1.memory.attEmp = data.get('empId') || '';
        if (isAdmin) S1.memory.attCompany = data.get('companyId') || '';
        Pages.attendance();
      };

      // Clear filter
      body.querySelector('#att-clear-filter').onclick = () => {
        S1.memory.attDate = '';
        S1.memory.attEmp = '';
        S1.memory.attCompany = '';
        Pages.attendance();
      };

      // HR Punch In button
      body.querySelector('#hr-punch-in-btn').onclick = async () => {
        const empId = body.querySelector('#hr-punch-emp-select').value;
        if (!empId) { UI.toast('Please select an employee first', 'bad'); return; }
        try {
          let place = {};
          try { place = await UI.locate() || {}; } catch (_) {}
          await UI.api('/api/attendance/punch', { method: 'POST', body: { employeeId: empId, action: 'in', method: 'Manual', ...place } });
          UI.toast('Punch in recorded!');
          Pages.attendance();
        } catch (err) { UI.toast(err.message, 'bad'); }
      };

      // HR Punch Out button
      body.querySelector('#hr-punch-out-btn').onclick = async () => {
        const empId = body.querySelector('#hr-punch-emp-select').value;
        if (!empId) { UI.toast('Please select an employee first', 'bad'); return; }
        try {
          let place = {};
          try { place = await UI.locate() || {}; } catch (_) {}
          await UI.api('/api/attendance/punch', { method: 'POST', body: { employeeId: empId, action: 'out', method: 'Manual', ...place } });
          UI.toast('Punch out recorded!');
          Pages.attendance();
        } catch (err) { UI.toast(err.message, 'bad'); }
      };

      // HR Scan Staff QR
      body.querySelector('#hr-scan-qr-btn').onclick = () => openQrScan(false);

      // HR View Staff QR
      body.querySelector('#hr-view-qr-btn').onclick = () => {
        const empId = body.querySelector('#hr-punch-emp-select').value;
        showMyQr(empId);
      };

      UI.bind(body, {
        xlsx: () => UI.download('/api/export/attendance?format=xlsx', 's1-attendance.xlsx'),
        mark: () => UI.openModal({
          title: 'Mark Attendance Manually',
          html: `<div class="fields">
            ${UI.field('employeeId', 'Employee', '', { select: personOptions })}
            ${UI.field('workDate', 'Date', new Date().toISOString().slice(0, 10), { type: 'date', required: true })}
            ${UI.field('inTime', 'In time', '09:30')}
            ${UI.field('outTime', 'Out time', '18:30')}
            ${UI.field('mode', 'Check-in Mode', 'Manual', { select: ['Manual', 'QR', 'ID card', 'Biometric', 'Web', 'Roster'].map((i) => ({ value: i, label: i })) })}
          </div>`,
          onSubmit: async (data) => {
            await UI.api('/api/attendance/mark', { method: 'POST', body: Object.fromEntries(data.entries()) });
            UI.toast('Attendance marked successfully');
            Pages.attendance();
          }
        }),
        edit: (node) => UI.openModal({
          title: 'Adjust Penalty, LOP, and Overtime',
          html: `${UI.field('penalty', 'Penalty amount (₹)', node.dataset.penalty, { type: 'number' })}${UI.field('lopDays', 'Loss of pay (LOP) days', node.dataset.lop, { type: 'number' })}${UI.field('otAmount', 'Overtime amount (₹)', node.dataset.ot, { type: 'number' })}${UI.field('penaltyRemarks', 'Remarks & notes', node.dataset.notes, { type: 'textarea' })}`,
          onSubmit: async (data) => {
            await UI.api(`/api/attendance/${node.dataset.id}`, { method: 'PUT', body: Object.fromEntries(data.entries()) });
            UI.toast('Attendance record updated');
            Pages.attendance();
          }
        })
      });
    }

    if (tab === 'today') {
      const todayDate = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
      const res = await load('/api/attendance?date=' + todayDate);
      if (!res) return;
      const allStaff = people.data;
      const punchedIds = new Set(res.data.map((r) => r.employeeId));
      const onDuty = res.data.filter((r) => r.inTime && !r.outTime);
      const doneForDay = res.data.filter((r) => r.outTime);
      const notPunched = allStaff.filter((e) => !punchedIds.has(e.id));

      body.innerHTML = `
        <div class="att-stats-row">
          <div class="att-stat-card"><div class="stat-label">Total Staff</div><div class="stat-value">${allStaff.length}</div><div class="stat-sub">Active workforce</div></div>
          <div class="att-stat-card"><div class="stat-label">Currently On Duty</div><div class="stat-value" style="color:#15803d;">${onDuty.length}</div><div class="stat-sub">Punched in right now</div></div>
          <div class="att-stat-card"><div class="stat-label">Done For Day</div><div class="stat-value" style="color:#2563eb;">${doneForDay.length}</div><div class="stat-sub">Punched out completed</div></div>
          <div class="att-stat-card"><div class="stat-label">Not Arrived Yet</div><div class="stat-value" style="color:#9ca3af;">${notPunched.length}</div><div class="stat-sub">No punch today</div></div>
        </div>

        <div class="att-table-wrap" style="margin-bottom:16px;">
          <div class="att-table-head"><h3 style="color:#15803d;">🟢 Currently On Duty (${onDuty.length})</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Shift</th><th>In Time</th><th>Mode</th><th>Status</th></tr></thead><tbody>
          ${onDuty.map((r) => `<tr>
            <td><strong>${UI.esc(r.employeeName)}</strong><br><span class="muted" style="font-size:11px;">${UI.esc(r.employeeCode)}</span></td>
            <td>${UI.esc(r.shiftName)}</td>
            <td><strong>${UI.clock(r.inTime)}</strong></td>
            <td><span class="att-mode-icon ${(r.mode || '').toLowerCase()}">${UI.esc(r.mode)}</span></td>
            <td><span class="att-emp-pill present">${UI.esc(r.status)}</span></td>
          </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">No staff are currently punched in.</td></tr>'}
          </tbody></table></div>
        </div>

        <div class="att-table-wrap" style="margin-bottom:16px;">
          <div class="att-table-head"><h3 style="color:#2563eb;">🔵 Shift Completed Today (${doneForDay.length})</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Shift</th><th>In Time</th><th>Out Time</th><th>Mode</th><th>OT</th></tr></thead><tbody>
          ${doneForDay.map((r) => `<tr>
            <td><strong>${UI.esc(r.employeeName)}</strong><br><span class="muted" style="font-size:11px;">${UI.esc(r.employeeCode)}</span></td>
            <td>${UI.esc(r.shiftName)}</td>
            <td>${UI.clock(r.inTime)}</td>
            <td><strong>${UI.clock(r.outTime)}</strong></td>
            <td>${UI.esc(r.mode)}</td>
            <td>${r.otHours || '—'}</td>
          </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">No staff have finished their shift yet today.</td></tr>'}
          </tbody></table></div>
        </div>

        <div class="att-table-wrap">
          <div class="att-table-head"><h3 style="color:#6b7280;">⚫ Not Punched Today (${notPunched.length})</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Role</th><th>Shift</th></tr></thead><tbody>
          ${notPunched.map((e) => `<tr>
            <td><strong>${UI.esc(e.fullName)}</strong><br><span class="muted" style="font-size:11px;">${UI.esc(e.employeeCode)}</span></td>
            <td>${UI.esc(e.department)}</td>
            <td>${UI.esc(e.roleTitle)}</td>
            <td>${UI.esc(e.shiftName)}</td>
          </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--muted)">All staff have punched in today!</td></tr>'}
          </tbody></table></div>
        </div>`;
    }

    if (tab === 'timesheet') {
      const month = S1.memory.attMonth || new Date().toISOString().slice(0, 7);
      const res = await load(`/api/attendance/timesheet?month=${month}`);
      if (!res) return;
      const t = res.data.totals;
      body.innerHTML = `
        <form class="att-filter-bar" id="ts-month-form">
          <input type="month" name="month" value="${UI.esc(month)}" />
          <button class="att-search-btn" type="submit">Show</button>
          <button class="btn ghost" type="button" data-act="xlsx">Export Excel</button>
        </form>
        <div class="att-stats-row">
          <div class="att-stat-card"><div class="stat-label">Total Hours</div><div class="stat-value">${t.hours}</div><div class="stat-sub">Worked hours</div></div>
          <div class="att-stat-card"><div class="stat-label">OT Hours</div><div class="stat-value">${t.otHours}</div><div class="stat-sub">Overtime</div></div>
          <div class="att-stat-card"><div class="stat-label">Late Arrivals</div><div class="stat-value" style="color:#f97316">${t.late}</div><div class="stat-sub">Past grace period</div></div>
          <div class="att-stat-card"><div class="stat-label">Early Departures</div><div class="stat-value" style="color:#ef4444">${t.early}</div><div class="stat-sub">Before shift end</div></div>
        </div>
        <div class="att-table-wrap">
          <div class="att-table-head"><h3>Timesheet Log · ${UI.esc(res.data.month)}</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>In Time</th><th>Out Time</th><th>Hours</th><th>OT Hours</th><th>Mode</th><th>Status</th></tr></thead><tbody>
          ${res.data.rows.map((row) => `<tr>
            <td>${UI.esc(row.workDate)}</td><td>${UI.esc(row.employeeName)}</td>
            <td>${UI.clock(row.inTime)}</td><td>${UI.clock(row.outTime)}</td>
            <td><strong>${row.hours}</strong></td><td>${row.otHours}</td>
            <td>${UI.esc(row.mode)}</td><td>${UI.badge(row.status)}</td>
          </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted)">No timesheet entries for this period.</td></tr>'}
          </tbody></table></div>
        </div>`;
      body.querySelector('#ts-month-form').onsubmit = (e) => {
        e.preventDefault(); S1.memory.attMonth = new FormData(e.target).get('month'); Pages.attendance();
      };
      UI.bind(body, { xlsx: () => UI.download('/api/export/attendance?format=xlsx', 's1-attendance.xlsx') });
    }

    if (tab === 'roster') {
      const today = new Date().toISOString().slice(0, 10);
      const res = await load(`/api/roster?from=${today.slice(0, 8)}01&to=${today.slice(0, 8)}31`);
      if (!res) return;
      body.innerHTML = `<form id="roster-form" class="fields" style="margin-bottom:14px;">
          ${UI.field('employeeId', 'Employee', '', { select: personOptions })}
          ${UI.field('workDate', 'Date', today, { type: 'date' })}
          ${UI.field('shiftId', 'Shift', '', { select: S1.ref.shifts.map((s) => ({ value: s.id, label: `${s.name} (${s.start}–${s.end})` })) })}
          <button class="btn span-2 primary" type="submit">Assign Roster Shift</button>
        </form>
        <div class="att-table-wrap">
          <div class="att-table-head"><h3>Current Month Roster Schedule</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>Shift</th><th>Hours</th></tr></thead><tbody>
          ${res.data.map((row) => `<tr><td>${UI.esc(row.workDate)}</td><td><strong>${UI.esc(row.employeeName)}</strong></td><td>${UI.esc(row.shiftName)}</td><td>${UI.esc(row.start)}–${UI.esc(row.end)}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--muted)">No roster lines assigned yet.</td></tr>'}
          </tbody></table></div>
        </div>`;
      body.querySelector('#roster-form').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/roster', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Roster assignment saved'); S1.go();
      };
    }

    if (tab === 'shifts') {
      body.innerHTML = `<div class="page-actions" style="margin-bottom:14px;"><button class="btn primary" type="button" data-act="add">+ Add Shift</button></div>
        <div class="att-table-wrap">
          <div class="att-table-head"><h3>Defined Shifts</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Shift Name</th><th>Start Time</th><th>End Time</th><th>Scope</th></tr></thead><tbody>
          ${S1.ref.shifts.map((s) => `<tr><td><strong>${UI.esc(s.name)}</strong></td><td>${UI.esc(s.start)}</td><td>${UI.esc(s.end)}</td><td>${s.clientId ? 'Company' : 'Shared across companies'}</td></tr>`).join('')}
          </tbody></table></div>
        </div>`;
      UI.bind(body, { add: () => UI.openModal({
        title: 'Create New Shift',
        html: `${isAdmin ? UI.field('clientId', 'Company', '', { select: [{ value: '', label: 'Shared across companies' }].concat(S1.ref.companies.map((c) => ({ value: c.id, label: c.name }))) }) : ''}${UI.field('name', 'Shift Name', '', { required: true })}${UI.field('start', 'Start Time', '09:30')}${UI.field('end', 'End Time', '18:30')}`,
        onSubmit: async (data) => {
          await UI.api('/api/shifts', { method: 'POST', body: Object.fromEntries(data.entries()) });
          S1.ref = (await UI.api('/api/reference')).data; UI.toast('Shift created successfully'); S1.go();
        }
      }) });
    }

    if (tab === 'rules') {
      const res = await load('/api/attendance/rules');
      if (!res) return;
      body.innerHTML = res.data.map((rule) => `<form class="card fields" data-client="${UI.esc(rule.clientId)}" style="margin-bottom:14px;">
        <h3 class="span-2">${UI.esc(rule.companyName)} — Attendance Rules</h3>
        ${UI.field('lateGrace', 'Late grace period (minutes)', rule.lateGrace, { type: 'number' })}
        ${UI.field('earlyGrace', 'Early-out grace period (minutes)', rule.earlyGrace, { type: 'number' })}
        ${UI.field('otAfter', 'Overtime threshold after shift end (minutes)', rule.otAfter, { type: 'number' })}
        <p class="muted span-2">Enabled check-in modes: Manual punch, QR code scanning, ID card barcode scanning, Biometric import, and Roster scheduling.</p>
        <button class="btn primary" type="submit">Save Attendance Rules</button>
      </form>`).join('') || '<p class="muted">No company rules found.</p>';
      body.querySelectorAll('form').forEach((f) => {
        f.onsubmit = async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(f).entries());
          data.clientId = f.dataset.client;
          data.modes = ['Web', 'Manual', 'QR', 'ID card', 'Biometric', 'Roster'];
          await UI.api('/api/attendance/rules', { method: 'PUT', body: data }); UI.toast('Rules saved successfully');
        };
      });
    }

    if (tab === 'leave') {
      const [policies, board] = await Promise.all([load('/api/leave-policies'), load('/api/leave-accrual')]);
      if (!policies || !board) return;
      body.innerHTML = `<div class="page-actions" style="margin-bottom:14px;">
          <button class="btn primary" type="button" data-act="policy">+ Add Leave Policy</button>
          <button class="btn ghost" type="button" data-act="accrue">Post Accruals</button>
        </div>
        <article class="card" style="margin-bottom:14px;"><h3>Company Leave Policies</h3>
          <div class="table-wrap"><table><thead><tr><th>Company</th><th>Leave Type</th><th>Yearly Quota</th><th>Monthly Accrual</th><th>Carry Forward</th><th>Paid</th></tr></thead><tbody>
          ${policies.data.map((row) => `<tr><td>${UI.esc(row.companyName)}</td><td><strong>${UI.esc(row.leaveType)}</strong></td><td>${row.yearlyQuota} days</td><td>${row.monthlyAccrual} days</td><td>${row.carryForward} days</td><td>${row.paid ? 'Yes' : 'No'}</td></tr>`).join('')}
          </tbody></table></div>
        </article>
        ${board.data.map((person) => `<article class="card" style="margin-bottom:12px;"><h3>${UI.esc(person.fullName)}</h3>
          <div class="table-wrap"><table><thead><tr><th>Leave Type</th><th>Accrued</th><th>Used</th><th>Balance</th><th>Quota</th></tr></thead><tbody>
          ${person.types.map((type) => `<tr><td>${UI.esc(type.leaveType)}</td><td>${type.accrued}</td><td>${type.used}</td><td><strong>${type.balance}</strong></td><td>${type.yearlyQuota}</td></tr>`).join('') || '<tr><td colspan="5">No records.</td></tr>'}
          </tbody></table></div>
        </article>`).join('')}`;
      UI.bind(body, {
        policy: () => UI.openModal({
          title: 'Configure Leave Type',
          html: `${isAdmin ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((c) => ({ value: c.id, label: c.name })) }) : ''}${UI.field('leaveType', 'Type', 'Casual', { select: ['Casual', 'Sick', 'Earned', 'Unpaid'].map((i) => ({ value: i, label: i })) })}${UI.field('yearlyQuota', 'Yearly quota (days)', 12, { type: 'number' })}${UI.field('monthlyAccrual', 'Monthly accrual (days)', 1, { type: 'number' })}${UI.field('carryForward', 'Max carry forward (days)', 0, { type: 'number' })}${UI.field('paid', 'Paid leave', 'yes', { select: [{ value: 'yes', label: 'Paid' }, { value: 'no', label: 'Unpaid' }] })}`,
          onSubmit: async (data) => { await UI.api('/api/leave-policies', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Leave policy saved'); S1.go(); }
        }),
        accrue: async () => { const result = await UI.api('/api/leave-accrual', { method: 'POST', body: {} }); UI.toast(`${result.data.posted} accrual lines posted`); S1.go(); }
      });
    }

    if (tab === 'holidays') {
      const holidays = await load('/api/holidays');
      if (!holidays) return;
      body.innerHTML = `<div class="page-actions" style="margin-bottom:14px;"><button class="btn primary" type="button" data-act="holiday">+ Add Holiday</button></div>
        ${holidays.data.map((day) => `<div class="flag-row"><span>🎉 <strong>${UI.esc(day.date)}</strong> · ${UI.esc(day.name)}</span><span class="muted">${UI.esc(day.companyName)}</span></div>`).join('') || '<p class="muted">No holidays listed.</p>'}`;
      UI.bind(body, { holiday: () => UI.openModal({
        title: 'Add Holiday',
        html: `${isAdmin ? UI.field('clientId', 'Applies To', '', { select: [{ value: '', label: 'All companies' }].concat(S1.ref.companies.map((c) => ({ value: c.id, label: c.name }))) }) : ''}${UI.field('name', 'Holiday Name', '', { required: true })}${UI.field('date', 'Holiday Date', '', { type: 'date', required: true })}`,
        onSubmit: async (data) => { await UI.api('/api/holidays', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Holiday added'); S1.go(); }
      }) });
    }
  },

  async approvals() {
    const admin = S1.user.role === 'admin';
    const [leaves, swaps, claims, regulars, clients, assetRequests, placeRequests, documentRequests, clientRequests] = await Promise.all([
      load('/api/leaves'),
      load('/api/shift-swaps'),
      load('/api/reimbursements'),
      load('/api/regularizations'),
      admin ? load('/api/clients') : Promise.resolve({ data: [] }),
      load('/api/asset-requests'),
      load('/api/location-requests'),
      load('/api/document-requests'),
      load('/api/client-requests')
    ]);
    if (!leaves || !swaps || !claims || !regulars || !clients || !assetRequests || !placeRequests || !documentRequests || !clientRequests) return;
    const names = admin ? ['leaves', 'regularization', 'swaps', 'claims', 'assets', 'locations', 'documents', 'clients', 'companies'] : ['leaves', 'regularization', 'swaps', 'claims', 'assets', 'locations', 'documents'];
    const tab = names.includes(S1.memory.approvalTab) ? S1.memory.approvalTab : 'leaves';
    const tabs = names.map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const desk = admin || S1.user.role === 'client';
    const openLeave = (row) => desk && ['Pending', 'Pending company', 'Pending admin'].includes(row.status);
    const openRegular = (row) => desk && ['Pending company', 'Pending admin'].includes(row.status);
    const openRequest = (row) => desk && ['Pending company', 'Pending admin'].includes(row.status);
    const decide = (kind, row, open) => open ? `<button class="btn small" type="button" data-act="yes" data-kind="${kind}" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-kind="${kind}" data-id="${row.id}">Reject</button>` : UI.badge(row.status);
    let body = '';
    if (tab === 'leaves') body = leaves.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.employeeName)}</strong> · ${UI.esc(row.leaveType)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.fromDate)} to ${UI.esc(row.toDate)} · ${UI.esc(row.reason)} · ${UI.when(row.raisedAt)}</span></span><span>${decide('leaves', row, openLeave(row))}</span></div>`).join('');
    if (tab === 'regularization') body = regulars.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.employeeName)}</strong> · ${UI.esc(row.workDate)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.requestedIn)}–${UI.esc(row.requestedOut || '—')} · ${UI.esc(row.reason)}</span></span><span>${decide('regularizations', row, openRegular(row))}</span></div>`).join('');
    if (tab === 'swaps') body = swaps.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.employeeName)}</strong> · ${UI.esc(row.fromShift)} to ${UI.esc(row.toShift)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.swapDate)} · ${UI.esc(row.reason)}</span></span><span>${decide('shift-swaps', row, desk && row.status === 'Pending')}</span></div>`).join('');
    const claimStep = (row) => {
      const reject = `<button class="btn small danger" type="button" data-act="no" data-kind="reimbursements" data-id="${row.id}">Reject</button>`;
      if (['Pending', 'Pending company'].includes(row.status)) return `<button class="btn small" type="button" data-act="yes" data-kind="reimbursements" data-id="${row.id}" data-status="Approved">Send to finance</button> ${reject}`;
      if (desk && row.status === 'Pending finance') return `<button class="btn small" type="button" data-act="yes" data-kind="reimbursements" data-id="${row.id}" data-status="Approved">Verify finance</button> ${reject}`;
      if (desk && row.status === 'Ready') return `<button class="btn small" type="button" data-act="yes" data-kind="reimbursements" data-id="${row.id}" data-status="Processed">Process payment</button> ${reject}`;
      return UI.badge(row.status);
    };
    if (tab === 'claims') body = claims.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.employeeName)}</strong> · ${UI.inr(row.amount)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.category)} · ${UI.esc(row.expenseDate || '')} · ${UI.esc(row.description)}</span></span><span>${(['Pending', 'Pending company'].includes(row.status) || (desk && ['Pending finance', 'Ready'].includes(row.status))) ? claimStep(row) : UI.badge(row.status)}</span></div>`).join('');
    if (tab === 'companies') body = clients.data.filter((client) => client.status === 'Pending').map((client) => `<div class="flag-row"><span><strong>${UI.esc(client.companyName)}</strong><br><span class="muted">${UI.esc(client.applicationNumber)}</span></span><a href="#/client/${UI.esc(client.id)}">Open</a></div>`).join('') || '<p class="muted">No companies are waiting.</p>';
    if (tab === 'assets') body = assetRequests.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.assetCode)}</strong> · ${UI.esc(row.action)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.assetName)} · ${UI.esc(row.employeeName || row.raisedBy)}${row.destinationName ? ` → ${UI.esc(row.destinationName)}` : ''} · ${UI.esc(row.detail)}</span></span><span>${openRequest(row) ? `<button class="btn small" type="button" data-act="yes" data-kind="asset-requests" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-kind="asset-requests" data-id="${row.id}">Reject</button>` : UI.badge(row.status)}</span></div>`).join('');
    if (tab === 'locations') body = placeRequests.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.placeName || row.locationName)}</strong> · ${UI.esc(row.action)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.employeeName || row.raisedBy)} · ${UI.esc(row.detail)}</span></span><span>${openRequest(row) ? `<button class="btn small" type="button" data-act="yes" data-kind="location-requests" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-kind="location-requests" data-id="${row.id}">Reject</button>` : UI.badge(row.status)}</span></div>`).join('');
    if (tab === 'documents') body = documentRequests.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.employeeName)}</strong> · ${UI.esc(row.kind)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.message)}</span></span><span>${openRequest(row) ? `<button class="btn small" type="button" data-act="yes" data-kind="document-requests" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-kind="document-requests" data-id="${row.id}">Reject</button>` : UI.badge(row.status)}</span></div>`).join('');
    if (tab === 'clients') body = clientRequests.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.companyName)}</strong> · ${UI.esc(row.plan)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.inr(row.fee)} ${UI.esc(row.cycle)} · ${UI.esc(row.paymentMethod || 'No method')} · ${UI.esc(row.detail)}</span></span><span>${row.status === 'Pending verification' ? `<button class="btn small" type="button" data-act="yes" data-kind="client-requests" data-id="${row.id}">Verify</button> <button class="btn small danger" type="button" data-act="no" data-kind="client-requests" data-id="${row.id}">Reject</button>` : row.status === 'Pending approval' ? `<button class="btn small" type="button" data-act="yes" data-kind="client-requests" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-kind="client-requests" data-id="${row.id}">Reject</button>` : UI.badge(row.status)}</span></div>`).join('');
    const root = mount(`${head('Approvals', 'Employee requests are approved or rejected by the client admin and the company admin. Company registrations and plan changes stay with the super admin.')}<div class="tabs">${tabs}</div><article class="card">${body || '<p class="muted">Nothing waiting in this list.</p>'}</article>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.approvalTab = button.dataset.tab; Pages.approvals(); }; });
    UI.bind(root, {
      yes: async (node) => {
        const path = ['asset-requests', 'location-requests', 'document-requests', 'client-requests'].includes(node.dataset.kind) ? `/api/${node.dataset.kind}/${node.dataset.id}` : `/api/${node.dataset.kind}/${node.dataset.id}/status`;
        await UI.api(path, { method: 'PUT', body: { status: node.dataset.status || 'Approved' } });
        UI.toast('Step recorded');
        S1.go();
      },
      no: async (node) => {
        const path = ['asset-requests', 'location-requests', 'document-requests', 'client-requests'].includes(node.dataset.kind) ? `/api/${node.dataset.kind}/${node.dataset.id}` : `/api/${node.dataset.kind}/${node.dataset.id}/status`;
        await UI.api(path, { method: 'PUT', body: { status: 'Rejected', remarks: 'Rejected by the access holder' } });
        UI.toast('Rejected');
        S1.go();
      }
    });
  },

  async hiring() {
    const tab = S1.memory.hireTab || 'jobs';
    const tabs = ['jobs', 'requisitions', 'tracker', 'resumes', 'offers', 'analytics', 'joining', 'history'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('ATS and employee key', 'Raise manpower inside the company or ask S1 HR, track applications, keep resumes, and issue offers. Search finds a person by name, employee id, or application number.')}<div class="tabs">${tabs}</div><div id="hire-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.hireTab = button.dataset.tab; Pages.hiring(); }; });
    const body = root.querySelector('#hire-body');
    const [applicants, jobs, requisitions] = await Promise.all([load('/api/applicants'), load('/api/jobs'), load('/api/requisitions')]);
    if (!applicants || !jobs || !requisitions) return;
    const admin = S1.user.role === 'admin';
    const stages = admin ? ['Applied', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'] : ['Applied', 'Screening', 'Interview', 'Rejected'];
    if (tab === 'jobs') {
      body.innerHTML = `<form id="job-form" class="fields" style="margin-bottom:12px">${admin ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('title', 'Job title', '', { required: true })}${UI.field('openings', 'Seats', 1, { type: 'number' })}${UI.field('description', 'Job description', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Create job</button></form>
        ${jobs.data.map((job) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(job.title)}</h3>${UI.badge(job.status)}</div><p>${UI.esc(job.applicationNumber)} · ${job.openings} seats · ${UI.esc(job.companyName)}</p><p>${UI.esc(job.description || 'No description yet.')}</p></article>`).join('') || ''}`;
      body.querySelector('#job-form').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/jobs', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Job created');
        S1.go();
      };
    }
    if (tab === 'requisitions') {
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px"><button class="btn" type="button" data-act="internal">Within organisation</button><button class="btn primary" type="button" data-act="s1">Request S1 HR</button></div>
        ${requisitions.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.position)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.applicationNumber)} · ${UI.esc(row.kind)} · ${row.openings} seats · ${UI.esc(row.companyName)}</p><p class="muted">${UI.esc(row.department)} · ${UI.esc(row.justification)} · ${UI.esc(row.raisedBy)}</p>${admin && row.status === 'Pending admin' ? `<button class="btn small" type="button" data-act="yes" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-id="${row.id}">Reject</button>` : ''}${row.status === 'Approved' ? `<button class="btn small ghost" type="button" data-act="filled" data-id="${row.id}">Mark filled</button>` : ''}</article>`).join('') || '<p class="muted">No requisitions yet.</p>'}`;
      const form = (kind) => UI.openModal({
        title: kind === 'S1 HR' ? 'Manpower request to S1 HR' : 'Manpower within the organisation',
        html: `<div class="fields">${admin ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('position', 'Position', '', { required: true })}${UI.field('openings', 'Seats', 1, { type: 'number' })}${UI.field('department', 'Department')}${UI.field('justification', 'Why this seat is needed', '', { type: 'textarea' })}</div>`,
        onSubmit: async (data) => { const payload = Object.fromEntries(data.entries()); payload.kind = kind; await UI.api('/api/requisitions', { method: 'POST', body: payload }); UI.toast('Requisition saved'); S1.go(); }
      });
      UI.bind(body, {
        internal: () => form('Internal'),
        s1: () => form('S1 HR'),
        yes: async (node) => { await UI.api(`/api/requisitions/${node.dataset.id}`, { method: 'PUT', body: { status: 'Approved' } }); UI.toast('Request approved'); S1.go(); },
        no: async (node) => { await UI.api(`/api/requisitions/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Request rejected'); S1.go(); },
        filled: async (node) => { await UI.api(`/api/requisitions/${node.dataset.id}`, { method: 'PUT', body: { status: 'Filled' } }); UI.toast('Marked filled'); S1.go(); }
      });
    }
    if (tab === 'tracker') {
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px"><button class="btn primary" type="button" data-act="add">Add applicant</button></div>
        <div class="table-wrap"><table><thead><tr><th>Applicant</th><th>Position</th><th>Source</th><th>Stage</th><th>BGV</th></tr></thead><tbody>
        ${applicants.data.map((row) => `<tr><td><strong>${UI.esc(row.fullName)}</strong><br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.when(row.raisedAt)}</span></td><td>${UI.esc(row.position)}</td><td>${UI.esc(row.source)}</td><td><select data-stage="${UI.esc(row.id)}">${stages.map((stage) => `<option ${stage === row.stage ? 'selected' : ''}>${stage}</option>`).join('')}</select></td><td>${row.bgvRequired ? 'Yes' : 'No'}</td></tr>`).join('') || '<tr><td colspan="5">No applicants yet.</td></tr>'}
        </tbody></table></div>
        <article class="card" style="margin-top:12px"><h3>Openings</h3>${jobs.data.map((job) => `<div class="flag-row"><span>${UI.esc(job.title)} · ${UI.esc(job.applicationNumber)}</span>${UI.badge(job.status)}</div>`).join('') || '<p class="muted">No openings.</p>'}</article>`;
      body.querySelectorAll('[data-stage]').forEach((select) => {
        select.onchange = async () => {
          try { await UI.api(`/api/applicants/${select.dataset.stage}/stage`, { method: 'PUT', body: { stage: select.value } }); UI.toast('Stage updated'); }
          catch (error) { UI.toast(error.message, 'bad'); S1.go(); }
        };
      });
      UI.bind(body, { add: () => UI.openModal({
        title: 'Applicant',
        html: `<div class="fields">${admin ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('fullName', 'Name', '', { required: true })}${UI.field('email', 'Email', '', { type: 'email' })}${UI.field('phone', 'Phone')}${UI.field('position', 'Position', '', { required: true })}${UI.field('jobId', 'Opening', '', { select: [{ value: '', label: 'Not linked' }].concat(jobs.data.map((job) => ({ value: job.id, label: job.title }))) })}${UI.field('source', 'Source', 'Direct', { select: ['Direct', 'Assigned', 'Sourcing company'].map((item) => ({ value: item, label: item })) })}${UI.field('sourceCompany', 'Sourcing company')}${UI.field('notes', 'Notes', '', { type: 'textarea' })}<label class="checkline span-2"><input type="checkbox" name="bgvRequired" value="yes" checked/> Background verification required</label><label class="field span-2">Resume<input name="resume" type="file" accept=".pdf,.doc,.docx"/></label></div>`,
        onSubmit: async (data, form) => {
          const payload = Object.fromEntries(data.entries());
          payload.bgvRequired = data.get('bgvRequired') === 'yes';
          if (form.resume.files[0]) {
            const file = await UI.upload(form.resume.files[0]);
            payload.resumeUrl = file.url;
            payload.resumeName = form.resume.files[0].name;
          }
          delete payload.resume;
          await UI.api('/api/applicants', { method: 'POST', body: payload });
          UI.toast('Applicant added');
          S1.go();
        }
      }) });
    }
    if (tab === 'resumes') {
      body.innerHTML = applicants.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.fullName)}</h3><span>${UI.esc(row.applicationNumber)}</span></div><p>${UI.esc(row.position)} · ${row.resumeName ? `<a href="${UI.esc(row.resumeUrl)}" target="_blank" rel="noreferrer">${UI.esc(row.resumeName)}</a>` : 'No resume yet'}</p><button class="btn small" type="button" data-act="upload" data-id="${row.id}">Upload resume</button></article>`).join('') || '<p class="muted">No applicants yet.</p>';
      UI.bind(body, { upload: (node) => UI.openModal({
        title: 'Resume',
        html: '<label class="field">File<input name="resume" type="file" required accept=".pdf,.doc,.docx"/></label>',
        onSubmit: async (data, form) => {
          const file = form.resume.files[0];
          if (!file) throw new Error('Choose a resume');
          const uploaded = await UI.upload(file);
          await UI.api(`/api/applicants/${node.dataset.id}/resume`, { method: 'PUT', body: { resumeUrl: uploaded.url, resumeName: file.name } });
          UI.toast('Resume saved');
          S1.go();
        }
      }) });
    }
    if (tab === 'offers') {
      body.innerHTML = applicants.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.fullName)}</h3>${UI.badge(row.offerStatus)}</div><p>${UI.esc(row.applicationNumber)} · ${UI.esc(row.position)} · stage ${UI.esc(row.stage)}</p>
        ${row.offerStatus === 'None' || row.offerStatus === 'Declined' ? `<button class="btn small" type="button" data-act="ask" data-id="${row.id}">Request offer</button>` : ''}
        ${admin && row.offerStatus === 'Pending admin' ? `<button class="btn small" type="button" data-act="issue" data-id="${row.id}">Issue</button> <button class="btn small ghost" type="button" data-act="accept" data-id="${row.id}">Accepted</button> <button class="btn small danger" type="button" data-act="decline" data-id="${row.id}">Declined</button>` : ''}
      </article>`).join('') || '<p class="muted">No applicants yet.</p>';
      UI.bind(body, {
        ask: async (node) => { await UI.api(`/api/applicants/${node.dataset.id}/offer`, { method: 'PUT', body: {} }); UI.toast('Offer sent to the administrator'); S1.go(); },
        issue: async (node) => { await UI.api(`/api/applicants/${node.dataset.id}/offer`, { method: 'PUT', body: { status: 'Issued' } }); UI.toast('Offer issued'); S1.go(); },
        accept: async (node) => { await UI.api(`/api/applicants/${node.dataset.id}/offer`, { method: 'PUT', body: { status: 'Accepted' } }); UI.toast('Offer accepted'); S1.go(); },
        decline: async (node) => { await UI.api(`/api/applicants/${node.dataset.id}/offer`, { method: 'PUT', body: { status: 'Declined' } }); UI.toast('Offer declined'); S1.go(); }
      });
    }
    if (tab === 'analytics') {
      const stats = await load('/api/recruitment/analytics');
      if (!stats) return;
      const data = stats.data;
      body.innerHTML = `<div class="kpis"><article class="kpi"><span>Open jobs</span><strong>${data.openings}</strong><em>${data.seats} seats</em></article><article class="kpi"><span>Candidates</span><strong>${data.applicants}</strong></article><article class="kpi"><span>Offers</span><strong>${data.offers}</strong></article><article class="kpi"><span>Joining</span><strong>${data.joining}</strong></article></div>
        <article class="card" style="margin-top:12px"><h3>Pipeline</h3>${data.byStage.map((row) => `<div class="flag-row"><span>${UI.esc(row.stage)}</span><strong>${row.count}</strong></div>`).join('')}</article>`;
    }
    if (tab === 'joining') {
      const joining = await load('/api/joining');
      if (!joining) return;
      body.innerHTML = joining.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.applicantName)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.applicationNumber)} · ${UI.esc(row.position)} · ${UI.esc(row.companyName)}</p>${S1.user.role === 'client' && row.status === 'Pending company' ? `<button class="btn small" type="button" data-act="yes" data-id="${row.id}">Send to admin</button>` : ''}${admin && ['Pending company', 'Pending admin'].includes(row.status) ? `<button class="btn small" type="button" data-act="join" data-id="${row.id}">Mark joined</button> <button class="btn small danger" type="button" data-act="no" data-id="${row.id}">Reject</button>` : ''}</article>`).join('') || '<p class="muted">Joining opens when an offer is accepted or a candidate is hired.</p>';
      UI.bind(body, {
        yes: async (node) => { await UI.api(`/api/joining/${node.dataset.id}`, { method: 'PUT', body: { status: 'Approved' } }); UI.toast('Sent to the administrator'); S1.go(); },
        join: async (node) => { await UI.api(`/api/joining/${node.dataset.id}`, { method: 'PUT', body: { status: 'Approved' } }); UI.toast('Marked joined'); S1.go(); },
        no: async (node) => { await UI.api(`/api/joining/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Joining rejected'); S1.go(); }
      });
    }
    if (tab === 'history') {
      const history = await load('/api/employment-history');
      if (!history) return;
      body.innerHTML = `<form id="history-form" class="fields" style="margin-bottom:12px">${UI.field('employeeId', 'Employee', '', { select: [{ value: '', label: 'Not linked yet' }] })}${UI.field('employer', 'Employer', '', { required: true })}${UI.field('roleTitle', 'Role', '', { required: true })}${UI.field('fromDate', 'From', '', { type: 'date' })}${UI.field('toDate', 'To', '', { type: 'date' })}${UI.field('notes', 'Notes', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Add history</button></form>
        ${history.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.roleTitle)}</strong> · ${UI.esc(row.employer)}<br><span class="muted">${UI.esc(row.fromDate || '—')} to ${UI.esc(row.toDate || 'present')} · ${UI.esc(row.notes)}</span></span></div>`).join('') || '<p class="muted">No employment history yet.</p>'}`;
      const people = await load('/api/employees');
      const select = body.querySelector('[name=employeeId]');
      if (people && select) select.innerHTML = `<option value="">Not linked yet</option>${people.data.map((person) => `<option value="${UI.esc(person.id)}">${UI.esc(person.fullName)}</option>`).join('')}`;
      body.querySelector('#history-form').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/employment-history', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('History added');
        S1.go();
      };
    }
  },

  async activities(route, options = {}) {
    const only = options.only || '';
    const res = await load(only ? `/api/activities?type=${only}` : '/api/activities');
    if (!res) return;
    const activityTabs = [['bgv', 'BGV'], ['service', 'Service'], ['device', 'Asset instore'], ['manpower', 'Manpower'], ['advertise', 'Advertise']];
    const tabs = only ? '' : activityTabs.map(([item, label]) => `<button class="tab ${(S1.memory.activityTab || 'bgv') === item ? 'on' : ''}" type="button" data-tab="${item}">${label}</button>`).join('');
    const tab = only || S1.memory.activityTab || 'bgv';
    const rows = res.data.filter((item) => item.type === tab);
    const admin = S1.user.role === 'admin';
    const client = S1.user.role === 'client';
    const cards = rows.map((item) => {
      const steps = (item.payload.steps || []).map((step) => `<li>${UI.esc(step.name)}${step.done ? ` · ${UI.esc(step.docName || 'document on file')}` : ''}</li>`).join('');
      let actions = '';
      if (admin && item.payload.kind !== 'catalog' && item.stage !== 'Published' && item.type !== 'advertise') {
        if (item.stage !== 'Final Report') actions += `<button class="btn small" type="button" data-act="advance" data-id="${item.id}">Advance stage</button>`;
        if (item.stage === 'Final Report' && !item.result) actions += `<button class="btn small" type="button" data-act="result" data-id="${item.id}">Set result</button>`;
        actions += `<button class="btn small ghost" type="button" data-act="file" data-id="${item.id}">Add document</button>`;
      }
      if (admin && item.type === 'advertise') actions += `<button class="btn small" type="button" data-act="live" data-id="${item.id}" data-stage="${item.stage === 'Live' ? 'Paused' : 'Live'}">${item.stage === 'Live' ? 'Pause' : 'Make live'}</button>`;
      if (client && item.payload.kind === 'catalog' && item.type === 'service') actions += `<button class="btn small primary" type="button" data-act="get" data-id="${item.id}" data-title="${UI.esc(item.title)}">Get the service</button>`;
      if (client && item.payload.kind === 'catalog' && item.type === 'device') actions += `<button class="btn small" type="button" data-act="buy" data-id="${item.id}" data-mode="Buy">Buy</button><button class="btn small ghost" type="button" data-act="buy" data-id="${item.id}" data-mode="Rent">Rent</button>`;
      return `<article class="activity-card"><p class="kicker">${UI.esc(item.applicationNumber)} · ${UI.when(item.raisedAt)}</p><h3>${UI.esc(item.title)}</h3><p>${UI.esc(item.description)}</p><p>${UI.badge(item.stage)} ${item.result ? UI.badge(item.result) : ''} <span class="muted">${UI.esc(item.companyName)} · ${UI.esc(item.raisedByName || '')}</span></p>${steps ? `<ul>${steps}</ul>` : ''}${item.payload.engagement ? `<p>${UI.esc(item.payload.engagement)} · ${UI.inr(item.payload.totalBudget || 0)}</p>` : ''}<div class="row-actions">${actions}</div></article>`;
    }).join('');
    const create = [];
    if (!only || only === 'bgv') {
      if (admin || client) create.push(['bgv', 'Raise BGV']);
    }
    if (admin && tab === 'service') create.push(['service', 'Post a service']);
    if (client && tab === 'service') { /* get buttons on cards */ }
    if (admin && tab === 'device') create.push(['device', 'Post a product']);
    if ((admin || client) && tab === 'manpower') create.push(['manpower', 'Manpower request']);
    if ((admin || client) && tab === 'advertise') create.push(['advertise', 'New slide']);
    const buttons = tab === 'bgv' && (admin || client) ? '<button class="btn primary" type="button" data-act="bgv">Raise BGV</button>' : create.filter((item) => item[0] === tab).map((item) => `<button class="btn primary" type="button" data-act="${item[0]}">${item[1]}</button>`).join('');
    let instore = '';
    if (tab === 'device') {
      const assets = await load('/api/assets');
      if (assets) {
        const stock = assets.data.filter((asset) => asset.status === 'In store');
        instore = `<article class="card" style="margin-bottom:12px"><h3>Assets in store</h3>${stock.map((asset) => `<div class="flag-row"><span><strong>${UI.esc(asset.name)}</strong><br><span class="muted">${UI.esc(asset.assetCode)} · ${UI.esc(asset.companyName)}</span></span>${UI.badge(asset.status)}</div>`).join('') || '<p class="muted">Nothing is in store.</p>'}</article>`;
      }
    }
    const root = mount(`${head(options.title || 'Activities', options.text || 'BGV, service, assets in store, manpower, and advertise. Requests land here and in messenger.', buttons)}
      ${tabs ? `<div class="tabs">${tabs}</div>` : ''}${instore}<div class="activity-list">${cards || '<div class="empty">Nothing in this lane yet.</div>'}</div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.activityTab = button.dataset.tab; Pages.activities(); }; });
    const companySelect = UI.field('clientId', 'Company', S1.user.clientId || '', { select: (S1.user.role === 'admin' ? S1.ref.companies : S1.ref.companies.filter((company) => company.id === S1.user.clientId)).map((company) => ({ value: company.id, label: company.name })) });
    UI.bind(root, {
      advance: async (node) => { await UI.api(`/api/activities/${node.dataset.id}`, { method: 'PUT', body: { advance: true } }); UI.toast('Stage advanced'); S1.go(); },
      result: (node) => UI.openModal({
        title: 'Result',
        html: UI.field('result', 'Result', 'Positive', { select: [{ value: 'Positive', label: 'Positive' }, { value: 'Negative', label: 'Negative' }] }),
        onSubmit: async (data) => { await UI.api(`/api/activities/${node.dataset.id}`, { method: 'PUT', body: { result: data.get('result') } }); UI.toast('Result saved'); S1.go(); }
      }),
      file: (node) => UI.openModal({
        title: 'Activity document',
        html: `${UI.field('stepName', 'Verification step', '')}${UI.field('docName', 'Document name', '')}<label class="field">File<input name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx,.doc,.docx"/></label>`,
        onSubmit: async (data) => { await UI.api(`/api/activities/${node.dataset.id}/files`, { method: 'POST', body: data }); UI.toast('Document added'); S1.go(); }
      }),
      live: async (node) => { await UI.api(`/api/activities/${node.dataset.id}`, { method: 'PUT', body: { stage: node.dataset.stage } }); UI.toast('Slide updated'); S1.go(); },
      get: async (node) => { await UI.api('/api/activities', { method: 'POST', body: { type: 'service', serviceId: node.dataset.id, description: 'Requested from the company desk' } }); UI.toast('Service requested'); S1.go(); },
      buy: (node) => UI.openModal({
        title: `${node.dataset.mode} device`,
        html: `${companySelect}${UI.field('model', 'Model')}${UI.field('documentName', 'Document name')}<label class="field">Supporting file<input name="file" type="file"/></label>`,
        onSubmit: async (data, form) => {
          let documentUrl = '';
          if (form.file.files[0]) documentUrl = (await UI.upload(form.file.files[0])).url;
          await UI.api('/api/activities', { method: 'POST', body: { type: 'device', productId: node.dataset.id, mode: node.dataset.mode, clientId: data.get('clientId'), model: data.get('model'), documentName: data.get('documentName'), documentUrl } });
          UI.toast('Order placed');
          S1.go();
        }
      }),
      bgv: () => UI.openModal({
        title: 'Background verification',
        html: `${companySelect}${UI.field('candidateName', 'Candidate', '', { required: true })}${UI.field('description', 'Note', '', { type: 'textarea' })}<div class="stack">${S1.ref.bgvSteps.map((step) => `<label class="checkline"><input type="checkbox" name="services" value="${UI.esc(step)}"/> ${UI.esc(step)}</label>`).join('')}</div>`,
        onSubmit: async (data) => { await UI.api('/api/activities', { method: 'POST', body: { type: 'bgv', clientId: data.get('clientId'), candidateName: data.get('candidateName'), description: data.get('description'), services: data.getAll('services') } }); UI.toast('BGV raised'); S1.go(); }
      }),
      service: () => UI.openModal({
        title: 'Post a service',
        html: `${UI.field('title', 'Service name', '', { required: true })}${UI.field('description', 'Description', '', { type: 'textarea' })}`,
        onSubmit: async (data) => { await UI.api('/api/activities', { method: 'POST', body: { type: 'service', kind: 'catalog', title: data.get('title'), description: data.get('description') } }); UI.toast('Service posted'); S1.go(); }
      }),
      device: () => UI.openModal({
        title: 'Post a product',
        html: `${UI.field('title', 'Product', '', { required: true })}${UI.field('model', 'Model')}${UI.field('description', 'Description', '', { type: 'textarea' })}`,
        onSubmit: async (data) => { await UI.api('/api/activities', { method: 'POST', body: { type: 'device', kind: 'catalog', title: data.get('title'), model: data.get('model'), description: data.get('description') } }); UI.toast('Product posted'); S1.go(); }
      }),
      manpower: () => UI.openModal({
        title: 'Manpower request',
        html: `<div class="fields">${companySelect}${UI.field('engagement', 'Engagement', 'Third party', { select: [{ value: 'Third party', label: 'Third party' }, { value: 'On roll', label: 'On roll' }] })}${UI.field('name', 'Position')}${UI.field('count', 'Headcount', '1', { type: 'number' })}${UI.field('budget', 'Position budget', '', { type: 'number' })}${UI.field('totalBudget', 'Total budget', '', { type: 'number' })}${UI.field('remarks', 'Remarks', '', { type: 'textarea' })}</div>`,
        onSubmit: async (data) => {
          await UI.api('/api/activities', { method: 'POST', body: { type: 'manpower', clientId: data.get('clientId'), engagement: data.get('engagement'), totalBudget: data.get('totalBudget'), remarks: data.get('remarks'), positions: [{ name: data.get('name'), count: data.get('count'), budget: data.get('budget') }] } });
          UI.toast('Manpower request raised');
          S1.go();
        }
      }),
      advertise: () => UI.openModal({
        title: 'Broadcast slide',
        html: `${S1.user.role === 'admin' ? UI.field('clientId', 'Show under', '', { select: [{ value: '', label: 'S1 desk — every company' }].concat(S1.ref.companies.map((company) => ({ value: company.id, label: company.name }))) }) : ''}${UI.field('title', 'Title', '', { required: true })}${UI.field('description', 'Description', '', { type: 'textarea' })}${UI.field('link', 'Link')}${UI.field('mediaUrl', 'Image or video URL')}${UI.field('mediaType', 'Media', 'image', { select: [{ value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }] })}`,
        onSubmit: async (data) => { await UI.api('/api/activities', { method: 'POST', body: { type: 'advertise', title: data.get('title'), description: data.get('description'), link: data.get('link'), mediaUrl: data.get('mediaUrl'), mediaType: data.get('mediaType'), clientId: data.get('clientId') || undefined } }); UI.toast('Slide saved'); S1.go(); }
      })
    });
  },

  async advertise() {
    S1.memory.activityTab = 'advertise';
    return Pages.activities(null, { only: 'advertise', title: 'Broadcasts', text: 'Slides change every 30 seconds after the administrator sets them live. Your company cap is on the company record.' });
  },

  async messenger() {
    if (S1.msgPoll) { clearInterval(S1.msgPoll); S1.msgPoll = null; }
    if (S1.msgStream) { S1.msgStream.close(); S1.msgStream = null; }

    const [channelsRes, usersRes] = await Promise.all([
      load('/api/messages/channels'),
      load('/api/messages/users')
    ]);
    if (!channelsRes) return;

    const channels = channelsRes.data || [];
    let allUsers = (usersRes && usersRes.data) || [];
    let currentTab = S1.memory.messengerTab || 'all';

    // Ensure valid selected channel
    if (!S1.memory.channel || (!channels.some((c) => c.id === S1.memory.channel) && !S1.memory.channel.startsWith('dm:'))) {
      S1.memory.channel = channels[0] ? channels[0].id : 'desk';
    }

    const messages = await load(`/api/messages?channel=${encodeURIComponent(S1.memory.channel)}`);
    if (!messages) return;

    // Helper: Determine recipient details for active chat header
    const getActiveHeader = (channelId) => {
      if (channelId.startsWith('dm:')) {
        const parts = channelId.split(':');
        const otherId = parts[1] === S1.user.id ? parts[2] : parts[1];
        const matchUser = allUsers.find((u) => u.id === otherId) ||
                          channels.find((c) => c.id === channelId);
        const name = matchUser ? (matchUser.name || matchUser.label) : 'Team Member';
        const role = matchUser ? (matchUser.roleLabel || matchUser.title || 'Colleague') : 'Colleague';
        const dept = matchUser ? (matchUser.department || matchUser.companyName || 'Direct Message') : 'Direct Message';
        const status = matchUser ? (matchUser.statusText || 'Available on Runwork One') : 'Active now';
        const initials = name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();

        return `
          <div class="chat-recipient-info">
            <div class="chat-avatar">
              ${initials}
              <span class="chat-online-dot"></span>
            </div>
            <div>
              <div class="chat-recipient-title">
                ${UI.esc(name)}
                <span class="chat-recipient-badge">${UI.esc(role)}</span>
              </div>
              <div class="chat-recipient-meta">
                <span class="chat-status-pulse">Active now</span> · <span>${UI.esc(dept)}</span> · <span class="muted">${UI.esc(status)}</span>
              </div>
            </div>
          </div>
          <button type="button" class="btn primary small" id="focus-composer-btn"
            style="font-size:12px;padding:6px 14px;display:flex;align-items:center;gap:5px;flex-shrink:0;">
            💬 Send Message
          </button>
        `;
      }

      const grp = channels.find((c) => c.id === channelId) || { label: 'General Channel', icon: '💬', description: 'Workplace conversation' };
      return `
        <div class="chat-recipient-info">
          <div class="chat-avatar group-avatar">${grp.icon || '💬'}</div>
          <div>
            <div class="chat-recipient-title">
              ${UI.esc(grp.label)}
              <span class="chat-recipient-badge">Workplace Channel</span>
            </div>
            <div class="chat-recipient-meta">
              <span>${UI.esc(grp.description || 'Active workplace discussion')}</span>
            </div>
          </div>
        </div>
        <button type="button" class="btn ghost small" id="focus-composer-btn"
          style="font-size:12px;padding:6px 14px;display:flex;align-items:center;gap:5px;flex-shrink:0;">
          💬 Write Message
        </button>
      `;
    };

    // Render Messenger Shell
    const root = mount(`
      ${head('Business Messenger', 'Real-time workplace communication, user search, direct 1-to-1 chats, and operations groups.')}
      <div class="page-actions" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="chat-status-pulse" style="font-size:12px;">Real-Time Messenger Online</span>
          <span class="muted" style="font-size:12px;">· Signed in as <strong>${UI.esc(S1.user.name)}</strong></span>
        </div>
        <button class="btn ghost small" type="button" id="edit-profile">Edit My Messenger Status</button>
      </div>

      <section class="chat">
        <!-- Sidebar with User Search & Channel List -->
        <div class="chat-list">
          <div class="chat-search-wrap">
            <span class="chat-search-icon">🔍</span>
            <input type="search" id="chat-user-search" class="chat-search-input" placeholder="Search users by name, role, desk..." autocomplete="off"/>
          </div>

          <div class="chat-tabs">
            <button type="button" class="chat-tab ${currentTab === 'all' ? 'active' : ''}" data-tab="all">All</button>
            <button type="button" class="chat-tab ${currentTab === 'dm' ? 'active' : ''}" data-tab="dm">Direct (${allUsers.length})</button>
            <button type="button" class="chat-tab ${currentTab === 'channels' ? 'active' : ''}" data-tab="channels">Channels</button>
          </div>

          <div class="chat-items-scroll" id="chat-items-container">
            <!-- Dynamically populated -->
          </div>
        </div>

        <!-- Main Chat Area -->
        <div class="chat-main">
          <div class="chat-header" id="chat-header-bar">
            ${getActiveHeader(S1.memory.channel)}
          </div>

          <div class="chat-log" id="chat-log"></div>

          <!-- Typing indicator bar -->
          <div id="chat-typing-bar" style="padding:0 16px;display:none;">
            <div class="typing-indicator">
              <span class="typing-dots-anim">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
              </span>
              <span id="typing-name">Team member is typing...</span>
            </div>
          </div>

          <!-- Quick Interaction Chips -->
          <div class="chat-chips">
            <button type="button" class="chat-chip" data-msg="Hello! Hope you are having a productive day.">👋 Hello!</button>
            <button type="button" class="chat-chip" data-msg="Shift timing update: Can you confirm today's floor roster?">⏱️ Shift update</button>
            <button type="button" class="chat-chip" data-msg="Regarding leave approval: Please review my pending request.">🏖️ Leave query</button>
            <button type="button" class="chat-chip" data-msg="Where can I download the latest monthly payslip?">📄 Payslip check</button>
            <button type="button" class="chat-chip" data-msg="Documents uploaded to the Digital Employee Vault.">💼 Vault verified</button>
          </div>

          <form class="composer" id="composer">
            <input name="body" id="composer-input" placeholder="Write a message... (Press Enter to send)" autocomplete="off" required/>
            <button class="btn primary" type="submit">
              Send
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-left:4px;"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </form>
        </div>
      </section>
    `);

    // Render sidebar items based on search query and active tab
    const renderSidebar = (searchQuery = '') => {
      const container = root.querySelector('#chat-items-container');
      if (!container) return;
      const q = searchQuery.trim().toLowerCase();

      let html = '';

      // If searching, show matching Users first
      if (q) {
        const matchedUsers = allUsers.filter((u) =>
          u.name.toLowerCase().includes(q) ||
          u.role.toLowerCase().includes(q) ||
          (u.title && u.title.toLowerCase().includes(q)) ||
          (u.department && u.department.toLowerCase().includes(q)) ||
          (u.companyName && u.companyName.toLowerCase().includes(q))
        );

        html += `<div class="chat-group-title">Users Matching "${UI.esc(searchQuery)}" (${matchedUsers.length})</div>`;
        if (matchedUsers.length === 0) {
          html += `<div style="padding:16px;text-align:center;font-size:12px;color:var(--muted);">No users found matching "${UI.esc(searchQuery)}".</div>`;
        } else {
          html += matchedUsers.map((u) => {
            const initials = u.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
            const isActive = S1.memory.channel === u.dmChannel;
            return `
              <button type="button" class="chat-item ${isActive ? 'on' : ''}" data-channel="${UI.esc(u.dmChannel)}" data-user-id="${UI.esc(u.id)}">
                <div class="chat-avatar">
                  ${initials}
                  <span class="chat-online-dot"></span>
                </div>
                <div class="chat-item-info">
                  <div class="chat-item-name">
                    <span>${UI.esc(u.name)}</span>
                    <span style="font-size:10px;color:var(--accent);">${UI.esc(u.roleLabel)}</span>
                  </div>
                  <div class="chat-item-sub">${UI.esc(u.department)} · ${UI.esc(u.statusText)}</div>
                </div>
                <span class="chat-msg-action-pill" style="margin-left:auto;font-size:11px;background:#e0f2fe;color:#0284c7;padding:3px 8px;border-radius:999px;font-weight:600;flex-shrink:0;">
                  Message 💬
                </span>
              </button>
            `;
          }).join('');
        }
      } else {
        // Normal View (Tabs)
        const dms = channels.filter((c) => c.kind === 'dm');
        const groups = channels.filter((c) => c.kind !== 'dm');

        if (currentTab === 'all' || currentTab === 'dm') {
          html += `<div class="chat-group-title">Direct Messages (${dms.length})</div>`;
          if (dms.length === 0) {
            html += `
              <div style="padding:10px 12px;font-size:11.5px;color:var(--muted);background:rgba(0,0,0,0.02);border-radius:8px;margin-bottom:8px;">
                💡 <em>Use the search bar above to find colleagues and start a direct chat.</em>
              </div>
            `;
          } else {
            html += dms.map((item) => {
              const initials = item.label.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
              const isSelected = S1.memory.channel === item.id;
              return `
                <button type="button" class="chat-item ${isSelected ? 'on' : ''}" data-channel="${UI.esc(item.id)}">
                  <div class="chat-avatar">
                    ${initials}
                    <span class="chat-online-dot"></span>
                  </div>
                  <div class="chat-item-info">
                    <div class="chat-item-name">
                      <span>${UI.esc(item.label)}</span>
                      <span class="chat-item-time">${item.lastTime ? UI.when(item.lastTime) : ''}</span>
                    </div>
                    <div class="chat-item-sub">${UI.esc(item.lastMsg || item.statusText || 'Click to message')}</div>
                  </div>
                </button>
              `;
            }).join('');
          }

          // Suggest available users to message if tab is DM or All
          const otherSuggested = allUsers.filter((u) => !dms.some((dm) => dm.id === u.dmChannel)).slice(0, 5);
          if (otherSuggested.length > 0 && currentTab === 'dm') {
            html += `<div class="chat-group-title" style="margin-top:12px;">Suggested Team Members (${otherSuggested.length})</div>`;
            html += otherSuggested.map((u) => {
              const initials = u.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
              return `
                <button type="button" class="chat-item" data-channel="${UI.esc(u.dmChannel)}" data-user-id="${UI.esc(u.id)}">
                  <div class="chat-avatar">
                    ${initials}
                    <span class="chat-online-dot"></span>
                  </div>
                  <div class="chat-item-info">
                    <div class="chat-item-name">
                      <span>${UI.esc(u.name)}</span>
                      <span style="font-size:10px;color:var(--muted);">${UI.esc(u.roleLabel)}</span>
                    </div>
                    <div class="chat-item-sub">Start conversation ↗</div>
                  </div>
                </button>
              `;
            }).join('');
          }
        }

        if (currentTab === 'all' || currentTab === 'channels') {
          html += `<div class="chat-group-title" style="margin-top:10px;">Workplace Channels (${groups.length})</div>`;
          html += groups.map((item) => {
            const isSelected = S1.memory.channel === item.id;
            return `
              <button type="button" class="chat-item ${isSelected ? 'on' : ''}" data-channel="${UI.esc(item.id)}">
                <div class="chat-avatar group-avatar">${item.icon || '💬'}</div>
                <div class="chat-item-info">
                  <div class="chat-item-name">
                    <span>${UI.esc(item.label)}</span>
                  </div>
                  <div class="chat-item-sub">${UI.esc(item.description || 'Company discussion')}</div>
                </div>
              </button>
            `;
          }).join('');
        }
      }

      container.innerHTML = html;

      // Bind channel click handlers
      container.querySelectorAll('[data-channel]').forEach((button) => {
        button.onclick = () => {
          const nextChannel = button.dataset.channel;
          if (S1.memory.channel !== nextChannel) {
            S1.memory.channel = nextChannel;
            Pages.messenger();
          }
        };
      });
    };

    // Paint messages in Chat Log
    const paint = (list) => {
      const log = root.querySelector('#chat-log');
      if (!log) return;

      if (!list || list.length === 0) {
        log.innerHTML = `
          <div class="chat-date-pill">Today</div>
          <div class="empty" style="padding:40px 20px;text-align:center;">
            <div style="font-size:36px;margin-bottom:8px;">💬</div>
            <strong style="color:var(--text);font-size:15px;">No messages in this conversation yet.</strong>
            <p class="muted" style="font-size:12.5px;margin:6px 0 16px;">Send a message to start communicating with this team member in real time.</p>
            <button type="button" class="btn primary small" id="empty-state-msg-btn"
              style="margin:0 auto;display:inline-flex;align-items:center;gap:6px;padding:8px 18px;font-size:13px;border-radius:999px;">
              💬 Start Conversation
            </button>
          </div>
        `;
        const emptyBtn = log.querySelector('#empty-state-msg-btn');
        if (emptyBtn) {
          emptyBtn.onclick = () => {
            const input = root.querySelector('#composer-input');
            if (input) {
              input.focus();
              input.placeholder = "Type your first message here and press Enter...";
            }
          };
        }
        return;
      }

      log.innerHTML = `
        <div class="chat-date-pill">Today</div>
        ${list.map((message) => {
          const isMine = message.senderId === S1.user.id;
          return `
            <div class="bubble ${isMine ? 'mine' : ''}">
              <small>
                <span>${UI.esc(message.senderName)} · ${UI.esc(message.senderRole)}</span>
                <span>${UI.when(message.createdAt)}${isMine ? '<span class="bubble-check">✓✓</span>' : ''}</span>
              </small>
              <div class="bubble-text">${UI.esc(message.body)}</div>
            </div>
          `;
        }).join('')}
      `;
      log.scrollTop = log.scrollHeight;
    };

    // Initial paint of messages & sidebar
    paint(messages.data);
    renderSidebar();

    // Setup User Search input
    const searchInput = root.querySelector('#chat-user-search');
    let searchDebounce;
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          renderSidebar(e.target.value);
        }, 150);
      });
    }

    // Setup Tab Pills (All / Direct / Channels)
    root.querySelectorAll('.chat-tab').forEach((tabBtn) => {
      tabBtn.onclick = () => {
        currentTab = tabBtn.dataset.tab;
        S1.memory.messengerTab = currentTab;
        root.querySelectorAll('.chat-tab').forEach((b) => b.classList.remove('active'));
        tabBtn.classList.add('active');
        renderSidebar(searchInput ? searchInput.value : '');
      };
    });

    // Wire Header Focus Message Button
    const focusBtn = root.querySelector('#focus-composer-btn');
    if (focusBtn) {
      focusBtn.onclick = () => {
        const composerInput = root.querySelector('#composer-input');
        if (composerInput) {
          composerInput.focus();
          composerInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    }

    // Quick Action Chips
    root.querySelectorAll('.chat-chip').forEach((chip) => {
      chip.onclick = () => {
        const composerInput = root.querySelector('#composer-input');
        if (composerInput) {
          composerInput.value = chip.dataset.msg;
          composerInput.focus();
        }
      };
    });

    // Show/Hide Typing Indicator
    const typingBar = root.querySelector('#chat-typing-bar');
    const showTyping = (nameText) => {
      if (typingBar) {
        const nameEl = root.querySelector('#typing-name');
        if (nameEl) nameEl.textContent = `${nameText} is typing...`;
        typingBar.style.display = 'block';
        const log = root.querySelector('#chat-log');
        if (log) log.scrollTop = log.scrollHeight;
      }
    };
    const hideTyping = () => {
      if (typingBar) typingBar.style.display = 'none';
    };

    // Composer Submit Handler (Optimistic Send)
    const composer = root.querySelector('#composer');
    composer.onsubmit = async (event) => {
      event.preventDefault();
      const input = composer.querySelector('input[name="body"]');
      const body = input.value.trim();
      if (!body) return;

      input.value = '';

      // Optimistic Render
      const tempMsg = {
        id: 'tmp_' + Date.now(),
        senderId: S1.user.id,
        senderName: S1.user.name,
        senderRole: S1.user.role,
        body,
        createdAt: new Date().toISOString()
      };
      const currentList = Array.from(root.querySelectorAll('.bubble')).map(() => ({})); // placeholder
      const log = root.querySelector('#chat-log');
      if (log) {
        const bubble = document.createElement('div');
        bubble.className = 'bubble mine';
        bubble.innerHTML = `
          <small>
            <span>${UI.esc(S1.user.name)} · ${UI.esc(S1.user.role)}</span>
            <span>Just now<span class="bubble-check">✓✓</span></span>
          </small>
          <div class="bubble-text">${UI.esc(body)}</div>
        `;
        log.appendChild(bubble);
        log.scrollTop = log.scrollHeight;
      }

      // Simulate typing indicator if in DM
      if (S1.memory.channel.startsWith('dm:')) {
        setTimeout(() => {
          showTyping('Colleague');
        }, 300);
      }

      // Actual API Send
      try {
        await UI.api('/api/messages', { method: 'POST', body: { channel: S1.memory.channel, body } });
        const fresh = await UI.api(`/api/messages?channel=${encodeURIComponent(S1.memory.channel)}`);
        hideTyping();
        paint(fresh.data);
      } catch (err) {
        hideTyping();
        UI.toast('Failed to send message: ' + (err.message || 'Network error'));
      }
    };

    // Edit Profile Modal
    root.querySelector('#edit-profile').onclick = () => UI.openModal({
      title: 'Messenger Profile & Status',
      html: `
        ${UI.field('name', 'Display Name', S1.user.name)}
        ${UI.field('phone', 'Phone Number', S1.user.phone)}
        ${UI.field('statusText', 'Messenger Status Note', S1.user.statusText || 'Available on Runwork One', { span: true })}
      `,
      onSubmit: async (data) => {
        S1.user = (await UI.api('/api/profile', { method: 'PUT', body: Object.fromEntries(data.entries()) })).data;
        UI.toast('Messenger profile updated');
        S1.go();
      }
    });

    // Real-Time Server-Sent Events (SSE) Stream
    try {
      const streamUrl = `/api/messages/stream?token=${encodeURIComponent(localStorage.getItem('s1_token') || '')}`;
      const stream = new EventSource(streamUrl);
      S1.msgStream = stream;

      stream.onmessage = (event) => {
        try {
          const newMsg = JSON.parse(event.data);
          if (newMsg && newMsg.channel === S1.memory.channel) {
            hideTyping();
            // Re-fetch or append
            UI.api(`/api/messages?channel=${encodeURIComponent(S1.memory.channel)}`).then((res) => {
              if (res && res.data) paint(res.data);
            }).catch(() => {});
          }
        } catch (_) {}
      };
    } catch (_) {}

    // Polling fallback every 2.5s
    S1.msgPoll = setInterval(async () => {
      try {
        const fresh = await UI.api(`/api/messages?channel=${encodeURIComponent(S1.memory.channel)}`);
        if (fresh && fresh.data) {
          paint(fresh.data);
        }
      } catch (_) {}
    }, 2500);

    // Stop hook when user navigates away
    S1.addStop(() => {
      if (S1.msgPoll) { clearInterval(S1.msgPoll); S1.msgPoll = null; }
      if (S1.msgStream) { S1.msgStream.close(); S1.msgStream = null; }
    });
  },

  async leads() {
    const res = await load('/api/leads');
    if (!res) return;
    const rows = res.data.map((lead) => `<tr><td><strong>${UI.esc(lead.companyName)}</strong><br><span class="muted">${UI.esc(lead.businessType)}</span></td>
      <td>${UI.esc(lead.contactName)}<br><a href="tel:${UI.esc(String(lead.phone).replace(/[^\d+]/g, ''))}">${UI.esc(lead.phone)}</a></td>
      <td>${UI.badge(lead.priority)} ${UI.badge(lead.status)}</td><td>${UI.esc(lead.assignedTo)}</td><td>${UI.esc(lead.notes)}</td>
      <td><button class="btn small" type="button" data-act="done" data-id="${lead.id}">Update</button></td></tr>`).join('');
    const root = mount(`${head('Leads and priority calls', 'Assign a lead to an administrator and call the contact from the row.', '<button class="btn primary" type="button" data-act="add">Add lead</button>')}
      <div class="table-wrap"><table><thead><tr><th>Company</th><th>Contact</th><th>Priority</th><th>Assigned</th><th>Notes</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`);
    UI.bind(root, {
      add: () => UI.openModal({
        title: 'Lead',
        html: `<div class="fields">${UI.field('companyName', 'Company', '', { required: true })}${UI.field('contactName', 'Contact', '', { required: true })}${UI.field('phone', 'Phone')}${UI.field('email', 'Email', '', { type: 'email' })}${UI.field('businessType', 'Business type')}${UI.field('priority', 'Priority', 'Normal', { select: [{ value: 'Normal', label: 'Normal' }, { value: 'High', label: 'High' }] })}${UI.field('assignedTo', 'Assign to', S1.user.name)}${UI.field('notes', 'Notes', '', { type: 'textarea' })}</div>`,
        onSubmit: async (data) => { await UI.api('/api/leads', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Lead added'); S1.go(); }
      }),
      done: (node) => UI.openModal({
        title: 'Update lead',
        html: `${UI.field('status', 'Status', 'Contacted')}${UI.field('assignedTo', 'Assigned to', S1.user.name)}${UI.field('priority', 'Priority', 'Normal', { select: [{ value: 'Normal', label: 'Normal' }, { value: 'High', label: 'High' }] })}${UI.field('notes', 'Notes', '', { type: 'textarea' })}`,
        onSubmit: async (data) => { await UI.api(`/api/leads/${node.dataset.id}`, { method: 'PUT', body: Object.fromEntries(data.entries()) }); UI.toast('Lead updated'); S1.go(); }
      })
    });
  },

  async tasks() {
    const tab = S1.memory.perfTab || 'tasks';
    const tabs = ['tasks', 'goals', 'kras', 'reviews', 'analytics', 'requests'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('Task and performance', 'Assign work with a deadline and priority, track it, and send goals, KRAs, and appraisals through approval.')}<div class="tabs">${tabs}</div><div id="perf-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.perfTab = button.dataset.tab; Pages.tasks(); }; });
    const body = root.querySelector('#perf-body');
    const people = await load('/api/employees');
    if (!people) return;
    const personOptions = people.data.map((person) => ({ value: person.id, label: `${person.fullName} · ${person.companyName}` }));
    if (tab === 'tasks') {
      const res = await load('/api/tasks');
      if (!res) return;
      const mine = S1.user.role === 'employee';
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px">${mine ? '<button class="btn primary" type="button" data-act="request">Request a task</button>' : '<button class="btn primary" type="button" data-act="add">Assign task</button>'}${S1.user.role === 'client' ? '<button class="btn ghost" type="button" data-act="request">Request approval</button>' : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>Task</th><th>Person</th><th>Priority</th><th>Due</th><th>Progress</th><th>Status</th><th></th></tr></thead><tbody>
        ${res.data.filter((task) => task.approvalStatus === 'Approved').map((task) => `<tr><td><strong>${UI.esc(task.title)}</strong><br><span class="muted">${UI.esc(task.description)}</span></td><td>${UI.esc(task.employeeName)}</td><td>${UI.badge(task.priority)}</td><td>${UI.esc(task.dueDate)} ${task.overdue ? UI.badge('Late') : ''}</td><td>${task.progress}%</td><td>${UI.badge(task.status)}</td><td><button class="btn small" type="button" data-act="track" data-id="${task.id}" data-progress="${task.progress}" data-status="${UI.esc(task.status)}" data-priority="${UI.esc(task.priority)}">Track</button></td></tr>`).join('') || '<tr><td colspan="7">No assigned tasks yet.</td></tr>'}
        </tbody></table></div>`;
      const send = (request) => UI.openModal({
        title: request ? 'Task request' : 'Assign task',
        html: `<div class="fields">${UI.field('employeeId', 'Employee', '', { select: personOptions })}${UI.field('title', 'Title', '', { required: true })}${UI.field('priority', 'Priority', 'Normal', { select: ['Low', 'Normal', 'High', 'Urgent'].map((item) => ({ value: item, label: item })) })}${UI.field('dueDate', 'Deadline', '', { type: 'date', required: true })}${UI.field('description', 'Notes', '', { type: 'textarea' })}</div>`,
        submitLabel: request ? 'Send for approval' : 'Assign',
        onSubmit: async (data) => {
          const payload = Object.fromEntries(data.entries());
          if (request) payload.request = 'yes';
          await UI.api('/api/tasks', { method: 'POST', body: payload });
          UI.toast(request ? 'Request sent' : 'Task assigned');
          S1.go();
        }
      });
      UI.bind(body, {
        add: () => send(false),
        request: () => send(true),
        track: (node) => UI.openModal({
          title: 'Track task',
          html: `${UI.field('status', 'Status', node.dataset.status, { select: ['Open', 'In progress', 'Done'].map((item) => ({ value: item, label: item })) })}${UI.field('progress', 'Progress %', node.dataset.progress, { type: 'number' })}${UI.field('priority', 'Priority', node.dataset.priority, { select: ['Low', 'Normal', 'High', 'Urgent'].map((item) => ({ value: item, label: item })) })}`,
          onSubmit: async (data) => { await UI.api(`/api/tasks/${node.dataset.id}`, { method: 'PUT', body: Object.fromEntries(data.entries()) }); UI.toast('Task updated'); S1.go(); }
        })
      });
    }
    if (tab === 'goals') {
      const res = await load('/api/goals');
      if (!res) return;
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px">${S1.user.role === 'employee' ? '' : '<button class="btn primary" type="button" data-act="add">Add KPI goal</button>'}</div>
        ${res.data.map((goal) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(goal.title)}</h3><span>${UI.badge(goal.status)} ${goal.attainment}%</span></div><p>${UI.esc(goal.employeeName)} · ${UI.esc(goal.kpi)} · ${goal.achieved} / ${goal.target} · ${UI.esc(goal.period)}</p><div class="meter"><span style="width:${Math.min(100, goal.attainment)}%"></span></div>${goal.status === 'Active' ? `<button class="btn small" type="button" data-act="achieved" data-id="${goal.id}" data-achieved="${goal.achieved}">Update achieved</button>` : ''}</article>`).join('') || '<p class="muted">No goals yet.</p>'}`;
      UI.bind(body, {
        add: () => UI.openModal({
          title: 'Goal and KPI',
          html: `<div class="fields">${UI.field('employeeId', 'Employee', '', { select: personOptions })}${UI.field('title', 'Goal', '', { required: true })}${UI.field('kpi', 'KPI', '', { required: true })}${UI.field('target', 'Target', '', { type: 'number' })}${UI.field('achieved', 'Achieved', 0, { type: 'number' })}${UI.field('period', 'Period', '2026-Q4')}</div>`,
          onSubmit: async (data) => { await UI.api('/api/goals', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Goal saved'); S1.go(); }
        }),
        achieved: (node) => UI.openModal({
          title: 'Update achieved',
          html: UI.field('achieved', 'Achieved', node.dataset.achieved, { type: 'number' }),
          onSubmit: async (data) => { await UI.api(`/api/goals/${node.dataset.id}`, { method: 'PUT', body: { achieved: data.get('achieved') } }); UI.toast('KPI updated'); S1.go(); }
        })
      });
    }
    if (tab === 'kras') {
      const res = await load('/api/kras');
      if (!res) return;
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px">${S1.user.role === 'employee' ? '' : '<button class="btn primary" type="button" data-act="add">Add KRA</button>'}</div>
        <div class="table-wrap"><table><thead><tr><th>Employee</th><th>KRA</th><th>Weight</th><th>Description</th></tr></thead><tbody>
        ${res.data.map((kra) => `<tr><td>${UI.esc(kra.employeeName)}</td><td>${UI.esc(kra.title)}</td><td>${kra.weight}%</td><td>${UI.esc(kra.description)}</td></tr>`).join('') || '<tr><td colspan="4">No KRAs yet.</td></tr>'}
        </tbody></table></div>`;
      UI.bind(body, { add: () => UI.openModal({
        title: 'KRA',
        html: `<div class="fields">${UI.field('employeeId', 'Employee', '', { select: personOptions })}${UI.field('title', 'KRA', '', { required: true })}${UI.field('weight', 'Weight %', 20, { type: 'number' })}${UI.field('description', 'What good looks like', '', { type: 'textarea' })}</div>`,
        onSubmit: async (data) => { await UI.api('/api/kras', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('KRA added'); S1.go(); }
      }) });
    }
    if (tab === 'reviews') {
      const res = await load('/api/reviews');
      if (!res) return;
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px"><button class="btn primary" type="button" data-act="add">${S1.user.role === 'employee' ? 'Request appraisal' : 'New appraisal'}</button></div>
        ${res.data.map((review) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(review.employeeName)} · ${UI.esc(review.period)}</h3>${UI.badge(review.status)}</div><p>Rating ${review.rating} / 5 · ${UI.esc(review.reviewer)}</p><p>${UI.esc(review.appraisal)}</p><p class="muted">${UI.esc(review.comments)}</p>${S1.user.role === 'client' && ['Pending company', 'Pending admin'].includes(review.status) ? `<button class="btn small" type="button" data-act="send" data-id="${review.id}">Finalise</button>` : ''}${S1.user.role === 'admin' && review.status === 'Pending admin' ? `<button class="btn small" type="button" data-act="final" data-id="${review.id}">Finalise</button> <button class="btn small danger" type="button" data-act="reject" data-id="${review.id}">Reject</button>` : ''}</article>`).join('') || '<p class="muted">No reviews yet.</p>'}`;
      UI.bind(body, {
        add: () => UI.openModal({
          title: S1.user.role === 'employee' ? 'Request appraisal' : 'Performance review',
          html: `<div class="fields">${S1.user.role === 'employee' ? '' : UI.field('employeeId', 'Employee', '', { select: personOptions })}${UI.field('period', 'Period', '2026-H2', { required: true })}${S1.user.role === 'employee' ? '' : UI.field('rating', 'Rating 1–5', 4, { type: 'number' })}${UI.field('appraisal', 'Appraisal', '', { type: 'textarea' })}${UI.field('comments', 'Comments', '', { type: 'textarea' })}</div>`,
          onSubmit: async (data) => { await UI.api('/api/reviews', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Review saved'); S1.go(); }
        }),
        send: (node) => UI.openModal({
          title: 'Company rating',
          html: `${UI.field('rating', 'Rating 1–5', 4, { type: 'number' })}${UI.field('appraisal', 'Appraisal', '', { type: 'textarea' })}`,
          onSubmit: async (data) => { await UI.api(`/api/reviews/${node.dataset.id}/status`, { method: 'PUT', body: { status: 'Final', rating: data.get('rating'), appraisal: data.get('appraisal') } }); UI.toast('Appraisal recorded'); S1.go(); }
        }),
        final: async (node) => { await UI.api(`/api/reviews/${node.dataset.id}/status`, { method: 'PUT', body: { status: 'Final' } }); UI.toast('Appraisal finalised'); S1.go(); },
        reject: async (node) => { await UI.api(`/api/reviews/${node.dataset.id}/status`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Review rejected'); S1.go(); }
      });
    }
    if (tab === 'analytics') {
      const res = await load('/api/performance');
      if (!res) return;
      const data = res.data;
      body.innerHTML = `${kpis([
        { label: 'Open tasks', value: data.open, note: `${data.overdue} overdue` },
        { label: 'Completed', value: data.done, note: 'Closed tasks' },
        { label: 'Avg progress', value: `${data.avgProgress}%`, note: 'Open work' },
        { label: 'KPI attainment', value: `${data.attainment}%`, note: `Rating ${data.avgRating || '—'} from ${data.reviews} reviews` }
      ])}
        <article class="card"><h3>Open work by priority</h3>${data.priorities.map((item) => `<div class="flag-row"><span>${UI.esc(item.name)}</span><strong>${item.count}</strong></div>`).join('')}</article>`;
    }
    if (tab === 'requests') {
      const [tasks, goals, reviews] = await Promise.all([load('/api/tasks'), load('/api/goals'), load('/api/reviews')]);
      if (!tasks || !goals || !reviews) return;
      const waitingTasks = tasks.data.filter((task) => task.approvalStatus !== 'Approved' && task.approvalStatus !== 'Rejected');
      const waitingGoals = goals.data.filter((goal) => goal.approvalStatus === 'Pending admin');
      const waitingReviews = reviews.data.filter((review) => ['Pending company', 'Pending admin'].includes(review.status));
      const act = (kind, id) => {
        const allowed = kind === 'goal' ? S1.user.role === 'admin' : (S1.user.role === 'admin' || S1.user.role === 'client');
        return allowed ? `<button class="btn small" type="button" data-act="yes" data-kind="${kind}" data-id="${id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-kind="${kind}" data-id="${id}">Reject</button>` : UI.badge('Waiting');
      };
      body.innerHTML = `<article class="card"><h3>Task requests</h3>${waitingTasks.map((task) => `<div class="flag-row"><span><strong>${UI.esc(task.title)}</strong><br><span class="muted">${UI.esc(task.employeeName)} · due ${UI.esc(task.dueDate)} · ${UI.esc(task.priority)}</span></span>${act('task', task.id)}</div>`).join('') || '<p class="muted">No task requests.</p>'}</article>
        <article class="card" style="margin-top:12px"><h3>Goal requests</h3>${waitingGoals.map((goal) => `<div class="flag-row"><span><strong>${UI.esc(goal.title)}</strong><br><span class="muted">${UI.esc(goal.employeeName)} · ${UI.esc(goal.kpi)}</span></span>${act('goal', goal.id)}</div>`).join('') || '<p class="muted">No goal requests.</p>'}</article>
        <article class="card" style="margin-top:12px"><h3>Appraisal requests</h3>${waitingReviews.map((review) => `<div class="flag-row"><span><strong>${UI.esc(review.employeeName)}</strong><br><span class="muted">${UI.esc(review.period)} · rating ${review.rating}</span></span>${act('review', review.id)}</div>`).join('') || '<p class="muted">No appraisals waiting.</p>'}</article>`;
      UI.bind(body, {
        yes: async (node) => {
          if (node.dataset.kind === 'task') await UI.api(`/api/tasks/${node.dataset.id}/approval`, { method: 'PUT', body: { status: 'Approved' } });
          if (node.dataset.kind === 'goal') await UI.api(`/api/goals/${node.dataset.id}`, { method: 'PUT', body: { status: 'Approved' } });
          if (node.dataset.kind === 'review') await UI.api(`/api/reviews/${node.dataset.id}/status`, { method: 'PUT', body: { status: 'Final' } });
          UI.toast('Approved');
          S1.go();
        },
        no: async (node) => {
          if (node.dataset.kind === 'task') await UI.api(`/api/tasks/${node.dataset.id}/approval`, { method: 'PUT', body: { status: 'Rejected' } });
          if (node.dataset.kind === 'goal') await UI.api(`/api/goals/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } });
          if (node.dataset.kind === 'review') await UI.api(`/api/reviews/${node.dataset.id}/status`, { method: 'PUT', body: { status: 'Rejected' } });
          UI.toast('Rejected');
          S1.go();
        }
      });
    }
  },

  async documents() {
    const tab = S1.memory.docTab || 'letters';
    const tabs = ['letters', 'templates', 'fields', 'forms', 'requests'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('Documents', 'Offer, appointment, experience, relieving, salary certificate, payslip, and the QR identity card use the company template. Ask HR when a letter needs approval.')}<div class="tabs">${tabs}</div><div id="doc-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.docTab = button.dataset.tab; Pages.documents(); }; });
    const body = root.querySelector('#doc-body');
    const canEdit = S1.user.role !== 'employee';
    const letters = [
      ['payslip', 'Payslip'], ['offer', 'Offer letter'], ['appointment', 'Appointment letter'], ['idcard', 'ID card with QR'],
      ['experience', 'Experience letter'], ['salarycert', 'Salary certificate'], ['relieving', 'Relieving letter']
    ];
    const [templates, people, requests, fields, forms, tokens] = await Promise.all([
      load('/api/templates'),
      canEdit ? load('/api/employees') : Promise.resolve({ data: [] }),
      load('/api/document-requests'),
      load('/api/custom-fields'),
      load('/api/custom-forms'),
      load('/api/template-tokens')
    ]);
    if (!templates || !people || !requests || !fields || !forms || !tokens) return;
    const tokenHint = tokens.data.map((item) => `{{${item}}}`).join(' ');
    if (tab === 'letters') {
      const approved = new Set(requests.data.filter((row) => row.status === 'Approved').map((row) => row.kind));
      const mine = S1.user.role === 'employee';
      body.innerHTML = mine
        ? `<div class="page-actions">${letters.map(([kind, label]) => kind === 'payslip' || approved.has(kind) ? `<button class="btn ${kind === 'payslip' ? '' : 'ghost'}" type="button" data-act="doc" data-kind="${kind}" data-id="${S1.user.employeeId}">${label}</button>` : `<span class="muted">${label} · ask HR</span>`).join(' ')}</div>`
        : `<div class="fields">${UI.field('employeeId', 'Employee', people.data[0] ? people.data[0].id : '', { select: people.data.map((person) => ({ value: person.id, label: `${person.fullName} · ${person.employeeCode}` })) })}
            <div class="page-actions span-2">${letters.map(([kind, label]) => `<button class="btn ${kind === 'payslip' ? '' : 'ghost'}" type="button" data-letter="${kind}">${label}</button>`).join('')}</div></div>`;
      body.querySelectorAll('[data-letter]').forEach((button) => { button.onclick = () => UI.openDoc(`/api/documents/${button.dataset.letter}/${body.querySelector('[name=employeeId]').value}`); });
      UI.bind(body, { doc: (node) => UI.openDoc(`/api/documents/${node.dataset.kind}/${node.dataset.id}`) });
    }
    if (tab === 'templates') {
      body.innerHTML = `${canEdit ? '<div class="page-actions" style="margin-bottom:12px"><button class="btn" type="button" data-act="add">New template</button></div>' : ''}
        <p class="muted">Map employee data with ${UI.esc(tokenHint)}. Turn on “use as the letter” when this text should replace the standard layout.</p>
        <div class="activity-list" style="margin-top:12px">${templates.data.map((item) => `<article class="activity-card"><p class="kicker">${UI.esc(item.category)} · ${UI.esc(item.ownerRole)}${item.useBody ? ' · custom layout' : ''}</p><h3>${UI.esc(item.name)}</h3><p>Watermark: ${UI.esc(item.watermark)}</p><p class="muted">${UI.esc(item.body)}</p>${canEdit && (S1.user.role === 'admin' || item.ownerId === S1.user.clientId) ? `<button class="btn small" type="button" data-act="edit" data-id="${item.id}">Edit</button>` : ''}</article>`).join('')}</div>`;
      const editor = (item) => UI.openModal({
        title: item ? 'Edit template' : 'Template',
        html: `<div class="fields">${UI.field('name', 'Name', item ? item.name : '')}${UI.field('category', 'Type', item ? item.category : 'payslip', { select: letters.map(([value, label]) => ({ value, label })).concat([{ value: 'invoice', label: 'Invoice' }, { value: 'quotation', label: 'Quotation' }]) })}${UI.field('watermark', 'Watermark', item ? item.watermark : 'S1 HR SOLUTION')}${UI.field('useBody', 'Use this text as the letter', item && item.useBody ? 'yes' : 'no', { select: [{ value: 'no', label: 'Keep the standard layout' }, { value: 'yes', label: 'Use this text as the letter' }] })}${UI.field('mapping', 'Mapped fields', item ? item.mapping : 'employee.fullName, employee.employeeCode, pay.net')}${UI.field('body', 'Letter text', item ? item.body : 'Dear {{employee.fullName}},', { type: 'textarea' })}</div>`,
        onSubmit: async (data) => {
          const payload = Object.fromEntries(data.entries());
          if (item) await UI.api(`/api/templates/${item.id}`, { method: 'PUT', body: payload });
          else await UI.api('/api/templates', { method: 'POST', body: payload });
          UI.toast('Template saved');
          S1.go();
        }
      });
      UI.bind(body, {
        add: () => editor(null),
        edit: (node) => editor(templates.data.find((item) => item.id === node.dataset.id))
      });
    }
    if (tab === 'fields') {
      const person = S1.user.role === 'employee' ? (await load(`/api/employees/${S1.user.employeeId}`)) : null;
      if (S1.user.role === 'employee' && !person) return;
      body.innerHTML = `${canEdit ? `<form id="field-form" class="fields" style="margin-bottom:12px">${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('key', 'Key', 'nominee')}${UI.field('label', 'Label', '')}${UI.field('type', 'Type', 'text', { select: ['text', 'number', 'date', 'select'].map((item) => ({ value: item, label: item })) })}${UI.field('options', 'Options, separated by commas')}${UI.field('required', 'Required', 'no', { select: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] })}<button class="btn span-2" type="submit">Save field</button></form>` : ''}
        <div class="table-wrap"><table><thead><tr><th>Label</th><th>Token</th><th>Type</th><th>Required</th></tr></thead><tbody>
          ${fields.data.map((field) => `<tr><td>${UI.esc(field.label)}</td><td>{{custom.${UI.esc(field.key)}}}</td><td>${UI.esc(field.type)}</td><td>${field.required ? 'Yes' : 'No'}</td></tr>`).join('') || '<tr><td colspan="4">No custom fields yet.</td></tr>'}
        </tbody></table></div>
        ${person ? `<form id="custom-values" class="fields" style="margin-top:12px"><h3 class="span-2">My details</h3>${fields.data.map((field) => UI.field(field.key, field.label, person.data.custom[field.key] || '')).join('')}<button class="btn span-2" type="submit">Save my details</button></form>` : ''}`;
      const form = body.querySelector('#field-form');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/custom-fields', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Field saved');
        S1.go();
      };
      const values = body.querySelector('#custom-values');
      if (values) values.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api(`/api/employees/${S1.user.employeeId}/custom`, { method: 'PUT', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Details saved');
        S1.go();
      };
    }
    if (tab === 'forms') {
      body.innerHTML = `${canEdit ? `<form id="form-builder" class="fields" style="margin-bottom:12px">${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('name', 'Form name', '')}${UI.field('category', 'Used on', 'experience', { select: letters.map(([value, label]) => ({ value, label })).concat([{ value: 'ask', label: 'Ask HR' }]) })}${UI.field('fieldKeys', 'Field keys', fields.data.map((field) => field.key).join(', '))}<button class="btn span-2" type="submit">Save form</button></form>` : '<p class="muted">These forms collect the custom fields used on a letter.</p>'}
        ${forms.data.map((form) => `<article class="card" style="margin-bottom:10px"><h3>${UI.esc(form.name)}</h3><p>${UI.esc(form.category)} · ${form.fieldKeys.map((key) => UI.esc(key)).join(', ')}</p></article>`).join('') || ''}`;
      const form = body.querySelector('#form-builder');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/custom-forms', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Form saved');
        S1.go();
      };
    }
    if (tab === 'requests') {
      const kinds = letters.map(([value, label]) => ({ value, label })).concat([{ value: 'ask', label: 'Ask HR' }]);
      body.innerHTML = `<form id="doc-request" class="fields" style="margin-bottom:12px">${canEdit ? UI.field('employeeId', 'Employee', '', { select: people.data.map((person) => ({ value: person.id, label: person.fullName })) }) : ''}${UI.field('kind', 'Document', 'experience', { select: kinds })}${UI.field('message', 'What you need', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Send for approval</button></form>
        ${requests.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.kind)} · ${UI.esc(row.employeeName)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.applicationNumber)}</p><p class="muted">${UI.esc(row.message)}</p>${row.reply ? `<p>${UI.esc(row.reply)}</p>` : ''}${row.status === 'Approved' && row.kind !== 'ask' ? `<button class="btn small" type="button" data-act="open" data-kind="${row.kind}" data-id="${row.employeeId}">Open</button>` : ''}</article>`).join('') || ''}`;
      body.querySelector('#doc-request').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/document-requests', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Request sent');
        S1.go();
      };
      UI.bind(body, { open: (node) => UI.openDoc(`/api/documents/${node.dataset.kind}/${node.dataset.id}`) });
    }
  },

  async statutory() {
    const links = S1.ref.statutory;
    mount(`${head('Statutory logins', 'PF, ESIC, TDS, and the other portals open in a new tab.')}
      <div class="grid-3">${links.map((link) => `<a class="stat-card" href="${UI.esc(link.url)}" target="_blank" rel="noreferrer"><p class="kicker">External</p><h3>${UI.esc(link.name)}</h3><p class="muted">${UI.esc(link.details)}</p></a>`).join('')}</div>`);
  },

  async search(route) {
    const query = route.params.get('q') || '';
    let groups = '';
    if (query.length >= 2) {
      const res = await load(`/api/search?q=${encodeURIComponent(query)}`);
      if (!res) return;
      groups = Object.entries(res.data).map(([name, hits]) => `<section class="search-group"><h3>${UI.esc(name)}</h3>${hits.length ? hits.map((hit) => `<a class="search-hit" href="${UI.esc(hit.href)}"><strong>${UI.esc(hit.label)}</strong><span class="muted">${UI.esc(hit.meta)}</span></a>`).join('') : '<p class="muted">No matches.</p>'}</section>`).join('');
    }
    mount(`${head('Search', 'Companies, people, activity numbers, and leads.')}
      <form id="search-form" class="composer" style="padding:0"><input name="q" value="${UI.esc(query)}" placeholder="Name, email, or application number"/><button class="btn primary" type="submit">Search</button></form>
      ${query && query.length < 2 ? '<p class="muted">Type at least 2 characters.</p>' : ''}${groups}`);
    document.getElementById('search-form').onsubmit = (event) => {
      event.preventDefault();
      location.hash = `#/search?q=${encodeURIComponent(new FormData(event.target).get('q') || '')}`;
    };
  },

  async help() {
    const tickets = await load('/api/tickets');
    if (!tickets) return;
    let posh = { data: [] };
    if (S1.user.role !== 'client') {
      posh = await load('/api/posh');
      if (!posh) return;
    }
    const admin = S1.user.role === 'admin';
    const root = mount(`${head(S1.user.role === 'client' ? 'Queries' : 'POSH and queries', 'Confidential notes stay between the employee and the administrator. Queries are visible to the company desk.')}
      ${S1.user.role === 'employee' ? `<article class="card"><h3>Raise a POSH note</h3><form id="posh-form" class="stack"><textarea name="message" rows="4" placeholder="Describe what should be reviewed" required></textarea><button class="btn primary" type="submit">Send confidentially</button></form></article>` : ''}
      ${S1.user.role !== 'client' ? `<article class="card" style="margin-top:12px"><h3>POSH notes</h3>${posh.data.map((item) => `<div class="flag-row"><span><strong>${UI.esc(item.applicationNumber)}</strong> · ${UI.esc(item.raisedByName)}<br><span class="muted">${UI.when(item.raisedAt)} · ${UI.esc(item.message)}</span></span><span>${admin ? `<select data-posh="${item.id}">${['Open', 'In review', 'Closed'].map((status) => `<option ${status === item.status ? 'selected' : ''}>${status}</option>`).join('')}</select>` : UI.badge(item.status)}</span></div>`).join('') || '<p class="muted">No POSH notes.</p>'}</article>` : ''}
      <article class="card" style="margin-top:12px"><h3>Query ticket</h3><form id="ticket-form" class="fields">${UI.field('subject', 'Subject', '', { required: true })}${UI.field('body', 'Details', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Raise query</button></form>
        ${tickets.data.map((ticket) => `<div class="flag-row"><div><strong>${UI.esc(ticket.subject)}</strong> ${UI.badge(ticket.status)}<br><span class="muted">${UI.esc(ticket.applicationNumber)} · ${UI.esc(ticket.raisedByName)} · ${UI.when(ticket.raisedAt)}</span><p>${UI.esc(ticket.body)}</p>${ticket.replies.map((reply) => `<p><strong>${UI.esc(reply.senderName)}</strong> · ${UI.esc(reply.body)}</p>`).join('')}<form data-reply="${ticket.id}" class="composer"><input name="body" placeholder="Reply" required/>${admin ? '<select name="status"><option>Open</option><option>Closed</option></select>' : ''}<button class="btn" type="submit">Reply</button></form></div></div>`).join('')}
      </article>`);
    const poshForm = root.querySelector('#posh-form');
    if (poshForm) poshForm.onsubmit = async (event) => {
      event.preventDefault();
      await UI.api('/api/posh', { method: 'POST', body: { message: new FormData(poshForm).get('message') } });
      UI.toast('POSH note sent to the administrator');
      S1.go();
    };
    root.querySelectorAll('[data-posh]').forEach((select) => {
      select.onchange = async () => { await UI.api(`/api/posh/${select.dataset.posh}/status`, { method: 'PUT', body: { status: select.value } }); UI.toast('POSH status updated'); };
    });
    root.querySelector('#ticket-form').onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      await UI.api('/api/tickets', { method: 'POST', body: { subject: data.get('subject'), body: data.get('body') } });
      UI.toast('Query raised');
      S1.go();
    };
    root.querySelectorAll('[data-reply]').forEach((form) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        await UI.api(`/api/tickets/${form.dataset.reply}/reply`, { method: 'POST', body: { body: data.get('body'), status: data.get('status') || undefined } });
        UI.toast('Reply sent');
        S1.go();
      };
    });
  },

  async profile() {
    const res = await load(`/api/employees/${S1.user.employeeId}`);
    if (!res) return;
    const person = res.data;
    const root = mount(`${head('Profile', 'You can change your contact, emergency number, photo, and messenger status.')}
      <form id="profile-form" class="card fields">
        ${UI.field('name', 'Name', S1.user.name)}
        ${UI.field('phone', 'Phone', person.phone)}
        ${UI.field('emergencyName', 'Emergency contact', person.emergencyName)}
        ${UI.field('emergencyPhone', 'Emergency number', person.emergencyPhone)}
        ${UI.field('statusText', 'Messenger status', S1.user.statusText, { span: true })}
        <label class="field span-2">Photo<input name="photo" type="file" accept=".jpg,.jpeg,.png,.webp"/></label>
        <button class="btn primary span-2" type="submit">Save profile</button>
      </form>`);
    root.querySelector('#profile-form').onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      const body = Object.fromEntries(data.entries());
      if (event.target.photo.files[0]) body.photoUrl = (await UI.upload(event.target.photo.files[0])).url;
      delete body.photo;
      S1.user = (await UI.api('/api/profile', { method: 'PUT', body })).data;
      UI.toast('Profile saved');
      S1.go();
    };
  },

  async claims() {
    const tab = S1.memory.claimTab || 'claims';
    const tabs = ['claims', 'policy', 'tracking'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('Expenses', 'Submit a claim with the receipt. The company checks the policy, finance verifies it, and the administrator processes payment.')}<div class="tabs">${tabs}</div><div id="claim-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.claimTab = button.dataset.tab; Pages.claims(); }; });
    const body = root.querySelector('#claim-body');
    const categories = ['Travel', 'E-bike', 'Food', 'Medical', 'Mobile', 'Hotel', 'Fuel', 'Conveyance', 'Internet', 'Other'].map((item) => ({ value: item, label: item }));
    const modes = ['Cab', 'Train', 'Flight', 'Bus', 'Own vehicle'].map((item) => ({ value: item, label: item }));
    const [claims, policies] = await Promise.all([load('/api/reimbursements'), load('/api/expense-policies')]);
    if (!claims || !policies) return;
    const canDesk = S1.user.role !== 'employee';
    const people = canDesk ? await load('/api/employees') : { data: [] };
    if (!people) return;
    const trip = (row) => [row.fromPlace && row.toPlace ? `${row.fromPlace} → ${row.toPlace}` : '', row.mode, row.km ? `${row.km} km` : ''].filter(Boolean).join(' · ');
    if (tab === 'claims') {
      const open = claims.data.filter((row) => ['Pending', 'Pending company', 'Pending finance', 'Ready'].includes(row.status));
      const paid = claims.data.filter((row) => row.status === 'Processed').reduce((sum, row) => sum + row.amount, 0);
      body.innerHTML = `<div class="kpis"><article class="kpi"><span>Open claims</span><strong>${open.length}</strong></article><article class="kpi"><span>Waiting on finance</span><strong>${claims.data.filter((row) => row.status === 'Pending finance').length}</strong></article><article class="kpi"><span>Ready to pay</span><strong>${claims.data.filter((row) => row.status === 'Ready').length}</strong></article><article class="kpi"><span>Processed</span><strong>${UI.inr(paid)}</strong></article></div>
        <form id="claim-form" class="card fields" style="margin:12px 0">${canDesk ? UI.field('employeeId', 'Employee', '', { select: people.data.map((person) => ({ value: person.id, label: person.fullName })) }) : ''}${UI.field('category', 'Category', 'Travel', { select: categories })}${UI.field('expenseDate', 'Date', '', { type: 'date' })}${UI.field('amount', 'Amount', '', { type: 'number' })}${UI.field('from', 'From', '')}${UI.field('to', 'To', '')}${UI.field('mode', 'Travel mode', 'Cab', { select: modes })}${UI.field('km', 'E-bike kilometres', '', { type: 'number' })}${UI.field('description', 'What was spent', '', { type: 'textarea' })}<label class="field">Receipt<input name="receipt" type="file" accept=".jpg,.jpeg,.png,.pdf,.webp"/></label><p class="muted span-2">Travel needs from, to, and mode. E-bike uses the policy rate per kilometre. A receipt is required when the policy says so.</p><button class="btn span-2" type="submit">Submit claim</button></form>
        <div class="page-actions" style="margin-bottom:12px"><button class="btn ghost" type="button" data-act="xlsx">Excel</button></div>
        ${claims.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.category)} · ${UI.inr(row.amount)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.applicationNumber)} · ${UI.esc(row.employeeName)} · ${UI.esc(row.expenseDate || 'No date')}</p><p class="muted">${UI.esc(trip(row))} ${UI.esc(row.description)}</p>${row.receiptUrl ? `<p><a href="${UI.esc(row.receiptUrl)}" target="_blank" rel="noopener">${UI.esc(row.receiptName || 'Receipt')}</a></p>` : ''}${row.financeNote ? `<p class="muted">Finance: ${UI.esc(row.financeNote)}</p>` : ''}<button class="btn small" type="button" data-act="history" data-id="${row.id}">Status</button></article>`).join('') || '<p class="muted">No claims yet.</p>'}<div id="claim-history"></div>`;
      body.querySelector('#claim-form').onsubmit = async (event) => {
        event.preventDefault();
        const data = new FormData(event.target);
        const payload = Object.fromEntries(data.entries());
        if (event.target.receipt.files[0]) {
          const file = await UI.upload(event.target.receipt.files[0]);
          payload.receiptUrl = file.url;
          payload.receiptName = file.name;
        }
        delete payload.receipt;
        await UI.api('/api/reimbursements', { method: 'POST', body: payload });
        UI.toast('Claim submitted');
        S1.go();
      };
      UI.bind(body, {
        xlsx: () => UI.download('/api/export/reimbursements?format=xlsx', 's1-expenses.xlsx'),
        history: async (node) => {
          const events = await UI.api(`/api/reimbursements/${node.dataset.id}/history`);
          body.querySelector('#claim-history').innerHTML = `<article class="card"><h3>Status</h3>${events.data.map((event) => `<div class="flag-row"><span><strong>${UI.esc(event.action)}</strong> ${UI.esc(event.fromStatus)} → ${UI.esc(event.toStatus)}<br><span class="muted">${UI.esc(event.detail)} · ${UI.esc(event.actor)}</span></span><span class="muted">${UI.when(event.createdAt)}</span></div>`).join('') || '<p class="muted">No status yet.</p>'}</article>`;
        }
      });
    }
    if (tab === 'policy') {
      body.innerHTML = `${canDesk ? `<form id="policy-form" class="fields" style="margin-bottom:12px">${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('category', 'Category', 'Travel', { select: categories })}${UI.field('maxAmount', 'Maximum', '', { type: 'number' })}${UI.field('receiptAbove', 'Receipt required from', 500, { type: 'number' })}${UI.field('monthlyCap', 'Monthly cap', '', { type: 'number' })}${UI.field('perKm', 'E-bike rate per km', 0, { type: 'number' })}${UI.field('notes', 'Rule', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Save policy</button></form>` : '<p class="muted">These are the limits the company set for each category.</p>'}
        <div class="table-wrap"><table><thead><tr><th>Category</th><th>Maximum</th><th>Receipt from</th><th>Monthly cap</th><th>Per km</th><th>Rule</th></tr></thead><tbody>
          ${policies.data.map((row) => `<tr><td>${UI.esc(row.category)}${S1.user.role === 'admin' ? `<br><span class="muted">${UI.esc(row.companyName)}</span>` : ''}</td><td>${UI.inr(row.maxAmount)}</td><td>${row.receiptAbove ? UI.inr(row.receiptAbove) : '—'}</td><td>${row.monthlyCap ? UI.inr(row.monthlyCap) : '—'}</td><td>${row.perKm ? UI.inr(row.perKm) : '—'}</td><td>${UI.esc(row.notes)}</td></tr>`).join('') || '<tr><td colspan="6">No policy yet.</td></tr>'}
        </tbody></table></div>`;
      const form = body.querySelector('#policy-form');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/expense-policies', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Policy saved');
        S1.go();
      };
    }
    if (tab === 'tracking') {
      body.innerHTML = `<label class="field">Claim<select id="track-claim">${claims.data.map((row) => `<option value="${UI.esc(row.id)}">${UI.esc(row.applicationNumber)} · ${UI.esc(row.category)} · ${UI.esc(row.status)}</option>`).join('')}</select></label><div id="track-list"></div>`;
      const show = async () => {
        const id = body.querySelector('#track-claim').value;
        if (!id) { body.querySelector('#track-list').innerHTML = '<p class="muted">No claims yet.</p>'; return; }
        const events = await UI.api(`/api/reimbursements/${id}/history`);
        body.querySelector('#track-list').innerHTML = events.data.map((event) => `<div class="flag-row"><span><strong>${UI.esc(event.action)}</strong> ${UI.esc(event.fromStatus)} → ${UI.esc(event.toStatus)}<br><span class="muted">${UI.esc(event.detail)} · ${UI.esc(event.actor)}</span></span><span class="muted">${UI.when(event.createdAt)}</span></div>`).join('') || '<p class="muted">No status yet.</p>';
      };
      const select = body.querySelector('#track-claim');
      if (select) { select.onchange = show; show(); }
    }
  },

  async requests() {
    const [leaves, swaps, claims, regulars, me] = await Promise.all([load('/api/leaves'), load('/api/shift-swaps'), load('/api/reimbursements'), load('/api/regularizations'), load(`/api/employees/${S1.user.employeeId}`)]);
    if (!leaves || !swaps || !claims || !regulars || !me) return;
    const balance = me.data.leaveBalance || {};
    const root = mount(`${head('Requests', 'Leave goes to the company desk and then the administrator. Regularization corrects a missed or wrong punch.')}
      <div class="kpis"><article class="kpi"><span>Casual leave</span><strong>${UI.esc(balance.casual ?? 0)}</strong><em>Days remaining</em></article><article class="kpi"><span>Sick leave</span><strong>${UI.esc(balance.sick ?? 0)}</strong><em>Days remaining</em></article><article class="kpi"><span>Earned leave</span><strong>${UI.esc(balance.earned ?? 0)}</strong><em>Days remaining</em></article></div>
      <div class="grid-3">
        <form id="leave-form" class="card stack"><h3>Leave</h3>${UI.field('leaveType', 'Type', 'Casual', { select: ['Casual', 'Sick', 'Earned', 'Unpaid'].map((item) => ({ value: item, label: item })) })}${UI.field('fromDate', 'From', '', { type: 'date' })}${UI.field('toDate', 'To', '', { type: 'date' })}${UI.field('reason', 'Reason', '', { type: 'textarea' })}<button class="btn primary" type="submit">Raise leave</button></form>
        <form id="swap-form" class="card stack"><h3>Shift swap</h3>${UI.field('toShift', 'Requested shift', '', { select: S1.ref.shifts.map((shift) => ({ value: shift.name, label: shift.name })) })}${UI.field('swapDate', 'Date', '', { type: 'date' })}${UI.field('reason', 'Reason', '', { type: 'textarea' })}<button class="btn primary" type="submit">Request swap</button></form>
        <form id="reg-form" class="card stack"><h3>Regularization</h3>${UI.field('workDate', 'Date', '', { type: 'date' })}${UI.field('inTime', 'In', '09:30')}${UI.field('outTime', 'Out', '18:30')}${UI.field('reason', 'Reason', '', { type: 'textarea' })}<button class="btn primary" type="submit">Request correction</button></form>
      </div>
      <form id="claim-form" class="card fields" style="margin-top:12px"><h3 class="span-2">Expenses</h3><p class="muted span-2">Travel, e-bike, food, medical, and the other categories are submitted with a receipt on the expenses desk. The company checks the policy, finance verifies the claim, and the administrator processes payment.</p><a class="btn" href="#/claims">Open expenses</a></form>
      <article class="card" style="margin-top:12px"><h3>My requests</h3>
        ${leaves.data.map((row) => `<div class="flag-row"><span>${UI.esc(row.applicationNumber)} · ${UI.esc(row.leaveType)} · ${UI.esc(row.fromDate)}</span>${UI.badge(row.status)}</div>`).join('')}
        ${regulars.data.map((row) => `<div class="flag-row"><span>${UI.esc(row.applicationNumber)} · ${UI.esc(row.workDate)} · ${UI.esc(row.requestedIn)}</span>${UI.badge(row.status)}</div>`).join('')}
        ${swaps.data.map((row) => `<div class="flag-row"><span>${UI.esc(row.applicationNumber)} · ${UI.esc(row.toShift)} · ${UI.esc(row.swapDate)}</span>${UI.badge(row.status)}</div>`).join('')}
        ${claims.data.map((row) => `<div class="flag-row"><span>${UI.esc(row.applicationNumber)} · ${UI.inr(row.amount)} · ${UI.esc(row.category)}</span>${UI.badge(row.status)}</div>`).join('')}
      </article>`);
    root.querySelector('#leave-form').onsubmit = async (event) => {
      event.preventDefault();
      await UI.api('/api/leaves', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
      UI.toast('Leave submitted');
      S1.go();
    };
    root.querySelector('#swap-form').onsubmit = async (event) => {
      event.preventDefault();
      await UI.api('/api/shift-swaps', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
      UI.toast('Shift swap submitted');
      S1.go();
    };
    root.querySelector('#reg-form').onsubmit = async (event) => {
      event.preventDefault();
      await UI.api('/api/regularizations', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
      UI.toast('Regularization submitted');
      S1.go();
    };
  },

  async payroll() {
    if (S1.user.role === 'employee') {
      const [res, runs, requests] = await Promise.all([load(`/api/employees/${S1.user.employeeId}`), load('/api/payroll/runs'), load('/api/payroll/requests')]);
      if (!res || !runs || !requests) return;
      const pay = res.data.pay;
      const checks = (await load('/api/payroll/compliance')).data[0];
      const table = (lines) => lines.length ? `<table><tbody>${lines.map((line) => `<tr><td>${UI.esc(line.label)}</td><td class="num">${UI.inr(line.amount)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing in this group.</p>';
      const root = mount(`${head('Pay', `${res.data.fullName} · ${res.data.employeeCode}`, `<button class="btn primary" type="button" id="open-slip">Open payslip</button><a class="btn ghost" href="#/documents">Salary certificate</a>`)}
        <div class="kpis"><article class="kpi"><span>Earnings</span><strong>${UI.inr(pay.earnTotal)}</strong><em>Structure, bonus, arrears, overtime</em></article><article class="kpi"><span>Deductions</span><strong>${UI.inr(pay.dedTotal)}</strong><em>PF, ESIC, PT, TDS, LWF</em></article><article class="kpi"><span>Net pay</span><strong>${UI.inr(pay.net)}</strong></article><article class="kpi"><span>Compliance</span><strong>${checks && checks.ok ? 'Clear' : 'Check'}</strong></article></div>
        <article class="card" style="margin-bottom:12px"><h3>Compliance</h3>${checks && checks.items.length ? checks.items.map((item) => `<div class="flag-row"><span>${UI.esc(item.text)}</span>${UI.badge(item.level === 'fail' ? 'Late' : 'Pending')}</div>`).join('') : '<p class="muted">PF, ESIC, professional tax, TDS, and LWF look present for this card.</p>'}</article>
        <div class="grid-2"><article class="card"><h3>Earnings and allowances</h3>${table(pay.earnings)}</article><article class="card"><h3>Deductions</h3>${table(pay.deductions)}</article></div>
        <article class="card" style="margin-top:12px"><h3>Employer contributions</h3>${table(pay.employer)}</article>
        <article class="card" style="margin-top:12px"><h3>Full and final settlement</h3>${table(pay.settlement)}</article>
        <article class="card" style="margin-top:12px"><h3>Payroll runs</h3>${runs.data.map((run) => `<div class="flag-row"><span>${UI.esc(run.period)} · ${UI.esc(run.companyName)}</span>${UI.badge(run.status)}</div>`).join('') || '<p class="muted">No payroll run for this company yet.</p>'}</article>
        <form id="pay-request" class="card fields" style="margin-top:12px"><h3 class="span-2">Payroll query</h3>${UI.field('period', 'Month', new Date().toISOString().slice(0, 7))}${UI.field('component', 'Component', 'Employee PF')}${UI.field('message', 'What should be checked', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Send for approval</button>
          ${requests.data.map((row) => `<div class="flag-row span-2"><span>${UI.esc(row.applicationNumber)} · ${UI.esc(row.component)}</span>${UI.badge(row.status)}</div>`).join('')}
        </form>`);
      document.getElementById('open-slip').onclick = () => UI.openDoc(`/api/documents/payslip/${S1.user.employeeId}`);
      document.getElementById('pay-request').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/payroll/requests', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Payroll query sent');
        S1.go();
      };
      return;
    }
    const [runs, checks, requests, people] = await Promise.all([load('/api/payroll/runs'), load('/api/payroll/compliance'), load('/api/payroll/requests'), load('/api/employees')]);
    if (!runs || !checks || !requests || !people) return;
    const root = mount(`${head('Payroll', 'Submit a month for company review, then the administrator processes it. Compliance covers PF, ESIC, professional tax, TDS, LWF, bonus, arrears, and overtime.')}
      <form id="run-form" class="fields" style="margin-bottom:12px">${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('period', 'Month', new Date().toISOString().slice(0, 7))}${S1.user.role === 'admin' ? '<label class="checkline span-2"><input type="checkbox" name="finalise" value="yes"/> Process now if compliance is clear</label>' : ''}<button class="btn span-2" type="submit">${S1.user.role === 'admin' ? 'Submit or process' : 'Send to administrator'}</button></form>
      <div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>Period</th><th>Company</th><th>People</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net</th><th>Status</th><th></th></tr></thead><tbody>
        ${runs.data.map((run) => `<tr><td>${UI.esc(run.period)}</td><td>${UI.esc(run.companyName)}</td><td>${run.headcount}</td><td class="num">${UI.inr(run.gross)}</td><td class="num">${UI.inr(run.deductions)}</td><td class="num">${UI.inr(run.net)}</td><td>${UI.badge(run.status)}</td><td>${S1.user.role === 'admin' && run.status === 'Pending admin' ? `<button class="btn small" type="button" data-act="process" data-id="${run.id}">Process</button> <button class="btn small danger" type="button" data-act="reject-run" data-id="${run.id}">Reject</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8">No payroll runs yet.</td></tr>'}
      </tbody></table></div>
      <article class="card" style="margin-bottom:12px"><h3>Compliance checks</h3>${checks.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.employeeName)}</strong><br><span class="muted">${row.items.map((item) => UI.esc(item.text)).join(' · ') || 'PF, ESIC, PT, TDS, and LWF are present'}${row.hasBonus ? ' · bonus on card' : ''}${row.hasArrears ? ' · arrears on card' : ''}</span></span>${UI.badge(row.ok ? 'Approved' : 'Late')}</div>`).join('') || '<p class="muted">No salary cards on this desk.</p>'}</article>
      <article class="card"><h3>Payroll queries</h3>${requests.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.employeeName)}</strong> · ${UI.esc(row.component)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.period)} · ${UI.esc(row.message)}</span></span><span>${(S1.user.role === 'admin' || S1.user.role === 'client') && ['Pending company', 'Pending admin'].includes(row.status) ? `<button class="btn small" type="button" data-act="yes" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-id="${row.id}">Reject</button>` : UI.badge(row.status)}</span></div>`).join('') || '<p class="muted">No payroll queries.</p>'}
        <p class="muted">Payslips stay on each employee record. Excel payroll is on Reports.</p></article>`);
    root.querySelector('#run-form').onsubmit = async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      await UI.api('/api/payroll/runs', { method: 'POST', body: data });
      UI.toast('Payroll run saved');
      S1.go();
    };
    UI.bind(root, {
      process: async (node) => { await UI.api(`/api/payroll/runs/${node.dataset.id}`, { method: 'PUT', body: { status: 'Processed' } }); UI.toast('Payroll processed'); S1.go(); },
      'reject-run': async (node) => { await UI.api(`/api/payroll/runs/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Payroll rejected'); S1.go(); },
      yes: async (node) => { await UI.api(`/api/payroll/requests/${node.dataset.id}/status`, { method: 'PUT', body: { status: 'Approved' } }); UI.toast('Query moved on'); S1.go(); },
      no: async (node) => { await UI.api(`/api/payroll/requests/${node.dataset.id}/status`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Query rejected'); S1.go(); }
    });
  },

  async assets() {
    const tab = S1.memory.assetTab || 'master';
    const tabs = ['master', 'tracking', 'movements', 'requests', 'history'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('Assets', 'Keep the asset master, allocate and return equipment, and approve a change, repair, transfer, or loss.')}<div class="tabs">${tabs}</div><div id="asset-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.assetTab = button.dataset.tab; Pages.assets(); }; });
    const body = root.querySelector('#asset-body');
    const res = await load('/api/assets');
    if (!res) return;
    const canEdit = S1.user.role !== 'employee';
    const people = await load('/api/asset-people');
    if (!people) return;
    const personOptions = people.data.map((person) => ({ value: person.id, label: person.fullName }));
    const assetOptions = res.data.map((asset) => ({ value: asset.id, label: `${asset.assetCode} · ${asset.name}` }));
    const statusFilter = S1.memory.assetStatus || '';
    if (tab === 'master' || tab === 'tracking') {
      const rows = res.data.filter((asset) => (!statusFilter || asset.status === statusFilter) && (tab !== 'tracking' || asset.employeeId)).map((asset) => `<tr><td><strong>${UI.esc(asset.name)}</strong><br><span class="muted">${UI.esc(asset.assetCode)} · ${UI.esc(asset.serialNo || 'No serial')}</span></td><td>${UI.esc(asset.category)}</td><td>${UI.badge(asset.status)}</td><td>${UI.esc(asset.employeeName || 'In store')}</td><td>${UI.esc(asset.issuedOn || '—')}</td><td>${UI.esc(asset.returnedOn || '—')}</td><td><button class="btn small" type="button" data-act="history" data-id="${asset.id}">History</button></td></tr>`).join('');
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px">${canEdit && tab === 'master' ? '<button class="btn primary" type="button" data-act="add">Add to master</button>' : ''}<button class="btn ghost" type="button" data-act="xlsx">Excel</button><label class="field" style="margin:0">Status<select id="asset-status">${['', 'In store', 'Allocated', 'Returned', 'Repair', 'Lost', 'Damaged'].map((item) => `<option value="${item}" ${statusFilter === item ? 'selected' : ''}>${item || 'All statuses'}</option>`).join('')}</select></label></div>
        <div class="table-wrap"><table><thead><tr><th>Asset</th><th>Category</th><th>Status</th><th>With</th><th>Issued</th><th>Returned</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">Nothing in this list.</td></tr>'}</tbody></table></div><div id="asset-history"></div>`;
      body.querySelector('#asset-status').onchange = (event) => { S1.memory.assetStatus = event.target.value; Pages.assets(); };
      UI.bind(body, {
        xlsx: () => UI.download('/api/export/assets?format=xlsx', 's1-assets.xlsx'),
        add: () => UI.openModal({
          title: 'Asset master',
          html: `<div class="fields">${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('name', 'Name', '', { required: true })}${UI.field('category', 'Category', 'Laptop', { select: ['Laptop', 'Access card', 'Mobile', 'Device', 'Uniform', 'Other'].map((item) => ({ value: item, label: item })) })}${UI.field('serialNo', 'Serial')}${UI.field('notes', 'Notes', '', { type: 'textarea' })}</div>`,
          onSubmit: async (data) => { await UI.api('/api/assets', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Asset added'); S1.go(); }
        }),
        history: async (node) => {
          const events = await UI.api(`/api/assets/${node.dataset.id}/history`);
          body.querySelector('#asset-history').innerHTML = `<article class="card" style="margin-top:12px"><h3>History</h3>${events.data.map((event) => `<div class="flag-row"><span><strong>${UI.esc(event.action)}</strong> · ${UI.esc(event.toStatus || '')}<br><span class="muted">${UI.esc(event.fromEmployee)} ${event.toEmployee ? `→ ${UI.esc(event.toEmployee)}` : ''} ${UI.esc(event.detail)} · ${UI.esc(event.actor)}</span></span><span class="muted">${UI.when(event.createdAt)}</span></div>`).join('') || '<p class="muted">No history yet.</p>'}</article>`;
        }
      });
    }
    if (tab === 'movements' && canEdit) {
      body.innerHTML = `<form id="move-form" class="fields">${UI.field('assetId', 'Asset', '', { select: assetOptions })}${UI.field('action', 'Movement', 'Allocate', { select: ['Allocate', 'Return', 'Reissue', 'Transfer', 'Repair', 'Lost', 'Damaged'].map((item) => ({ value: item, label: item })) })}${UI.field('employeeId', 'Employee', '', { select: [{ value: '', label: 'Not required for return, repair, or loss' }].concat(personOptions) })}${UI.field('detail', 'Details', '', { type: 'textarea' })}<p class="muted span-2">Allocate, reissue, and transfer need an employee. Reissue is available after the asset is returned, in store, or under repair.</p><button class="btn span-2" type="submit">Record movement</button></form>`;
      body.querySelector('#move-form').onsubmit = async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target).entries());
        await UI.api(`/api/assets/${data.assetId}/move`, { method: 'POST', body: data });
        UI.toast('Movement recorded');
        S1.go();
      };
    }
    if (tab === 'movements' && !canEdit) body.innerHTML = '<p class="muted">Ask the company desk to move an asset, or raise a request.</p>';
    if (tab === 'requests') {
      const requests = await load('/api/asset-requests');
      if (!requests) return;
      body.innerHTML = `<form id="asset-request" class="fields" style="margin-bottom:12px">${UI.field('assetId', 'Asset', '', { select: assetOptions })}${UI.field('action', 'Request', 'Change', { select: ['Change', 'Return', 'Repair', 'Transfer', 'Reissue', 'Lost', 'Damaged'].map((item) => ({ value: item, label: item })) })}${UI.field('employeeId', 'New holder', '', { select: [{ value: '', label: 'Needed for transfer or reissue' }].concat(personOptions) })}${UI.field('detail', 'What should change', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Send for approval</button></form>
        ${requests.data.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.assetCode)} · ${UI.esc(row.action)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.applicationNumber)} · ${UI.esc(row.assetName)} · ${UI.esc(row.employeeName || row.raisedBy)}${row.destinationName ? ` → ${UI.esc(row.destinationName)}` : ''}</p><p class="muted">${UI.esc(row.detail)}</p>${(S1.user.role === 'client' || S1.user.role === 'admin') && ['Pending company', 'Pending admin'].includes(row.status) ? `<button class="btn small" type="button" data-act="yes" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-id="${row.id}">Reject</button>` : ''}</article>`).join('') || ''}`;
      body.querySelector('#asset-request').onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/asset-requests', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Request sent');
        S1.go();
      };
      UI.bind(body, {
        yes: async (node) => { await UI.api(`/api/asset-requests/${node.dataset.id}`, { method: 'PUT', body: { status: 'Approved' } }); UI.toast('Request approved'); S1.go(); },
        no: async (node) => { await UI.api(`/api/asset-requests/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Request rejected'); S1.go(); }
      });
    }
    if (tab === 'history') {
      body.innerHTML = `<label class="field">Asset<select id="history-asset">${assetOptions.map((item) => `<option value="${UI.esc(item.value)}">${UI.esc(item.label)}</option>`).join('')}</select></label><div id="history-list"></div>`;
      const show = async () => {
        const id = body.querySelector('#history-asset').value;
        if (!id) return;
        const events = await UI.api(`/api/assets/${id}/history`);
        body.querySelector('#history-list').innerHTML = events.data.map((event) => `<div class="flag-row"><span><strong>${UI.esc(event.action)}</strong> ${UI.esc(event.fromStatus)} → ${UI.esc(event.toStatus)}<br><span class="muted">${UI.esc(event.fromEmployee)} ${event.toEmployee ? `→ ${UI.esc(event.toEmployee)}` : ''} ${UI.esc(event.detail)} · ${UI.esc(event.actor)}</span></span><span class="muted">${UI.when(event.createdAt)}</span></div>`).join('') || '<p class="muted">No history yet.</p>';
      };
      body.querySelector('#history-asset').onchange = show;
      show();
    }
  },

  async incentives() {
    const tab = S1.memory.incTab || 'rules';
    const tabs = ['rules', 'calculate', 'awards', 'requests'].map((item) => `<button class="tab ${tab === item ? 'on' : ''}" type="button" data-tab="${item}">${item}</button>`).join('');
    const root = mount(`${head('Bonus and incentives', 'Set the rule, check who is eligible, calculate the amount, then post it to the salary card after approval.')}<div class="tabs">${tabs}</div><div id="inc-body"></div>`);
    root.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { S1.memory.incTab = button.dataset.tab; Pages.incentives(); }; });
    const body = root.querySelector('#inc-body');
    const people = await load('/api/employees');
    if (!people) return;
    const personOptions = people.data.map((person) => ({ value: person.id, label: `${person.fullName} · ${person.companyName}` }));
    const components = ['bonus', 'festivalBonus', 'joiningBonus', 'retentionBonus', 'referralBonus', 'exGratia', 'performanceIncentive', 'productionIncentive', 'salesIncentive'].map((item) => ({ value: item, label: item }));
    if (tab === 'rules') {
      const res = await load('/api/incentives/rules');
      if (!res) return;
      body.innerHTML = `<div class="page-actions" style="margin-bottom:12px"><button class="btn primary" type="button" data-act="add">Add rule</button></div>
        ${res.data.map((rule) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(rule.name)}</h3>${UI.badge(rule.status)}</div><p>${UI.esc(rule.companyName)} · ${UI.esc(rule.kind)} · ${UI.esc(rule.basis)} · rate ${rule.rate}</p><p class="muted">Posts to ${UI.esc(rule.component)}. Min rating ${rule.minRating}. Tenure ${rule.minTenureMonths} months. ${UI.esc(rule.department || 'All departments')}</p>${S1.user.role === 'admin' && rule.status === 'Pending admin' ? `<button class="btn small" type="button" data-act="active" data-id="${rule.id}">Activate</button> <button class="btn small danger" type="button" data-act="reject" data-id="${rule.id}">Reject</button>` : ''}</article>`).join('') || '<p class="muted">No rules yet.</p>'}`;
      UI.bind(body, {
        add: () => UI.openModal({
          title: 'Bonus or incentive rule',
          html: `<div class="fields">${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('name', 'Name', '', { required: true })}${UI.field('kind', 'Kind', 'Bonus', { select: ['Bonus', 'Target', 'Performance'].map((item) => ({ value: item, label: item })) })}${UI.field('basis', 'Calculation', 'Fixed', { select: ['Fixed', 'Percent of basic', 'Per target unit', 'Rating multiple'].map((item) => ({ value: item, label: item })) })}${UI.field('component', 'Payroll component', 'bonus', { select: components })}${UI.field('rate', 'Rate or amount', 0, { type: 'number' })}${UI.field('minRating', 'Minimum rating', 0, { type: 'number' })}${UI.field('minTenureMonths', 'Minimum tenure months', 0, { type: 'number' })}${UI.field('department', 'Department limit')}</div>`,
          onSubmit: async (data) => { await UI.api('/api/incentives/rules', { method: 'POST', body: Object.fromEntries(data.entries()) }); UI.toast('Rule saved'); S1.go(); }
        }),
        active: async (node) => { await UI.api(`/api/incentives/rules/${node.dataset.id}`, { method: 'PUT', body: { status: 'Active' } }); UI.toast('Rule activated'); S1.go(); },
        reject: async (node) => { await UI.api(`/api/incentives/rules/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Rule rejected'); S1.go(); }
      });
    }
    if (tab === 'calculate') {
      body.innerHTML = `<form id="calc-form" class="fields">${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}${UI.field('period', 'Month', new Date().toISOString().slice(0, 7))}<button class="btn" type="submit">Calculate eligibility</button><button class="btn ghost" type="button" id="send-calc">Send eligible lines for approval</button></form><div id="calc-lines"></div>`;
      const paint = (rows) => {
        body.querySelector('#calc-lines').innerHTML = `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Employee</th><th>Kind</th><th>Eligible</th><th class="num">Amount</th><th>Why</th><th>Status</th></tr></thead><tbody>
          ${(rows || []).map((row) => `<tr><td>${UI.esc(row.employeeName)}</td><td>${UI.esc(row.kind)}</td><td>${row.eligible ? 'Yes' : 'No'}</td><td class="num">${UI.inr(row.amount)}</td><td>${UI.esc(row.detail)}</td><td>${UI.badge(row.status)}</td></tr>`).join('') || '<tr><td colspan="6">Run a month to see eligibility.</td></tr>'}
        </tbody></table></div>`;
      };
      body.querySelector('#calc-form').onsubmit = async (event) => {
        event.preventDefault();
        const result = await UI.api('/api/incentives/calculate', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        paint(result.data);
        UI.toast('Calculation finished');
      };
      body.querySelector('#send-calc').onclick = async () => {
        const period = body.querySelector('[name=period]').value;
        const clientId = body.querySelector('[name=clientId]');
        await UI.api('/api/incentives/submit', { method: 'POST', body: { period, clientId: clientId ? clientId.value : '' } });
        UI.toast('Eligible lines sent to the administrator');
        S1.go();
      };
    }
    if (tab === 'awards' || tab === 'requests') {
      const res = await load('/api/incentives/awards');
      if (!res) return;
      const rows = tab === 'requests' ? res.data.filter((row) => row.requested || ['Pending admin', 'Pending company'].includes(row.status)) : res.data;
      body.innerHTML = `${tab === 'requests' ? `<form id="inc-request" class="fields" style="margin-bottom:12px">${UI.field('employeeId', 'Employee', '', { select: personOptions })}${UI.field('period', 'Month', new Date().toISOString().slice(0, 7))}${UI.field('component', 'Component', 'bonus', { select: components })}${UI.field('amount', 'Amount', '', { type: 'number' })}${UI.field('detail', 'Reason', '', { type: 'textarea' })}<button class="btn span-2" type="submit">Request incentive</button></form>` : '<div class="page-actions" style="margin-bottom:12px"><button class="btn ghost" type="button" data-act="xlsx">Excel history</button></div>'}
        ${rows.map((row) => `<article class="card" style="margin-bottom:10px"><div class="card-head"><h3>${UI.esc(row.employeeName)} · ${UI.inr(row.amount)}</h3>${UI.badge(row.status)}</div><p>${UI.esc(row.applicationNumber)} · ${UI.esc(row.period)} · ${UI.esc(row.kind)} · ${UI.esc(row.component)}</p><p class="muted">${UI.esc(row.detail)}</p>${S1.user.role === 'admin' && row.status === 'Pending admin' && row.eligible ? `<button class="btn small" type="button" data-act="post" data-id="${row.id}">Post to payroll</button> <button class="btn small danger" type="button" data-act="reject" data-id="${row.id}">Reject</button>` : ''}</article>`).join('') || '<p class="muted">Nothing in this list.</p>'}`;
      const form = body.querySelector('#inc-request');
      if (form) form.onsubmit = async (event) => {
        event.preventDefault();
        await UI.api('/api/incentives/requests', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
        UI.toast('Request sent');
        S1.go();
      };
      UI.bind(body, {
        xlsx: () => UI.download('/api/export/incentives?format=xlsx', 's1-incentives.xlsx'),
        post: async (node) => { await UI.api(`/api/incentives/awards/${node.dataset.id}`, { method: 'PUT', body: { status: 'Posted' } }); UI.toast('Posted to the salary card'); S1.go(); },
        reject: async (node) => { await UI.api(`/api/incentives/awards/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Rejected'); S1.go(); }
      });
    }
  },

  async reports() {
    const [dash, requests] = await Promise.all([load('/api/reports/dashboard'), load('/api/report-requests')]);
    if (!dash || !requests) return;
    const data = dash.data;
    const cards = [
      ['hr', 'HR data', 'Companies, branches, staff, budget, and score'],
      ['onboarding', 'Onboarding', 'People still in the joining stage'],
      ['employees', 'Employee data', 'Master record, branch, shift, and hiring source'],
      ['attendance', 'Attendance', 'In, out, mode, late flag, penalty, and overtime'],
      ['leaves', 'Leave', 'Types, dates, and approval status'],
      ['payroll', 'Payroll', 'Gross, deductions, net, employer cost, and full-and-final'],
      ['recruitment', 'Recruitment', 'Applicants, offers, and manpower requisitions'],
      ['performance', 'Performance', 'Tasks, priority, progress, and overdue work'],
      ['assets', 'Assets', 'What is in store, issued, or under repair'],
      ['reimbursements', 'Reimbursements', 'Claims, categories, receipts, finance check, and payment'],
      ['dataentry', 'Data entry', 'Activity posts raised on the desk'],
      ['operations', 'Operations', 'BGV, service, device, manpower, and advertise stages'],
      ['exits', 'Exit employees', 'Separation, last day, clearance, and full-and-final'],
      ['incentives', 'Incentives', 'Bonus and incentive lines, eligibility, and payroll status'],
      ['locations', 'Locations', 'Branches, offices, sites, units, floors, headcount, and attendance']
    ];
    const root = mount(`${head('Reports and analytics', 'Every sheet is limited to the companies on this desk. A company can also ask the administrator to approve a report.')}
      ${kpis([
        { label: 'Workforce', value: data.workforce, note: `${data.onboarding} onboarding` },
        { label: 'Present today', value: data.presentToday, note: `${data.openLeaves} open leaves` },
        { label: 'Payroll net', value: UI.inr(data.payrollNet), note: 'Current cards' },
        { label: 'Open tasks', value: data.openTasks, note: `Rating ${data.avgRating || '—'}` }
      ])}
      <div class="kpis">
        <article class="kpi"><span>Assets out</span><strong>${data.assetsOut}</strong><em>${data.assetsRepair} in repair · ${data.assetsLost} lost or damaged</em></article>
        <article class="kpi"><span>Hiring</span><strong>${data.applicants}</strong><em>Open applications</em></article>
        <article class="kpi"><span>Exits</span><strong>${data.exits}</strong><em>Separation or full-and-final</em></article>
        <article class="kpi"><span>Companies</span><strong>${data.companies}</strong><em>${data.openClaims} open claims</em></article>
      </div>
      <div class="grid-2" style="margin-top:12px">${cards.map(([entity, title, text]) => `<article class="card"><h3>${title}</h3><p class="muted">${text}</p><div class="page-actions"><button class="btn" type="button" data-entity="${entity}" data-format="xlsx">Excel</button><button class="btn ghost" type="button" data-entity="${entity}" data-format="csv">CSV</button></div></article>`).join('')}</div>
      <form id="report-request" class="card fields" style="margin-top:12px"><h3 class="span-2">Request a report</h3>
        ${S1.user.role === 'admin' ? UI.field('clientId', 'Company', '', { select: S1.ref.companies.map((company) => ({ value: company.id, label: company.name })) }) : ''}
        ${UI.field('reportName', 'Report', 'Payroll', { select: cards.map(([entity, title]) => ({ value: title, label: title })) })}
        ${UI.field('period', 'Period', new Date().toISOString().slice(0, 7))}
        ${UI.field('reason', 'Why it is needed', '', { type: 'textarea' })}
        <button class="btn span-2" type="submit">Send for approval</button>
      </form>
      <article class="card" style="margin-top:12px"><h3>Report requests</h3>
        ${requests.data.map((row) => `<div class="flag-row"><span><strong>${UI.esc(row.reportName)}</strong> · ${UI.esc(row.companyName)}<br><span class="muted">${UI.esc(row.applicationNumber)} · ${UI.esc(row.period)} · ${UI.esc(row.reason)}</span></span><span>${S1.user.role === 'admin' && row.status === 'Pending admin' ? `<button class="btn small" type="button" data-act="yes" data-id="${row.id}">Approve</button> <button class="btn small danger" type="button" data-act="no" data-id="${row.id}">Reject</button>` : UI.badge(row.status)}</span></div>`).join('') || '<p class="muted">No report requests.</p>'}
      </article>`);
    root.querySelectorAll('[data-entity]').forEach((button) => {
      button.onclick = () => UI.download(`/api/export/${button.dataset.entity}?format=${button.dataset.format}`, `s1-${button.dataset.entity}.${button.dataset.format === 'csv' ? 'csv' : 'xlsx'}`);
    });
    root.querySelector('#report-request').onsubmit = async (event) => {
      event.preventDefault();
      await UI.api('/api/report-requests', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
      UI.toast('Report request sent');
      S1.go();
    };
    UI.bind(root, {
      yes: async (node) => { await UI.api(`/api/report-requests/${node.dataset.id}`, { method: 'PUT', body: { status: 'Approved' } }); UI.toast('Report approved'); S1.go(); },
      no: async (node) => { await UI.api(`/api/report-requests/${node.dataset.id}`, { method: 'PUT', body: { status: 'Rejected' } }); UI.toast('Report rejected'); S1.go(); }
    });
  }
};

window.Pages = Pages;
