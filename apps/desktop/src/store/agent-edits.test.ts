import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $activePendingEditCount,
  $activePendingEdits,
  acceptAllEdits,
  acceptEdit,
  clearAllPendingEdits,
  recordPendingEdit,
  rejectAllEdits,
  rejectEdit
} from './agent-edits'
import { $activeSessionId, $currentCwd } from './session'

const SID = 'sess-1'
const REPO = '/tmp/repo'

const SAMPLE_DIFF = `--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
 keep
-old
+new`

const NEW_FILE_DIFF = `--- /dev/null
+++ b/created.ts
@@ -0,0 +1,1 @@
+brand new`

function installGitApi(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const api = { revertEdit: vi.fn().mockResolvedValue({ ok: true }), ...overrides }

  ;(globalThis as unknown as { window: { hermesDesktop: { git: typeof api } } }).window = {
    hermesDesktop: { git: api }
  } as never

  return api
}

beforeEach(() => {
  $activeSessionId.set(SID)
  $currentCwd.set(REPO)
  clearAllPendingEdits(SID)
})

afterEach(() => {
  vi.restoreAllMocks()
  clearAllPendingEdits(SID)
  delete (globalThis as { window?: unknown }).window
})

describe('recordPendingEdit', () => {
  it('captures an edit with parsed +/- counts', () => {
    recordPendingEdit(SID, { toolId: 't1', tool: 'patch', path: 'foo.ts', diff: SAMPLE_DIFF, isNew: false })

    const edits = $activePendingEdits.get()
    expect(edits).toHaveLength(1)
    expect(edits[0].path).toBe('foo.ts')
    expect(edits[0].additions).toBe(1)
    expect(edits[0].deletions).toBe(1)
    expect($activePendingEditCount.get()).toBe(1)
  })

  it('dedupes by path — a later edit supersedes the earlier row but keeps seq', () => {
    recordPendingEdit(SID, { toolId: 't1', tool: 'patch', path: 'foo.ts', diff: SAMPLE_DIFF, isNew: false })
    const firstSeq = $activePendingEdits.get()[0].seq
    recordPendingEdit(SID, { toolId: 't2', tool: 'patch', path: 'foo.ts', diff: SAMPLE_DIFF, isNew: false })

    const edits = $activePendingEdits.get()
    expect(edits).toHaveLength(1)
    expect(edits[0].seq).toBe(firstSeq)
  })

  it('ignores empty path or diff', () => {
    recordPendingEdit(SID, { toolId: 't', tool: 'patch', path: '', diff: SAMPLE_DIFF, isNew: false })
    recordPendingEdit(SID, { toolId: 't', tool: 'patch', path: 'x.ts', diff: '   ', isNew: false })

    expect($activePendingEdits.get()).toHaveLength(0)
  })

  it('orders edits by capture sequence', () => {
    recordPendingEdit(SID, { toolId: 'a', tool: 'patch', path: 'a.ts', diff: SAMPLE_DIFF, isNew: false })
    recordPendingEdit(SID, { toolId: 'b', tool: 'patch', path: 'b.ts', diff: SAMPLE_DIFF, isNew: false })

    expect($activePendingEdits.get().map(e => e.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('accept', () => {
  it('acceptEdit drops one edit without touching git', () => {
    const api = installGitApi()
    recordPendingEdit(SID, { toolId: 't1', tool: 'patch', path: 'foo.ts', diff: SAMPLE_DIFF, isNew: false })

    acceptEdit(SID, 'foo.ts')

    expect($activePendingEdits.get()).toHaveLength(0)
    expect(api.revertEdit).not.toHaveBeenCalled()
  })

  it('acceptAllEdits clears the whole queue', () => {
    recordPendingEdit(SID, { toolId: 'a', tool: 'patch', path: 'a.ts', diff: SAMPLE_DIFF, isNew: false })
    recordPendingEdit(SID, { toolId: 'b', tool: 'patch', path: 'b.ts', diff: SAMPLE_DIFF, isNew: false })

    acceptAllEdits(SID)

    expect($activePendingEditCount.get()).toBe(0)
  })
})

describe('reject', () => {
  it('rejectEdit calls revertEdit then drops the edit on success', async () => {
    const api = installGitApi()
    recordPendingEdit(SID, { toolId: 't1', tool: 'patch', path: 'foo.ts', diff: SAMPLE_DIFF, isNew: false })
    const edit = $activePendingEdits.get()[0]

    const ok = await rejectEdit(SID, edit)

    expect(ok).toBe(true)
    expect(api.revertEdit).toHaveBeenCalledWith(REPO, { path: 'foo.ts', diff: SAMPLE_DIFF, isNew: false })
    expect($activePendingEdits.get()).toHaveLength(0)
  })

  it('keeps the edit queued when the revert fails', async () => {
    installGitApi({ revertEdit: vi.fn().mockResolvedValue({ ok: false, error: 'patch does not apply' }) })
    recordPendingEdit(SID, { toolId: 't1', tool: 'patch', path: 'foo.ts', diff: SAMPLE_DIFF, isNew: false })
    const edit = $activePendingEdits.get()[0]

    const ok = await rejectEdit(SID, edit)

    expect(ok).toBe(false)
    expect($activePendingEdits.get()).toHaveLength(1)
  })

  it('forwards isNew for created files', async () => {
    const api = installGitApi()
    recordPendingEdit(SID, { toolId: 't1', tool: 'write_file', path: 'created.ts', diff: NEW_FILE_DIFF, isNew: true })
    const edit = $activePendingEdits.get()[0]

    await rejectEdit(SID, edit)

    expect(api.revertEdit).toHaveBeenCalledWith(REPO, { path: 'created.ts', diff: NEW_FILE_DIFF, isNew: true })
  })

  it('rejectAllEdits reverts every edit and returns the failure count', async () => {
    installGitApi()
    recordPendingEdit(SID, { toolId: 'a', tool: 'patch', path: 'a.ts', diff: SAMPLE_DIFF, isNew: false })
    recordPendingEdit(SID, { toolId: 'b', tool: 'patch', path: 'b.ts', diff: SAMPLE_DIFF, isNew: false })

    const failed = await rejectAllEdits(SID, $activePendingEdits.get())

    expect(failed).toBe(0)
    expect($activePendingEditCount.get()).toBe(0)
  })
})
