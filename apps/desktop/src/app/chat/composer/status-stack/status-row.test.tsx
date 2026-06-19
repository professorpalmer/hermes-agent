import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { ComposerStatusItem } from '@/store/composer-status'

import { StatusItemRow } from './status-row'

// Regression guard for the "task pane hangs at the end" report: an in_progress
// todo must show a live spinner ONLY while the session's turn is running. When
// the turn settles (agent finished / stopped / waiting on the user) a todo left
// in_progress must NOT keep spinning forever.

function todoItem(): ComposerStatusItem {
  return {
    id: 'todo:1',
    title: 'in-flight step',
    type: 'todo',
    state: 'running', // todoToItem maps in_progress -> state:'running'
    todoStatus: 'in_progress'
  }
}

function renderRow(item: ComposerStatusItem, sessionWorking: boolean) {
  return render(
    <I18nProvider configClient={null}>
      <StatusItemRow item={item} sessionWorking={sessionWorking} />
    </I18nProvider>
  )
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
