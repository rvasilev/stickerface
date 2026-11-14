// THROWAWAY self-test for the harness, not a gate. Deleted in the same session that
// created it. Its purpose is to prove the shortfall run.py must now catch really does
// fail the run: the touch phase is driven for real, then its reader returns NOTHING
// without throwing. No exception is raised, so the console section stays clean and the
// main reader stays green — only the harness's own "no result at all" check can catch
// it. Before that check existed this printed one line and exited 0.
(async () => {
  window.__sfTouchSteps = async () => JSON.stringify([['selftest', 'drive one touch step']]);
  window.__sfReadTouch = async () => undefined;   // returns nothing, does not throw

  const r = { steps: [], errors: [] };
  const log = (k, v) => r.steps.push([k, v]);
  log('selfTest', 'main reader ran; the failure must come from the touch phase');
  r.mainReaderIsGreen = true;
  r.secondCriterionIsGreen = 1 + 1 === 2;
  return JSON.stringify(r);
})()
