import Foundation
import Network
import os

struct Speaker: Identifiable, Hashable, Sendable {
    let id: String        // Bonjour instance name (stable across DHCP changes)
    var name: String      // room name, e.g. "Salon"
    var host: String      // speaker IPv4, e.g. "192.168.1.139"
    var localIP: String   // this Mac's IPv4 on the interface that reaches the speaker
}

nonisolated enum Sonos {
    enum Service: String, Sendable { case AVTransport, RenderingControl }
    struct Failure: LocalizedError { var errorDescription: String? }

    // Short timeout: the caller polls once a second and must not hang when the speaker vanishes.
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 3
        return URLSession(configuration: c)
    }()

    // MARK: SOAP

    static func soap(_ host: String, _ service: Service, _ action: String,
                     _ args: KeyValuePairs<String, String>) async throws -> String {
        guard let url = URL(string: "http://\(host):1400/MediaRenderer/\(service.rawValue)/Control") else {
            throw Failure(errorDescription: "Bad speaker address \(host)")
        }
        let ns = "urn:schemas-upnp-org:service:\(service.rawValue):1"
        let params = args.map { "<\($0.key)>\(xmlEscape($0.value))</\($0.key)>" }.joined()
        let body = """
        <?xml version="1.0" encoding="utf-8"?>\
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\
        <s:Body><u:\(action) xmlns:u="\(ns)">\(params)</u:\(action)></s:Body></s:Envelope>
        """
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("text/xml; charset=\"utf-8\"", forHTTPHeaderField: "Content-Type")
        req.setValue("\"\(ns)#\(action)\"", forHTTPHeaderField: "SOAPACTION")
        req.httpBody = Data(body.utf8)
        let (data, resp) = try await session.data(for: req)
        let text = String(decoding: data, as: UTF8.self)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let upnp = xmlValue("errorCode", in: text).map { ", UPnP error \($0)" } ?? ""
            throw Failure(errorDescription: "Sonos \(action) failed (HTTP \(code)\(upnp))")
        }
        return text
    }

    // MARK: Discovery

    // ponytail: commands go to the selected player directly; grouped/stereo-paired players need the group coordinator (ZoneGroupTopology) if that ever matters.
    static func speakers() -> AsyncStream<[Speaker]> {
        AsyncStream { out in
            let (snapshots, push) = AsyncStream<[(String, NWEndpoint)]>.makeStream()
            let browser = NWBrowser(for: .bonjour(type: "_sonos._tcp", domain: nil), using: .tcp)
            browser.browseResultsChangedHandler = { results, _ in
                push.yield(results.compactMap {
                    if case let .service(name, _, _, _) = $0.endpoint { (name, $0.endpoint) } else { nil }
                })
            }
            browser.start(queue: DispatchQueue(label: "sonos.browse"))
            let roster = Roster(out: out)
            // One consumer keeps snapshots applied in order.
            let task = Task { for await items in snapshots { await roster.update(items) } }
            out.onTermination = { _ in browser.cancel(); task.cancel(); push.finish() }
        }
    }

    private actor Roster {
        let out: AsyncStream<[Speaker]>.Continuation
        var found: [String: Speaker] = [:]
        var current: Set<String> = []
        var resolving: Set<String> = []
        init(out: AsyncStream<[Speaker]>.Continuation) { self.out = out }

        func update(_ items: [(String, NWEndpoint)]) {
            current = Set(items.map(\.0))
            if found.keys.contains(where: { !current.contains($0) }) {
                found = found.filter { current.contains($0.key) }
                publish()
            }
            for (name, endpoint) in items where found[name] == nil && resolving.insert(name).inserted {
                Task { await add(name, endpoint, Sonos.resolve(name, endpoint)) }
            }
        }

        func add(_ name: String, _ endpoint: NWEndpoint, _ speaker: Speaker?) async {
            guard current.contains(name) else { resolving.remove(name); return }
            guard let speaker else {
                // Speakers boot slowly and Wi-Fi drops: keep trying while Bonjour still lists it.
                try? await Task.sleep(for: .seconds(5))
                return await add(name, endpoint, Sonos.resolve(name, endpoint))
            }
            resolving.remove(name)
            found[name] = speaker
            publish()
        }

        func publish() {
            out.yield(found.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending })
        }
    }

    private static func ip(_ e: NWEndpoint?) -> String? {
        guard case let .hostPort(host, _)? = e else { return nil }
        return host.debugDescription.split(separator: "%").first.map(String.init)  // strip "%en0" scope
    }

    private static func resolve(_ name: String, _ endpoint: NWEndpoint) async -> Speaker? {
        let route: (String, String)? = await withCheckedContinuation { k in
            let params = NWParameters.tcp
            (params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
            let conn = NWConnection(to: endpoint, using: params)
            let q = DispatchQueue(label: "sonos.resolve")
            let done = OSAllocatedUnfairLock(initialState: false)
            let finish: @Sendable ((String, String)?) -> Void = { r in
                guard !done.withLock({ let was = $0; $0 = true; return was }) else { return }
                conn.cancel()
                k.resume(returning: r)
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let h = ip(conn.currentPath?.remoteEndpoint), let l = ip(conn.currentPath?.localEndpoint) { finish((h, l)) } else { finish(nil) }
                case .failed: finish(nil)   // .waiting recovers by itself (e.g. Local Network prompt still open); the timer below bounds it
                default: break
                }
            }
            q.asyncAfter(deadline: .now() + 5) { finish(nil) }
            conn.start(queue: q)
        }
        guard let (host, local) = route else { return nil }
        var room = name
        if let url = URL(string: "http://\(host):1400/xml/device_description.xml"),
           let (data, _) = try? await session.data(from: url),
           let n = xmlValue("roomName", in: String(decoding: data, as: UTF8.self)) { room = n }
        return Speaker(id: name, name: room, host: host, localIP: local)
    }

    // MARK: Pure helpers

    // Plain substring search (no XMLParser): Sonos nests an escaped DIDL inside <TrackMetaData>, so callers call this twice.
    static func xmlValue(_ tag: String, in xml: String) -> String? {
        let opens = [xml.range(of: "<\(tag)>"), xml.range(of: "<\(tag) ")].compactMap { $0 }
        guard let open = opens.min(by: { $0.lowerBound < $1.lowerBound }),
              let gt = xml[open.lowerBound...].firstIndex(of: ">"),
              let close = xml.range(of: "</\(tag)>", range: xml.index(after: gt)..<xml.endIndex) else { return nil }
        // &amp; last so "&amp;lt;" unescapes only once.
        return xml[xml.index(after: gt)..<close.lowerBound]
            .replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    static func xmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    static func seconds(_ hms: String) -> Double {
        let p = hms.split(separator: ":", omittingEmptySubsequences: false).map { Double($0) }
        guard p.count == 3, let h = p[0], let m = p[1], let s = p[2] else { return 0 }
        return h * 3600 + m * 60 + s
    }

    static func hms(_ seconds: Double) -> String {
        let t = seconds.isFinite && seconds > 0 ? Int(seconds) : 0
        return String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60)
    }

    static func didl(title: String, creator: String, artURL: String, uri: String, duration: Double) -> String {
        """
        <DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">\
        <item id="0" parentID="0" restricted="true">\
        <dc:title>\(xmlEscape(title))</dc:title><dc:creator>\(xmlEscape(creator))</dc:creator>\
        <upnp:albumArtURI>\(xmlEscape(artURL))</upnp:albumArtURI>\
        <upnp:class>object.item.audioItem.musicTrack</upnp:class>\
        <res protocolInfo="http-get:*:audio/mpeg:*" duration="\(hms(duration))">\(xmlEscape(uri))</res>\
        </item></DIDL-Lite>
        """
    }

    static func videoID(_ input: String) -> String? {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let c = URLComponents(string: s.contains("://") ? s : "https://" + s),
              let host = c.host?.lowercased() else { return nil }
        let path = c.path.split(separator: "/").map(String.init)
        let id: String?
        if host == "youtu.be" {
            id = path.first
        } else if host == "youtube.com" || host.hasSuffix(".youtube.com") {
            if path.first == "watch" { id = c.queryItems?.first { $0.name == "v" }?.value }
            else if path.count >= 2, ["shorts", "embed", "live"].contains(path[0]) { id = path[1] }
            else { id = nil }
        } else { id = nil }
        guard let id, id.count == 11,
              id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { return nil }
        return id
    }
}
