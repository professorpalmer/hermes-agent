import { useStore } from '@nanostores/react'
import { useCallback, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  $activePendingEdits,
  acceptAllEdits,
  acceptEdit,
  type PendingEdit,
  rejectAllEdits,
  rejectEdit
} from '@/store/agent-edits'
import { $activeSessionId } from '@/store/session'

import { DiffViewer } from '../source-control/diff-viewer'

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p
}

function dirname(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  parts.pop()

  return parts.join('/')
}

/**
 * Cursor-style agent edit review. Lists every file the agent touched this
 * session as a pending change; click one to see its diff, then Accept (keep) or
 * Reject (surgically undo on disk). Accept-all / Reject-all at the top. Reuses
 * the SCM DiffViewer for rendering and the git engine for reverts.
 */
export function ReviewPanel() {
  const { t } = useI18n()
  const r = t.review
  const edits = useStore($activePendingEdits)
  const sessionId = useStore($activeSessionId) ?? ''
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onAccept = useCallback(
    (edit: PendingEdit) => {
      acceptEdit(sessionId, edit.path)
      setOpenPath(current => (current === edit.path ? null : current))
    },
    [sessionId]
  )

  const onReject = useCallback(
    async (edit: PendingEdit) => {
      setBusy(true)
      const ok = await rejectEdit(sessionId, edit)
      setBusy(false)

      if (ok) {
        setOpenPath(current => (current === edit.path ? null : current))
      }
    },
    [sessionId]
  )

  const onAcceptAll = useCallback(() => {
    acceptAllEdits(sessionId)
    setOpenPath(null)
  }, [sessionId])

  const onRejectAll = useCallback(async () => {
    setBusy(true)
    await rejectAllEdits(sessionId, edits)
    setBusy(false)
    setOpenPath(null)
  }, [sessionId, edits])

  if (edits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <Codicon className="text-muted-foreground/40" name="git-pull-request" size="1.5rem" />
        <div className="text-[0.72rem] font-semibold text-foreground">{r.emptyTitle}</div>
        <div className="text-[0.66rem] leading-relaxed text-muted-foreground/65">{r.emptyBody}</div>
      </div>
    )
  }

  // Diff overlay for one reviewed file, with Accept/Reject in the footer.
  const openEdit = openPath ? edits.find(e => e.path === openPath) : null

  if (openEdit) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffViewer
            filePath={openEdit.path}
            onClose={() => setOpenPath(null)}
            staged={false}
            title={basename(openEdit.path)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5 border-t border-(--ui-stroke-tertiary) p-2">
          <Button
            className="h-7 flex-1 text-[0.72rem]"
            disabled={busy}
            onClick={() => void onReject(openEdit)}
            size="sm"
            variant="ghost"
          >
            <Codicon name="discard" size="0.8rem" />
            {r.reject}
          </Button>
          <Button className="h-7 flex-1 text-[0.72rem]" disabled={busy} onClick={() => onAccept(openEdit)} size="sm">
            <Codicon name="check" size="0.8rem" />
            {r.accept}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Batch actions */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-(--ui-stroke-tertiary) px-2">
        <span className="flex-1 text-[0.7rem] font-medium text-foreground">
          {r.pendingCount(edits.length)}
        </span>
        <Button className="h-6 text-[0.68rem]" disabled={busy} onClick={() => void onRejectAll()} size="sm" variant="ghost">
          {r.rejectAll}
        </Button>
        <Button className="h-6 text-[0.68rem]" disabled={busy} onClick={onAcceptAll} size="sm">
          {r.acceptAll}
        </Button>
      </div>

      {/* File list */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {edits.map(edit => {
          const dir = dirname(edit.path)

          return (
            <div
              className="group/edit flex h-7 items-center gap-1.5 rounded-sm px-1.5 hover:bg-(--ui-control-hover-background)"
              key={edit.path}
            >
              <Codicon
                className={cn('shrink-0', edit.isNew ? 'text-emerald-500' : 'text-yellow-500')}
                name={edit.isNew ? 'diff-added' : 'diff-modified'}
                size="0.8rem"
              />
              <button className="flex min-w-0 flex-1 items-center text-left" onClick={() => setOpenPath(edit.path)} type="button">
                <span className="truncate text-[0.72rem] leading-5 text-foreground">{basename(edit.path)}</span>
                {dir && <span className="ml-1.5 truncate text-[0.62rem] text-muted-foreground/55">{dir}</span>}
              </button>

              <span className="shrink-0 text-[0.6rem] tabular-nums text-muted-foreground/60">
                {edit.additions > 0 && <span className="text-emerald-500">+{edit.additions}</span>}
                {edit.deletions > 0 && <span className="ml-1 text-red-500">-{edit.deletions}</span>}
              </span>

              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/edit:opacity-100">
                <Tip label={r.reject}>
                  <button
                    aria-label={r.reject}
                    className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--ui-bg-secondary) hover:text-destructive disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void onReject(edit)}
                    type="button"
                  >
                    <Codicon name="close" size="0.8rem" />
                  </button>
                </Tip>
                <Tip label={r.accept}>
                  <button
                    aria-label={r.accept}
                    className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--ui-bg-secondary) hover:text-emerald-500 disabled:opacity-40"
                    disabled={busy}
                    onClick={() => onAccept(edit)}
                    type="button"
                  >
                    <Codicon name="check" size="0.8rem" />
                  </button>
                </Tip>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
