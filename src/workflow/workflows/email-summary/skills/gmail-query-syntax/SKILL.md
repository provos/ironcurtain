---
name: gmail-query-syntax
description: Reference for Gmail's search query syntax — operators like is:sent, newer_than:, from:, has:attachment, label:, and how they compose. Read this when constructing a Gmail search query string for the google_workspace.gmail_search_messages Code Mode call, especially when filtering by sent vs received, recency, sender, or labels.
---

# Gmail query syntax primer

These tools live on the `google-workspace` MCP server, sanitized to
`google_workspace` in Code Mode. In Docker Agent Mode the only MCP tool
exposed to Claude Code is `execute_code`; write TypeScript inside it and
call the Gmail tools as dotted callables, e.g.
`google_workspace.gmail_search_messages({ query: "is:sent", pageSize: 3 })`.

`gmail_search_messages` accepts a `query` parameter that uses Gmail's
standard search operator language — the same syntax the Gmail web UI
search box accepts. Operators combine with implicit AND; use `OR`
(uppercase) for disjunction and parentheses for grouping.

Note: `gmail_search_messages` returns message IDs, thread IDs, and URLs
only — not full message contents. To read sender, recipient, subject,
date, and body for a matched message, follow up with
`google_workspace.gmail_get_message` (single id) or
`google_workspace.gmail_get_messages_batch` (array of ids).

## Common operators

| Operator          | Meaning                                         | Example                   |
| ----------------- | ----------------------------------------------- | ------------------------- |
| `is:sent`         | Messages the user sent (not received)           | `is:sent`                 |
| `is:unread`       | Unread messages                                 | `is:unread`               |
| `is:starred`      | Starred messages                                | `is:starred`              |
| `from:<addr>`     | Sender address (substring or full)              | `from:alice@example.com`  |
| `to:<addr>`       | Recipient address                               | `to:team@example.com`     |
| `subject:<text>`  | Subject contains text                           | `subject:"weekly update"` |
| `newer_than:<n>d` | Messages newer than N days (also `h`, `m`, `y`) | `newer_than:7d`           |
| `older_than:<n>d` | Messages older than N (same units)              | `older_than:30d`          |
| `after:<date>`    | After a date (YYYY/MM/DD)                       | `after:2025/01/01`        |
| `before:<date>`   | Before a date                                   | `before:2025/02/01`       |
| `has:attachment`  | Messages with at least one attachment           | `has:attachment`          |
| `label:<name>`    | Messages with the given Gmail label             | `label:invoices`          |
| `in:inbox`        | In the inbox (excludes archived)                | `in:inbox`                |
| `in:anywhere`     | Includes Spam and Trash (rarely needed)         | `in:anywhere`             |

## Composing queries

- Implicit AND: `is:sent newer_than:7d` -> sent in the last 7 days.
- Explicit OR with grouping: `(from:alice OR from:bob) is:unread`.
- Negation with `-`: `is:sent -label:archived`.
- Quote multi-word values: `subject:"quarterly review"`.

## Tips

- Prefer `newer_than:Nd` over `after:` when "the last N days" is what
  you actually want — `after:` is calendar-anchored and behaves
  unexpectedly across timezone boundaries.
- For "the most recent N sent emails", combine `is:sent` with the
  `pageSize` argument on the dotted call —
  `google_workspace.gmail_search_messages({ query: "is:sent", pageSize: N })` —
  do not try to express the limit inside the query string. (Pagination
  tokens come back as `pageToken` and are passed back in via the same
  argument name on the next call if you need to walk past the first page.)
- The query is case-insensitive for operator names but case-sensitive
  inside quoted values.
