const steps = [
  ['Landing', 'Prove your software works.', 'Connect a repository, define what should work, and watch VERIFIAI execute real verification experiments.', 'Connect GitHub'],
  ['GitHub Login', 'Connect GitHub', 'Demo mode uses a safe repository fixture. Production can switch to the backend OAuth endpoints.', 'Continue'],
  ['Dashboard', 'Projects', 'No dead ends: create the flagship checkout verification project.', 'New Project'],
  ['Repository', 'Select repository', 'aditya-zig/demo-checkout · main · commit 8c4e1b7', 'Analyze Repository'],
  ['Analysis', 'Repository analyzed', 'Node app detected · checkout flow detected · payment dependency detected.', 'Configure Environment'],
  ['Environment', 'Environment setup', 'Build: npm ci && npm run build · Start: npm start · Health: /health', 'Save Environment'],
  ['Requirements', 'What must work?', 'If payment provider is unavailable, checkout must fail gracefully and preserve the cart.', 'Parse Requirements'],
  ['Parsed Requirements', 'Requirement R-CHECKOUT', 'Invariants: cart preserved · loading state exits · no duplicate payment.', 'Create Verification Plan'],
  ['Plan', 'Verification plan', 'Desktop workflow · API checks · 8s payment latency · scoped security regression.', 'Start Verification'],
  ['Verification Lab', 'Live Verification Lab', 'Normal checkout passed. Injecting 8-second payment-provider latency…', 'View Results'],
  ['Results', '1 failure found', 'Normal: VERIFIED · payment latency: FAILED · security: VERIFIED.', 'Failure Evidence'],
  ['Failure Evidence', 'Failure Evidence', 'Reproduced 3/3. Network timeout at 5s; UI remains loading; cart preserved.', 'View Proposed Fix'],
  ['Proposed Fix', 'Confirmed root cause', 'Frontend timeout path never resets checkout loading state. Patch is isolated on a repair branch.', 'Approve & Verify'],
  ['Re-verification', 'Re-verifying repair', 'Original failure rerun · regression suite · chaos experiment · security probe.', 'Finish Verification'],
  ['Fix Verified', 'Fix Verified', 'After fix: 10/10 passed · regressions: 0 · chaos experiment: Passed.', 'Open Project'],
  ['Project Overview', 'Project verified', 'Requirement R-CHECKOUT is VERIFIED with persistent evidence and repair history.', 'Run Again']
];

let index = 0;
const app = document.querySelector('#app');
const stageLabel = document.querySelector('#stageLabel');

function badge(text) {
  const cls = text === 'FAILED' ? 'failed' : text === 'VERIFIED' ? 'verified' : 'running';
  return `<span class="badge ${cls}">${text}</span>`;
}

function render() {
  const [stage, title, copy, cta] = steps[index];
  stageLabel.textContent = stage;
  const status = stage === 'Failure Evidence' || stage === 'Results' ? badge('FAILED') : stage === 'Fix Verified' || stage === 'Project Overview' ? badge('VERIFIED') : badge('RUNNING');
  app.innerHTML = `
    <section class="shell">
      <aside><div class="eyebrow">FLAGSHIP DEMO</div><h2>Checkout resilience</h2><p>Requirement R-CHECKOUT</p><div>${status}</div></aside>
      <article>
        <div class="eyebrow">${stage}</div><h1>${title}</h1><p class="lead">${copy}</p>
        ${stage === 'Verification Lab' ? `<div class="timeline"><p>✓ Environment started</p><p>✓ Normal checkout passed</p><p>→ Latency injected: 8000 ms</p><p>! Failure detected and evidence captured</p></div>` : ''}
        ${stage === 'Failure Evidence' ? `<div class="evidence"><strong>Evidence</strong><p>Screenshot · Network · Runtime · Database · Timeline</p><code>POST /payments/confirm → timeout after 5000 ms</code></div>` : ''}
        ${stage === 'Proposed Fix' ? `<pre>finally {\n  setCheckoutLoading(false);\n  preserveCart();\n}</pre>` : ''}
        <button id="primary">${cta}</button>
      </article>
    </section>`;
  document.querySelector('#primary').addEventListener('click', nextStep);
}

export function nextStep() {
  index = index === steps.length - 1 ? 8 : index + 1;
  render();
}
render();
