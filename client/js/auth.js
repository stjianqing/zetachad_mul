import { api } from './api.js';

function nextUrl() {
  const p = new URLSearchParams(location.search);
  const n = p.get('next');
  if (n === 'play') return 'play.html';
  return 'index.html';
}

function showError(el, code) {
  const map = {
    invalid_username: 'Username must be 3–20 characters: letters, digits, underscore, hyphen.',
    invalid_password: 'Password must be at least 8 characters.',
    invalid_credentials: 'Username or password is incorrect.',
    username_taken: 'That username is already taken.',
    bad_request: 'Please fill out both fields.'
  };
  el.textContent = map[code] || 'Something went wrong. Please try again.';
}

export function wireLoginForm() {
  const form = document.getElementById('login-form');
  const err = form.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api.login({
        username: form.elements.username.value.trim(),
        password: form.elements.password.value
      });
      location.href = nextUrl();
    } catch (ex) {
      showError(err, ex.message);
    }
  });
}

export function wireRegisterForm() {
  const form = document.getElementById('register-form');
  const err = form.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api.register({
        username: form.elements.username.value.trim(),
        password: form.elements.password.value
      });
      location.href = nextUrl();
    } catch (ex) {
      showError(err, ex.message);
    }
  });
}
