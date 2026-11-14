// Registers the service worker and offers an update.
//
// The worker never reloads on its own: the photo and stickers live in memory, so an automatic
// reload would destroy unexported work. The bar asks, and the reload happens on
// `controllerchange` after the click — reloading in the same tick as SKIP_WAITING can land
// back under the old worker.
const bar = document.getElementById('update-bar');
const reloadBtn = document.getElementById('update-reload');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let reloading = false;
  const offerUpdate = () => { if (bar) bar.hidden = false; };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      // A worker already waiting when this page loaded is an update too. `updatefound` alone
      // misses it: that fires only for an install starting now.
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate();

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
        });
      });

      if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
          reloading = true;
          // The message goes to the WAITING worker. `skipWaiting()` on the ACTIVE one is a no-op,
          // and posting to `navigator.serviceWorker.controller` (which is what this did) therefore
          // left the update waiting forever: no activation, no `controllerchange`, no reload, and
          // the bar sat there looking like a click that had been ignored. `reg.waiting` is null
          // only once that worker has already activated, and then a reload is all that is left.
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          else location.reload();
          // Say something either way. Disabled-and-labelled beats a live button that appears to do
          // nothing while the new worker takes over.
          reloadBtn.disabled = true;
          reloadBtn.textContent = 'Reloading…';
        });
      }
    } catch (err) {
      // First visit with no network, or the API switched off: the app still works, it simply
      // is not cached. This must never throw into the boot path.
      console.warn('service worker not registered:', err);
    }
  });
}
