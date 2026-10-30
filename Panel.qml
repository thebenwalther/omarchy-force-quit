import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// macOS-style Force Quit: one row per open app (windows grouped by class
// and owning process), with live CPU / memory so a spinning or frozen app stands out.
// Quit asks the app's windows to close; Force Quit SIGKILLs its process tree
// after a confirmation.
Panel {
  id: root
  moduleName: "thebenwalther.force-quit"
  ipcTarget: "thebenwalther.force-quit"

  // CLK_TCK, PAGESIZE, uptime, then every /proc/<pid>/stat line.
  readonly property string sampleCommand: "getconf CLK_TCK; getconf PAGESIZE; cat /proc/uptime; cat /proc/[0-9]*/stat 2>/dev/null"
  // Above this an app is likely spinning; its CPU figure turns urgent.
  readonly property real busyCpu: 80

  property var apps: []
  property int selectedIndex: 0
  property string selectedKey: ""
  property var clients: null
  property var sample: null
  property var prevSample: null
  property var webEntries: []
  property bool confirmOpen: false
  property var confirmApp: null

  readonly property var selectedApp: apps.length > 0 && selectedIndex < apps.length ? apps[selectedIndex] : null
  readonly property color fg: bar ? bar.foreground : Commons.Color.foreground
  readonly property color hoverFill: Style.hoverFillFor(fg, Commons.Color.accent)
  readonly property color selectedFill: Style.selectedFillFor(fg, Commons.Color.accent)
  readonly property color dim: Qt.darker(fg, 1.5)

  function refresh() {
    if (!clientsProc.running) clientsProc.running = true
    if (!sampleProc.running) sampleProc.running = true
  }

  // Desktop entries as plain objects for Model.matchEntry, rebuilt per open
  // so newly installed web apps resolve without restarting the shell.
  function loadEntries() {
    var values = DesktopEntries.applications.values || []
    var out = []
    for (var i = 0; i < values.length; i++) {
      var e = values[i]
      out.push({ name: e.name, icon: e.icon, exec: e.execString })
    }
    webEntries = out
  }

  function resolveName(cls) {
    var entry = Model.matchEntry(cls, root.webEntries)
    if (!entry) {
      var found = DesktopEntries.heuristicLookup(cls)
      if (found) entry = { name: found.name, icon: found.icon }
    }
    return entry
  }

  function iconSource(app) {
    var value = String((app && app.icon) || "")
    if (value.charAt(0) === "/") return Util.fileUrl(value)
    var themed = value.length > 0 ? Quickshell.iconPath(value, true) : ""
    if (themed.length === 0 && app) themed = Quickshell.iconPath(String(app.cls).toLowerCase(), true)
    return themed.length > 0 ? themed : Quickshell.iconPath("application-x-executable", true)
  }

  function rebuild() {
    if (clients === null || sample === null) return
    var next = Model.buildApps(clients, sample, Model.cpuByPid(prevSample, sample), root.resolveName)
    selectedIndex = selectedKey === "" ? Model.frontmostIndex(next) : Model.indexForKey(next, selectedKey, selectedIndex)
    apps = next
    selectedKey = apps.length > 0 ? apps[selectedIndex].key : ""
    // The app being confirmed vanished (crashed, or quit on its own).
    if (confirmOpen && !apps.some(function(a) { return a.key === root.confirmApp.key })) cancelForceQuit()
  }

  function select(index) {
    if (apps.length === 0) return
    selectedIndex = Math.max(0, Math.min(apps.length - 1, index))
    selectedKey = apps[selectedIndex].key
  }

  function quitSelected() {
    var app = selectedApp
    if (!app) return
    for (var i = 0; i < app.addresses.length; i++) {
      Quickshell.execDetached(["hyprctl", "dispatch", "hl.dsp.window.close({ window = \"address:" + app.addresses[i] + "\" })"])
    }
    afterAction.restart()
  }

  function askForceQuit() {
    if (!selectedApp) return
    confirmApp = selectedApp
    confirmDialog.selectedIndex = 1
    confirmOpen = true
  }

  function cancelForceQuit() {
    confirmOpen = false
    confirmApp = null
  }

  function confirmForceQuit() {
    var app = confirmApp
    cancelForceQuit()
    if (!app || app.treePids.length === 0) return
    Quickshell.execDetached(["kill", "-KILL"].concat(app.treePids.map(String)))
    afterAction.restart()
  }

  onOpenedChanged: {
    if (opened) {
      // Start on the frontmost app, never a selection left from last time.
      selectedKey = ""
      prevSample = null
      sample = null
      clients = null
      loadEntries()
      refresh()
    } else {
      cancelForceQuit()
    }
  }

  Process {
    id: clientsProc
    command: ["hyprctl", "clients", "-j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.clients = JSON.parse(text) } catch (e) { root.clients = [] }
        root.rebuild()
      }
    }
  }

  Process {
    id: sampleProc
    command: ["sh", "-c", root.sampleCommand]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.prevSample = root.sample
        root.sample = Model.parseSample(text)
        root.rebuild()
      }
    }
  }

  // The first tick comes quickly so CPU figures appear within a second of
  // opening; after that, every two seconds while the panel stays open.
  Timer {
    interval: root.prevSample === null ? 700 : 2000
    running: root.opened
    repeat: true
    onTriggered: root.refresh()
  }

  // Windows take a moment to go away after a close or kill.
  Timer { id: afterAction; interval: 400; onTriggered: root.refresh() }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰅜"
    tooltipText: "Force Quit"
    onPressed: function(b) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(Math.max(column.implicitHeight, root.confirmOpen ? Style.space(190) : 0))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (root.confirmOpen) { if (dx !== 0) confirmDialog.selectedIndex = confirmDialog.selectedIndex === 0 ? 1 : 0; return }
        if (dy !== 0) root.select(root.selectedIndex + dy)
      }
      onActivateRequested: {
        if (!root.confirmOpen) root.askForceQuit()
        else if (confirmDialog.selectedIndex === 1) root.confirmForceQuit()
        else root.cancelForceQuit()
      }
      onDeleteRequested: if (!root.confirmOpen) root.askForceQuit()
      onCloseRequested: root.confirmOpen ? root.cancelForceQuit() : root.close()
      onTabRequested: function(direction) {
        if (root.confirmOpen) confirmDialog.selectedIndex = confirmDialog.selectedIndex === 0 ? 1 : 0
        else root.switchPanel(direction)
      }
      onTextKey: function(t) { if (!root.confirmOpen && (t === "q" || t === "Q")) root.quitSelected() }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: "󰅜"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              textFormat: Text.PlainText
              text: "Force Quit"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              text: root.clients === null ? "LOADING…" : (root.apps.length === 1 ? "1 APP OPEN" : root.apps.length + " APPS OPEN")
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
            }
          }
        }

        PanelSeparator { foreground: root.bar.foreground }

        ListView {
          id: appList
          width: parent.width
          height: Math.min(contentHeight, Style.space(420))
          spacing: Style.space(4)
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          model: root.apps
          currentIndex: root.selectedIndex
          onCurrentIndexChanged: if (currentIndex >= 0) Qt.callLater(keepCurrentVisible)
          function keepCurrentVisible() {
            if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)
          }

          delegate: AppRow {
            required property var modelData
            required property int index
            width: ListView.view.width
            app: modelData
            rowIndex: index
          }
        }

        Text {
          textFormat: Text.PlainText
          visible: root.clients !== null && root.apps.length === 0
          text: "No apps are open."
          color: root.dim
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        PanelSeparator { foreground: root.bar.foreground }

        Item {
          width: parent.width
          implicitHeight: Math.max(hint.implicitHeight, actions.implicitHeight)

          Text {
            id: hint
            textFormat: Text.PlainText
            text: "q quit · ↵ force quit"
            color: root.dim
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Row {
            id: actions
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            Button {
              text: "Quit"
              enabled: !!root.selectedApp
              opacity: enabled ? 1 : 0.4
              fontSize: Style.font.bodySmall
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              bordered: true
              onClicked: root.quitSelected()
            }

            Button {
              text: "Force Quit"
              enabled: !!root.selectedApp
              opacity: enabled ? 1 : 0.4
              fontSize: Style.font.bodySmall
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              bordered: true
              onClicked: root.askForceQuit()
            }
          }
        }
      }

      ConfirmDialog {
        id: confirmDialog
        anchors.fill: parent
        z: 10
        opened: root.confirmOpen
        message: Model.confirmMessage(root.confirmApp)
        confirmText: "Force Quit"
        fontFamily: root.bar.fontFamily
        onCanceled: root.cancelForceQuit()
        onConfirmed: root.confirmForceQuit()
      }
    }
  }

  component AppRow: CursorSurface {
    id: row
    required property var app
    required property int rowIndex

    readonly property bool busy: app.cpu !== null && app.cpu >= root.busyCpu

    hasCursor: root.selectedIndex === rowIndex
    foreground: root.bar.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.select(row.rowIndex)
      onDoubleClicked: { root.select(row.rowIndex); root.askForceQuit() }
    }

    Item {
      id: rowContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      implicitHeight: Math.max(appIcon.height, info.implicitHeight, stats.implicitHeight)

      Image {
        id: appIcon
        width: Style.space(28)
        height: width
        sourceSize.width: width * 2
        sourceSize.height: height * 2
        source: root.iconSource(row.app)
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
      }

      Column {
        id: info
        spacing: Style.space(1)
        anchors.left: appIcon.right
        anchors.leftMargin: Style.space(10)
        anchors.right: stats.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter

        Text {
          textFormat: Text.PlainText
          text: row.app.name
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
          width: parent.width
        }

        Text {
          textFormat: Text.PlainText
          text: row.app.stopped ? "Frozen — not responding" : row.app.subtitle
          visible: text.length > 0
          color: row.app.stopped ? Commons.Color.urgent : root.dim
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          width: parent.width
        }
      }

      Column {
        id: stats
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          text: Model.formatCpu(row.app.cpu) + " CPU"
          color: row.busy ? Commons.Color.urgent : root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: row.busy
          anchors.right: parent.right
        }

        Text {
          textFormat: Text.PlainText
          text: Model.formatMemory(row.app.rssKb)
          color: root.dim
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          anchors.right: parent.right
        }
      }
    }
  }
}
