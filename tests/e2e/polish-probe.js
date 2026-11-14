// Gate: UI/UX polish — the measured defects, not the opinions.
//
// The headline is `noHiddenElementRenders`: nine elements carry the `hidden`
// attribute and six of them rendered anyway, because a class rule that sets
// `display` (`.toolbar button, .file-btn` and `.panel section`) beats the UA's
// `[hidden] { display: none }`. That is why the v1-off controls looked enabled,
// why the About panel was ~690px of always-present markup, and why the panel
// overflowed by ~1030px.
//
// MODE-AWARE ON PURPOSE. The harness sets device metrics before the page loads,
// so one run sees one viewport. Each run asserts only the criteria that hold for
// its viewport — a desktop criterion like "the panel fits without scrolling" is
// simply false on a phone, where the panel is meant to scroll. Criteria that do
// not apply are NOT reported, so none can read as a silent pass; CI runs both.
//
//   desktop (9): noHiddenElementRenders, panelFitsOnDesktop,
//                layersVisibleWithoutScroll, panelSectionsCollapse,
//                focusRingCoverage, controlsAreAtLeast32px,
//                sectionHeadingTreatment, nudgeOrderIsConventional,
//                unitFormatConsistent
//   phone   (4): phoneStageIsHalfTheScreen, controlsAreAtLeast32px,
//                noHorizontalOverflow, panelSectionsCollapse
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const phone = window.matchMedia('(max-width: 880px)').matches || navigator.maxTouchPoints > 0;
  const DESKTOP = ['noHiddenElementRenders', 'panelFitsOnDesktop', 'layersVisibleWithoutScroll',
    'panelSectionsCollapse', 'focusRingCoverage', 'controlsAreAtLeast32px',
    'sectionHeadingTreatment', 'nudgeOrderIsConventional', 'unitFormatConsistent'];
  const PHONE = ['phoneStageIsHalfTheScreen', 'controlsAreAtLeast32px',
    'noHorizontalOverflow', 'panelSectionsCollapse'];
  // Declared false up front: a phase that never runs must leave its criterion
  // failing rather than absent.
  for (const k of (phone ? PHONE : DESKTOP)) r[k] = false;

  try {
    const app = window.__stickerface;
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(350);

    const imgW = app.image.naturalWidth, imgH = app.image.naturalHeight;
    const w = 0.16, h = (w * imgW) / imgH;
    for (const [src, cx, cy] of [['assets/emoji/1f600.svg', 0.3, 0.35],
      ['assets/emoji/1f60d.svg', 0.6, 0.55], ['assets/emoji/1f921.svg', 0.45, 0.7]]) {
      app.store.add({ kind: 'emoji', src, cx, cy, w, h });
    }
    await sleep(500);

    const panel = document.querySelector('aside.panel');
    const visible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const box = (el) => el.getBoundingClientRect();
    const logRef = (el) => ({ w: +box(el).width.toFixed(1), h: +box(el).height.toFixed(1) });

    // ---- shared: touch minimum, with the exceptions named -------------------
    const controls = [...panel.querySelectorAll('button, a, label.file-btn, summary, input')].filter(visible);
    const EXEMPT = (el) => {
      if (el.tagName === 'INPUT' && (el.type === 'range' || el.type === 'file')) return true;
      return el.tagName === 'A' && !!el.closest('p, li');   // inline text links
    };
    const small = controls.filter((el) => !EXEMPT(el) && (box(el).height < 32 || box(el).width < 32))
      .map((el) => ({
        t: (el.textContent || el.getAttribute('aria-label') || el.id || el.tagName).trim().slice(0, 20),
        ...logRef(el),
      }));
    r.controlsAreAtLeast32px = small.length === 0;
    log('under32', { count: small.length, small, controls: controls.length });

    if (!phone) {
      // ---- 1. does `hidden` actually hide? ---------------------------------
      const hiddenReport = [...document.querySelectorAll('[hidden]')].map((el) => ({
        id: el.id || el.tagName,
        display: getComputedStyle(el).display,
        renders: visible(el),
      }));
      const offenders = hiddenReport.filter((e) => e.renders && e.display !== 'none').map((e) => e.id);
      r.noHiddenElementRenders = offenders.length === 0;
      log('hiddenElements', { total: hiddenReport.length, offenders });

      // ---- 2/3. the panel must not be a 1000px wall ------------------------
      const rows = [...panel.querySelectorAll('.layer-row')];
      r.panelFitsOnDesktop = panel.scrollHeight <= panel.clientHeight + 8;
      log('panelOverflow', {
        clientH: panel.clientHeight, scrollH: panel.scrollHeight,
        overflow: panel.scrollHeight - panel.clientHeight,
        sections: [...panel.children].filter(visible).map((s) => {
          const b = box(s);
          const name = s.id || (s.querySelector('h2') ? (s.querySelector('h2').textContent || '').trim().split('\n')[0] : s.tagName);
          return `${name.slice(0, 22)}=${Math.round(b.height)}`;
        }),
      });
      const lastRow = rows[rows.length - 1];
      r.layersVisibleWithoutScroll = !!lastRow && panel.scrollTop === 0
        && box(lastRow).bottom <= box(panel).bottom + 1;
      log('layersVisibility', lastRow ? {
        panelScrollTop: panel.scrollTop,
        lastRowBottom: Math.round(box(lastRow).bottom),
        panelBottom: Math.round(box(panel).bottom),
        rows: rows.length,
      } : { rows: 0 });

      // ---- 5. does a :focus-visible rule cover every control type present? --
      const focusSel = [...document.styleSheets].flatMap((s) => {
        try { return [...s.cssRules]; } catch { return []; }
      })
        .filter((rule) => rule.selectorText && /:focus(-visible)?/.test(rule.selectorText))
        .flatMap((rule) => rule.selectorText.split(',').map((s) => s.trim()))
        .filter((s) => /:focus(-visible)?/.test(s))
        .map((s) => s.replace(/:focus-within|:focus-visible|:focus/g, '').trim())
        .filter(Boolean);
      const uncovered = [...new Set(controls.filter((el) => {
        try { return !focusSel.some((sel) => el.matches(sel)); } catch { return true; }
      }).map((el) => `${el.tagName}${el.type ? '[' + el.type + ']' : ''}${el.id ? '#' + el.id : ''}`))];
      r.focusRingCoverage = controls.length > 0 && uncovered.length === 0;
      log('focusCoverage', { sel: focusSel, uncovered });

      // ---- 7. one treatment for one semantic element -----------------------
      const headings = [...panel.querySelectorAll('h2')].filter(visible);
      const style = (el) => {
        const cs = getComputedStyle(el);
        return [cs.fontSize, cs.fontWeight, cs.textTransform, cs.letterSpacing, cs.color].join('|');
      };
      const treatments = [...new Set(headings.map(style))];
      r.sectionHeadingTreatment = headings.length >= 2 && treatments.length === 1;
      log('headings', { count: headings.length, distinct: treatments });

      // ---- 8. the nudge cluster reads in a conventional order -------------
      // Selected by its label, not by index: the pad's groups are not a fixed
      // list (the mode row was added as the first one), and the claim is about
      // the NUDGE cluster specifically.
      const order = panel.querySelector('#sticker-pad .pad-group[aria-label="Nudge sticker"]');
      const domIds = order ? [...order.querySelectorAll('button')].map((b) => b.id) : [];
      r.nudgeOrderIsConventional = domIds.length === 4
        && domIds.join(',') === 'pad-nudge-left,pad-nudge-up,pad-nudge-down,pad-nudge-right';
      log('nudgeOrder', { dom: domIds });

      // ---- 9. one number format everywhere --------------------------------
      // The tag-stripped markup, once: it includes switched-off sections, so this
      // is a document-wide claim. (Concatenating innerText with this double-counts
      // every string — an earlier version did, and read 4/4 instead of 2/2.)
      const text = document.body.innerHTML.replace(/<[^>]+>/g, ' ');
      const spaced = (text.match(/\b\d+\s+px\b/g) || []).length;
      const unspaced = (text.match(/\b\d+px\b/g) || []).length;
      r.unitFormatConsistent = spaced + unspaced > 0 && !(spaced > 0 && unspaced > 0);
      log('unitFormat', { spaced, unspaced });
    } else {
      const stage = document.getElementById('stage');
      const hPct = box(stage).height / window.innerHeight;
      r.phoneStageIsHalfTheScreen = hPct >= 0.42;
      log('phoneStage', {
        stageH: Math.round(box(stage).height), viewportH: window.innerHeight, pct: +hPct.toFixed(3),
      });
      r.noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
      log('overflowX', { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth });
    }

    // ---- 4. collapse, through real input (both viewports) ------------------
    // Scroll it into view FIRST: the panel is over 1000px tall, so the Layers
    // summary starts below the fold and a click at its measured coordinates would
    // land outside the viewport and prove nothing. The layout criteria above were
    // measured before this scroll, so they still describe the unscrolled state.
    const details = [...panel.querySelectorAll('details')];
    const summary = details[0] ? details[0].querySelector('summary') : null;
    if (summary) summary.scrollIntoView({ block: 'center' });
    await sleep(250);
    const sb = summary ? box(summary) : null;
    log('collapsibles', {
      count: details.length,
      summaryAt: sb && { x: Math.round(sb.left + sb.width / 2), y: Math.round(sb.top + sb.height / 2) },
    });
    const snaps = {};
    window.__sfSnaps = snaps;
    window.__sfSnap = (name) => {
      const list = document.getElementById('layer-list');
      const d = details[0];
      snaps[name] = {
        details: details.map((x) => x.open),
        rows: list.children.length,
        detailsH: d ? Math.round(d.getBoundingClientRect().height) : -1,
        // Recorded, NOT asserted: a closed <details> leaves its child's rect alone
        // (Chromium hides the content with content-visibility), so this is a
        // useless collapse signal — the details' own height is the honest one.
        listH: Math.round(list.getBoundingClientRect().height),
      };
      return true;
    };
    if (sb) {
      window.__sfNextInput = [
        { t: 'settle', ms: 250 },
        { t: 'read', name: 'open0' },
        { t: 'click', pts: [[sb.left + sb.width / 2, sb.top + sb.height / 2]], ms: 350 },
        { t: 'read', name: 'closed' },
        { t: 'click', pts: [[sb.left + sb.width / 2, sb.top + sb.height / 2]], ms: 350 },
        { t: 'read', name: 'reopened' },
      ];
    }
    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const a = s.open0, b = s.closed, c = s.reopened;
      // Guarded: a click that missed leaves open0/closed identical, which must
      // FAIL rather than count as "no change".
      r.panelSectionsCollapse = !!(a && b && c
        && a.details[0] === true && b.details[0] === false && c.details[0] === true
        && b.rows === a.rows && a.rows > 0            // collapsing must not rebuild the list
        && b.detailsH < a.detailsH * 0.5              // the section visibly shrinks
        && c.detailsH >= a.detailsH * 0.9);           // and comes back
      return JSON.stringify({
        panelSectionsCollapse: r.panelSectionsCollapse,
        steps: [['collapse', {
          open: a && a.details, closed: b && b.details, reopened: c && c.details,
          detailsH: [a && a.detailsH, b && b.detailsH, c && c.detailsH],
          listH: [a && a.listH, b && b.listH, c && c.listH],
          rows: [a && a.rows, b && b.rows, c && c.rows],
          collapsibleSections: details.length,
        }]],
      });
    };
    log('armed', { mode: phone ? 'phone' : 'desktop', criteria: (phone ? PHONE : DESKTOP).length, steps: (window.__sfNextInput || []).length });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
