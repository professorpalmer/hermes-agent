import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $backgroundStatusBySession, type ComposerStatusItem } from '@/store/composer-status'
import { $activeSessionId } from '@/store/session'

import { ProcessOutputModal } from './process-output-modal'

const SID = 'sess-1'

function seed(items: ComposerStatusItem[]) {
  $activeSessionId.set(SID)
  $backgroundStatusBySession.set({ [SID]: items })
}

function bg(overrides: Partial<ComposerStatusItem> = {}): ComposerStatusItem {
  return {
    id: 'bg-1',
    type: 'background',
    title: 'npm run build',
    state: 'running',
    ...overrides
  } as ComposerStatusItem
}

function renderModal(itemId: string, onClose = () => {}) {
  return render(
    <I18nProvider configClient={null}>
      <ProcessOutputModal itemId={itemId} onClose={onClose} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  $backgroundStatusBySession.set({})
  $activeSessionId.set(null)
})

describe('ProcessOutputModal', () => {
  beforeEach(() => seed([bg({ output: 'building...\nstep 2\n' })]))

  it('renders the task title and its live output', () => {
    renderModal('bg-1')
    expect(screen.getByText('npm run build')).toBeTruthy()
    expect(screen.getByText(/building/)).toBeTruthy()
  })

  it('shows the waiting placeholder when a running task has no output yet', () => {
    seed([bg({ output: undefined })])
    renderModal('bg-1')
    expect(screen.getByText('Waiting for output…')).toBeTruthy()
  })

  it('reflects live store updates (output_tail poll) without remount', () => {
    const { container } = renderModal('bg-1')
    expect(container.textContent).not.toContain('done in 4s')

    // Simulate a process.list poll appending output + finishing the task.
    act(() => {
      $backgroundStatusBySession.set({
        [SID]: [bg({ output: 'building...\nstep 2\ndone in 4s\n', state: 'done', exitCode: 0 })]
      })
    })

    expect(container.textContent).toContain('done in 4s')
  })

  it('renders nothing when the task id is no longer in the registry', () => {
    const { container } = renderModal('does-not-exist')
    expect(container.textContent).toBe('')
  })

  it('calls onClose from the close control', () => {
    let closed = false
    renderModal('bg-1', () => (closed = true))
    // OverlayView renders a labeled close button.
    fireEvent.click(screen.getByLabelText('Close'))
    expect(closed).toBe(true)
  })
})
