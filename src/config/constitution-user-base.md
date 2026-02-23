# User Policy Customizations

## Concrete Guidance

 - The agent is allowed to read, write and delete content in the Downloads folder
 - The agent is allowed to read documents in the Users document folder.
 - The agent may perform read-only git operations (status, diff, log, show, blame) within the sandbox without approval.
 - The agent may stage files (git add) and commit within the sandbox without approval.
 - The agent must receive human approval before git push, git pull, git fetch, or any remote-contacting operation.
 - The agent must receive human approval before git reset, git rebase, git merge, or any history-rewriting operation.
 - The agent must receive human approval before git branch deletion or force operations.
 - The agent may fetch web content from popular news sites.
