const form = document.getElementById('login-form');
const error = document.getElementById('form-error');
const portal = document.body.dataset.portal;
const note = document.getElementById('register-note');
if ((portal === 'client' || portal === 'client-admin') && note) {
  note.innerHTML = '<a href="/register">Register a company</a> if portal access has not been issued yet.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;
  const data = new FormData(form);
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portal, email: data.get('email'), password: data.get('password') })
    });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || 'Sign-in failed');
    localStorage.setItem('s1_token', body.token);
    localStorage.setItem('s1_portal', portal);
    location.href = '/workspace#/dashboard';
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
    button.disabled = false;
  }
});
