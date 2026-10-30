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

// Groups windows into one row per owning process. Windows that share a pid
// (e.g. Chromium and its web apps) collapse into one row, because killing
// that pid closes all of them and the row should say so.
//
// clients: parsed `hyprctl clients -j`; sample: parseSample() result;
// cpu: cpuByPid() result; nameFor(cls) -> { name, icon } optional resolver.
function buildApps(clients, sample, cpu, nameFor) {
  var procs = sample ? sample.procs : {}
  var kids = childrenIndex(procs)
  var byPid = {}
  var order = []
  var list = Array.isArray(clients) ? clients : []

  for (var i = 0; i < list.length; i++) {
    var c = list[i]
    var pid = Number(c.pid)
    if (!(pid > 1) || c.mapped === false) continue
    var proc = procs[pid]
    if (proc && PROTECTED_COMMS[proc.comm]) continue
    if (!byPid[pid]) {
      byPid[pid] = { pid: pid, windows: [] }
      order.push(pid)
    }
    byPid[pid].windows.push({
      address: String(c.address || ""),
      cls: String(c.class || c.initialClass || ""),
      title: String(c.title || ""),
      focusHistoryID: Number(c.focusHistoryID)
    })
  }

  var apps = []
  for (var j = 0; j < order.length; j++) {
    var app = byPid[order[j]]
    // Name the row after its most recently focused window so a shared
    // Chromium process reads as whichever window the user last touched.
    app.windows.sort(function(a, b) { return a.focusHistoryID - b.focusHistoryID })
    var primary = app.windows[0]
    var resolved = nameFor ? nameFor(primary.cls) : null
    var name = (resolved && resolved.name) || fallbackName(primary.cls, primary.title)
    // A shared process can hold unrelated-looking windows (the X web app and
    // the Chromium browser), so spell out every app a force quit would take.
    var names = [name]
    for (var w = 1; w < app.windows.length; w++) {
      var other = nameFor ? nameFor(app.windows[w].cls) : null
      var otherName = (other && other.name) || fallbackName(app.windows[w].cls, app.windows[w].title)
      if (names.indexOf(otherName) < 0) names.push(otherName)
    }
    var tree = descendants(app.pid, procs, kids, byPid)
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
      pid: app.pid,
      name: name,
      icon: (resolved && resolved.icon) || "",
      cls: primary.cls,
      subtitle: app.windows.length === 1 ? primary.title
        : names.length > 1 ? app.windows.length + " windows · " + names.join(", ")
        : app.windows.length + " windows",
      sharedWith: names.slice(1),
      windowCount: app.windows.length,
      addresses: app.windows.map(function(w) { return w.address }),
      cpu: cpuTotal,
      rssKb: rss,
      // T/t = stopped or traced: frozen and won't respond to a polite quit.
      stopped: state === "T" || state === "t",
      // 0 = the window focused right now; lower means used more recently.
      focusRank: primary.focusHistoryID,
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
function indexForPid(apps, pid, fallbackIndex) {
  for (var i = 0; i < apps.length; i++) {
    if (apps[i].pid === pid) return i
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
    indexForPid: indexForPid
  }
}
