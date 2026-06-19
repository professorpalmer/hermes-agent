import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { ComposerStatusItem } from '@/store/composer-status'

import { StatusItemRow } from './status-row'

afterEach(cleanup)

function renderRow(item: ComposerStatusItem, sessionWorking = false) {
  return render(
    <I18nProvider configClient={null}>
      <StatusItemRow item={item} sessionWorking={sessionWorking} />
    </I18nProvider>
  )
}

// ── "task pane hangs at the end" regression: an in_progress todo must show a
// live spinner ONLY while the session's turn is running. When the turn settles
// a todo left in_progress must NOT keep spinning forever. ───────────────────

function todoItem(): ComposerStatusItem {
  return {
    id: 'todo:1',
    title: 'in-flight step',
    type: 'todo',
    state: 'running', // todoToItem maps in_progress -> state:'running'
    todoStatus: 'in_progress'
  }
}

// The spinner is the only element with role="status" in this row.
const hasSpinner = (c: HTMLElement) => c.querySelector('[role="status"]') !== null

describe('StatusItemRow in_progress spinner gating', () => {
  it('spins while the session turn is running', () => {
    const { container } = renderRow(todoItem(), true)
    expect(hasSpinner(container)).toBe(true)
  })

  it('settles (no spinner) when the session turn has ended', () => {
    const { container } = renderRow(todoItem(), false)
    expect(hasSpinner(container)).toBe(false)
  })

  it('still renders the item title in the settled state', () => {
    const { container } = renderRow(todoItem(), false)
    expect(container.textContent).toContain('in-flight step')
  })

  it('keeps spinning for a running background item regardless of sessionWorking', () => {
    // Background/subagent rows carry their own lifecycle via `state`; the gate
    // only applies to in_progress TODOs, so a running background task must
    // still spin even when no agent turn is active.
    const bg: ComposerStatusItem = {
      id: 'bg:1',
      title: 'long task',
      type: 'background',
      state: 'running'
    }

    const { container } = renderRow(bg, false)
    expect(hasSpinner(container)).toBe(true)
  })

  it('shows the completed glyph (no spinner) for a completed todo', () => {
    const done: ComposerStatusItem = {
      id: 'todo:2',
      title: 'done step',
      type: 'todo',
      state: 'done',
      todoStatus: 'completed'
    }

    const { container } = renderRow(done, false)
    expect(hasSpinner(container)).toBe(false)
  })
})

// ── Background task output: a *running* job opens the roomy live-output modal
// (onOpenOutput); a *finished* job toggles its captured output inline. ───────

function bgItem(overrides: Partial<ComposerStatusItem> = {}): ComposerStatusItem {
  return {
    id: 'bg-1',
    type: 'background',
    title: 'cd ~/project && npm run build',
    state: 'running',
    ...overrides
  } as ComposerStatusItem
}

function renderRowWithHandlers(
  item: ComposerStatusItem,
  handlers: { onOpenOutput?: (id: string) => void } = {}
) {
  return render(
    <I18nProvider configClient={null}>
      <StatusItemRow item={item} onOpenOutput={handlers.onOpenOutput} sessionWorking={false} />
    </I18nProvider>
  )
}

describe('StatusItemRow — background task output', () => {
  it('a running background task with no output yet is still clickable', () => {
    renderRow(bgItem())
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('clicking a RUNNING task opens the live-output modal (does not expand inline)', () => {
    let openedId: string | null = null
    renderRowWithHandlers(bgItem({ output: 'line 1\n' }), { onOpenOutput: id => (openedId = id) })

    fireEvent.click(screen.getByRole('button'))

    // Routed to the modal, not the cramped inline box.
    expect(openedId).toBe('bg-1')
    expect(screen.queryByText(/line 1/)).toBeNull()
  })

  it('clicking a FINISHED task also opens the modal (one path for every background row)', () => {
    let openedId: string | null = null
    renderRowWithHandlers(bgItem({ state: 'done', output: 'line 1\nline 2\n' }), {
      onOpenOutput: id => (openedId = id)
    })

    fireEvent.click(screen.getByRole('button'))

    expect(openedId).toBe('bg-1')
    // No inline disclosure remains — the modal owns output now.
    expect(screen.queryByText(/line 1/)).toBeNull()
  })

  it('routes the task id through onOpenOutput so the parent opens the right modal', () => {
    const opened: string[] = []
    renderRowWithHandlers(bgItem({ id: 'bg-xyz', state: 'running' }), {
      onOpenOutput: id => opened.push(id)
    })

    fireEvent.click(screen.getByRole('button'))

    expect(opened).toEqual(['bg-xyz'])
  })
})
