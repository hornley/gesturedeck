@main
enum ServerLifecycleTests {
    static func main() {
        var lifecycle = ServerLifecycle()
        precondition(!lifecycle.consume("other output\nGestureDeck listening on 0.0.0"))
        precondition(lifecycle.consume(".0:5173\n"))
        precondition(lifecycle.state == .ready)
        precondition(!lifecycle.consume("A later server message\n"))

        var earlyExit = ServerLifecycle()
        let startupError = earlyExit.processTerminated(shutdownRequested: false)
        precondition(startupError?.contains("port 5173") == true)
        precondition(earlyExit.state == .failed(startupError!))
        precondition(earlyExit.processTerminated(shutdownRequested: false) == nil)

        var unexpectedExit = lifecycle
        let runtimeError = unexpectedExit.processTerminated(shutdownRequested: false)
        precondition(runtimeError?.contains("stopped unexpectedly") == true)
        precondition(unexpectedExit.state == .failed(runtimeError!))
        precondition(unexpectedExit.processTerminated(shutdownRequested: false) == nil)

        var shutdown = lifecycle
        precondition(shutdown.processTerminated(shutdownRequested: true) == nil)
        precondition(shutdown.state == .ready)

        var launchFailure = ServerLifecycle()
        precondition(launchFailure.fail("startup error"))
        precondition(launchFailure.processTerminated(shutdownRequested: false) == nil)
    }
}
