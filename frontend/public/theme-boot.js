/* global document, window */
/*
 * Applies the stored colour theme before the first paint (user decision D-5, UX F-15, UI.md section 13), so the other theme
 * never flashes. A same-origin classic script loaded from <head>: the CSP (script-src 'self') forbids inline scripts.
 * Mirrors src/theme/theme.ts: key "snapland.theme", values "dark" | "light", anything else (or a storage that throws)
 * means dark. The OS prefers-color-scheme setting is deliberately not consulted.
 */
(function () {
  var theme = 'dark';
  try {
    var stored = window.localStorage.getItem('snapland.theme');
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch {
    // Storage unavailable (private window, blocked site data): dark.
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
