document.addEventListener('DOMContentLoaded', async () => {
  const existing = await EmberDB.currentUser();
  if (existing) {
    window.location.href = 'app.html';
    return;
  }

  const tabSignin = document.getElementById('tab-signin');
  const tabSignup = document.getElementById('tab-signup');
  const formSignin = document.getElementById('form-signin');
  const formSignup = document.getElementById('form-signup');
  const errorBox = document.getElementById('auth-error');

  function showTab(which) {
    errorBox.classList.remove('show');
    const isSignin = which === 'signin';
    tabSignin.classList.toggle('active', isSignin);
    tabSignup.classList.toggle('active', !isSignin);
    formSignin.style.display = isSignin ? 'block' : 'none';
    formSignup.style.display = isSignin ? 'none' : 'block';
  }

  tabSignin.addEventListener('click', () => showTab('signin'));
  tabSignup.addEventListener('click', () => showTab('signup'));

  function showError(msg, isInfo = false) {
    errorBox.textContent = msg;
    errorBox.classList.add('show');
    errorBox.style.color = isInfo ? 'var(--teal)' : 'var(--danger)';
    errorBox.style.borderColor = isInfo ? 'rgba(82, 214, 196, 0.3)' : 'rgba(255, 107, 107, 0.3)';
    errorBox.style.background = isInfo ? 'rgba(82, 214, 196, 0.1)' : 'rgba(255, 107, 107, 0.1)';
  }

  function setLoading(form, loading) {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = loading;
    btn.textContent = loading ? 'Please wait…' : (form === formSignin ? 'Sign in' : 'Create account');
  }

  const usernameInput = document.getElementById('su-username');
  usernameInput.addEventListener('input', () => {
    const cursor = usernameInput.selectionStart;
    const cleaned = usernameInput.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (cleaned !== usernameInput.value) {
      usernameInput.value = cleaned;
      usernameInput.setSelectionRange(cursor - 1, cursor - 1);
    }
  });

  formSignup.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');
    const name = document.getElementById('su-name').value;
    const username = document.getElementById('su-username').value;
    const email = document.getElementById('su-email').value;
    const password = document.getElementById('su-password').value;
    setLoading(formSignup, true);
    try {
      await EmberDB.signUp({ name, username, email, password });
      window.location.href = 'app.html';
    } catch (err) {
      if (err.code === 'CONFIRM_EMAIL') {
        showError(err.message, true);
        showTab('signin');
      } else {
        showError(err.message);
      }
    } finally {
      setLoading(formSignup, false);
    }
  });

  formSignin.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');
    const email = document.getElementById('si-email').value;
    const password = document.getElementById('si-password').value;
    setLoading(formSignin, true);
    try {
      await EmberDB.signIn({ email, password });
      window.location.href = 'app.html';
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(formSignin, false);
    }
  });

  // Register the service worker so the app becomes installable
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
