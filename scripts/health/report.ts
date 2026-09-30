/**
 * A health check reports only what a person still has to fix.
 * Add a check by appending it to `checks` in ./checks.ts.
 */

/** One place that needs a fix. `url` is the page to open; otherwise `id` is the line to print. */
export type HealthFinding = {
  id: string
  url?: string
}

/** Findings that share one instruction. The instruction is printed once, then the links. */
export type HealthGroup = {
  summary: string
  findings: HealthFinding[]
}

export type HealthReport = {
  id: string
  title: string
  groups: HealthGroup[]
  /** The check could not run. No per-package list is meaningful until this is resolved. */
  error?: string
}

export type HealthCheck = {
  id: string
  /** One line for `bun run health -- --help`. */
  summary: string
  run: () => Promise<HealthReport>
}

export function findingCount(report: HealthReport): number {
  return report.groups.reduce((count, group) => count + group.findings.length, 0)
}

export function needsAttention(report: HealthReport): boolean {
  return report.error !== undefined || findingCount(report) > 0
}

export function renderHealth(reports: HealthReport[]): string {
  const lines = ["health", ""]
  for (const report of reports) {
    if (report.error) {
      lines.push(`${report.title} — could not check`, report.error, "")
      continue
    }
    const count = findingCount(report)
    if (count === 0) {
      lines.push(`${report.title} — ok`, "")
      continue
    }
    lines.push(`${report.title} — ${count} to fix`, "")
    for (const group of report.groups) {
      if (group.findings.length === 0) continue
      lines.push(group.summary)
      for (const finding of group.findings) lines.push(finding.url ?? finding.id)
      lines.push("")
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`
}
