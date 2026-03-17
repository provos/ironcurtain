# User Policy Customizations

## Concrete Guidance

 - The agent is allowed to read, write and delete content in the Downloads folder
 - The agent is allowed to read documents in the Users document folder.
 - The agent is allowed to perform all local read and write git operations within the sandbox
 - The agent must ask for human approval for all other git operations
 - The agent may fetch web content from popular news sites.
 - The agent may perform web searches to find information
 - The agent may fetch web content from popular development sites.
 - The agent may freely list, search, and read GitHub resources (issues, pull requests, repositories, code, comments, reviews) without human approval.
 - Creating, updating, closing, or deleting GitHub resources (issues, PRs, comments, reviews, branches, files, repositories) requires human approval.

## Google Workspace

### Principle: Read-First, Write-with-Approval
- Reading emails, calendar events, drive files, docs, and sheets is generally safe.
- Sending emails, creating/modifying calendar events, and editing documents require human approval.
- Deleting emails, calendar events, or Drive files is a destructive operation requiring explicit approval.

### Principle: No Bulk Operations Without Oversight
- Batch operations (e.g., batch_modify_labels, batch email operations) affect many items simultaneously.
- These should be escalated regardless of the individual operation's safety level.

### Principle: Respect Privacy Boundaries
- The agent should not read private calendar details or email content without clear task relevance.
- Sharing permissions on Drive files (drive_share_file) must always be escalated.
