import Foundation

enum ServerState: Equatable {
    case starting
    case ready
    case failed(String)
}

struct ServerReadiness {
    private var buffer = ""
    private(set) var isReady = false

    mutating func consume(_ chunk: String) -> Bool {
        guard !isReady else { return false }
        buffer += chunk
        while let newline = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<newline]).trimmingCharacters(in: .newlines)
            buffer.removeSubrange(...newline)
            if line.hasPrefix("GestureDeck listening on ") {
                isReady = true
                return true
            }
        }
        return false
    }
}

func serverTerminationMessage(for state: ServerState) -> String? {
    switch state {
    case .starting:
        "The local server stopped before it was ready. If port 5173 is already in use, quit the other app using it and reopen GestureDeck."
    case .ready:
        "The local server stopped unexpectedly. Reopen GestureDeck to restore the presentation and phone connection."
    case .failed:
        nil
    }
}
