import Foundation
import Network

nonisolated final class FileServer: Sendable {
    private let listener: NWListener

    init(directory: URL, port: UInt16, onError: @escaping @Sendable (String) -> Void) throws {
        guard let p = NWEndpoint.Port(rawValue: port) else { throw Sonos.Failure(errorDescription: "Bad port \(port)") }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: p)
        let q = DispatchQueue(label: "fileserver")
        listener.stateUpdateHandler = { state in
            if case let .failed(e) = state { onError("File server failed on port \(port): \(e.localizedDescription)") }
        }
        listener.newConnectionHandler = { c in
            c.start(queue: q)
            Self.receive(c, Data(), directory)
        }
        listener.start(queue: q)
    }

    deinit { listener.cancel() }

    // nil only for an unsatisfiable/malformed Range header (-> 416). Single range only.
    static func byteRange(_ header: String?, size: Int) -> Range<Int>? {
        guard let header else { return 0..<size }
        guard header.hasPrefix("bytes="), !header.contains(",") else { return nil }
        let p = header.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard p.count == 2 else { return nil }
        if p[0].isEmpty {                                   // suffix: last n bytes
            guard let n = Int(p[1]), n > 0, size > 0 else { return nil }
            return max(0, size - n)..<size
        }
        guard let a = Int(p[0]), a >= 0, a < size else { return nil }
        if p[1].isEmpty { return a..<size }
        guard let b = Int(p[1]), b >= a else { return nil }
        return a..<min(b + 1, size)
    }

    // MARK: connection handling (state is passed through closures; nothing shared)

    private static func receive(_ c: NWConnection, _ acc: Data, _ dir: URL) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, isDone, err in
            let buf = acc + (data ?? Data())
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                respond(c, String(decoding: buf[..<end.lowerBound], as: UTF8.self), dir)
            } else if err != nil || isDone || buf.count > 16 * 1024 {
                c.cancel()
            } else {
                receive(c, buf, dir)
            }
        }
    }

    private static func respond(_ c: NWConnection, _ head: String, _ dir: URL) {
        let lines = head.components(separatedBy: "\r\n")
        let req = lines[0].split(separator: " ")
        guard req.count >= 2, req[0] == "GET" || req[0] == "HEAD" else { return reply(c, "405 Method Not Allowed") }
        // Whitelist /<[A-Za-z0-9_-]+>.mp3 : the only path-traversal defence, so no decoding or joining of anything else.
        let path = req[1]
        guard path.hasPrefix("/"), path.hasSuffix(".mp3") else { return reply(c, "404 Not Found") }
        let name = path.dropFirst().dropLast(4)
        guard !name.isEmpty, name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }),
              let fh = try? FileHandle(forReadingFrom: dir.appendingPathComponent(name + ".mp3")),
              let size = try? fh.seekToEnd() else { return reply(c, "404 Not Found") }
        let size_ = Int(size)
        let range = lines.dropFirst().lazy.compactMap { l -> String? in
            guard let i = l.firstIndex(of: ":"), l[..<i].lowercased() == "range" else { return nil }
            return l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }.first
        guard let r = byteRange(range, size: size_) else {
            try? fh.close()
            return reply(c, "416 Range Not Satisfiable", ["Content-Range: bytes */\(size_)"])
        }
        var h = [
            "Content-Type: audio/mpeg", "Accept-Ranges: bytes", "Content-Length: \(r.count)", "Connection: close",
        ]
        if range != nil { h.append("Content-Range: bytes \(r.lowerBound)-\(r.upperBound - 1)/\(size_)") }
        let status = range != nil ? "206 Partial Content" : "200 OK"
        let headOnly = req[0] == "HEAD" || r.isEmpty
        send(c, Data(("HTTP/1.1 \(status)\r\n" + h.joined(separator: "\r\n") + "\r\n\r\n").utf8), final: headOnly) {
            if headOnly { try? fh.close(); return }
            try? fh.seek(toOffset: UInt64(r.lowerBound))
            stream(c, fh, r.lowerBound, r.upperBound)
        }
    }

    // Next chunk is sent from the previous send's completion: backpressure, never more than one chunk in memory.
    private static func stream(_ c: NWConnection, _ fh: FileHandle, _ pos: Int, _ end: Int) {
        guard let d = try? fh.read(upToCount: min(256 * 1024, end - pos)), !d.isEmpty else {
            try? fh.close(); return c.cancel()
        }
        let next = pos + d.count
        send(c, d, final: next >= end) {
            if next >= end { try? fh.close() } else { stream(c, fh, next, end) }
        }
    }

    // On error the connection is cancelled; `then` runs only on success.
    private static func send(_ c: NWConnection, _ data: Data, final: Bool, then: @escaping @Sendable () -> Void) {
        c.send(content: data, contentContext: .defaultStream, isComplete: false,
               completion: .contentProcessed { err in
            if err != nil { return c.cancel() }
            // Cancelling right after the last send can drop unsent data, and .finalMessage on a later chunk stalls
            // NWConnection; so wait for the peer to close (Connection: close), with a timeout for stuck clients.
            if final {
                c.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, _, _ in c.cancel() }
                DispatchQueue.global().asyncAfter(deadline: .now() + 10) { c.cancel() }
            }
            then()
        })
    }

    private static func reply(_ c: NWConnection, _ status: String, _ extra: [String] = []) {
        let h = (["HTTP/1.1 \(status)", "Content-Length: 0", "Connection: close"] + extra).joined(separator: "\r\n")
        send(c, Data((h + "\r\n\r\n").utf8), final: true) {}
    }
}
