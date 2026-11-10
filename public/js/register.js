const form = document.getElementById('register-form');
const error = document.getElementById('form-error');
const panels = [...form.querySelectorAll('[data-panel]')];
const steps = [...document.querySelectorAll('.steps li')];
const next = document.getElementById('next');
const back = document.getElementById('back');
const submit = document.getElementById('submit');
const planSelect = form.querySelector('[name=plan]');
const preview = document.getElementById('plan-preview');
const labels = ['Next: Admin details', 'Next: Documents', 'Next: Review'];
let catalog = [];
let step = 1;

form.querySelectorAll('[required]').forEach((field) => {
  field.dataset.need = 'yes';
  field.removeAttribute('required');
});

function currentValid() {
  const fields = [...panels[step - 1].querySelectorAll('[data-need]')];
  for (const field of fields) {
    const ok = field.type === 'checkbox' ? field.checked : field.type === 'file' ? field.files.length > 0 : String(field.value || '').trim();
    if (!ok) {
      error.hidden = false;
      error.textContent = 'Complete the required fields on this step.';
      field.focus();
      return false;
    }
  }
  if (step === 2 && form.password.value !== form.confirmPassword.value) {
    error.hidden = false;
    error.textContent = 'Passwords do not match.';
    return false;
  }
  if (step === 2 && form.password.value.length < 12) {
    error.hidden = false;
    error.textContent = 'Use a password of at least 12 characters.';
    return false;
  }
  error.hidden = true;
  return true;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function show(nextStep) {
  step = nextStep;
  panels.forEach((panel) => { panel.hidden = Number(panel.dataset.panel) !== step; });
  steps.forEach((item) => item.classList.toggle('on', Number(item.dataset.step) <= step));
  back.hidden = step === 1;
  next.hidden = step === 4;
  submit.hidden = step !== 4;
  if (step < 4) next.textContent = labels[step - 1];
  if (step === 4) fillReview();
}

function fillReview() {
  const data = new FormData(form);
  document.getElementById('review').innerHTML = `
    <p><strong>${esc(data.get('companyName'))}</strong> · ${esc(data.get('businessType'))}</p>
    <p>${esc(data.get('address'))}, ${esc(data.get('city'))}, ${esc(data.get('state'))}, ${esc(data.get('country') || 'India')}</p>
    <p>${esc(data.get('adminName'))} · ${esc(data.get('designation'))}<br/>${esc(data.get('officialMail'))} · ${esc(data.get('phone'))}</p>`;
}

function showPlan() {
  const plan = catalog.find((item) => item.id === planSelect.value);
  preview.innerHTML = plan ? `<strong>${esc(plan.name)}</strong><p>${esc(plan.clientLabel)}</p>` : '';
}

fetch('/api/public/plans').then((response) => response.json()).then((body) => {
  catalog = body.data || [];
  const families = [...new Set(catalog.map((plan) => plan.family))];
  planSelect.innerHTML = families.map((family) => `<optgroup label="${esc(family)}">${catalog.filter((plan) => plan.family === family).map((plan) => `<option value="${esc(plan.id)}">${esc(plan.name)}</option>`).join('')}</optgroup>`).join('');
  showPlan();
}).catch(() => { planSelect.innerHTML = '<option value="">Plans could not be loaded</option>'; });
planSelect.addEventListener('change', showPlan);
next.onclick = () => { if (currentValid()) show(step + 1); };
back.onclick = () => show(step - 1);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  if (!currentValid()) return;
  submit.disabled = true;
  try {
    const response = await fetch('/api/public/register', { method: 'POST', body: new FormData(form) });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || 'Registration failed');
    document.querySelector('.reg section').innerHTML = `<h2>Application ${esc(body.data.applicationNumber)}</h2><p>${esc(body.data.companyName)} is waiting for the super admin. The client admin login stays off until the company is approved.</p><p><a class="btn solid" href="/login/superadmin">Super admin desk</a></p>`;
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
    submit.disabled = false;
  }
});
show(1);
