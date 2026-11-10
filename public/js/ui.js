const UI = {
  esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  },
  inr(value) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
  },
  when(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return this.esc(value);
    return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  },
  clock(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return this.esc(value);
    return date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  },
  initials(name) {
    return String(name || 'S1').split(' ').slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  },
  badge(status) {
    const kind = {
      Approved: 'good', Active: 'good', Present: 'good', Positive: 'good', Live: 'good', Hired: 'good', Closed: 'good', Done: 'good', Completed: 'good', Settled: 'good', Confirmed: 'good',
      Rejected: 'bad', Negative: 'bad', Late: 'bad', Absent: 'bad', Inactive: 'bad', Separated: 'bad', Closed: 'bad',
      Active: 'good', Live: 'good',
      Pending: 'wait', Submitted: 'wait', Processing: 'wait', 'In review': 'wait', 'In progress': 'wait', 'Priority call': 'wait', Open: 'wait', Paused: 'wait', Onboarding: 'wait', Probation: 'wait', Draft: 'wait', Exit: 'wait', 'Pending company': 'wait', 'Pending admin': 'wait', 'Pending finance': 'wait', 'Pending verification': 'wait', 'Pending approval': 'wait', Ready: 'wait', Early: 'wait', Registered: 'wait', Implementation: 'wait',
      Verified: 'info', 'Final Report': 'info', Published: 'info', Viewed: 'info', Screening: 'info', Interview: 'info', Offer: 'info', Confirmation: 'info', Transfer: 'info', Promotion: 'info', 'Full and final': 'info', Processed: 'good',
    }[status] || 'neutral';
    return `<span class="badge ${kind}">${this.esc(status || '—')}</span>`;
  },
  async api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = localStorage.getItem('s1_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (options.body instanceof FormData) body = options.body;
    else if (options.body != null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(path, { method: options.method || 'GET', headers, body });
    if (response.status === 401 && !path.includes('/api/auth/login')) {
      localStorage.removeItem('s1_token');
      location.href = '/';
      throw new Error('Sign in again');
    }
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const data = await response.json();
      if (!response.ok || data.success === false) throw new Error(data.error || 'Request failed');
      return data;
    }
    if (!response.ok) throw new Error('Request failed');
    return response;
  },
  toast(message, tone) {
    const node = document.createElement('div');
    node.className = `toast${tone === 'bad' ? ' bad' : ''}`;
    node.textContent = message;
    document.getElementById('toast-root').appendChild(node);
    setTimeout(() => node.remove(), 3800);
  },
  async download(path, filename) {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${localStorage.getItem('s1_token')}` } });
    if (!response.ok) throw new Error('Download failed');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  },
  async openDoc(path) {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${localStorage.getItem('s1_token')}` } });
    if (!response.ok) throw new Error('The letter could not be opened');
    const html = await response.text();
    const blob = new Blob([html], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank');
  },
  locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    });
  },
  async upload(file) {
    const data = new FormData();
    data.append('file', file);
    const result = await this.api('/api/upload', { method: 'POST', body: data });
    return result.file;
  },
  field(name, label, value = '', options = {}) {
    const span = options.span ? ' span-2' : '';
    if (options.select) {
      const choices = options.select.map((item) => `<option value="${this.esc(item.value)}" ${String(item.value) === String(value) ? 'selected' : ''}>${this.esc(item.label)}</option>`).join('');
      return `<label class="field${span}">${this.esc(label)}<select name="${name}">${choices}</select></label>`;
    }
    if (options.type === 'textarea') {
      return `<label class="field span-2">${this.esc(label)}<textarea name="${name}" rows="${options.rows || 3}">${this.esc(value)}</textarea></label>`;
    }
    return `<label class="field${span}">${this.esc(label)}<input name="${name}" type="${options.type || 'text'}" value="${this.esc(value)}" ${options.required ? 'required' : ''}/></label>`;
  },
  openModal({ title, html, submitLabel = 'Save', wide = false, onReady, onSubmit }) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-back"><form class="modal${wide ? ' wide' : ''}">
      <header class="modal-head"><h2>${this.esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
      <div class="modal-body">${html}</div>
      <footer class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${this.esc(submitLabel)}</button></footer>
    </form></div>`;
    const close = () => { root.innerHTML = ''; };
    root.querySelectorAll('[data-close]').forEach((node) => { node.onclick = close; });
    root.querySelector('.modal-back').onclick = (event) => { if (event.target.classList.contains('modal-back')) close(); };
    const form = root.querySelector('form');
    if (onReady) onReady(form);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector('[type=submit]');
      button.disabled = true;
      try {
        await onSubmit(new FormData(form), form);
        close();
      } catch (error) {
        this.toast(error.message, 'bad');
        button.disabled = false;
      }
    };
  },
  bind(root, actions) {
    root.querySelectorAll('[data-act]').forEach((node) => {
      node.addEventListener('click', async (event) => {
        const act = node.dataset.act;
        if (!actions[act]) return;
        event.preventDefault();
        node.disabled = true;
        try {
          await actions[act](node);
        } catch (error) {
          this.toast(error.message, 'bad');
          node.disabled = false;
        }
      });
    });
  },
  icon(name) {
    const paths = {
      grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
      building: '<path d="M4 20h16M6 20V6h8v14M14 10h4v10M9 9h2M9 13h2"/>',
      users: '<path d="M16 20v-1a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v1"/><circle cx="10" cy="8" r="3"/><path d="M20 20v-1a3 3 0 0 0-2.2-2.9"/><path d="M16 5.1a3 3 0 0 1 0 5.8"/>',
      clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
      check: '<path d="M5 12l5 5L20 7"/>',
      briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5h8v2M3 12h18"/>',
      layers: '<path d="M12 3l9 5-9 5L3 8l9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/>',
      message: '<path d="M5 6h14v10H8l-3 3V6z"/>',
      phone: '<path d="M8 4h3l1 4-2 1a12 12 0 0 0 5 5l1-2 4 1v3a2 2 0 0 1-2 2A16 16 0 0 1 4 6a2 2 0 0 1 2-2z"/>',
      flag: '<path d="M6 4v16"/><path d="M6 5h11l-2 4 2 4H6"/>',
      file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
      shield: '<path d="M12 3l8 3v6c0 5-3.4 7.6-8 9-4.6-1.4-8-4-8-9V6l8-3z"/>',
      search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/>',
      user: '<circle cx="12" cy="8" r="3"/><path d="M5 19a7 7 0 0 1 14 0"/>'
    };
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${paths[name] || ''}</svg>`;
  }
};

window.UI = UI;
