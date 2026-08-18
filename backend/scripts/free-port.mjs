#!/usr/bin/env node
'use strict'

// Kills whatever process is already listening on the server's port before
// `npm run server` starts a new one — the EADDRINUSE crash otherwise seen
// almost every time a previous `node server.cjs` (this session's own, a
// crashed one, or one left over from testing) is still holding the port.
// Wired in as the `preserver` npm script (package.json), so `npm run server`
// always runs this first automatically — npm runs `pre<name>` before
// `<name>` for any script name, not just its built-in lifecycle events.
//
// Cross-platform: Windows uses netstat + taskkill, everything else uses
// lsof + kill. Safe to run when nothing is listening (no-op, exits 0).

import { execSync } from 'node:child_process'

const PORT = process.env.PORT || 3001
const isWindows = process.platform === 'win32'

function findPids(port) {
  try {
    if (isWindows) {
      // One line per local/foreign address combo; last column is the PID.
      // A port can show multiple rows (IPv4 + IPv6) mapping to the same PID.
      const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' })
      const pids = new Set()
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
        if (m && Number(m[1]) === Number(port)) pids.add(m[2])
      }
      return [...pids]
    }
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' })
    return out.split('\n').map(s => s.trim()).filter(Boolean)
  } catch (e) {
    // Both netstat/lsof exit non-zero when there's simply no match — that's
    // the common case (port already free), not a real failure.
    return []
  }
}

function killPid(pid) {
  try {
    if (isWindows) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' })
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

const pids = findPids(PORT)
if (!pids.length) {
  console.log(`[free-port] Port ${PORT} is already free.`)
  process.exit(0)
}

console.log(`[free-port] Port ${PORT} is held by PID(s) ${pids.join(', ')} — freeing it...`)
let allOk = true
for (const pid of pids) {
  const ok = killPid(pid)
  console.log(`[free-port]   PID ${pid}: ${ok ? 'stopped' : 'could not stop (already gone, or needs elevated permissions)'}`)
  if (!ok) allOk = false
}
// Give the OS a brief moment to actually release the socket before the
// server tries to bind it again.
execSync(isWindows ? 'ping -n 2 127.0.0.1 >NUL' : 'sleep 1')
process.exit(0) // never block `npm run server` — worst case it still fails with the original clear EADDRINUSE message
