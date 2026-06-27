import { useStore } from '@nanostores/react'
import { FileDiffPanel } from '@/components/chat/diff-lines'
import { DiffSkeleton, TreeSkeleton } from '@/components/chat/skeletons'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DiffCount } from '@/components/ui/diff-count'
import { Tip } from '@/components/ui/tooltip'
import { useDelayedTrue } from '@/hooks/use-delayed-true'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $panesFlipped } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import {
  $reviewDiff,
  $reviewDiffLoading,
  $reviewFiles,
  $reviewIsRepo,
  $reviewLoading,
  $reviewRevertTarget,
  $reviewSelectedPath,
  $reviewTreeMode,
  cancelRevert,
  clearReviewSelection,
  closeReview,
  confirmRevert,
  refreshReview,
  requestRevert,
  stageReviewFile,
  toggleReviewTreeMode,
  unstageReviewFile
} from '@/store/review'
import { SidebarPanelLabel } from '../../shell/sidebar-label'
import { PaneEmptyState, RightSidebarSectionHeader } from '../index'
import { ReviewFileTree } from './file-tree'
import { ReviewShipBar } from './ship-bar'
import { useCallback, useState } from 'react'
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


// Compact header/diff action buttons — micro hit targets packed tight, matching
// the rest of the app's icon-action rows.
const ACTION_BTN = 'size-5'

export function ReviewPane() {
  const { t } = useI18n()
  const c = t.statusStack.coding
  const panesFlipped = useStore($panesFlipped)
  const files = useStore($reviewFiles)
  const loading = useStore($reviewLoading)
  const isRepo = useStore($reviewIsRepo)
  const selectedPath = useStore($reviewSelectedPath)
  const diff = useStore($reviewDiff)
  const diffLoading = useStore($reviewDiffLoading)
  const revertTarget = useStore($reviewRevertTarget)
  const treeMode = useStore($reviewTreeMode)

  const selectedFile = files.find(file => file.path === selectedPath)
  const hasFiles = files.length > 0
  // `{ path: null }` → revert all; `{ path: '…' }` → revert one file.
  const revertingAll = revertTarget?.path == null
  // Delay the skeletons so fast loads (most project switches) just blank → content
  // instead of flashing a jarring loading state.
  const showTreeSkeleton = useDelayedTrue(loading && !hasFiles)
  const showDiffSkeleton = useDelayedTrue(diffLoading)

  return (
    <aside
      aria-label={c.review}
      className={cn(
        'before:pointer-events-none relative flex h-full w-full min-w-0 flex-col overflow-hidden border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) pt-(--titlebar-height) text-(--ui-text-tertiary)',
        panesFlipped
          ? 'border-r shadow-[inset_-0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
          : 'border-l shadow-[inset_0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
      )}
    >
      {(loading || isRepo) && (
        <RightSidebarSectionHeader data-suppress-pane-reveal-side="">
          <div className="flex min-w-0 flex-1">
            <SidebarPanelLabel>{c.review}</SidebarPanelLabel>
          </div>
          <Tip label={treeMode === 'tree' ? c.viewAsList : c.viewAsTree}>
            <Button
              aria-label={treeMode === 'tree' ? c.viewAsList : c.viewAsTree}
              className={ACTION_BTN}
              disabled={!hasFiles}
              onClick={toggleReviewTreeMode}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name={treeMode === 'tree' ? 'list-flat' : 'list-tree'} size="0.8125rem" />
            </Button>
          </Tip>
          <Tip label={c.stageAll}>
            <Button
              aria-label={c.stageAll}
              className={ACTION_BTN}
              disabled={!hasFiles}
              onClick={() => void stageReviewFile(null).catch(err => notifyError(err, c.stageAll))}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name="add" size="0.8125rem" />
            </Button>
          </Tip>
          <Tip label={c.revertAll}>
            <Button
              aria-label={c.revertAll}
              className={ACTION_BTN}
              disabled={!hasFiles}
              onClick={() => requestRevert(null)}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name="discard" size="0.8125rem" />
            </Button>
          </Tip>
          <Tip label={t.rightSidebar.refreshTree}>
            <Button
              aria-label={t.rightSidebar.refreshTree}
              className={ACTION_BTN}
              onClick={() => void refreshReview()}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name="refresh" size="0.8125rem" spinning={loading} />
            </Button>
          </Tip>
          <Tip label={c.close}>
            <Button aria-label={c.close} className={ACTION_BTN} onClick={closeReview} size="icon-xs" variant="ghost">
              <Codicon name="close" size="0.8125rem" />
            </Button>
          </Tip>
        </RightSidebarSectionHeader>
      )}

      {loading || isRepo ? (
        hasFiles ? (
          <ReviewFileTree />
        ) : showTreeSkeleton ? (
          <TreeSkeleton />
        ) : loading ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <PaneEmptyState label={t.rightSidebar.noDiffs} />
        )
      ) : (
        // No repo at all → same terse empty state, just without the chrome.
        <PaneEmptyState label={t.rightSidebar.noDiffs} />
      )}

      {/* Selected file's diff — reuses the shiki-highlighted FileDiffPanel. */}
      {selectedFile && (
        <div className="flex max-h-[55%] shrink-0 flex-col border-t border-(--ui-stroke-secondary)">
          <div className="flex items-center gap-1 px-2.5 py-1.5" data-suppress-pane-reveal-side="">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[0.66rem] text-(--ui-text-secondary)"
              title={selectedFile.path}
            >
              {selectedFile.path}
            </span>
            <DiffCount added={selectedFile.added} className="text-[0.64rem] leading-4" removed={selectedFile.removed} />
            <Tip label={selectedFile.staged ? c.unstage : c.stage}>
              <Button
                aria-label={selectedFile.staged ? c.unstage : c.stage}
                className={ACTION_BTN}
                onClick={() =>
                  void (
                    selectedFile.staged ? unstageReviewFile(selectedFile.path) : stageReviewFile(selectedFile.path)
                  ).catch(err => notifyError(err, c.stage))
                }
                size="icon-xs"
                variant="ghost"
              >
                <Codicon name={selectedFile.staged ? 'remove' : 'add'} size="0.8rem" />
              </Button>
            </Tip>
            <Tip label={c.close}>
              <Button
                aria-label={c.close}
                className={ACTION_BTN}
                onClick={clearReviewSelection}
                size="icon-xs"
                variant="ghost"
              >
                <Codicon name="close" size="0.8rem" />
              </Button>
            </Tip>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1 pb-1">
            {diffLoading ? (
              showDiffSkeleton ? (
                <DiffSkeleton />
              ) : null
            ) : diff ? (
              <FileDiffPanel diff={diff} path={selectedFile.path} />
            ) : (
              <div className="py-6 text-center text-[0.66rem] text-muted-foreground/60">{c.noDiff}</div>
            )}
          </div>
        </div>
      )}

      <ReviewShipBar />

      <Dialog onOpenChange={open => !open && cancelRevert()} open={revertTarget !== undefined}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revertingAll ? c.revertAll : c.revert}</DialogTitle>
            <DialogDescription>
              {revertingAll ? c.revertAllConfirm : c.revertConfirm}
              {!revertingAll && revertTarget?.path && (
                <span
                  className="mt-2 block truncate font-mono text-[0.7rem] text-(--ui-text-secondary)"
                  title={revertTarget.path}
                >
                  {revertTarget.path}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={cancelRevert} variant="ghost">
              {t.common.cancel}
            </Button>
            <Button onClick={() => void confirmRevert().catch(err => notifyError(err, c.revert))} variant="destructive">
              {revertingAll ? c.revertAll : c.revert}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

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
