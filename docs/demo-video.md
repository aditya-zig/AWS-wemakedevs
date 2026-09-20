# VERIFAI demo recording guide

The repository includes `assets/verifai-product-demo.mp4`, extracted from the exact base64 MP4 embedded in `apps/web/index.html`. It is the frontend product clip and may be used in the README as product media.

Do **not** treat that clip as executed verification evidence. The final audit-evidence recording should still come from a real VERIFAI run. After review, use separate assets such as:

~~~text
assets/verifai-audit-demo.gif
assets/verifai-audit-demo.mp4
~~~

Only the real audit recording may be used to demonstrate A11/A12 execution evidence, findings or repair proof.

## Target

**45–60 seconds.** The viewer should understand:

**GitHub repo → Deep Audit → agents visibly working → executed evidence → truthful findings → investigation → repair/re-verification**

## Recording preflight

Before recording:

1. Start the real VERIFAI web UI and API.
2. Use a repository/run that can produce real executed evidence.
3. Confirm secrets/tokens are absent from the browser, terminal, URL, logs and evidence panel.
4. Confirm unavailable engines show **Incomplete**, not fake success.
5. Confirm the run can reach a terminal state and the evidence panel contains real artifacts/events.
6. If repair/re-verification appears, use a repair that was actually executed and independently rechecked.

## Exact 45–60 second shot list

| Time | Shot | What must be visible |
| --- | --- | --- |
| **0–5s** | **GitHub repo** | VERIFAI product UI. Enter/select a real GitHub repository. Keep product name + repo visible. |
| **5–10s** | **Deep Audit** | Trigger Deep Audit. Show resolved repo/branch/commit or the first real bootstrap/progress state. |
| **10–22s** | **Agents working** | Live specialist cards/events changing over time. Show actual Strands/worker activity, not a mock animation. |
| **22–31s** | **Executed evidence** | Open one real engine output, browser/computer trace, screenshot, API result, metric or reproduction artifact. |
| **31–39s** | **Truthful findings** | Combined report with Confirmed/Unconfirmed/Unknown/Incomplete state. Keep incomplete lanes visible. |
| **39–47s** | **Investigation** | Show an investigator/judge step or evidence trail that distinguishes confirmed from unconfirmed. |
| **47–55s** | **Repair + re-verification** | If a verified repair exists, show isolated repair plus targeted re-verification/regression result. |
| **55–60s** | **Final proof** | End on findings, evidence count, re-verification/PR-ready state and a clean VERIFAI frame. |

## Suggested narration

> Connect a repository and VERIFAI turns it into a real verification lab. Strands agents plan the audit, isolated workers run real security, API, browser, computer-use, chaos and performance checks, and every claim is tied to executed evidence. Conflicting signals stay unconfirmed; tools that cannot run stay incomplete. When VERIFAI proposes a repair, it re-runs the failing experiment and regressions before the fix becomes PR-ready.

## Capture rules

- Prefer one continuous real product recording over stitched fake states.
- Speed up waiting only when the edit does not alter the meaning of the run.
- Never insert synthetic findings, fake terminals, placeholder screenshots or manufactured success states.
- Configure/redact secrets so they are never exposed.
- If an engine is Incomplete, leave it truthful.
- Keep the cursor visible during interactions.
- Capture 16:9 MP4 first; derive the GIF from that same real recording.

## Upgrade the README hero with audit evidence

The README already links the frontend product clip. After a real audit recording is captured and reviewed:

1. Add <code>assets/verifai-audit-demo.mp4</code>.
2. Derive <code>assets/verifai-audit-demo.gif</code> from that same recording.
3. Use the GIF as the README hero and link it to the audit MP4.
4. Keep the frontend product clip only if it still adds value.
5. Re-run README/link checks before merge.
