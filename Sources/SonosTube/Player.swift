import Foundation

nonisolated struct Track: Codable, Identifiable, Hashable {
    let id: String            // YouTube video id
    var title: String
    var uploader: String
    var duration: Double      // seconds
    var thumbnail: URL { URL(string: "https://i.ytimg.com/vi/\(id)/mqdefault.jpg")! }
    var url: String { "https://www.youtube.com/watch?v=\(id)" }
}

// The speaker is the source of truth: we poll it and render what it reports, so relaunching mid-song just works.
@Observable final class Player {
    private(set) var speakers: [Speaker] = []
    var speakerID: String? = UserDefaults.standard.string(forKey: "speaker") {
        didSet { UserDefaults.standard.set(speakerID, forKey: "speaker") }
    }
    var speaker: Speaker? { speakers.first { $0.id == speakerID } ?? speakers.first }
    private(set) var library: [Track] = []
    // Ids only: the link never changes, and play(track) re-downloads if the cached audio is gone.
    private(set) var favorites = Set(UserDefaults.standard.stringArray(forKey: "favorites") ?? []) {
        didSet { UserDefaults.standard.set(Array(favorites), forKey: "favorites") }
    }
    private(set) var current: Track?
    private(set) var externalTitle: String?
    private(set) var isPlaying = false
    private(set) var position = 0.0
    private(set) var duration = 0.0
    private(set) var volume = 0.0
    private(set) var download: Download?
    var error: String?

    struct Download { var title: String; var progress: Double? }
    nonisolated enum Event: Equatable { case meta(Track), progress(Double), error(String) }

    @ObservationIgnored private let dir = URL.cachesDirectory.appending(path: "SonosTube")
    @ObservationIgnored private var port: UInt16 = 17800
    @ObservationIgnored private var server: FileServer?
    @ObservationIgnored private var volumeTask: Task<Void, Never>?
    @ObservationIgnored private var downloadTask: Task<Void, Never>?
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var volumeLock = Date.distantPast
    @ObservationIgnored private var seekLock = Date.distantPast

    init() {
        if let d = UserDefaults.standard.data(forKey: "library"),
           let l = try? JSONDecoder().decode([Track].self, from: d) { library = l }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Fixed port so a URI already handed to the speaker stays valid across relaunches;
        // set the "port" default if 17800 is taken.
        let p = UserDefaults.standard.integer(forKey: "port")
        if p != 0 { port = UInt16(clamping: p) }
        do {
            server = try FileServer(directory: dir, port: port) { [weak self] msg in
                Task { @MainActor in self?.error = msg }
            }
        } catch { self.error = error.localizedDescription }
        Task { for await s in Sonos.speakers() { speakers = s } }
        Task {
            while true {
                await refresh()
                try? await Task.sleep(for: .seconds(1))  // ponytail: 1 Hz polling; UPnP GENA event subscriptions if this ever matters
            }
        }
    }

    // MARK: polling

    private func refresh() async {
        guard let host = speaker?.host else { return }
        async let t = Sonos.soap(host, .AVTransport, "GetTransportInfo", ["InstanceID": "0"])
        async let p = Sonos.soap(host, .AVTransport, "GetPositionInfo", ["InstanceID": "0"])
        async let v = Sonos.soap(host, .RenderingControl, "GetVolume", ["InstanceID": "0", "Channel": "Master"])
        guard let (t, p, v) = try? await (t, p, v) else { return }  // asleep or unreachable
        let state = Sonos.xmlValue("CurrentTransportState", in: t)
        let file = (Sonos.xmlValue("TrackURI", in: p) ?? "").split(separator: "/").last.map(String.init) ?? ""
        let track = file.hasSuffix(".mp3") ? library.first { $0.id == file.dropLast(4) } : nil
        var dur = Sonos.seconds(Sonos.xmlValue("TrackDuration", in: p) ?? "")
        if dur == 0 { dur = track?.duration ?? 0 }
        let title = Sonos.xmlValue("TrackMetaData", in: p).flatMap { Sonos.xmlValue("dc:title", in: $0) }

        let playing = state == "PLAYING" || state == "TRANSITIONING"
        if isPlaying != playing { isPlaying = playing }
        if current != track { current = track }
        let ext = track == nil && title?.isEmpty == false ? title : nil
        if externalTitle != ext { externalTitle = ext }
        if duration != dur { duration = dur }
        let pos = Sonos.seconds(Sonos.xmlValue("RelTime", in: p) ?? "")
        if .now > seekLock, position != pos { position = pos }
        let vol = Double(Sonos.xmlValue("CurrentVolume", in: v) ?? "") ?? volume
        if .now > volumeLock, volume != vol { volume = vol }
    }

    // MARK: commands

    func play(_ input: String) {
        let input = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if input.isEmpty { return }
        if let id = Sonos.videoID(input), let t = library.first(where: { $0.id == id }), exists(t) { return play(t) }
        start(input.hasPrefix("http://") || input.hasPrefix("https://") ? input : "ytsearch1:" + input, title: input)
    }

    func play(_ track: Track) {
        guard exists(track) else { return start(track.url, title: track.title) }
        library.removeAll { $0.id == track.id }
        library.insert(track, at: 0)
        save()
        guard let s = speaker else { error = "No Sonos speaker found."; return }
        let uri = "http://\(s.localIP):\(port)/\(track.id).mp3"
        let meta = Sonos.didl(title: track.title, creator: track.uploader, artURL: track.thumbnail.absoluteString,
                              uri: uri, duration: track.duration)
        attempt {
            // Older firmware can reject metadata it dislikes; the bare URI still plays (the CLI needed this too).
            for m in [meta, ""] {
                do {
                    _ = try await Sonos.soap(s.host, .AVTransport, "SetAVTransportURI",
                                             ["InstanceID": "0", "CurrentURI": uri, "CurrentURIMetaData": m])
                    break
                } catch is Sonos.Failure where !m.isEmpty {}
            }
            _ = try await Sonos.soap(s.host, .AVTransport, "Play", ["InstanceID": "0", "Speed": "1"])
            await self.refresh()
        }
    }

    func togglePlayPause() {
        guard let h = speaker?.host else { return }
        let wasPlaying = isPlaying
        isPlaying.toggle()
        attempt {
            if wasPlaying { _ = try await Sonos.soap(h, .AVTransport, "Pause", ["InstanceID": "0"]) }
            else { _ = try await Sonos.soap(h, .AVTransport, "Play", ["InstanceID": "0", "Speed": "1"]) }
            await self.refresh()
        }
    }

    func seek(to seconds: Double) {
        guard let h = speaker?.host else { return }
        position = seconds
        seekLock = .now + 2
        attempt {
            _ = try await Sonos.soap(h, .AVTransport, "Seek",
                                     ["InstanceID": "0", "Unit": "REL_TIME", "Target": Sonos.hms(seconds)])
        }
    }

    func setVolume(_ v: Double) {
        volume = min(max(v, 0), 100)
        volumeLock = .now + 2
        guard volumeTask == nil, let h = speaker?.host else { return }
        // One in-flight sender: a drag never queues stale or reordered values.
        volumeTask = Task {
            defer { volumeTask = nil }
            var sent = -1
            while Int(volume) != sent {
                sent = Int(volume)
                do {
                    _ = try await Sonos.soap(h, .RenderingControl, "SetVolume",
                                             ["InstanceID": "0", "Channel": "Master", "DesiredVolume": "\(sent)"])
                } catch { self.error = error.localizedDescription; return }
                volumeLock = .now + 2
            }
        }
    }

    func cancelDownload() {
        downloadTask?.cancel()
        process?.terminate()
        downloadTask = nil
        download = nil
    }

    func toggleFavorite(_ track: Track) { favorites.formSymmetricDifference([track.id]) }

    func remove(_ track: Track) {
        try? FileManager.default.removeItem(at: file(track))
        favorites.remove(track.id)
        library.removeAll { $0.id == track.id }
        save()
    }

    // MARK: download

    private func start(_ target: String, title: String) {
        cancelDownload()
        download = Download(title: title, progress: nil)
        downloadTask = Task { await run(target) }
    }

    private func run(_ target: String) async {
        let p = Process()
        p.executableURL = URL(filePath: "/usr/bin/env")
        p.arguments = ["yt-dlp", "--no-playlist", "--playlist-items", "1", "--match-filter", "!is_live",
                       "--encoding", "utf-8", "-x", "--audio-format", "mp3", "--audio-quality", "192K", "--no-simulate",
                       "--print", "before_dl:META\t%(id)s\t%(duration)s\t%(uploader)s\t%(title)s",
                       "--progress", "--newline", "--progress-template", "download:PROG\t%(progress._percent_str)s",
                       "-o", dir.appending(path: "%(id)s.%(ext)s").path, "--", target]
        // A GUI app has no shell PATH; yt-dlp needs it to find ffmpeg and deno.
        p.environment = ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "HOME": NSHomeDirectory()]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { download = nil; self.error = error.localizedDescription; return }
        process = p
        var meta: Track?, lastError: String?, known = false
        do {
            for try await line in pipe.fileHandleForReading.bytes.lines {
                if Task.isCancelled { break }
                switch Self.parse(line) {
                case .meta(let t)?:
                    meta = t
                    download?.title = t.title
                    if exists(t) { known = true; p.terminate() }
                case .progress(let f)?: download?.progress = f >= 1 ? nil : f  // 100%: ffmpeg is converting
                case .error(let m)?: lastError = m
                case nil: break
                }
            }
        } catch {}
        p.waitUntilExit()
        if Task.isCancelled { return }  // cancelDownload already cleaned up
        process = nil
        download = nil
        if known, let meta { return play(meta) }
        switch p.terminationStatus {
        case 127: error = "yt-dlp not found. Install it with: brew install yt-dlp ffmpeg"
        case 0:
            if let meta, exists(meta) { play(meta) } else { error = "Nothing playable found." }
        default: error = lastError ?? "Download failed."
        }
    }

    nonisolated static func parse(_ line: String) -> Event? {
        let f = line.split(separator: "\t", maxSplits: 4, omittingEmptySubsequences: false)  // title keeps its tabs
        if f.count == 5, f[0] == "META" {
            return .meta(Track(id: String(f[1]), title: String(f[4]), uploader: String(f[3]), duration: Double(f[2]) ?? 0))
        }
        if f.count == 2, f[0] == "PROG", let pct = Double(f[1].trimmingCharacters(in: .whitespaces).dropLast()) {
            return .progress(pct / 100)
        }
        if line.hasPrefix("ERROR:") { return .error(line.dropFirst(6).trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    // MARK: helpers

    private func file(_ t: Track) -> URL { dir.appending(path: "\(t.id).mp3") }
    private func exists(_ t: Track) -> Bool { FileManager.default.fileExists(atPath: file(t).path) }
    private func save() { UserDefaults.standard.set(try? JSONEncoder().encode(library), forKey: "library") }

    private func attempt(_ work: @escaping () async throws -> Void) {
        Task { do { try await work() } catch { self.error = error.localizedDescription } }
    }
}
