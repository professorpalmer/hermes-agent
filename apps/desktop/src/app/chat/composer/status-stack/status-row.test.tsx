import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ComposerStatusItem } from '@/store/composer-status'

import { StatusItemRow } from './status-row'

afterEach(cleanup)

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
    render(<StatusItemRow item={bgItem()} />)

    // The row is activatable (role=button) even before any output arrives —
    // this is the regression: it used to be a dead no-op click.
    const row = screen.getByRole('button')
    expect(row).toBeTruthy()
  })

  it('clicking a running task with no output reveals the waiting placeholder', () => {
    render(<StatusItemRow item={bgItem()} />)

    expect(screen.queryByText('Waiting for output…')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Waiting for output…')).toBeTruthy()
  })

  it('clicking a task with captured output shows the output, not a placeholder', () => {
    render(<StatusItemRow item={bgItem({ output: 'line 1\nline 2\n' })} />)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/line 1/)).toBeTruthy()
    expect(screen.queryByText('Waiting for output…')).toBeNull()
  })

  it('a finished task with no output shows the no-output placeholder when expanded', () => {
    render(<StatusItemRow item={bgItem({ state: 'done' })} />)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('No output captured.')).toBeTruthy()
  })

  it('toggles the output region closed on a second click', () => {
    render(<StatusItemRow item={bgItem({ output: 'hello' })} />)

    const row = screen.getByRole('button')
    fireEvent.click(row)
    expect(screen.getByText(/hello/)).toBeTruthy()
    fireEvent.click(row)
    expect(screen.queryByText(/hello/)).toBeNull()
  })
})
