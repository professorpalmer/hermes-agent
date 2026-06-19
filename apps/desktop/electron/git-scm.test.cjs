'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  parseStatus,
  statusWord,
  gitStatusForIpc,
  gitDiffForIpc,
  gitStageForIpc,
  gitUnstageForIpc,
  gitCommitForIpc
} = require('./git-scm.cjs')

// ── Pure parser tests (no git needed) ───────────────────────────────────────

test('statusWord maps porcelain codes to friendly words', () => {
  assert.equal(statusWord('M', '.'), 'modified')
  assert.equal(statusWord('A', '.'), 'added')
  assert.equal(statusWord('D', '.'), 'deleted')
  assert.equal(statusWord('R', '.'), 'renamed')
  assert.equal(statusWord('.', 'M'), 'modified')
  assert.equal(statusWord('U', 'U'), 'conflicted')
})

test('parseStatus reads branch header + ahead/behind', () => {
  const z =
    '# branch.head main\u0000' +
    '# branch.upstream origin/main\u0000' +
    '# branch.ab +2 -1\u0000'
  const r = parseStatus(z)
  assert.equal(r.branch, 'main')
  assert.equal(r.upstream, 'origin/main')
  assert.equal(r.ahead, 2)
  assert.equal(r.behind, 1)
})

test('parseStatus splits staged vs unstaged vs untracked', () => {
  const z =
    '# branch.head main\u0000' +
    // staged modification (X=M, Y=.)
    '1 M. N... 100644 100644 100644 aaa bbb staged.txt\u0000' +
    // unstaged modification (X=., Y=M)
    '1 .M N... 100644 100644 100644 ccc ccc work.txt\u0000' +
    // both staged and unstaged (X=M, Y=M)
    '1 MM N... 100644 100644 100644 ddd eee both.txt\u0000' +
    // untracked
    '? newfile.txt\u0000'
  const r = parseStatus(z)

  assert.deepEqual(
    r.staged.map(e => e.path).sort(),
    ['both.txt', 'staged.txt']
  )
  assert.deepEqual(
    r.unstaged.map(e => e.path).sort(),
    ['both.txt', 'work.txt']
  )
  assert.deepEqual(r.untracked.map(e => e.path), ['newfile.txt'])
})

test('parseStatus handles rename records (kind 2 + origPath)', () => {
  const z =
    '# branch.head main\u0000' +
    '2 R. N... 100644 100644 100644 aaa bbb R100 new-name.txt\u0000old-name.txt\u0000'
  const r = parseStatus(z)
  assert.equal(r.staged.length, 1)
  assert.equal(r.staged[0].path, 'new-name.txt')
  assert.equal(r.staged[0].origPath, 'old-name.txt')
  assert.equal(r.staged[0].status, 'renamed')
})

test('parseStatus records conflicts under conflicted', () => {
  const z =
    '# branch.head main\u0000' +
    'u UU N... 100644 100644 100644 100644 hash1 hash2 hash3 both-edited.txt\u0000'
  const r = parseStatus(z)
  assert.equal(r.conflicted.length, 1)
  assert.equal(r.conflicted[0].path, 'both-edited.txt')
})

test('parseStatus keeps filenames with spaces intact', () => {
  const z = '# branch.head main\u0000' + '1 .M N... 100644 100644 100644 ccc ccc my file name.txt\u0000'
  const r = parseStatus(z)
  assert.equal(r.unstaged[0].path, 'my file name.txt')
})

// ── End-to-end against a real temp git repo ─────────────────────────────────

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-git-scm-'))
  const run = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  run(['init', '-q'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['checkout', '-q', '-b', 'main'])
  return { root, run }
}

test('e2e: status → stage → commit → status round-trip', { skip: !gitAvailable() }, async t => {
  const { root, run } = initRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // Seed an initial commit so HEAD exists.
  fs.writeFileSync(path.join(root, 'README.md'), '# repo\n')
  run(['add', 'README.md'])
  run(['commit', '-q', '-m', 'init'])

  // Create one untracked + modify the tracked file.
  fs.writeFileSync(path.join(root, 'new.txt'), 'hello\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# repo\nmore\n')

  let st = await gitStatusForIpc('git', root)
  assert.equal(st.ok, true)
  assert.equal(st.branch, 'main')
  assert.equal(st.untracked.map(e => e.path).includes('new.txt'), true)
  assert.equal(st.unstaged.map(e => e.path).includes('README.md'), true)

  // Stage both, confirm they move to staged.
  const staged = await gitStageForIpc('git', root, ['new.txt', 'README.md'])
  assert.equal(staged.ok, true)
  st = await gitStatusForIpc('git', root)
  assert.equal(st.staged.map(e => e.path).sort().join(','), 'README.md,new.txt')
  assert.equal(st.untracked.length, 0)

  // Unstage new.txt → back to untracked.
  const unstaged = await gitUnstageForIpc('git', root, ['new.txt'])
  assert.equal(unstaged.ok, true)
  st = await gitStatusForIpc('git', root)
  assert.equal(st.untracked.map(e => e.path).includes('new.txt'), true)

  // Commit the staged README change.
  const committed = await gitCommitForIpc('git', root, 'update readme')
  assert.equal(committed.ok, true)
  st = await gitStatusForIpc('git', root)
  assert.equal(st.staged.length, 0)
})

test('e2e: diff returns a unified patch for a worktree change', { skip: !gitAvailable() }, async t => {
  const { root, run } = initRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n')
  run(['add', 'a.txt'])
  run(['commit', '-q', '-m', 'init'])
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\n')

  const res = await gitDiffForIpc('git', root, 'a.txt', false)
  assert.equal(res.ok, true)
  assert.match(res.diff, /\+three/)
  assert.match(res.diff, /-two/)
})

test('e2e: empty commit message is rejected', { skip: !gitAvailable() }, async t => {
  const { root } = initRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const res = await gitCommitForIpc('git', root, '   ')
  assert.equal(res.ok, false)
  assert.equal(res.error, 'empty-message')
})

test('e2e: status on a non-repo returns not-a-repo', { skip: !gitAvailable() }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-notrepo-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const res = await gitStatusForIpc('git', dir)
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not-a-repo')
})
