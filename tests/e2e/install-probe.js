// Gate — the app is installable: a linked, parseable manifest whose icons really load and
// decode at the sizes they declare.
//
// One criterion cannot be seen from page JS at all — whether the BROWSER considers the app
// installable — so tests/e2e/run.py adds `installabilityErrorsEmpty` from CDP
// `Page.getInstallabilityErrors` when E2E_INSTALLABILITY=1. Together they say: the manifest
// is not merely well-formed, the browser accepts it.
(async () => {
  const r = { steps: [], errors: [] };
  const log = (k, v) => r.steps.push([k, v]);

  // A criterion must be able to fail: declare every one false up front, so a throw below
  // leaves a RED probe rather than a missing key that reads as "not tested".
  r.manifestLinked = false;
  r.manifestParses = false;
  r.manifestMembersPresent = false;
  r.iconsLoadAndDecode = false;
  r.appleTouchIconPresent = false;
  r.themeColorMatchesAppBackground = false;

  try {
    const link = document.querySelector('link[rel="manifest"]');
    r.manifestLinked = !!link;
    log('manifestHref', link && link.getAttribute('href'));
    if (!link) return JSON.stringify(r);

    const res = await fetch(link.href, { cache: 'no-store' });
    r.manifestParses = res.ok;
    const m = await res.json();
    log('manifest', m);

    const icon = (m.icons || []).find(
      (i) => (i.purpose || 'any').split(' ').includes('any') && /192|any/.test(i.sizes || ''),
    );
    r.manifestMembersPresent = !!(
      (m.name || m.short_name) && m.start_url && m.display &&
      ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display) && icon
    );

    // Decode every icon for real: a 404, a mislabelled type or a lying `sizes` shows up
    // here and nowhere else. `naturalWidth` is the decoded truth.
    const decodes = [];
    for (const i of m.icons || []) {
      const img = new Image();
      img.src = new URL(i.src, link.href).href;
      const ok = await new Promise((done) => {
        img.onload = () => done(img.naturalWidth > 0);
        img.onerror = () => done(false);
      });
      const [w, h] = (i.sizes || '').split('x').map(Number);
      decodes.push({
        src: i.src, ok, declared: i.sizes,
        decoded: ok ? [img.naturalWidth, img.naturalHeight] : null,
        matches: ok && (!w || (img.naturalWidth === w && img.naturalHeight === h)),
      });
    }
    r.iconsLoadAndDecode = decodes.length > 0 && decodes.every((d) => d.ok && d.matches);
    log('icons', decodes);

    const ati = document.querySelector('link[rel="apple-touch-icon"]');
    if (ati) {
      const img = new Image();
      img.src = ati.href;
      r.appleTouchIconPresent = await new Promise((done) => {
        img.onload = () => done(img.naturalWidth === 180 && img.naturalHeight === 180);
        img.onerror = () => done(false);
      });
    }
    log('appleTouchIcon', ati && ati.getAttribute('href'));

    // The theme colour must equal what the app actually paints, or the installed splash and
    // the first frame disagree and the launch flashes a different colour.
    const meta = document.querySelector('meta[name="theme-color"]');
    const bg = getComputedStyle(document.body).backgroundColor;
    const rgb = bg.match(/\d+/g);
    const hex = meta && rgb
      ? '#' + rgb.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('')
      : null;
    r.themeColorMatchesAppBackground = !!meta && hex === meta.getAttribute('content').toLowerCase();
    log('theme', { meta: meta && meta.getAttribute('content'), computed: hex });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
