// Registers the service worker and surfaces an update.
//
// It deliberately does NOT reload by itself. The editor keeps the photo and the stickers in
// memory only (there is no persistence yet), so an automatic update would throw away work the
// user has not exported. The reload is the user's click, and it is the only safe place for it
// until autosave exists. Same reason the worker does not skipWaiting() on install: a new
// version waits until it is asked for, rather than taking over under a running page.
const bar = document.getElementById('update-bar');
const reloadBtn = document.getElementById('update-reload');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let reloading = false;

  // Reload only once the NEW worker actually controls the page. Posting SKIP_WAITING and
  // calling location.reload() in the same tick would sometimes reload into the OLD worker
  // still in charge, which looks exactly like the update not working.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      // "installled while something is already controlling this page" is an update, not a
      // first install — only then is there a version to offer.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller && bar) {
            bar.hidden = false;
          }
        });
      });

      if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
          reloading = true;
          navigator.serviceWorker.controller?.postMessage({ type: 'SKIP_WAITING' });
        });
      }
    } catch (err) {
      // Offline on a first visit, or a browser with the API switched off: the app itself still
      // works, it is simply not cached. This must never throw into the app's boot path.
      console.warn('service worker not registered:', err);
    }
  });
}
