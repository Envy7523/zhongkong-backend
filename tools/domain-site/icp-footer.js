// Domain gateway footer: place the existing filing link inside the app's scroll area.
// No auth, routing, business data, or global layout changes.
(() => {
  const footer = document.getElementById('site-icp-filing');
  const app = document.getElementById('app');
  if (!footer || !app) return;

  function placeFooter() {
    const content = app.querySelector('.app-layout .content-area');
    const target = content || document.body;
    if (footer.parentElement !== target) target.appendChild(footer);
    footer.style.marginTop = content ? '20px' : '0';
    footer.style.background = 'transparent';
    footer.style.position = 'static';
    footer.style.flex = '0 0 auto';
    footer.style.width = 'auto';
  }

  placeFooter();
  // Vue mounts asynchronously and replaces the login shell on sign-in/sign-out.
  // Child-list observation also restores the footer if a route replaces its container.
  new MutationObserver(placeFooter).observe(app, {childList: true, subtree: true});
})();
