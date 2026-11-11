<script lang="ts">
  import type { ResumableSessionDto } from '$lib/types.js';
  import { formatRelativeTime } from '$lib/format.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import ReadonlyFoldersInput from './readonly-folders-input.svelte';
  import { folderName, withFolder } from '../../readonly-folders.js';

  let {
    open,
    sessions,
    loading,
    loadError,
    actionError,
    resumingId,
    onclose,
    onretry,
    onresume,
  }: {
    open: boolean;
    sessions: readonly ResumableSessionDto[];
    loading: boolean;
    loadError: string;
    actionError: string;
    resumingId: string | null;
    onclose: () => void;
    onretry: () => void;
    /** `readonlyMounts` are added to the session's saved read-only folders. */
    onresume: (sessionId: string, readonlyMounts?: string[]) => void;
  } = $props();

  // Folders to add on resume. This component stays mounted while the dialog
  // is closed, so clear them each time it opens: choices for one resume must
  // not carry over to the next. (A failed resume keeps the dialog open, so the
  // folders survive a retry.)
  let addedFolders = $state<string[]>([]);
  let folderDraft = $state('');
  $effect(() => {
    if (open) {
      addedFolders = [];
      folderDraft = '';
    }
  });

  function close(): void {
    if (resumingId === null) onclose();
  }

  function resume(sessionId: string): void {
    // A typed-but-not-added folder still counts.
    const folders = withFolder(addedFolders, folderDraft);
    onresume(sessionId, folders.length > 0 ? folders : undefined);
  }
</script>

<Modal {open} onclose={close} title="Resume a session" class="max-w-3xl">
  <div class="flex max-h-[80dvh] min-h-56 flex-col">
    <div class="border-b border-border px-5 py-3 text-sm text-muted-foreground">
      Continue a previous container session with its original agent, workspace, profile, persona, and read-only folders.
    </div>
    {#if sessions.length > 0}
      <div class="border-b border-border px-5 py-3">
        <ReadonlyFoldersInput
          bind:folders={addedFolders}
          bind:draft={folderDraft}
          disabled={resumingId !== null}
          testIdPrefix="resume-readonly"
          label="Add read-only folders (optional) · kept with the session"
        />
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto p-4" aria-busy={loading || resumingId !== null}>
      {#if actionError}
        <Alert variant="destructive" class="mb-3 items-start">
          <div class="flex flex-col items-start gap-3">
            <span>{actionError}</span>
            <Button variant="outline" size="sm" onclick={onretry}>Refresh sessions</Button>
          </div>
        </Alert>
      {/if}
      {#if loading}
        <div
          class="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Spinner size="md" />
          Loading resumable sessions…
        </div>
      {:else if loadError}
        <Alert variant="destructive" class="items-start">
          <div class="flex flex-col items-start gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onclick={onretry}>Retry</Button>
          </div>
        </Alert>
      {:else if sessions.length === 0}
        <div class="flex min-h-40 flex-col items-center justify-center px-6 text-center">
          <div class="text-sm font-semibold text-foreground">No resumable sessions</div>
          <p class="mt-1 max-w-sm text-sm text-muted-foreground">
            Completed sessions appear here when their agent supports continuing the conversation.
          </p>
        </div>
      {:else}
        <div class="space-y-2">
          {#each sessions as session (session.sessionId)}
            <article class="rounded-xl border border-border bg-background/40 p-3 transition-colors hover:bg-accent/20">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <span class="truncate text-sm font-semibold" title={session.displayName}>{session.displayName}</span
                    >
                    <Badge
                      variant={session.status === 'crashed' || session.status === 'auth-failure'
                        ? 'warning'
                        : 'secondary'}
                    >
                      {session.status}
                    </Badge>
                  </div>
                  <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span class="font-mono" title={session.sessionId}>{session.sessionId.slice(0, 8)}</span>
                    <span>{session.agent}</span>
                    {#if session.persona}<span>Persona: {session.persona}</span>{/if}
                    {#if session.providerProfileName}<span>Profile: {session.providerProfileName}</span>{/if}
                    <time datetime={session.lastActivity} title={new Date(session.lastActivity).toLocaleString()}>
                      {formatRelativeTime(session.lastActivity)}
                    </time>
                  </div>
                  <div
                    class="mt-1 truncate text-xs text-muted-foreground"
                    title={session.workspaceLabel ?? 'Session sandbox'}
                  >
                    {session.workspaceLabel ?? 'Session sandbox'}
                  </div>
                  {#if session.readonlyMounts && session.readonlyMounts.length > 0}
                    <div
                      data-testid="resume-saved-folders"
                      class="mt-1 truncate text-xs text-muted-foreground"
                      title={session.readonlyMounts.join('\n')}
                    >
                      Read-only: {session.readonlyMounts.map(folderName).join(', ')}
                    </div>
                  {/if}
                </div>
                <Button
                  variant="outline"
                  class="min-h-11 w-full sm:min-h-0 sm:w-auto"
                  loading={resumingId === session.sessionId}
                  disabled={resumingId !== null}
                  aria-label={`Resume ${session.displayName}`}
                  onclick={() => resume(session.sessionId)}
                >
                  {resumingId === session.sessionId ? 'Resuming…' : 'Resume'}
                </Button>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </div>

    <div class="flex justify-end border-t border-border px-5 py-3">
      <Button variant="ghost" disabled={resumingId !== null} onclick={close}>Close</Button>
    </div>
  </div>
</Modal>
