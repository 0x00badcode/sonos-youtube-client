import Foundation

nonisolated func selfTest() async {
    // videoID
    let id = "dQw4w9WgXcQ"
    precondition(Sonos.videoID("https://www.youtube.com/watch?feature=share&v=\(id)&t=5") == id)
    precondition(Sonos.videoID("https://youtu.be/\(id)?si=abc") == id)
    precondition(Sonos.videoID("https://youtube.com/shorts/\(id)") == id)
    precondition(Sonos.videoID("https://music.youtube.com/watch?v=\(id)") == id)
    precondition(Sonos.videoID("https://www.youtube.com/embed/\(id)") == id)
    precondition(Sonos.videoID("https://example.com/watch?v=\(id)") == nil)
    precondition(Sonos.videoID("https://www.youtube.com/watch?v=short") == nil)
    precondition(Sonos.videoID("lofi hip hop") == nil)

    // time
    precondition(Sonos.seconds("0:03:25") == 205 && Sonos.hms(205) == "0:03:25")
    precondition(Sonos.seconds(Sonos.hms(3725)) == 3725 && Sonos.hms(3725) == "1:02:05")
    precondition(Sonos.seconds("NOT_IMPLEMENTED") == 0)

    // xml
    precondition(Sonos.xmlEscape(#"&<>"'"#) == "&amp;&lt;&gt;&quot;&apos;")
    precondition(Sonos.xmlValue("res", in: #"<res protocolInfo="x">a&amp;b</res>"#) == "a&b")
    precondition(Sonos.xmlValue("nope", in: "<a>1</a>") == nil)
    let item = Sonos.didl(title: "A & B <x>", creator: "C", artURL: "http://a/b?x=1&y=2", uri: "http://h/i.mp3", duration: 205)
    precondition(Sonos.xmlValue("dc:title", in: item) == "A & B <x>")
    precondition(Sonos.xmlValue("res", in: item) == "http://h/i.mp3")
    let resp = "<s:Envelope><RelTime>0:00:05</RelTime><TrackMetaData>\(Sonos.xmlEscape(item))</TrackMetaData></s:Envelope>"
    let inner = Sonos.xmlValue("TrackMetaData", in: resp)!
    precondition(Sonos.xmlValue("dc:title", in: inner) == "A & B <x>")

    // byteRange
    precondition(FileServer.byteRange(nil, size: 1000) == 0..<1000)
    precondition(FileServer.byteRange("bytes=0-99", size: 1000) == 0..<100)
    precondition(FileServer.byteRange("bytes=100-", size: 1000) == 100..<1000)
    precondition(FileServer.byteRange("bytes=-50", size: 1000) == 950..<1000)
    precondition(FileServer.byteRange("bytes=900-5000", size: 1000) == 900..<1000)
    precondition(FileServer.byteRange("bytes=1000-", size: 1000) == nil)
    precondition(FileServer.byteRange("bytes=5-2", size: 1000) == nil)
    precondition(FileServer.byteRange("garbage", size: 1000) == nil)
    precondition(FileServer.byteRange("bytes=a-b", size: 1000) == nil)

    // FileServer on loopback; ~600 KB spans several 256 KB chunks
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let bytes = Data((0..<600_000).map { UInt8($0 % 251) })
    try! bytes.write(to: dir.appendingPathComponent("abc_-123.mp3"))
    let port = UInt16.random(in: 40000...60000)
    let server = try! FileServer(directory: dir, port: port) { preconditionFailure($0) }
    let cfg = URLSessionConfiguration.ephemeral
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    let http = URLSession(configuration: cfg)
    func fetch(_ path: String, method: String = "GET", range: String? = nil) async -> (Data, HTTPURLResponse)? {
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        r.httpMethod = method
        if let range { r.setValue(range, forHTTPHeaderField: "Range") }
        do { let (d, resp) = try await http.data(for: r); return (d, resp as! HTTPURLResponse) } catch { return nil }
    }
    // listener starts asynchronously: wait until it answers
    for _ in 0..<30 {
        if await fetch("/abc_-123.mp3", method: "HEAD") != nil { break }
        try? await Task.sleep(for: .milliseconds(100))
    }

    let full = await fetch("/abc_-123.mp3")!
    precondition(full.1.statusCode == 200 && full.0 == bytes)
    precondition(full.1.value(forHTTPHeaderField: "Accept-Ranges") == "bytes")
    let part = await fetch("/abc_-123.mp3", range: "bytes=100-299")!
    precondition(part.1.statusCode == 206 && part.0 == bytes[100..<300])
    precondition(part.1.value(forHTTPHeaderField: "Content-Range") == "bytes 100-299/600000")
    let tail = await fetch("/abc_-123.mp3", range: "bytes=-1000")!
    precondition(tail.1.statusCode == 206 && tail.0 == bytes.suffix(1000))
    precondition(tail.1.value(forHTTPHeaderField: "Content-Range") == "bytes 599000-599999/600000")
    let open = await fetch("/abc_-123.mp3", range: "bytes=300000-")!
    precondition(open.1.statusCode == 206 && open.0 == bytes[300_000...])
    let bad = await fetch("/abc_-123.mp3", range: "bytes=600000-")!
    precondition(bad.1.statusCode == 416 && bad.1.value(forHTTPHeaderField: "Content-Range") == "bytes */600000")
    for p in ["/../etc/passwd", "/x.txt", "/nope.mp3", "/a%2Fb.mp3", "/.mp3"] {
        let r = await fetch(p)!
        precondition(r.1.statusCode == 404, "\(p)")
    }
    let head = await fetch("/abc_-123.mp3", method: "HEAD")!
    precondition(head.1.statusCode == 200 && head.0.isEmpty && head.1.expectedContentLength == 600_000)
    let post = await fetch("/abc_-123.mp3", method: "POST")!
    precondition(post.1.statusCode == 405)
    withExtendedLifetime(server) {}

    // Player.parse
    precondition(Player.parse("META\tjNQXAC9IVRw\t19\tjawed\tMe at the zoo")
        == .meta(Track(id: "jNQXAC9IVRw", title: "Me at the zoo", uploader: "jawed", duration: 19)))
    precondition(Player.parse("META\tid\tNA\tup\ta\tb\tc") == .meta(Track(id: "id", title: "a\tb\tc", uploader: "up", duration: 0)))
    precondition(Player.parse("PROG\t 50.0%") == .progress(0.5))
    precondition(Player.parse("PROG\t100.0%") == .progress(1))
    precondition(Player.parse("ERROR: [youtube] x: Video unavailable") == .error("[youtube] x: Video unavailable"))
    precondition(Player.parse("[ExtractAudio] Destination: x.mp3") == nil)
    print("ok")
}
