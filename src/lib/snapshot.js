import fs from 'node:fs'
import path from 'node:path'
import {
  getRepoRoot,
  currentBranch,
  capturePatch,
  applyPatch,
  inspectPatch,
  countChangedFiles,
  captureUntracked,
  cleanWorkingDirectory,
  isWorkingDirClean,
  checkoutBranch
} from './git.js'
import {
  captureLinks,
  restoreLinks,
  captureModified,
  copyModifiedFiles,
  restoreModifiedFiles,
  walkFiles
} from './modules.js'
import { makeRepoSlug, getStashDir, readMeta, mostRecentStash, deleteStash } from './storage.js'

function findLockfile(repoRoot) {
  for (const name of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    const p = path.join(repoRoot, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function copyUntrackedFiles(files, repoRoot, destDir) {
  for (const relPath of files) {
    const src = path.join(repoRoot, relPath)
    const dest = path.join(destDir, relPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.copyFileSync(src, dest)
    } catch {}
  }
}

function restoreUntrackedFiles(srcDir, repoRoot) {
  if (!fs.existsSync(srcDir)) return
  const files = walkFiles(srcDir, srcDir)
  for (const relPath of files) {
    const src = path.join(srcDir, relPath)
    const dest = path.join(repoRoot, relPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

export async function capture(stashName) {
  const repoRoot = getRepoRoot()
  const branch = currentBranch(repoRoot)
  const slug = makeRepoSlug(repoRoot)
  const nodeModulesPath = path.join(repoRoot, 'node_modules')
  const lockfilePath = findLockfile(repoRoot)

  const name = stashName || `${branch.replace(/\//g, '-')}-${Date.now()}`
  const dir = getStashDir(slug, name)

  if (fs.existsSync(dir)) {
    throw new Error(`Stash "${name}" already exists`)
  }

  const patch = capturePatch(repoRoot)
  const untracked = captureUntracked(repoRoot)
  const links = captureLinks(nodeModulesPath)
  const modified = lockfilePath ? captureModified(nodeModulesPath, lockfilePath) : []

  const meta = {
    name,
    branch,
    timestamp: Date.now(),
    repoPath: repoRoot,
    repoSlug: slug,
    stats: {
      files: countChangedFiles(patch),
      untracked: untracked.length,
      links: links.length,
      modified: modified.length
    }
  }

  fs.mkdirSync(path.join(dir, 'node_modules', 'modified'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'untracked'), { recursive: true })

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  fs.writeFileSync(path.join(dir, 'git.patch'), patch)
  fs.writeFileSync(path.join(dir, 'node_modules', 'links.json'), JSON.stringify(links, null, 2))

  if (lockfilePath) {
    fs.copyFileSync(lockfilePath, path.join(dir, path.basename(lockfilePath)))
  }

  if (untracked.length > 0) {
    copyUntrackedFiles(untracked, repoRoot, path.join(dir, 'untracked'))
  }

  if (modified.length > 0) {
    copyModifiedFiles(modified, nodeModulesPath, path.join(dir, 'node_modules', 'modified'))
  }

  cleanWorkingDirectory(repoRoot, links, modified)

  return { name, meta, dir, slug }
}

export async function restore(stashName) {
  const repoRoot = getRepoRoot()
  const slug = makeRepoSlug(repoRoot)
  const nodeModulesPath = path.join(repoRoot, 'node_modules')

  let dir, meta

  if (stashName) {
    dir = getStashDir(slug, stashName)
    if (!fs.existsSync(dir)) {
      throw new Error(`Stash "${stashName}" not found`)
    }
    meta = readMeta(dir)
  } else {
    meta = mostRecentStash(slug)
    if (!meta) throw new Error('No stashes found for this repo')
    dir = getStashDir(slug, meta.name)
  }

  if (!isWorkingDirClean(repoRoot)) {
    throw new Error('Working directory is not clean. Run `wrn stash` or `git stash` first.')
  }

  const currentBranchName = currentBranch(repoRoot)
  const switched = meta.branch !== currentBranchName
  if (switched) checkoutBranch(meta.branch, repoRoot)

  const patch = fs.readFileSync(path.join(dir, 'git.patch'), 'utf8')
  if (patch.trim()) applyPatch(patch, repoRoot)

  restoreUntrackedFiles(path.join(dir, 'untracked'), repoRoot)

  const linksPath = path.join(dir, 'node_modules', 'links.json')
  const links = JSON.parse(fs.readFileSync(linksPath, 'utf8'))
  if (links.length > 0) restoreLinks(links, nodeModulesPath)

  restoreModifiedFiles(path.join(dir, 'node_modules', 'modified'), nodeModulesPath)

  deleteStash(dir)

  return { name: meta.name, meta, switched }
}

export function inspect(stashName) {
  const repoRoot = getRepoRoot()
  const slug = makeRepoSlug(repoRoot)

  let dir, meta

  if (stashName) {
    dir = getStashDir(slug, stashName)
    if (!fs.existsSync(dir)) {
      throw new Error(`Stash "${stashName}" not found`)
    }
    meta = readMeta(dir)
  } else {
    meta = mostRecentStash(slug)
    if (!meta) throw new Error('No stashes found for this repo')
    dir = getStashDir(slug, meta.name)
  }

  const stashed = {
    branch: meta.branch,
    changes: [],
    untracked: [],
    modules: [],
    links: []
  }

  const currentBranchName = currentBranch(repoRoot)
  const switched = meta.branch !== currentBranchName

  const patch = fs.readFileSync(path.join(dir, 'git.patch'), 'utf8')
  if (patch.trim()) stashed.changes = inspectPatch(patch)

  const linksPath = path.join(dir, 'node_modules', 'links.json')
  const untrackedPath = path.join(dir, 'untracked')
  const modifiedPath = path.join(dir, 'node_modules', 'modified')

  stashed.links = JSON.parse(fs.readFileSync(linksPath, 'utf8'))
  stashed.untracked = walkFiles(untrackedPath, untrackedPath)
  stashed.modules = walkFiles(modifiedPath, modifiedPath)

  return stashed
}

export async function swap(targetName) {
  const repoRoot = getRepoRoot()
  const slug = makeRepoSlug(repoRoot)

  const targetDir = getStashDir(slug, targetName)
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Stash "${targetName}" not found`)
  }

  const tempName = `__swap_${Date.now()}`
  await capture(tempName)
  await restore(targetName)

  const tempDir = getStashDir(slug, tempName)
  const finalDir = getStashDir(slug, targetName)
  fs.renameSync(tempDir, finalDir)

  const meta = readMeta(finalDir)
  meta.name = targetName
  fs.writeFileSync(path.join(finalDir, 'meta.json'), JSON.stringify(meta, null, 2))

  return { swapped: targetName, saved: targetName }
}
