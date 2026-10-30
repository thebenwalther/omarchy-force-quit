// Pure helpers for the Force Quit panel. No QML here so the logic can be
// exercised with node against live `hyprctl clients -j` and /proc output.

// Processes that own windows but must never be offered for killing.
// hyprland-dialog is Hyprland's own "app not responding" prompt, not an app.
var PROTECTED_COMMS = { "Hyprland": true, "hyprland": true, "hyprland-dialog": true, "quickshell": true, "qs": true }

// Parses the output of SAMPLE_COMMAND: CLK_TCK, PAGESIZE, /proc/uptime, then
// one /proc/<pid>/stat line per process. Returns
// { uptime, procs: { pid: {pid, ppid, state, ticks, rssKb, comm} } }.
function parseSample(text) {
  var lines = String(text || "").split("\n")
  var tck = Number(lines[0]) || 100
  var pageKb = (Number(lines[1]) || 4096) / 1024
  var uptime = parseFloat(lines[2]) || 0
  var procs = {}
  for (var i = 3; i < lines.length; i++) {
    var line = lines[i]
    // comm sits in parens and may itself contain spaces or ")", so split on
    // the last ") " rather than on whitespace.
    var open = line.indexOf(" (")
    var close = line.lastIndexOf(") ")
    if (open < 0 || close < open) continue
    var pid = Number(line.slice(0, open))
    var rest = line.slice(close + 2).split(" ")
    if (!(pid > 0) || rest.length < 22) continue
    procs[pid] = {
      pid: pid,
      ppid: Number(rest[1]),
      state: rest[0],
      ticks: (Number(rest[11]) + Number(rest[12])) / tck,
      rssKb: Number(rest[21]) * pageKb,
      comm: line.slice(open + 2, close)
    }
  }
  return { uptime: uptime, procs: procs }
}

// Current CPU % per pid from two samples, like top. Empty until a previous
// sample exists, so the UI shows "—" instead of a misleading number.
function cpuByPid(prev, sample) {
  var out = {}
  if (!prev || !sample) return out
  var elapsed = sample.uptime - prev.uptime
  if (!(elapsed > 0)) return out
  for (var key in sample.procs) {
    var before = prev.procs[key]
    if (!before) continue
    out[key] = Math.max(0, (sample.procs[key].ticks - before.ticks) / elapsed * 100)
  }
  return out
}

function childrenIndex(procs) {
  var kids = {}
  for (var key in procs) {
    var p = procs[key]
    if (!kids[p.ppid]) kids[p.ppid] = []
    kids[p.ppid].push(p.pid)
  }
  return kids
}

// The pid itself plus every descendant, parents first. Subtrees rooted at a
// pid in `stopAt` are skipped, so a launcher (Steam) and an app it started
// (a game) are counted and killed separately.
function descendants(pid, procs, kids, stopAt) {
  if (!kids) kids = childrenIndex(procs)
  var root = Number(pid)
  var out = []
  var seen = {}
  var queue = [root]
  while (queue.length > 0) {
    var next = queue.shift()
    if (seen[next]) continue
    seen[next] = true
    if (next !== root && stopAt && stopAt[next]) continue
    out.push(next)
    var c = kids[next] || []
    for (var i = 0; i < c.length; i++) queue.push(c[i])
  }
  return out
}

// "chrome-x.com__-Default" -> "x.com", "org.gnome.Nautilus" -> "Nautilus",
// "steam" -> "Steam". Only used when no desktop entry matches.
function prettyClass(cls) {
  var value = String(cls || "").trim()
  if (value.length === 0) return "Unknown"
  var web = value.match(/^(?:chrome|brave|msedge)-(.+?)__/)
  if (web) return web[1]
  var parts = value.split(".")
  value = parts[parts.length - 1]
  return value.charAt(0).toUpperCase() + value.slice(1)
}

// Steam games get classes like "steam_app_3920"; their title is the name.
function fallbackName(cls, title) {
  if (/^steam_app_\d+$/.test(cls) && title) return title
  return prettyClass(cls)
}

// Matches window classes that desktop-entry heuristics miss, against plain
// { name, icon, exec } entries: Steam games by game id, and Chromium web apps
// by the URL they launch or, failing that, by name ("Apple Music" <->
// music.apple.com). Returns the entry or null.
function matchEntry(cls, entries) {
  var list = entries || []
  var game = String(cls || "").match(/^steam_app_(\d+)$/)
  if (game) {
    for (var g = 0; g < list.length; g++) {
      if (String(list[g].exec || "").indexOf("rungameid/" + game[1]) >= 0) return list[g]
    }
    return null
  }
  var web = String(cls || "").match(/^(?:chrome|brave|msedge)-(.+?)__/)
  if (!web) return null
  var host = web[1].toLowerCase()
  for (var i = 0; i < list.length; i++) {
    var exec = String(list[i].exec || "").toLowerCase()
    if (exec.indexOf("://" + host) >= 0 || exec.indexOf("://www." + host) >= 0) return list[i]
  }
  var labels = host.replace(/^www\./, "").split(".").slice(0, -1)
  for (var j = 0; j < list.length; j++) {
    var words = String(list[j].name || "").toLowerCase().split(/\s+/).filter(function(w) { return w.length > 0 })
    if (words.length === 0) continue
    var all = words.every(function(w) { return labels.indexOf(w) >= 0 })
    if (all) return list[j]
  }
  return null
}

// Groups windows into one row per app: windows of the same class in the
// same process. Apps that share a process (Chromium and its web apps) still
// get their own rows, but each row lists the others in `sharedWith`, because
// force quitting one kills that process and closes them all.
//
// clients: parsed `hyprctl clients -j`; sample: parseSample() result;
// cpu: cpuByPid() result; nameFor(cls) -> { name, icon } optional resolver.
function buildApps(clients, sample, cpu, nameFor) {
  var procs = sample ? sample.procs : {}
  var kids = childrenIndex(procs)
  var byKey = {}
  var order = []
  var appPids = {}
  var list = Array.isArray(clients) ? clients : []

  for (var i = 0; i < list.length; i++) {
    var c = list[i]
    var pid = Number(c.pid)
    if (!(pid > 1) || c.mapped === false) continue
    var proc = procs[pid]
    if (proc && PROTECTED_COMMS[proc.comm]) continue
    var cls = String(c.class || c.initialClass || "")
    var key = pid + " " + cls
    if (!byKey[key]) {
      byKey[key] = { key: key, pid: pid, windows: [] }
      order.push(key)
      appPids[pid] = true
    }
    byKey[key].windows.push({
      address: String(c.address || ""),
      cls: cls,
      title: String(c.title || ""),
      focusHistoryID: Number(c.focusHistoryID)
    })
  }

  var groups = []
  var namesByPid = {}
  for (var j = 0; j < order.length; j++) {
    var group = byKey[order[j]]
    // The most recently focused window titles the row and ranks it.
    group.windows.sort(function(a, b) { return a.focusHistoryID - b.focusHistoryID })
    var primary = group.windows[0]
    group.resolved = nameFor ? nameFor(primary.cls) : null
    group.name = (group.resolved && group.resolved.name) || fallbackName(primary.cls, primary.title)
    if (!namesByPid[group.pid]) namesByPid[group.pid] = []
    if (namesByPid[group.pid].indexOf(group.name) < 0) namesByPid[group.pid].push(group.name)
    groups.push(group)
  }

  var apps = []
  for (var g = 0; g < groups.length; g++) {
    var app = groups[g]
    var first = app.windows[0]
    var sharedWith = namesByPid[app.pid].filter(function(n) { return n !== app.name })
    var tree = descendants(app.pid, procs, kids, appPids)
    var cpuTotal = null
    var rss = 0
    for (var k = 0; k < tree.length; k++) {
      var p = procs[tree[k]]
      if (!p) continue
      rss += p.rssKb
      if (cpu && cpu[tree[k]] !== undefined) cpuTotal = (cpuTotal || 0) + cpu[tree[k]]
    }
    var state = procs[app.pid] ? procs[app.pid].state : ""
    apps.push({
      key: app.key,
      pid: app.pid,
      name: app.name,
      icon: (app.resolved && app.resolved.icon) || "",
      cls: first.cls,
      subtitle: app.windows.length === 1 ? first.title : app.windows.length + " windows",
      sharedWith: sharedWith,
      windowCount: app.windows.length,
      addresses: app.windows.map(function(w) { return w.address }),
      // Shared-process rows report the whole process, so they repeat figures.
      cpu: cpuTotal,
      rssKb: rss,
      // T/t = stopped or traced: frozen and won't respond to a polite quit.
      stopped: state === "T" || state === "t",
      // 0 = the window focused right now; lower means used more recently.
      focusRank: first.focusHistoryID,
      treePids: tree
    })
  }

  apps.sort(function(a, b) {
    var an = a.name.toLowerCase()
    var bn = b.name.toLowerCase()
    return an < bn ? -1 : an > bn ? 1 : a.pid - b.pid
  })
  return apps
}

function formatMemory(kb) {
  var mb = Number(kb || 0) / 1024
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB"
  return Math.round(mb) + " MB"
}

function formatCpu(cpu) {
  if (cpu === null || cpu === undefined) return "—"
  var value = Number(cpu)
  return (value >= 10 ? Math.round(value) : value.toFixed(1)) + "%"
}

// The frontmost app, which is the one most likely to have just hung. Used as
// the starting selection each time the panel opens, like macOS.
function frontmostIndex(apps) {
  var best = 0
  for (var i = 1; i < apps.length; i++) {
    if (apps[i].focusRank < apps[best].focusRank) best = i
  }
  return best
}

function confirmMessage(app) {
  if (!app) return ""
  // Name the window too, so two rows of the same app ("Foot") can't be confused.
  var label = app.windowCount === 1 && app.subtitle && app.subtitle !== app.name
    ? app.name + " (“" + app.subtitle + "”)"
    : app.name
  var text = "Force quit " + label + "? Unsaved changes will be lost."
  if (app.sharedWith && app.sharedWith.length > 0) {
    text += " " + app.sharedWith.join(" and ") + (app.sharedWith.length === 1 ? " shares" : " share") + " its process and will close too."
  }
  else if (app.windowCount > 1) text += " This closes all " + app.windowCount + " of its windows."
  return text
}

// Keeps the cursor on the same app across refreshes, falling back to the
// nearest surviving row when it disappears.
function indexForKey(apps, key, fallbackIndex) {
  for (var i = 0; i < apps.length; i++) {
    if (apps[i].key === key) return i
  }
  if (apps.length === 0) return 0
  return Math.max(0, Math.min(fallbackIndex, apps.length - 1))
}

if (typeof module !== "undefined") {
  module.exports = {
    parseSample: parseSample,
    cpuByPid: cpuByPid,
    descendants: descendants,
    prettyClass: prettyClass,
    fallbackName: fallbackName,
    matchEntry: matchEntry,
    frontmostIndex: frontmostIndex,
    buildApps: buildApps,
    formatMemory: formatMemory,
    formatCpu: formatCpu,
    confirmMessage: confirmMessage,
    indexForKey: indexForKey
  }
}
