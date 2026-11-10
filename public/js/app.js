const NAV = {
  admin: [
    ['label', 'Overview'],
    ['dashboard', 'Command', 'grid'],
    ['approvals', 'Approvals', 'check'],
    ['search', 'Search', 'search'],
    ['label', 'Records'],
    ['clients', 'Clients', 'building'],
    ['plans', 'Plans', 'file'],
    ['workforce', 'Workforce', 'users'],
    ['join', 'Join employee', 'user'],
    ['organization', 'Organisation', 'building'],
    ['places', 'Locations', 'building'],
    ['attendance', 'Attendance', 'clock'],
    ['hiring', 'Hiring', 'briefcase'],
    ['label', 'Operations'],
    ['activities', 'Activities', 'layers'],
    ['leads', 'Leads & calls', 'phone'],
    ['tasks', 'Performance', 'flag'],
    ['documents', 'Documents', 'file'],
    ['assets', 'Assets', 'briefcase'],
    ['claims', 'Expenses', 'file'],
    ['reports', 'Reports', 'file'],
    ['payroll', 'Payroll', 'file'],
    ['incentives', 'Incentives', 'flag'],
    ['statutory', 'Statutory', 'shield'],
    ['label', 'Messages'],
    ['messenger', 'Messenger', 'message'],
    ['help', 'POSH & queries', 'shield']
  ],
  client: [
    ['label', 'Overview'],
    ['dashboard', 'Overview', 'grid'],
    ['search', 'Search', 'search'],
    ['label', 'Company'],
    ['company', 'Company', 'building'],
    ['plans', 'Plans', 'file'],
    ['workforce', 'People', 'users'],
    ['join', 'Join employee', 'user'],
    ['organization', 'Organisation', 'building'],
    ['places', 'Locations', 'building'],
    ['attendance', 'Attendance', 'clock'],
    ['approvals', 'Approvals', 'check'],
    ['hiring', 'Hiring', 'briefcase'],
    ['label', 'Operations'],
    ['activities', 'Requests', 'layers'],
    ['tasks', 'Performance', 'flag'],
    ['advertise', 'Broadcasts', 'layers'],
    ['documents', 'Documents', 'file'],
    ['assets', 'Assets', 'briefcase'],
    ['claims', 'Expenses', 'file'],
    ['reports', 'Reports', 'file'],
    ['payroll', 'Payroll', 'file'],
    ['incentives', 'Incentives', 'flag'],
    ['statutory', 'Statutory', 'shield'],
    ['label', 'Messages'],
    ['messenger', 'Messenger', 'message'],
    ['help', 'Queries', 'message']
  ],
  employee: [
    ['label', 'My day'],
    ['dashboard', 'My day', 'grid'],
    ['attendance', 'Attendance', 'clock'],
    ['places', 'Locations', 'building'],
    ['requests', 'Requests', 'check'],
    ['claims', 'Expenses', 'file'],
    ['payroll', 'Pay', 'file'],
    ['tasks', 'Performance', 'flag'],
    ['label', 'Record'],
    ['profile', 'Profile', 'user'],
    ['documents', 'Downloads', 'file'],
    ['assets', 'Assets', 'briefcase'],
    ['label', 'Company'],
    ['activities', 'Activities', 'layers'],
    ['statutory', 'Statutory', 'shield'],
    ['messenger', 'Messenger', 'message'],
    ['help', 'POSH & queries', 'shield'],
    ['search', 'Search', 'search']
  ]
};

const S1 = {
  user: null,
  ref: null,
  boot: null,
  memory: {},
  ticket: 0,
  stop() {},
  addStop() {}
};

function parseHash() {
  const raw = (location.hash || '#/dashboard').replace(/^#/, '');
  const [path, query] = raw.split('?');
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  return { view: parts[0] || 'dashboard', id: parts[1] || '', params: new URLSearchParams(query || '') };
}

function menu() {
  const role = S1.user.isHrAdmin ? 'client' : S1.user.role;
  const items = NAV[role] || [];
  return S1.user.isHrAdmin ? items.filter((item) => item[0] !== 'plans') : items;
}

function navItems() {
  return menu().filter((item) => item[0] !== 'label');
}

function allowed(view) {
  const ids = navItems().map((item) => item[0]);
  const extra = S1.user.role === 'employee' ? ['employee'] : ['employee', 'client'];
  return ids.includes(view) || extra.includes(view);
}

function activeNav(view) {
  if (view === 'employee') return 'workforce';
  if (view === 'client') return S1.user.role === 'client' ? 'company' : 'clients';
  return view;
}

function labelFor(view) {
  const hit = navItems().find((item) => item[0] === activeNav(view));
  return hit ? hit[1] : 'Desk';
}

function renderShell() {
  const desk = S1.user.isHrAdmin ? 'Admin desk' : { admin: 'Super admin', client: 'Client admin', employee: 'People desk' }[S1.user.role];
  const links = menu().map((item) => {
    if (item[0] === 'label') return `<div class="nav-label">${UI.esc(item[1])}</div>`;
    const count = item[0] === 'approvals' ? '<span class="count" id="approval-count"></span>' : '';
    return `<a class="side-link" data-nav="${item[0]}" href="#/${item[0]}">${UI.icon(item[2])}<span>${UI.esc(item[1])}</span>${count}</a>`;
  }).join('');
  document.body.dataset.portal = S1.user.isHrAdmin ? 'hradmin' : S1.user.role;
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="side-brand" href="#/dashboard"><span class="mark tiny">S1</span><span><strong>S1 HR</strong><span>${desk}</span></span></a>
        <nav class="side-nav">${links}</nav>
        <div class="side-user">
          <div class="who"><span class="avatar" id="user-initials"></span><span><strong id="user-name"></strong><span id="user-title" class="muted"></span></span></div>
          <button class="btn ghost full" id="sign-out" type="button">Sign out</button>
        </div>
      </aside>
      <section class="main">
        <header class="topbar">
          <div>
            <p class="kicker" id="today-label"></p>
            <h2 id="crumb-title">Desk</h2>
          </div>
          <form id="top-search"><input name="q" placeholder="Search the desk" aria-label="Search"/><button class="btn" type="submit">Search</button></form>
          <button class="icon-btn" id="bell" type="button" aria-label="Notices">${UI.icon('flag')}<span class="dot" id="notice-dot" hidden></span></button>
        </header>
        <div id="notice-panel" class="notice-panel" hidden></div>
        <div id="view" class="content"></div>
      </section>
    </div>`;
  document.getElementById('sign-out').onclick = async () => {
    try { await UI.api('/api/auth/logout', { method: 'POST', body: {} }); } catch (_) { /* session may already be gone */ }
    localStorage.removeItem('s1_token');
    location.href = '/';
  };
  document.getElementById('bell').onclick = async () => {
    const panel = document.getElementById('notice-panel');
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    const notes = S1.boot.notifications || [];
    panel.innerHTML = notes.length ? notes.map((note) => `<article><strong>${UI.esc(note.title)}</strong><p class="muted">${UI.esc(note.message)}</p><small>${UI.when(note.createdAt)}</small></article>`).join('') : '<article>No notices on this desk.</article>';
    await UI.api('/api/notifications/read', { method: 'POST', body: {} });
    S1.boot.badges.notices = 0;
    document.getElementById('notice-dot').hidden = true;
  };
  document.getElementById('top-search').onsubmit = (event) => {
    event.preventDefault();
    const query = new FormData(event.target).get('q') || '';
    location.hash = `#/search?q=${encodeURIComponent(query)}`;
  };
}

function paintChrome(route) {
  document.getElementById('crumb-title').textContent = labelFor(route.view);
  document.getElementById('today-label').textContent = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  document.title = `${labelFor(route.view)} · S1 HR Solution`;
  document.querySelectorAll('[data-nav]').forEach((link) => link.classList.toggle('active', link.dataset.nav === activeNav(route.view)));
  const count = document.getElementById('approval-count');
  if (count) {
    const value = S1.boot.badges.approvals || 0;
    count.textContent = value ? String(value) : '';
    count.style.display = value ? '' : 'none';
  }
  const dot = document.getElementById('notice-dot');
  if (dot) dot.hidden = !S1.boot.badges.notices;
  document.getElementById('user-name').textContent = S1.user.name;
  document.getElementById('user-title').textContent = S1.user.title || S1.user.companyName || S1.user.role;
  document.getElementById('user-initials').textContent = UI.initials(S1.user.name);
}

S1.go = async function go() {
  const my = ++S1.ticket;
  if (S1.stop) S1.stop();
  const stops = [];
  S1.stop = () => stops.splice(0).forEach((fn) => fn());
  S1.addStop = (fn) => stops.push(fn);
  const route = parseHash();
  if (!S1.user && !S1.ref) return;
  if (!allowed(route.view)) {
    if (location.hash !== '#/dashboard') location.hash = '#/dashboard';
    return;
  }
  const boot = await UI.api('/api/bootstrap');
  if (my !== S1.ticket) return;
  S1.boot = boot.data;
  S1.user = boot.data.user;
  paintChrome(route);
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty">Opening the desk…</div>';
  try {
    let page = route.view;
    let arg = route;
    if (page === 'company') {
      page = 'client';
      arg = { ...route, id: S1.user.clientId };
    }
    await Pages[page](arg);
  } catch (error) {
    if (my !== S1.ticket) return;
    document.getElementById('view').innerHTML = `<div class="banner bad">${UI.esc(error.message)}</div>`;
  }
};

async function bootApp() {
  if (!localStorage.getItem('s1_token')) {
    location.href = '/';
    return;
  }
  try {
    S1.ref = (await UI.api('/api/reference')).data;
    S1.user = { role: localStorage.getItem('s1_portal') || 'admin', name: '' };
    const boot = await UI.api('/api/bootstrap');
    S1.boot = boot.data;
    S1.user = boot.data.user;
  } catch (error) {
    document.getElementById('app').innerHTML = `<div class="content"><div class="banner bad">${UI.esc(error.message)}</div><p><a href="/">Return to the desks</a></p></div>`;
    return;
  }
  renderShell();
  window.addEventListener('hashchange', () => S1.go());
  if (!location.hash) location.hash = '#/dashboard';
  else S1.go();
}

window.S1 = S1;
bootApp();
