import AppKit
import Foundation

struct GuiConfig: Decodable {
    let node: String
    let cli: String
    let registry: String
    let agentLabel: String
    let agentPlist: String
    let healthURL: String
    let uiURL: String
    let dashboardHealthURL: String
    let chatgptURL: String
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private static let bundleId = "com.mcp-local-editor.bar"
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let probeLock = NSLock()
    private var probeRunning = false
    private var refreshTimer: Timer?
    private var config: GuiConfig?
    private var ready = false
    private var agentIsLoaded = false
    private var tunnelStatusItem: NSMenuItem?
    private var startItem: NSMenuItem?
    private var stopItem: NSMenuItem?
    private var loginItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Self.otherInstanceExists() {
            openStatusThenTerminate()
            return
        }
        config = loadConfig()
        statusItem.button?.title = "LE"
        statusItem.button?.toolTip = "Local Editor"
        buildMenu()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refreshInBackground()
        }
        refreshInBackground()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openStatus()
        return false
    }

    private static func otherInstanceExists() -> Bool {
        let mine = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .contains { $0.processIdentifier != mine }
    }

    private func configURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/mcp-local-editor/gui.json")
    }

    private func loadConfig() -> GuiConfig? {
        let url = configURL()
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(GuiConfig.self, from: data)
    }

    private func buildMenu() {
        let menu = NSMenu()
        menu.delegate = self
        if config == nil {
            menu.addItem(withTitle: "gui.json이 없습니다. macos/install-gui.sh를 실행하세요", action: nil, keyEquivalent: "")
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
            statusItem.menu = menu
            return
        }

        tunnelStatusItem = menu.addItem(withTitle: "터널: 확인 중", action: nil, keyEquivalent: "")
        startItem = addItem(menu, title: "터널 켜기", action: #selector(startTunnel))
        stopItem = addItem(menu, title: "터널 끄기", action: #selector(stopTunnel))
        _ = addItem(menu, title: "상태 페이지", action: #selector(openStatus))
        menu.addItem(NSMenuItem.separator())
        _ = addItem(menu, title: "상태 페이지에서 폴더 관리", action: #selector(openStatus))
        menu.addItem(NSMenuItem.separator())
        _ = addItem(menu, title: "ChatGPT 커넥터", action: #selector(openChatGPT))
        let login = NSMenuItem(title: "로그인 시 터널 시작", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        menu.addItem(login)
        loginItem = login
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
        applyMenuState()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        applyMenuState()
    }

    private func applyMenuState() {
        statusItem.button?.title = ready ? "LE●" : "LE○"
        tunnelStatusItem?.title = ready ? "터널: 연결됨" : "터널: 꺼짐"
        startItem?.isEnabled = !ready
        stopItem?.isEnabled = agentIsLoaded || ready
        loginItem?.state = agentIsLoaded ? .on : .off
    }

    private func addItem(_ menu: NSMenu, title: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        return item
    }

    private func refreshInBackground() {
        Thread.detachNewThread { [weak self] in
            guard let self else { return }
            self.probeLock.lock()
            if self.probeRunning {
                self.probeLock.unlock()
                return
            }
            self.probeRunning = true
            self.probeLock.unlock()
            self.probeAndApply()
            self.probeLock.lock()
            self.probeRunning = false
            self.probeLock.unlock()
        }
    }

    private func probeAndApply() {
        let nextReady = pingReady()
        let nextLoaded = agentLoaded()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.ready = nextReady
            self.agentIsLoaded = nextLoaded
            self.applyMenuState()
        }
    }

    private func pingReady() -> Bool {
        guard let config else { return false }
        return pingURL(config.healthURL, expect: "ready")
    }

    private func pingURL(_ raw: String, expect: String) -> Bool {
        guard let url = URL(string: raw) else { return false }
        var request = URLRequest(url: url, timeoutInterval: 1.2)
        request.httpMethod = "GET"
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = String(data: data ?? Data(), encoding: .utf8) ?? ""
            ok = code == 200 && body.contains(expect)
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.4)
        return ok
    }

    @objc private func startTunnel() {
        Thread.detachNewThread { [weak self] in
            guard let self, let config = self.config else { return }
            _ = self.run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", config.agentPlist])
            _ = self.run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(config.agentLabel)"])
            Thread.sleep(forTimeInterval: 1.0)
            self.probeAndApply()
        }
    }

    @objc private func stopTunnel() {
        Thread.detachNewThread { [weak self] in
            guard let self, let config = self.config else { return }
            _ = self.run("/bin/launchctl", ["bootout", "gui/\(getuid())/\(config.agentLabel)"])
            Thread.sleep(forTimeInterval: 0.4)
            self.probeAndApply()
        }
    }

    @objc private func toggleLogin() {
        if agentIsLoaded { stopTunnel() } else { startTunnel() }
    }

    @objc private func openStatus() {
        openConfiguredURL(\.uiURL)
        Thread.detachNewThread { [weak self] in
            self?.ensureDashboard()
        }
    }

    private func openStatusThenTerminate() {
        config = loadConfig()
        openConfiguredURL(\.uiURL)
        Thread.detachNewThread { [weak self] in
            self?.ensureDashboard()
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
    }

    private func ensureDashboard() {
        guard let config else { return }
        if pingURL(config.dashboardHealthURL, expect: "ok") { return }
        spawn(config.node, [config.cli, "dashboard", "--registry", config.registry])
        for _ in 0..<20 {
            if pingURL(config.dashboardHealthURL, expect: "ok") { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }

    @objc private func openChatGPT() {
        openConfiguredURL(\.chatgptURL)
    }

    private func openConfiguredURL(_ keyPath: KeyPath<GuiConfig, String>) {
        guard let config, let url = URL(string: config[keyPath: keyPath]) else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open(url, configuration: configuration)
    }

    private func spawn(_ launchPath: String, _ arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    private func agentLoaded() -> Bool {
        guard let config else { return false }
        return run("/bin/launchctl", ["list", config.agentLabel]).status == 0
    }

    private func notify(_ title: String, _ body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(body.prefix(400))
        alert.runModal()
    }

    private func run(_ launchPath: String, _ arguments: [String], timeout: TimeInterval = 2.0) -> (status: Int32, stdout: String, stderr: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        let box = ProcessResult()
        let thread = Thread {
            do {
                try process.run()
                process.waitUntilExit()
                let out = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                box.value = (process.terminationStatus, out, err)
            } catch {
                box.value = (1, "", error.localizedDescription)
            }
            box.sem.signal()
        }
        thread.start()
        if box.sem.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = box.sem.wait(timeout: .now() + 0.4)
            return (1, "", "timeout")
        }
        return box.value
    }
}

private final class ProcessResult: @unchecked Sendable {
    let sem = DispatchSemaphore(value: 0)
    var value: (status: Int32, stdout: String, stderr: String) = (1, "", "")
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
