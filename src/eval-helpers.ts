import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

import type { CarvedFeature, FileOperation } from "./carve-features"
import type { AgentStep } from "./runners/runner"

export function selectRandom<T>(items: T[], count: number): T[] {
  const shuffled = [...items].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

export function applyCarveOperations(
  repoDir: string,
  operations: FileOperation[],
): void {
  for (const op of operations) {
    const fullPath = path.join(repoDir, op.path)
    if (op.action === "delete") {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath)
      }
    } else if (op.action === "modify" && op.newContent !== undefined) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, op.newContent)
    }
  }
}

const DOC_PATH_PATTERN = /(?:^|\/)(?:docs\/|AGENTS\.md|CLAUDE\.md)/

export function extractDocsRead(steps: AgentStep[]): string[] {
  const seen = new Set<string>()
  for (const step of steps) {
    if (step.type !== "tool_call") continue

    const toolName = step.toolName

    // Handle read tools (canonical: Read, read_file; Codebuff-native: read_files)
    if (
      toolName === "Read" ||
      toolName === "read_file" ||
      toolName === "read_files"
    ) {
      // Check single-path fields
      const filePath: string | undefined =
        step.input?.file_path || step.input?.path
      if (typeof filePath === "string" && DOC_PATH_PATTERN.test(filePath)) {
        const match = filePath.match(/((?:docs\/\S+|AGENTS\.md|CLAUDE\.md))/)
        if (match) seen.add(match[1])
      }
      // Check array-of-paths (Codebuff read_files emits input.paths)
      const paths: unknown = step.input?.paths
      if (Array.isArray(paths)) {
        for (const p of paths) {
          if (typeof p === "string" && DOC_PATH_PATTERN.test(p)) {
            const match = p.match(/((?:docs\/\S+|AGENTS\.md|CLAUDE\.md))/)
            if (match) seen.add(match[1])
          }
        }
      }
      continue
    }

    // Handle shell tools (canonical: shell; Codebuff-native: run_terminal_command)
    if (toolName === "shell" || toolName === "run_terminal_command") {
      const command: string | undefined = step.input?.command
      if (typeof command === "string" && DOC_PATH_PATTERN.test(command)) {
        const matches = command.match(/((?:docs\/\S+|AGENTS\.md|CLAUDE\.md))/g)
        if (matches) for (const m of matches) seen.add(m)
      }
    }
  }
  return [...seen].sort()
}

export function computeGroundTruthDiff(feature: CarvedFeature): string {
  const diffs: string[] = []
  for (const op of feature.operations) {
    if (op.action === "delete" && feature.originalFiles[op.path]) {
      const lines = feature.originalFiles[op.path].split("\n")
      diffs.push(
        `--- /dev/null\n+++ b/${op.path}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map((l) => `+${l}`).join("\n"),
      )
    } else if (op.action === "modify" && feature.originalFiles[op.path]) {
      const origLines = feature.originalFiles[op.path].split("\n")
      const carvedLines = (op.newContent || "").split("\n")
      diffs.push(
        `--- a/${op.path}\n+++ b/${op.path}\n@@ -1,${carvedLines.length} +1,${origLines.length} @@\n` +
          carvedLines.map((l) => `-${l}`).join("\n") +
          "\n" +
          origLines.map((l) => `+${l}`).join("\n"),
      )
    }
  }
  return diffs.join("\n\n")
}

export function getGroundTruthDiff(feature: CarvedFeature): string {
  // Prefer computeGroundTruthDiff which flips the carve into a rebuild diff
  // (+ lines for code to be added back). feature.diff is the raw carve removal.
  const rebuilt = computeGroundTruthDiff(feature)
  if (rebuilt.trim()) return rebuilt
  return feature.diff
}

export function ensureGitIdentity(repoPath: string): void {
  try {
    execFileSync("git", ["config", "user.name", "Evalbuff"], {
      cwd: repoPath,
      stdio: "ignore",
    })
    execFileSync("git", ["config", "user.email", "evalbuff@example.invalid"], {
      cwd: repoPath,
      stdio: "ignore",
    })
  } catch {
    // best-effort only
  }
}

export function captureGitDiff(
  repoPath: string,
  options: {
    baseRef?: string
    pathspecs?: string[]
  } = {},
): string {
  const { baseRef = "HEAD", pathspecs = [] } = options
  const trackedArgs = ["diff", "--binary", baseRef]
  if (pathspecs.length > 0) trackedArgs.push("--", ...pathspecs)

  let trackedDiff = ""
  try {
    trackedDiff = execFileSync("git", trackedArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch {
    trackedDiff = ""
  }

  const untrackedFiles = listUntrackedFiles(repoPath, pathspecs)
  const untrackedDiffs = untrackedFiles
    .map((filePath) => captureUntrackedFileDiff(repoPath, filePath))
    .filter(Boolean)

  return [trackedDiff.trimEnd(), ...untrackedDiffs.map((d) => d.trimEnd())]
    .filter(Boolean)
    .join("\n")
}

export function copyDocsIntoRepo(
  sourceRepoPath: string,
  targetRepoPath: string,
): void {
  const changedPaths = syncDocsIntoRepo(sourceRepoPath, targetRepoPath)

  if (changedPaths.length > 0) {
    ensureGitIdentity(targetRepoPath)
    try {
      execFileSync("git", ["add", "-A", "--", ...changedPaths], {
        cwd: targetRepoPath,
        stdio: "ignore",
      })
      execFileSync(
        "git",
        ["commit", "-m", "evalbuff: pre-load docs", "--allow-empty"],
        {
          cwd: targetRepoPath,
          stdio: "ignore",
        },
      )
    } catch {
      // fine
    }
  }
}

export function syncDocsIntoRepo(
  sourceRepoPath: string,
  targetRepoPath: string,
): string[] {
  const sourceDocs = getDocsSnapshot(sourceRepoPath)
  const targetDocs = getDocsSnapshot(targetRepoPath)
  const changed = new Set<string>()

  // Detect symlinks among root doc files so we can preserve them.
  // When CLAUDE.md is a symlink to AGENTS.md, writing it as a regular file
  // breaks the relationship — git patches that modify AGENTS.md won't
  // propagate to CLAUDE.md, leaving it stale.
  const docSymlinks = new Map<string, string>()
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const p = path.join(sourceRepoPath, file)
    try {
      if (fs.lstatSync(p).isSymbolicLink()) {
        docSymlinks.set(file, fs.readlinkSync(p))
      }
    } catch {
      // file doesn't exist
    }
  }

  for (const filePath of Object.keys(targetDocs)) {
    if (filePath in sourceDocs) continue
    fs.rmSync(path.join(targetRepoPath, filePath), { force: true })
    removeEmptyDocDirs(targetRepoPath, filePath)
    changed.add(filePath)
  }

  for (const [filePath, content] of Object.entries(sourceDocs)) {
    if (docSymlinks.has(filePath)) continue
    if (targetDocs[filePath] === content) continue
    const absolutePath = path.join(targetRepoPath, filePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content)
    changed.add(filePath)
  }

  // Recreate symlinks so git patches propagate correctly
  for (const [file, linkTarget] of docSymlinks) {
    const absolutePath = path.join(targetRepoPath, file)
    let alreadyCorrect = false
    try {
      alreadyCorrect = fs.lstatSync(absolutePath).isSymbolicLink()
        && fs.readlinkSync(absolutePath) === linkTarget
    } catch {
      // doesn't exist yet
    }
    if (!alreadyCorrect) {
      fs.rmSync(absolutePath, { force: true })
      fs.symlinkSync(linkTarget, absolutePath)
      changed.add(file)
    }
  }

  return [...changed].sort()
}

export function getDocsSnapshot(repoPath: string): Record<string, string> {
  const docs: Record<string, string> = {}
  const docsDir = path.join(repoPath, "docs")

  if (fs.existsSync(docsDir)) {
    function readDir(dir: string, prefix: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          readDir(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        } else if (entry.name.endsWith(".md")) {
          docs[`docs/${prefix}${entry.name}`] = fs.readFileSync(
            path.join(dir, entry.name),
            "utf-8",
          )
        }
      }
    }
    readDir(docsDir, "")
  }

  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const p = path.join(repoPath, file)
    if (fs.existsSync(p)) {
      docs[file] = fs.readFileSync(p, "utf-8")
    }
  }

  return docs
}

export function computeDocsDiffText(
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const lines: string[] = []
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])

  for (const key of [...allKeys].sort()) {
    if (!(key in before)) {
      lines.push(`\n=== NEW FILE: ${key} ===`)
      lines.push(after[key])
    } else if (!(key in after)) {
      lines.push(`\n=== DELETED FILE: ${key} ===`)
      lines.push(`(was ${before[key].split("\n").length} lines)`)
    } else if (before[key] !== after[key]) {
      lines.push(`\n=== MODIFIED FILE: ${key} ===`)
      lines.push(`--- before`)
      lines.push(`+++ after`)
      const oldLines = before[key].split("\n")
      const newLines = after[key].split("\n")
      const maxLen = Math.max(oldLines.length, newLines.length)
      for (let i = 0; i < maxLen; i++) {
        if (i >= oldLines.length) {
          lines.push(`+${newLines[i]}`)
        } else if (i >= newLines.length) {
          lines.push(`-${oldLines[i]}`)
        } else if (oldLines[i] !== newLines[i]) {
          lines.push(`-${oldLines[i]}`)
          lines.push(`+${newLines[i]}`)
        }
      }
    }
  }

  return lines.join("\n")
}

const MAX_FILE_DIFF_CHARS = 150_000
const MAX_TOTAL_DIFF_CHARS = 500_000

/** Truncate individual file diffs and the overall diff to stay within context limits. */
export function truncateDiff(
  diff: string,
  maxFileChars = MAX_FILE_DIFF_CHARS,
  maxTotalChars = MAX_TOTAL_DIFF_CHARS,
): string {
  if (diff.length <= maxFileChars) return diff

  // Split into per-file chunks (each starts with "diff --git" or "diff --no-index")
  const fileChunks: string[] = []
  const fileDiffPattern = /^diff --/gm
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = fileDiffPattern.exec(diff)) !== null) {
    if (match.index > lastIndex) {
      fileChunks.push(diff.slice(lastIndex, match.index))
    }
    lastIndex = match.index
  }
  if (lastIndex < diff.length) {
    fileChunks.push(diff.slice(lastIndex))
  }

  // Truncate each file's diff individually
  const truncatedChunks = fileChunks.map((chunk) => {
    if (chunk.length <= maxFileChars) return chunk
    const cut = chunk.slice(0, maxFileChars)
    const lastNewline = cut.lastIndexOf("\n")
    const cutPoint = lastNewline > maxFileChars * 0.8 ? lastNewline : maxFileChars
    const omitted = chunk.length - cutPoint
    return `${chunk.slice(0, cutPoint)}\n\n... [FILE TRUNCATED — ${omitted.toLocaleString()} characters omitted] ...`
  })

  // Cap overall size
  let result = truncatedChunks.join("")
  if (result.length > maxTotalChars) {
    const cut = result.slice(0, maxTotalChars)
    const lastNewline = cut.lastIndexOf("\n")
    const cutPoint =
      lastNewline > maxTotalChars * 0.8 ? lastNewline : maxTotalChars
    const omitted = result.length - cutPoint
    result = `${result.slice(0, cutPoint)}\n\n... [DIFF TRUNCATED — ${omitted.toLocaleString()} characters omitted] ...`
  }

  return result
}

function listUntrackedFiles(repoPath: string, pathspecs: string[]): string[] {
  const args = ["ls-files", "--others", "--exclude-standard"]
  if (pathspecs.length > 0) args.push("--", ...pathspecs)

  try {
    const output = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim()
    return output ? output.split("\n").filter(Boolean) : []
  } catch {
    return []
  }
}

function captureUntrackedFileDiff(repoPath: string, filePath: string): string {
  try {
    return execFileSync(
      "git",
      ["diff", "--binary", "--no-index", "--", "/dev/null", filePath],
      {
        cwd: repoPath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
    )
  } catch (error) {
    const output =
      error instanceof Error && "stdout" in error
        ? String((error as { stdout?: Buffer | string }).stdout || "")
        : ""
    return output
  }
}

function removeEmptyDocDirs(repoPath: string, filePath: string): void {
  let currentDir = path.dirname(path.join(repoPath, filePath))
  const docsRoot = path.join(repoPath, "docs")

  while (currentDir.startsWith(docsRoot) && currentDir !== docsRoot) {
    try {
      if (fs.readdirSync(currentDir).length > 0) break
      fs.rmdirSync(currentDir)
      currentDir = path.dirname(currentDir)
    } catch {
      break
    }
  }

  try {
    if (
      currentDir === docsRoot &&
      fs.existsSync(docsRoot) &&
      fs.readdirSync(docsRoot).length === 0
    ) {
      fs.rmdirSync(docsRoot)
    }
  } catch {
    // ignore cleanup failures
  }
}
