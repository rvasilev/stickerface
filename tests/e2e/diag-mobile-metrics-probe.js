// Diagnostic (NOT a gate): the mobile numbers the optimisation work needs, read
// from the live page instead of guessed — picker target size, canvas backing vs
// CSS box, DPR, viewport units, safe-area insets. Requires E2E_MOBILE=1.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(300);

    const canvas = document.getElementById('stage-canvas');
    const rect = canvas.getBoundingClientRect();
    const firstBtn = document.querySelector('#emoji-picker button');
    const btn = firstBtn?.getBoundingClientRect();
    const cols = getComputedStyle(document.getElementById('emoji-picker')).gridTemplateColumns.split(' ').length;
    const cs = (el) => getComputedStyle(el);
    const app = window.__stickerface;

    r.metrics = {
      viewport: [window.innerWidth, window.innerHeight],
      visualViewport: window.visualViewport ? [Math.round(window.visualViewport.width), Math.round(window.visualViewport.height)] : null,
      devicePixelRatio: window.devicePixelRatio,
      innerHeightVsDvh: {
        innerHeight: window.innerHeight,
        css100vh: (() => { const d = document.createElement('div'); d.style.height = '100vh'; d.style.position = 'absolute'; document.body.append(d); const h = d.getBoundingClientRect().height; d.remove(); return Math.round(h); })(),
        css100dvh: (() => { const d = document.createElement('div'); d.style.height = '100dvh'; d.style.position = 'absolute'; document.body.append(d); const h = d.getBoundingClientRect().height; d.remove(); return Math.round(h); })(),
      },
      safeAreaInsetBottom: (() => {
        // An env() probe element: the footer's own padding is NOT a safe-area
        // measurement (it is authored CSS), which is exactly the confusion this
        // field is here to prevent.
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;padding-bottom:env(safe-area-inset-bottom,0px)';
        document.body.append(d);
        const v = getComputedStyle(d).paddingBottom;
        d.remove();
        return v;
      })(),
      footerPaddingBottom: cs(document.querySelector('.footer')).paddingBottom,
      pickerColumns: cols,
      pickerButtonCss: btn ? [Math.round(btn.width * 10) / 10, Math.round(btn.height * 10) / 10] : null,
      canvasCss: [Math.round(rect.width), Math.round(rect.height)],
      canvasBacking: [canvas.width, canvas.height],
      backingOverCss: [Math.round((canvas.width / rect.width) * 100) / 100, Math.round((canvas.height / rect.height) * 100) / 100],
      idealBackingAtDpr: [Math.round(rect.width * window.devicePixelRatio), Math.round(rect.height * window.devicePixelRatio)],
      previewScale: app?.scale,
      imageNatural: app ? [app.image.naturalWidth, app.image.naturalHeight] : null,
      panelOrder: {
        stage: cs(document.querySelector('.stage')).order,
        panel: cs(document.querySelector('.panel')).order,
        toolbar: cs(document.querySelector('.toolbar')).order,
      },
      pageScrollHeight: document.documentElement.scrollHeight,
      footerTop: Math.round(document.querySelector('.footer').getBoundingClientRect().top),
      emojiDecoded: app?.bitmaps ? app.bitmaps.size : null,
      layerRows: document.querySelectorAll('#layer-list .layer-row').length,
    };
    r.metricKeys = Object.keys(r.metrics);
    r.diagnosticOnly = true;
    r.steps.push(['metrics', r.metrics]);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
