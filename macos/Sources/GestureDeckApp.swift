import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

@main
struct GestureDeckApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView(appDelegate: appDelegate)
                .frame(minWidth: 900, minHeight: 620)
        }
        .windowResizability(.contentSize)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, ObservableObject {
    @Published private(set) var state = ServerState.starting
    private var process: Process?
    private var outputReader: FileHandle?
    private var lifecycle = ServerLifecycle()
    private var isShuttingDown = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let serverDirectory = Bundle.main.resourceURL!.appendingPathComponent("GestureDeck", isDirectory: true)
        let node = serverDirectory.appendingPathComponent("node")
        let output = Pipe()
        let child = Process()
        child.executableURL = node
        child.arguments = ["server.mjs"]
        child.currentDirectoryURL = serverDirectory
        child.environment = ProcessInfo.processInfo.environment.merging(["HOST": "0.0.0.0", "PORT": "5173"]) { _, new in new }
        child.standardOutput = output
        child.standardError = output
        child.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self,
                      self.lifecycle.processTerminated(shutdownRequested: self.isShuttingDown) != nil else { return }
                self.state = self.lifecycle.state
                self.outputReader?.readabilityHandler = nil
            }
        }
        outputReader = output.fileHandleForReading
        outputReader?.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
                handle.readabilityHandler = nil
                return
            }
            Task { @MainActor [weak self] in self?.receive(text) }
        }

        process = child
        do {
            try child.run()
        } catch {
            fail("GestureDeck could not start its bundled Node server: \(error.localizedDescription)")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        isShuttingDown = true
        outputReader?.readabilityHandler = nil
        if let process, process.isRunning { process.terminate() }
    }

    private func receive(_ text: String) {
        guard !isShuttingDown, lifecycle.consume(text) else { return }
        state = lifecycle.state
    }

    private func fail(_ message: String) {
        guard !isShuttingDown, lifecycle.fail(message) else { return }
        state = lifecycle.state
        outputReader?.readabilityHandler = nil
        if let process, process.isRunning { process.terminate() }
    }
}

private struct ContentView: View {
    @ObservedObject var appDelegate: AppDelegate

    var body: some View {
        Group {
            switch appDelegate.state {
            case .starting:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Starting GestureDeck…")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready:
                WorkspaceWebView()
            case .failed(let message):
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.orange)
                    Text("GestureDeck couldn’t start")
                        .font(.title2)
                    Text(message)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 520)
                }
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

private struct WorkspaceWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.uiDelegate = context.coordinator
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:5173/workspace.html")!))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKUIDelegate {
        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.pdf]
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.canChooseFiles = true
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }
}
