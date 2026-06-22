// ===== Theme (light/dark) =====
function initTheme() {
  const saved = localStorage.getItem('edu_theme') ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('edu_theme', next);
  renderThemeToggleIcon();
}
function renderThemeToggleIcon() {
  const btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;
  const cur = document.documentElement.getAttribute('data-theme');
  btn.innerHTML = cur === 'dark' ? icon('sun', 'w-4 h-4') : icon('moon', 'w-4 h-4');
}
initTheme();
