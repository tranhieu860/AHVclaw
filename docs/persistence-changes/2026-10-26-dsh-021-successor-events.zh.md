---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-26-dsh-021-successor-events

[English](2026-10-26-dsh-021-successor-events.md) | 中文

## 概述

声明 dsh 0.2.1 的 Session 事件 job/registered、job/settled、working-directory/change 以及 subagent/catalog 载荷 v2，使本版本能读取 dsh 0.2.1 写入的 Session。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效，本版本不写入任何新增记录。载荷类型与 dsh 0.2.1-rc.3 的声明相同（根摘要一致）。三个事件均为仅日志，此处没有 projection 消费它们；模型看到的工作目录通知是单独的 user/message。v2 subagent/catalog 事实会被校验，并因没有本地子 Session 而从目录中省略。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/successor-event-admission.spec.ts packages/subagent/subagent/tests/catalog.spec.ts：全部测试通过；改动前 JSONL 测试以 'job/registered ... unknown to this harness and not marked ignorable' 失败。

<a id="dev-note"></a>
## 开发备注

无。
