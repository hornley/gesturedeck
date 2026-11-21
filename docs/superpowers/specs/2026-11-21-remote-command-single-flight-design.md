# Remote command single-flight lock design

**Date:** 2026-11-21

## Goal

Prevent two paired phones from issuing overlapping navigation commands to one presentation. Multiple phones remain paired and may take turns controlling it.

## Approved behavior

- Accept and forward the first valid remote command.
- While that command awaits its presenter acknowledgment, reject later remote commands with the existing `{ type: 'commandAck', accepted: false }` response. Do not queue or replay rejected taps.
- Release the lock only for the matching acknowledgment. A phone disconnect does not release an already-forwarded command.
- Once released, any paired phone may send the next command. Each presentation has an independent lock.

## Design

The in-memory `createMobileRemoteSession` owns the local and in-process cloud lock. Its existing pending presenter-command records provide the gate: set the pending record before forwarding, reject a new command while one is outstanding, and clear the record on its acknowledgment. Keep a pending record until acknowledgment even if its phone disconnects, so removal cannot unlock a command that may still execute.

The Vercel Redis relay needs a cross-instance lock. `PHONE_COMMAND_SCRIPT` claims a per-session Redis key with `SET NX` before appending and publishing a command. The key value is the presenter command ID. `PRESENTER_ACK_SCRIPT` releases it only when the acknowledgment identifies that same command. Give the key the existing 20-second presenter-lease TTL as recovery if an acknowledgment is lost. The script returns a busy result when another command owns the key; the WebSocket route maps that result to the existing negative acknowledgment.

This keeps the wire protocol and phone UI unchanged. It applies only to remote commands; keyboard and presenter-window controls remain independent.

## Scope and verification

Update the focused mobile-remote session checks for rejection while a command is pending, release after its matching acknowledgment, and continued locking after phone removal. Update the Redis fake-model checks for the lock result and matching release; the fake model does not execute the production Lua scripts, so it cannot prove Redis atomicity. Review the Lua operations to confirm claim and command publication are in one script and that only the matching acknowledgment releases the lock.

No persistent controller ownership, command queue, new message fields, or UI controls are in scope.
