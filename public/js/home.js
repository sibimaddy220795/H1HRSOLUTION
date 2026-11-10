const families = [
  { key: 'small', match: (plan) => plan.family === 'Small' && !plan.id.startsWith('hr-blue') },
  { key: 'warehouse', match: (plan) => plan.id.startsWith('hr-blue') },
  { key: 'medium', match: (plan) => plan.family === 'Medium' },
  { key: 'large', match: (plan) => plan.family === 'Large' }
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function readJson(pending) {
  const response = await pending;
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error || 'The desk could not take that');
  return body.data;
}

function bindForm(id, noteId, send) {
  const form = document.getElementById(id);
  const note = document.getElementById(noteId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    note.hidden = true;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await send(form);
      form.reset();
      note.hidden = false;
      note.textContent = 'Received. The super admin desk has it.';
    } catch (error) {
      note.hidden = false;
      note.textContent = error.message;
    }
    button.disabled = false;
  });
}

fetch('/api/public/plans').then((response) => response.json()).then((body) => {
  const catalog = body.data || [];
  document.querySelectorAll('[data-plans]').forEach((list) => {
    const plans = catalog.filter(families.find((family) => family.key === list.dataset.plans).match);
    list.innerHTML = plans.map((plan) => `<li>${esc(plan.name)}</li>`).join('') || '<li>Plans load with the catalogue.</li>';
  });
}).catch(() => {});

function setText(id, value) {
  const node = document.getElementById(id);
  if (node && value != null) node.textContent = value;
}

fetch('/api/public/story').then((response) => response.json()).then((body) => {
  const story = body.data || {};
  setText('stat-people', story.people);
  setText('stat-companies', story.companies);
  setText('stat-rating', story.rating);
  setText('hiring-rating', story.rating);
}).catch(() => {});

bindForm('demo-form', 'demo-note', (form) => readJson(fetch('/api/public/demo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
})));

bindForm('news-form', 'news-note', (form) => readJson(fetch('/api/public/newsletter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
})));

bindForm('apply-form', 'apply-note', (form) => readJson(fetch('/api/public/apply', {
  method: 'POST',
  body: new FormData(form)
})));
