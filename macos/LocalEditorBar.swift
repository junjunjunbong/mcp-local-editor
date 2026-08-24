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

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var refreshTimer: Timer?
    private var config: GuiConfig?
    private var ready = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        config = loadConfig()
        statusItem.button?.title = "LE"
        rebuildMenu()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.rebuildMenu()
        }
        RunLoop.main.add(refreshTimer!, forMode: .common)
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

    private func rebuildMenu() {
        ready = pingReady()
        statusItem.button?.title = ready ? "LE●" : "LE○"

        let menu = NSMenu()
        if config == nil {
            menu.addItem(withTitle: "gui.json이 없습니다. macos/install-gui.sh를 실행하세요", action: nil, keyEquivalent: "")
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
            statusItem.menu = menu
            return
        }

        menu.addItem(withTitle: ready ? "터널: 연결됨" : "터널: 꺼짐", action: nil, keyEquivalent: "")
        addItem(menu, title: "터널 켜기", action: #selector(startTunnel), enabled: !ready)
        addItem(menu, title: "터널 끄기", action: #selector(stopTunnel), enabled: agentLoaded() || ready)
        addItem(menu, title: "상태 페이지", action: #selector(openStatus))
        menu.addItem(NSMenuItem.separator())
        addItem(menu, title: "상태 페이지에서 폴더 관리", action: #selector(openStatus))
        menu.addItem(NSMenuItem.separator())
        addItem(menu, title: "ChatGPT 커넥터", action: #selector(openChatGPT))
        let login = NSMenuItem(title: "로그인 시 터널 시작", action: #selector(toggleLogin), keyEquivalent: "")
        login.state = agentLoaded() ? .on : .off
        login.target = self
        menu.addItem(login)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    private func addItem(_ menu: NSMenu, title: String, action: Selector, enabled: Bool = true) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.isEnabled = enabled
        menu.addItem(item)
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
        guard let config else { return }
        _ = run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", config.agentPlist])
        _ = run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(config.agentLabel)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.rebuildMenu() }
    }

    @objc private func stopTunnel() {
        guard let config else { return }
        _ = run("/bin/launchctl", ["bootout", "gui/\(getuid())/\(config.agentLabel)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.rebuildMenu() }
    }

    @objc private func toggleLogin() {
        if agentLoaded() { stopTunnel() } else { startTunnel() }
    }

    @objc private func openStatus() {
        ensureDashboard()
        guard let config, let url = URL(string: config.uiURL) else { return }
        NSWorkspace.shared.open(url)
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
        guard let config, let url = URL(string: config.chatgptURL) else { return }
        NSWorkspace.shared.open(url)
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
        return run("/bin/launchctl", ["print", "gui/\(getuid())/\(config.agentLabel)"]).status == 0
    }

    private func notify(_ title: String, _ body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(body.prefix(400))
        alert.runModal()
    }

    private func run(_ launchPath: String, _ arguments: [String]) -> (status: Int32, stdout: String, stderr: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (1, "", error.localizedDescription)
        }
        let out = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, out, err)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
