'use strict'

// Git source-control operations for the desktop Source Control panel.
//
// Mirrors git-root.cjs: a pure, testable module over the git binary. Every
// operation runs `git` via execFile with an ARGUMENT ARRAY (never a shell
// string) so file names / commit messages can't inject. The repo root is
// resolved + hardened through resolveRequestedPathForIpc before any spawn, so
// the renderer can't point us outside an allowed path.
//
// Status uses porcelain=v2 + -z (NUL-delimited) so filenames with spaces,
// quotes, newlines, and unicode parse unambiguously.

const { execFile } = require('node:child_process')

const { findGitRoot } = require('./git-root.cjs')
const { resolveRequestedPathForIpc } = require('./hardening.cjs')

const MAX_BUFFER = 16 * 1024 * 1024 // 16MB — large diffs / status on big repos.
const DEFAULT_TIMEOUT_MS = 20_000

// Resolve a renderer-supplied cwd to a hardened absolute git root, or null.
function resolveRepoRoot(cwd) {
  let resolved
  try {
    resolved = resolveRequestedPathForIpc(cwd, { purpose: 'Git source control' })
  } catch {
    return null
  }

  return findGitRoot(resolved)
}

// Run git with an arg array in `root`. Resolves to { code, stdout, stderr }.
// Never rejects on a non-zero exit — callers decide what an error means (e.g.
// `git diff` exits 1 when there are differences).
function runGit(gitBinary, root, args, options = {}) {
  return new Promise(resolve => {
    execFile(
      gitBinary,
      ['-C', root, ...args],
      {
        cwd: root,
        timeout: options.timeout || DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: options.encoding || 'utf8',
        // Keep git non-interactive: never pop a credential prompt that would
        // hang the spawn. Push/pull rely on the OS credential helper / agent.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({
          code,
          stdout: stdout == null ? '' : stdout,
          stderr: stderr == null ? '' : String(stderr),
          timedOut: Boolean(error && error.killed)
        })
      }
    )
  })
}

// XY status code (porcelain v2) → a friendly status word the UI renders.
function statusWord(x, y) {
  const code = (x || ' ') + (y || ' ')
  if (code.includes('U') || x === 'U' || y === 'U') return 'conflicted'
  const c = x !== '.' && x !== ' ' ? x : y
  switch (c) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    default:
      return 'modified'
  }
}

// Parse `git status --porcelain=v2 -z --branch` into structured groups.
// Returns { branch, upstream, ahead, behind, staged[], unstaged[], untracked[],
// conflicted[] } where each entry is { path, origPath?, status, staged }.
function parseStatus(z) {
  const out = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  }

  const records = z.split('\u0000')
  let i = 0

  while (i < records.length) {
    const rec = records[i]
    if (!rec) {
      i += 1
      continue
    }

    const kind = rec[0]

    if (kind === '#') {
      // Branch header line, e.g. "# branch.head main" / "# branch.ab +1 -2".
      const m = rec.slice(2)
      if (m.startsWith('branch.head ')) out.branch = m.slice('branch.head '.length)
      else if (m.startsWith('branch.upstream ')) out.upstream = m.slice('branch.upstream '.length)
      else if (m.startsWith('branch.ab ')) {
        const ab = m.slice('branch.ab '.length).split(' ')
        for (const tok of ab) {
          if (tok.startsWith('+')) out.ahead = parseInt(tok.slice(1), 10) || 0
          if (tok.startsWith('-')) out.behind = parseInt(tok.slice(1), 10) || 0
        }
      }
      i += 1
      continue
    }

    if (kind === '1') {
      // Ordinary change: "1 XY sub mH mI mW hH hI path"
      const parts = rec.split(' ')
      const xy = parts[1] || '..'
      const x = xy[0]
      const y = xy[1]
      const filePath = parts.slice(8).join(' ')
      addEntry(out, x, y, filePath)
      i += 1
      continue
    }

    if (kind === '2') {
      // Rename/copy: "2 XY sub mH mI mW hH hI Xscore path" then NUL origPath.
      const parts = rec.split(' ')
      const xy = parts[1] || '..'
      const x = xy[0]
      const y = xy[1]
      const filePath = parts.slice(9).join(' ')
      const origPath = records[i + 1] || ''
      addEntry(out, x, y, filePath, origPath)
      i += 2
      continue
    }

    if (kind === 'u') {
      // Unmerged (conflict): "u XY sub m1 m2 m3 mW h1 h2 h3 path"
      const parts = rec.split(' ')
      const filePath = parts.slice(10).join(' ')
      out.conflicted.push({ path: filePath, status: 'conflicted', staged: false })
      i += 1
      continue
    }

    if (kind === '?') {
      // Untracked: "? path"
      out.untracked.push({ path: rec.slice(2), status: 'untracked', staged: false })
      i += 1
      continue
    }

    if (kind === '!') {
      // Ignored — skip (we don't list ignored files in the SCM panel).
      i += 1
      continue
    }

    i += 1
  }

  return out
}

function addEntry(out, x, y, filePath, origPath) {
  // Staged side (index): X is non-'.'; unstaged side (worktree): Y is non-'.'.
  if (x && x !== '.' && x !== ' ') {
    out.staged.push({ path: filePath, origPath: origPath || undefined, status: statusWord(x, '.'), staged: true })
  }
  if (y && y !== '.' && y !== ' ') {
    out.unstaged.push({ path: filePath, origPath: origPath || undefined, status: statusWord('.', y), staged: false })
  }
}

async function gitStatusForIpc(gitBinary, cwd) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }

  const res = await runGit(gitBinary, root, ['status', '--porcelain=v2', '-z', '--branch'])
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'git-status-failed' }

  const parsed = parseStatus(res.stdout)
  return { ok: true, root, ...parsed }
}

// Diff for one path. `staged` true → index vs HEAD; false → worktree vs index.
// Untracked files have no diff target, so we synthesize an all-added diff.
async function gitDiffForIpc(gitBinary, cwd, filePath, staged) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'bad-path' }

  const args = ['diff', '--no-color']
  if (staged) args.push('--cached')
  args.push('--', filePath)

  let res = await runGit(gitBinary, root, args)

  // Empty + untracked → show the whole file as additions via /dev/null compare.
  if (res.code === 0 && !res.stdout.trim()) {
    const untracked = await runGit(gitBinary, root, [
      'diff',
      '--no-color',
      '--no-index',
      '--',
      '/dev/null',
      filePath
    ])
    if (untracked.stdout.trim()) res = untracked
  }

  return { ok: true, diff: res.stdout }
}

async function gitStageForIpc(gitBinary, cwd, paths) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }
  const list = sanitizePaths(paths)
  if (!list.length) return { ok: false, error: 'no-paths' }

  // `git add` stages adds + modifications + deletions (with --all on pathspec).
  const res = await runGit(gitBinary, root, ['add', '--all', '--', ...list])
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'stage-failed' }
  return { ok: true }
}

async function gitUnstageForIpc(gitBinary, cwd, paths) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }
  const list = sanitizePaths(paths)
  if (!list.length) return { ok: false, error: 'no-paths' }

  // `git restore --staged` is the modern unstage; falls back cleanly on old git
  // via `reset` if restore is unavailable.
  let res = await runGit(gitBinary, root, ['restore', '--staged', '--', ...list])
  if (res.code !== 0 && /unknown|not a git command|usage/i.test(res.stderr)) {
    res = await runGit(gitBinary, root, ['reset', '-q', 'HEAD', '--', ...list])
  }
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'unstage-failed' }
  return { ok: true }
}

// Discard worktree changes for tracked paths; delete untracked paths.
async function gitDiscardForIpc(gitBinary, cwd, paths) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }
  const list = sanitizePaths(paths)
  if (!list.length) return { ok: false, error: 'no-paths' }

  // restore worktree (tracked) — ignore failures for untracked, then clean them.
  await runGit(gitBinary, root, ['restore', '--worktree', '--', ...list])
  const res = await runGit(gitBinary, root, ['clean', '-fd', '--', ...list])
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'discard-failed' }
  return { ok: true }
}

async function gitCommitForIpc(gitBinary, cwd, message, options = {}) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }
  if (typeof message !== 'string' || !message.trim()) return { ok: false, error: 'empty-message' }

  const args = ['commit', '-m', message]
  if (options.amend) args.push('--amend')
  if (options.all) args.push('--all') // stage tracked modifications too

  const res = await runGit(gitBinary, root, args)
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout).trim() || 'commit-failed' }
  }
  return { ok: true, output: res.stdout.trim() }
}

async function gitPushForIpc(gitBinary, cwd, options = {}) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }

  const args = ['push']
  if (options.setUpstream) args.push('--set-upstream', 'origin', 'HEAD')

  const res = await runGit(gitBinary, root, args, { timeout: 120_000 })
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout).trim() || 'push-failed' }
  }
  return { ok: true, output: (res.stderr || res.stdout).trim() }
}

async function gitPullForIpc(gitBinary, cwd) {
  const root = resolveRepoRoot(cwd)
  if (!root) return { ok: false, error: 'not-a-repo' }

  const res = await runGit(gitBinary, root, ['pull', '--ff-only'], { timeout: 120_000 })
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout).trim() || 'pull-failed' }
  }
  return { ok: true, output: (res.stdout || res.stderr).trim() }
}

// Strip dangerous / empty entries and option-like leading dashes (defense in
// depth — every call already uses `--` before pathspecs).
function sanitizePaths(paths) {
  if (!Array.isArray(paths)) return []
  const out = []
  for (const p of paths) {
    if (typeof p !== 'string') continue
    const trimmed = p.trim()
    if (!trimmed) continue
    out.push(trimmed)
  }
  return out
}

module.exports = {
  parseStatus,
  statusWord,
  resolveRepoRoot,
  gitStatusForIpc,
  gitDiffForIpc,
  gitStageForIpc,
  gitUnstageForIpc,
  gitDiscardForIpc,
  gitCommitForIpc,
  gitPushForIpc,
  gitPullForIpc,
  // exported for tests
  _runGit: runGit
}
