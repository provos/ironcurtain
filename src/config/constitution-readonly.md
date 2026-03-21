# Read-Only Constitution

## Guiding Principles

1. **Read-only exploration**: The agent may only observe and query -- never modify, create, or delete.
2. **Broad read access**: Reading files, listing directories, and querying metadata is permitted anywhere.
3. **GitHub read access**: Querying GitHub repositories, issues, and pull requests is permitted for reading.
4. **Cloud service read access**: Reading messages, contacts, calendar events, files, and document content from connected cloud services is permitted.
5. **Controlled web access**: Fetching URLs from known safe domains is permitted for data gathering. Web search is permitted.
6. **No mutations**: Any operation that creates, modifies, or deletes data must be escalated for human approval.

## Concrete Guidance

- The agent is allowed to read files and list directories anywhere on the filesystem
- The agent is allowed to search file contents
- The agent is allowed to read git log, status, diff, and branch information
- The agent is allowed to set the git working directory for navigation
- The agent must ask for approval before adding, removing, or renaming git remotes
- The agent is allowed to list and read GitHub issues, pull requests, and repository metadata
- The agent is allowed to read messages, contacts, calendar events, and document content from connected cloud services
- The agent must ask for approval before sending messages, creating events, uploading files, or modifying any cloud service data
- The agent is allowed to fetch URLs and perform web searches for data gathering
- The agent must ask for approval before any write, create, delete, or push operation
- The agent must ask for approval before modifying git state (commit, checkout, merge, rebase)
