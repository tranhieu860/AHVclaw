---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-26-dsh-021-successor-events

English | [中文](2026-10-26-dsh-021-successor-events.zh.md)

## Summary

Declares the dsh 0.2.1 Session events job/registered, job/settled, and working-directory/change, and subagent/catalog payload version 2, so this build reads Sessions written by dsh 0.2.1.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-dsh-021-successor-events
baseline: false
changes:
  - root: "event:job/registered"
    previous: null
    after: "f5520c1d261ca86ea03735799c311a0a9ede8babb588cf0a65422576d2ee0ad1"
    decision: same-version
  - root: "event:job/settled"
    previous: null
    after: "edd37b1e4974af648633014435572089b1e8fb71910468a0767a7e28fdd22abf"
    decision: same-version
  - root: "event:subagent/catalog"
    previous: "2026-09-20-unknown-child-catalog"
    after: "53750b9abf61efb7992b0aadc3e247ec927449c63266df28230fd1139f5590ac"
    decision: same-version
  - root: "event:working-directory/change"
    previous: null
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid and this build writes none of the added records. The payload types equal the dsh 0.2.1-rc.3 declarations (identical root digests). All three events are log-only and no projection here consumes them; the working-directory notice the model sees is a separate user/message. A v2 subagent/catalog fact is validated and omitted from the catalog because no local child Session exists.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/successor-event-admission.spec.ts packages/subagent/subagent/tests/catalog.spec.ts: all tests passed; before the change the JSONL test failed with 'job/registered ... unknown to this harness and not marked ignorable'.

<a id="dev-note"></a>
## Dev Note

None.
