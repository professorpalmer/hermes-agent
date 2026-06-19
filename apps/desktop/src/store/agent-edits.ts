import { atom, computed } from 'nanostores'

import { $activeSessionId, $currentCwd } from './session'

// Cursor-style agent edit review.
//
// Every time the agent completes a file-mutating tool (`patch` / `write_file`),
// the gateway emits a `tool.complete` with the tool name, args (incl. the path)
// and a rendered unified `inline_diff`. We capture those here as a per-session
// queue of *pending* edits the user can review and accept / reject — without
// any backend change (the edit already landed on disk; this is a review layer
// over the working tree, the same model Cursor uses).
//
// Accept = keep the on-disk change, drop it from the queue.
// Reject = reverse-apply the captured diff to the worktree (surgically undo just
//          the agent's hunk, preserving any unrelated edits), drop from queue.

export interface PendingEdit {
  /** Tool call id — stable key for the edit. */
  toolId: string
  /** Workspace-relative (or absolute) file path the agent touched. */
  path: string
  /** The tool that produced it. */
  tool: 'patch' | 'write_file'
  /** Rendered unified diff for the change (from the gateway). */
  diff: string
  /** Whether the file was newly created (write_file to a non-existent path). */
  isNew: boolean
  /** Monotonic capture order, for stable display + "review next". */
  seq: number
  /** Line counts parsed from the diff, for the +N/-M summary. */
  additions: number
  deletions: number
}

// Per-session queue keyed by session id → (path → edit). Keyed by path so a
// later edit to the same file supersedes the earlier pending entry (the diff
// the gateway sends is cumulative-from-snapshot per tool call, but path-keying
// keeps the queue to one row per file — matching how a reviewer thinks).
type SessionEdits = Record<string, PendingEdit>

export const $pendingEditsBySession = atom<Record<string, SessionEdits>>({})

let seqCounter = 0

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0

  for (const line of diff.split('\n')) {
    // Ignore the +++/--- file header lines.
    if (line.startsWith('+') && !line.startsWith('+++')) {additions += 1}
    else if (line.startsWith('-') && !line.startsWith('---')) {deletions += 1}
  }

  return { additions, deletions }
}

/** Record a completed agent edit into the review queue for `sessionId`. */
export function recordPendingEdit(
  sessionId: string,
  edit: { toolId: string; tool: 'patch' | 'write_file'; path: string; diff: string; isNew: boolean }
): void {
  if (!sessionId || !edit.path || !edit.diff.trim()) {
    return
  }

  const { additions, deletions } = countDiffLines(edit.diff)
  const all = $pendingEditsBySession.get()
  const session = all[sessionId] ?? {}
  const prior = session[edit.path]

  const next: PendingEdit = {
    toolId: edit.toolId || edit.path,
    path: edit.path,
    tool: edit.tool,
    diff: edit.diff,
    // Keep the earliest "new" classification — a file created then edited again
    // is still a new file from review's perspective.
    isNew: prior ? prior.isNew : edit.isNew,
    seq: prior ? prior.seq : (seqCounter += 1),
    additions,
    deletions
  }

  $pendingEditsBySession.set({ ...all, [sessionId]: { ...session, [edit.path]: next } })
}

/** Remove one edit from a session's queue (after accept / reject). */
export function clearPendingEdit(sessionId: string, path: string): void {
  const all = $pendingEditsBySession.get()
  const session = all[sessionId]

  if (!session || !session[path]) {
    return
  }

  const next = { ...session }
  delete next[path]

  if (Object.keys(next).length === 0) {
    const copy = { ...all }
    delete copy[sessionId]
    $pendingEditsBySession.set(copy)
  } else {
    $pendingEditsBySession.set({ ...all, [sessionId]: next })
  }
}

/** Clear every pending edit for a session (accept-all, or session reset). */
export function clearAllPendingEdits(sessionId: string): void {
  const all = $pendingEditsBySession.get()

  if (!all[sessionId]) {
    return
  }

  const copy = { ...all }
  delete copy[sessionId]
  $pendingEditsBySession.set(copy)
}

/** Pending edits for the active session, ordered by capture sequence. */
export const $activePendingEdits = computed(
  [$pendingEditsBySession, $activeSessionId],
  (bySession, sessionId) => {
    const session = sessionId ? bySession[sessionId] : undefined

    if (!session) {
      return [] as PendingEdit[]
    }

    return Object.values(session).sort((a, b) => a.seq - b.seq)
  }
)

/** Count of pending edits for the active session (for the badge). */
export const $activePendingEditCount = computed($activePendingEdits, edits => edits.length)

// ─── Accept / reject ─────────────────────────────────────────────────────────

function gitApi() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.git : undefined
}

function cwd(): string {
  return $currentCwd.get() ?? ''
}

/** Accept an edit: keep the on-disk change, just drop it from the queue. */
export function acceptEdit(sessionId: string, path: string): void {
  clearPendingEdit(sessionId, path)
}

/** Accept every pending edit for the session. */
export function acceptAllEdits(sessionId: string): void {
  clearAllPendingEdits(sessionId)
}

/**
 * Reject an edit: surgically undo just the agent's change on disk (delete a new
 * file, or reverse-apply its diff), then drop it from the queue. Returns false
 * (and leaves the edit queued) if the revert failed — e.g. the file moved on
 * since, so the diff no longer applies cleanly.
 */
export async function rejectEdit(sessionId: string, edit: PendingEdit): Promise<boolean> {
  const api = gitApi()
  const dir = cwd()

  if (!api?.revertEdit || !dir) {
    return false
  }

  try {
    const res = await api.revertEdit(dir, { path: edit.path, diff: edit.diff, isNew: edit.isNew })

    if (res.ok) {
      clearPendingEdit(sessionId, edit.path)

      return true
    }

    return false
  } catch {
    return false
  }
}

/** Reject every pending edit for the session (best-effort; reverts each). */
export async function rejectAllEdits(sessionId: string, edits: readonly PendingEdit[]): Promise<number> {
  let failed = 0

  // Reverse order: undo the most recent first, so earlier diffs still apply.
  for (const edit of [...edits].reverse()) {
    const ok = await rejectEdit(sessionId, edit)

    if (!ok) {failed += 1}
  }

  return failed
}
