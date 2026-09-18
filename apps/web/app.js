const steps = [
  ['Landing', 'Prove your software works.', 'Connect a repository, define what should work, and watch VERIFIAI execute real verification experiments.', 'Connect GitHub'],
  ['GitHub Login', 'Connect GitHub', 'Demo mode uses a safe repository fixture. Production can switch to the backend OAuth endpoints.', 'Continue'],
  ['Dashboard', 'Projects', 'Create the flagship checkout verification project.', 'New Project'],
  ['Repository', 'Select repository', 'aditya-zig/demo-checkout · main · commit 8c4e1b7', 'Analyze Repository'],
  ['Analysis', 'Repository analyzed', 'Node app detected · checkout flow detected · payment dependency detected.', 'Configure Environment'],
  ['Environment', 'Environment setup', 'Build: npm ci && npm run build · Start: npm start · Health: /health', 'Save Environment'],
  ['Requirements', 'What must work?', 'If payment provider is unavailable, checkout must fail gracefully and preserve the cart.', 'Parse Requirements'],
  ['Parsed Requirements', 'Requirement R-CHECKOUT', 'Invariants: cart preserved · loading state exits · no duplicate payment.', 'Create Verification Plan'],
  ['Plan', 'Verification plan', 'Desktop workflow · API checks · 8s payment latency · scoped security regression.', 'Start Verification'],
  ['Verification Lab', 'Live Verification Lab', 'Starting the executed flagship verification run…', 'View Results'],
  ['Results', 'Verification result', 'Executed evidence is ready.', 'Failure Evidence'],
  ['Failure Evidence', 'Failure Evidence', 'Executed evidence reproduced the failure.', 'View Proposed Fix'],
  ['Proposed Fix', 'Confirmed root cause', 'The investigator confirmed the root cause from executed evidence.', 'Approve & Verify'],
  ['Re-verification', 'Repair re-verified', 'The original experiment and regression checks were rerun.', 'Finish Verification'],
  ['Fix Verified', 'Fix Verified', 'The repaired behavior is verified.', 'Open Project'],
  ['Project Overview', 'Project verified', 'Requirement R-CHECKOUT is VERIFIED with persistent evidence and repair history.', 'Run Again']
];

let index = 0;
let runResult = null;
let runPending = false;
let runError = '';
const app = document.querySelector('#app');
const stageLabel = document.querySelector('#stageLabel');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function badge(text) {
  const cls = text === 'FAILED' ? 'failed' : text === 'VERIFIED' ? 'verified' : 'running';
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

function stageCopy(stage, fallback) {
  if (stage === 'Verification Lab') {
    if (runPending) return 'Running sandbox, desktop verification, chaos injection, evidence capture and repair re-verification…';
    if (runError) return `Verification could not complete: ${runError}`;
    if (runResult) return `Run ${runResult.runId} completed with ${runResult.evidence.length} evidence items.`;
  }
  if (!runResult) return fallback;
  if (stage === 'Results') return `Baseline verdict: ${runResult.before.verdict} · ${runResult.evidence.length} evidence items collected.`;
  if (stage === 'Failure Evidence') return runResult.before.reason;
  if (stage === 'Proposed Fix') return runResult.finding.rootCause;
  if (stage === 'Re-verification') return `Repair branch ${runResult.repair.branch} was applied in the controlled demo run and the checks were rerun.`;
  if (stage === 'Fix Verified') return `After fix: ${runResult.after.verdict} · regressions: ${runResult.regressions} · chaos restored: ${runResult.chaosRestored ? 'yes' : 'no'}.`;
  if (stage === 'Project Overview') return `R-CHECKOUT is ${runResult.after.verdict}. Evidence from run ${runResult.runId} remains tied to the verification result.`;
  return fallback;
}

function render() {
  const [stage, title, fallbackCopy, defaultCta] = steps[index];
  stageLabel.textContent = stage;
  const copy = stageCopy(stage, fallbackCopy);
  const verdict = stage === 'Results' || stage === 'Failure Evidence'
    ? (runResult?.before.verdict ?? 'RUNNING')
    : stage === 'Fix Verified' || stage === 'Project Overview'
      ? (runResult?.after.verdict ?? 'RUNNING')
      : 'RUNNING';

  const cta = stage === 'Verification Lab' && runPending
    ? 'Running verification…'
    : stage === 'Verification Lab' && runError
      ? 'Retry Verification'
      : defaultCta;

  app.innerHTML = `
    <section class="shell">
      <aside><div class="eyebrow">FLAGSHIP DEMO</div><h2>Checkout resilience</h2><p>Requirement R-CHECKOUT</p><div>${badge(verdict)}</div></aside>
      <article>
        <div class="eyebrow">${escapeHtml(stage)}</div><h1>${escapeHtml(title)}</h1><p class="lead">${escapeHtml(copy)}</p>
        ${stage === 'Verification Lab' ? `<div class="timeline"><p>✓ Environment started</p><p>✓ Normal checkout executed</p><p>→ Payment latency: 8000 ms</p><p>${runPending ? '→ Verification in progress' : runResult ? '! Failure reproduced, repaired and re-verified' : runError ? '! Run failed to complete' : '→ Ready to execute'}</p></div>` : ''}
        ${stage === 'Failure Evidence' && runResult ? `<div class="evidence"><strong>Executed evidence</strong><p>${runResult.evidence.length} items · Network · Runtime · Screenshot · Database · Code</p><code>POST /payments/confirm → timeout after 5000 ms</code></div>` : ''}
        ${stage === 'Proposed Fix' && runResult ? `<pre>${escapeHtml(runResult.repair.patch)}</pre>` : ''}
        <button id="primary"${runPending && stage === 'Verification Lab' ? ' disabled' : ''}>${escapeHtml(cta)}</button>
      </article>
    </section>`;

  const button = document.querySelector('#primary');
  if (runPending && stage === 'Verification Lab') return;
  if (stage === 'Plan') return button.addEventListener('click', startVerification);
  if (stage === 'Verification Lab' && runError) return button.addEventListener('click', runVerification);
  button.addEventListener('click', nextStep);
}

async function startVerification() {
  index = 9;
  runResult = null;
  runError = '';
  render();
  await runVerification();
}

async function runVerification() {
  runPending = true;
  runError = '';
  render();
  try {
    const response = await fetch('/api/demo/flagship', {
      method: 'POST',
      headers: { accept: 'application/json' }
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    runResult = payload.run;
  } catch (error) {
    runResult = null;
    runError = String(error?.message ?? error);
  } finally {
    runPending = false;
    render();
  }
}

export function nextStep() {
  index = index === steps.length - 1 ? 8 : index + 1;
  render();
}

render();
