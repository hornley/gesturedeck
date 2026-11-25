# Hosted pairing recovery design

## Problem

The hosted phone can show “This pairing link is invalid” when a pairing attempt carries an outdated invite. Renewing a link replaces its token, so older QR codes no longer work. The hosted phone handler also maps missing or ended Redis sessions to the same `invalid` reason, obscuring the actual failure.

The presenter can still show phone rows as “Reconnecting” after their short-lived connection leases expire. Those rows are retained records, not proof that the phone or the opened link is connected. They do not block pairing while the session is below its eight-phone limit.

## Design

- Preserve distinct hosted pair rejection reasons. Keep `invalid` for a mismatched or locked invite, keep `expired` for an expired invite, and map missing and ended sessions to separate reasons.
- Show phone recovery copy that tells the user when the session is missing or ended. Retain the existing guidance for invalid and expired invites.
- Keep phone record and lease behavior unchanged. “Reconnecting” continues to mean a saved phone record has no live lease; the presenter’s Disconnect control removes that record.
- Treat `extension/manifest.json` `version` as the extension release version. Bump its patch once per user-facing PR that changes extension code or packaged extension assets. Do not bump per commit or for unrelated application, test, or documentation changes. Keep it independent from the root package version. This hosted relay change does not touch extension files, so it does not bump the manifest.

## Verification

Add focused hosted relay and phone client tests for missing and ended sessions, true invite expiry, old invites after renewal, and the existing rejection/renewal behavior. Verify a renewed invite still pairs while prior phone records remain intact. Do not change behavior outside those cases.

## Out of scope

- Changing invite lifetime, attempt limits, phone lease lifetime, or the eight-phone limit.
- Automatically deleting reconnecting phone records.
- Automatically bumping extension versions in CI.
