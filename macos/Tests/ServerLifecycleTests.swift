@main
enum ServerLifecycleTests {
    static func main() {
        var readiness = ServerReadiness()
        precondition(!readiness.consume("GestureDeck listening on 0.0.0"))
        precondition(readiness.consume(".0:5173\n"))
        precondition(readiness.isReady)
        precondition(!readiness.consume("A later server message\n"))

        var incompleteReadiness = ServerReadiness()
        precondition(!incompleteReadiness.consume("not ready\n"))
        precondition(serverTerminationMessage(for: .starting)?.contains("port 5173") == true)
        precondition(serverTerminationMessage(for: .ready)?.contains("stopped unexpectedly") == true)
        precondition(serverTerminationMessage(for: .failed("startup error")) == nil)
    }
}
