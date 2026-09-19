# VERIFAI Deep Audit — final recording path

Use the deterministic demo repository value `github.com/acme/checkout`.

1. Open VERIFAI and click **Audit your repo**.
2. Leave optional deployed URL/app empty for the deterministic recording. Explain that those inputs expand coverage when supplied.
3. Click **Run Deep Audit**. Show live engine states, actions, evidence, coverage and the hard run budget.
4. Pause on the combined report: three reproduced findings are impact-sorted. Point out Confirmed vs Incomplete/Unknown semantics.
5. In steering, ask: **Investigate duplicate-payment risk after a late webhook.** Show the follow-up tied to the current run.
6. Open the checkout finding and **Review verified fix**.
7. Show the sandbox patch, 10/10 targeted verification, 0 regression failures, redacted 18-second proof-of-fix artifact, and the human-controlled **Create pull request** gate.
8. End on: **You decide what gets merged.**

Recording acceptance:
- Deep Audit is the default path.
- 10 engines participate in the integrated run.
- 3 findings are Confirmed in the deterministic fixture.
- Fix is verified only after targeted + regression checks.
- No auto-merge.
- Clean demo E2E runs twice.
- Estimated demo spend is $0.95/run with a $2.50 hard application cap and $100 credit ceiling context.
- Temporary credentials are redacted and cleared with the run.
