#!/usr/bin/env node
/**
 * timmy-core entry point.
 *
 * Phase 0 deliverable: print the version and exit. The HTTP/WS server,
 * config loading, and credential store arrive in Phase 1.
 */

const VERSION = '0.1.0'

function main(): void {
  console.log(`Timmy v${VERSION}`)
  process.exit(0)
}

main()
