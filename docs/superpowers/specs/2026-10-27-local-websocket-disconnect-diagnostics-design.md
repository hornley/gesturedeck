# Local WebSocket Disconnect Diagnostics

## Goal

Identify whether the local presenter WebSocket or a paired phone WebSocket closes, and record its WebSocket close code and reason when available. Do not change reconnect or session shutdown behavior.

## Design

The local server already receives a `close` event for accepted presenter and phone WebSockets. Log one structured line from each handler with the endpoint (`presenter` or `phone`), close code, and reason. Use JSON serialization for the peer-provided reason so control characters cannot forge terminal log lines. Do not log credentials, phone IDs or labels, peer addresses, or message contents.

These diagnostics are for the local development server only. They add no WebSocket messages and do not change pairing, reconnect, or session lifecycle. When the transport ends without a WebSocket close frame, code and reason may be absent; the endpoint will still be identified.

## Testing

Extend `tests/mobile-remote-server.test.js` to capture the structured logs and verify both endpoint labels plus a peer-supplied close code and reason. Confirm that the local session retains its current behavior when the presenter closes.

## Limits

A close code can distinguish a clean WebSocket close from an unclean transport loss, but it cannot identify the physical cause, such as hotspot power saving or a Wi-Fi interruption.
