# Local and Hosted WebSocket Disconnect Diagnostics

## Goal

Identify whether the local presenter, a paired phone, or a hosted Vercel presenter/phone WebSocket closes, and record its close code and reason when available. Do not change reconnect or session shutdown behavior.

## Design

The local server receives a `close` event for accepted presenter and phone WebSockets. The Redis-backed hosted relay used by Vercel also receives close events after its route has been resolved to presenter or phone. Log one structured line from each endpoint with its role, close code, and reason. Use JSON serialization for the peer-provided reason so control characters cannot forge terminal log lines. Do not log credentials, session IDs, phone IDs or labels, peer addresses, or message contents.

These diagnostics appear in the local development server terminal and Vercel function logs. They add no WebSocket messages and do not change pairing, reconnect, or session lifecycle. When the transport ends without a WebSocket close frame, code and reason may be absent; the endpoint will still be identified.

## Testing

Extend `tests/mobile-remote-server.test.js` and `tests/cloud-remote-redis-server.test.js` to capture the structured logs and verify both endpoint labels plus a peer-supplied close code and reason. Confirm that existing local and hosted close behavior remains unchanged.

## Limits

A close code can distinguish a clean WebSocket close from an unclean transport loss, but it cannot identify the physical cause, such as hotspot power saving or a Wi-Fi interruption.
