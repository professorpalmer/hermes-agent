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

// ── "clicking a background task does nothing" regression: every background row
// is expandable, showing its captured output inline (or a placeholder until the
// first output_tail chunk arrives). ────────────────────────────────────────

function bgItem(overrides: Partial<ComposerStatusItem> = {}): ComposerStatusItem {
  return {
    id: 'bg-1',
    type: 'background',
    title: 'cd ~/project && npm run build',
    state: 'running',
    ...overrides
  } as ComposerStatusItem
}

describe('StatusItemRow — background task output', () => {
  it('a running background task with no output yet is still clickable', () => {
    renderRow(bgItem())
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('clicking a running task with no output reveals the waiting placeholder', () => {
    renderRow(bgItem())
    expect(screen.queryByText('Waiting for output…')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Waiting for output…')).toBeTruthy()
  })

  it('clicking a task with captured output shows the output, not a placeholder', () => {
    renderRow(bgItem({ output: 'line 1\nline 2\n' }))
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/line 1/)).toBeTruthy()
    expect(screen.queryByText('Waiting for output…')).toBeNull()
  })

  it('a finished task with no output shows the no-output placeholder when expanded', () => {
    renderRow(bgItem({ state: 'done' }))
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('No output captured.')).toBeTruthy()
  })

  it('toggles the output region closed on a second click', () => {
    renderRow(bgItem({ output: 'hello' }))
    const row = screen.getByRole('button')
    fireEvent.click(row)
    expect(screen.getByText(/hello/)).toBeTruthy()
    fireEvent.click(row)
    expect(screen.queryByText(/hello/)).toBeNull()
  })
})
