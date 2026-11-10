import SwiftUI

// Quitting on last window close would stop the file server feeding the speaker; keep running like Music.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
}

struct SonosTubeApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    @State private var player = Player()

    var body: some Scene {
        Window("SonosTube", id: "main") {
            ContentView()
                .frame(minWidth: 340, minHeight: 420)
                .environment(player)
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 380, height: 560)
        .commands {
            CommandMenu("Controls") {
                Button("Play/Pause") { player.togglePlayPause() }
                Button("Increase Volume") { player.setVolume(player.volume + 5) }
                    .keyboardShortcut(.upArrow, modifiers: .command)
                Button("Decrease Volume") { player.setVolume(player.volume - 5) }
                    .keyboardShortcut(.downArrow, modifiers: .command)
            }
        }
    }
}

private func clock(_ s: Double) -> String {
    Duration.seconds(s).formatted(.time(pattern: s >= 3600 ? .hourMinuteSecond(padHourToLength: 1) : .minuteSecond(padMinuteToLength: 1)))
}

private func thumb(_ t: Track, width: CGFloat) -> some View {
    AsyncImage(url: t.thumbnail) { $0.resizable().scaledToFill() } placeholder: { Color.secondary.opacity(0.15) }
        .frame(width: width, height: width * 9 / 16)
        .clipShape(.rect(cornerRadius: 6))
}

private func star(_ t: Track, _ player: Player) -> some View {
    let on = player.favorites.contains(t.id)
    return Button(on ? "Remove from Favorites" : "Add to Favorites", systemImage: on ? "star.fill" : "star") {
        player.toggleFavorite(t)
    }
    .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(on ? Color.yellow : .secondary)
    .help(on ? "Remove from Favorites" : "Add to Favorites")
}

struct ContentView: View {
    @Environment(Player.self) private var player
    @State private var query = ""
    @State private var selection: Track.ID?
    @AppStorage("favoritesOnly") private var favoritesOnly = false

    private var tracks: [Track] {
        player.library.filter {
            (!favoritesOnly || player.favorites.contains($0.id)) && (query.isEmpty
                || $0.title.localizedCaseInsensitiveContains(query) || $0.uploader.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        List(tracks, selection: $selection) { t in
            HStack(spacing: 10) {
                thumb(t, width: 64)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.title).lineLimit(2)
                    Text("\(t.uploader) · \(clock(t.duration))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if player.current == t {
                    Image(systemName: "speaker.wave.2.fill").foregroundStyle(.tint)
                        .symbolEffect(.variableColor, isActive: player.isPlaying)
                }
                star(t, player)
            }
        }
        .contextMenu(forSelectionType: Track.ID.self) { ids in
            let ts = player.library.filter { ids.contains($0.id) }
            if ts.count == 1, let t = ts.first {
                Button("Play") { player.play(t) }
                Button(player.favorites.contains(t.id) ? "Remove from Favorites" : "Add to Favorites") { player.toggleFavorite(t) }
                Button("Copy Link") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(t.url, forType: .string)
                }
            }
            if !ts.isEmpty { Button("Remove", role: .destructive) { ts.forEach(player.remove) } }
        } primaryAction: { ids in
            if let t = player.library.first(where: { ids.contains($0.id) }) { player.play(t) }
        }
        .onDeleteCommand {
            if let t = player.library.first(where: { $0.id == selection }) { player.remove(t) }
        }
        .onKeyPress(.space) { player.togglePlayPause(); return .handled }  // not .keyboardShortcut: that eats spaces in the search field
        .overlay {
            if player.library.isEmpty {
                ContentUnavailableView("No Tracks Yet", systemImage: "play.rectangle",
                                       description: Text("Search YouTube or paste a link above."))
            } else if tracks.isEmpty, query.isEmpty {
                ContentUnavailableView("No Favorites", systemImage: "star",
                                       description: Text("Star a track to keep it here."))
            } else if tracks.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .safeAreaInset(edge: .bottom) { NowPlaying() }
        .dropDestination(for: URL.self) { urls, _ in
            guard let u = urls.first else { return false }
            player.play(u.absoluteString)
            return true
        }
        .searchable(text: $query, placement: .toolbar, prompt: "Search or paste a YouTube link")
        .onSubmit(of: .search) { player.play(query); query = "" }
        .toolbar {
            ToolbarItem {
                Toggle("Favorites Only", systemImage: favoritesOnly ? "star.fill" : "star", isOn: $favoritesOnly)
                    .help("Show Favorites Only")
            }
            ToolbarItem {
                Menu {
                    if player.speakers.isEmpty {
                        Button("Searching for speakers…") {}.disabled(true)
                    } else {
                        Picker("Speaker", selection: Binding(get: { player.speaker?.id }, set: { player.speakerID = $0 })) {
                            ForEach(player.speakers) { Text($0.name).tag(Optional($0.id)) }
                        }
                        .pickerStyle(.inline)
                    }
                } label: {
                    Label(player.speaker?.name ?? "Speakers", systemImage: "hifispeaker.fill")
                        .labelStyle(.titleAndIcon)
                }
            }
        }
        .toolbar(removing: .title)
    }
}

// The one floating glass panel: control layer above the list, never glass on glass.
struct NowPlaying: View {
    @Environment(Player.self) private var player
    @State private var scrub: Double?

    var body: some View {
        VStack(spacing: 10) {
            if let message = player.error {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                    Text(message).font(.callout).foregroundStyle(.secondary).lineLimit(3).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button("Dismiss", systemImage: "xmark.circle.fill") { player.error = nil }
                        .labelStyle(.iconOnly).buttonStyle(.plain).help("Dismiss")
                }
            }
            if let d = player.download {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(d.title).font(.callout).lineLimit(1)
                        ProgressView(value: d.progress)
                    }
                    Button("Cancel Download", systemImage: "xmark.circle.fill") { player.cancelDownload() }
                        .labelStyle(.iconOnly).buttonStyle(.plain).help("Cancel Download")
                }
            }
            HStack(spacing: 10) {
                if let t = player.current {
                    thumb(t, width: 71)
                } else {
                    Image(systemName: "hifispeaker").foregroundStyle(.secondary)
                        .frame(width: 71, height: 40)
                        .background(.quaternary, in: .rect(cornerRadius: 6))
                }
                VStack(alignment: .leading) {
                    Text(player.current?.title ?? player.externalTitle ?? "Not Playing").font(.headline).lineLimit(1)
                    if let t = player.current { Text(t.uploader).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if let t = player.current { star(t, player) }
                Button(player.isPlaying ? "Pause" : "Play", systemImage: player.isPlaying ? "pause.fill" : "play.fill") {
                    player.togglePlayPause()
                }
                .labelStyle(.iconOnly).buttonStyle(.plain).font(.title2)
                .contentTransition(.symbolEffect(.replace))
                .disabled(player.speaker == nil)
            }
            HStack {
                Text(clock(scrub ?? player.position))
                Slider(value: Binding(get: { scrub ?? player.position }, set: { scrub = $0 }),
                       in: 0...max(player.duration, 1)) { editing in
                    if !editing, let s = scrub { player.seek(to: s); scrub = nil }
                }
                .accessibilityLabel("Position")
                .disabled(player.duration == 0)
                Text(clock(player.duration))
            }
            .font(.caption.monospacedDigit())
            HStack {
                Image(systemName: "speaker.fill")
                Slider(value: Binding(get: { player.volume }, set: { player.setVolume($0) }), in: 0...100)
                    .accessibilityLabel("Volume")
                Image(systemName: "speaker.wave.3.fill")
            }
            .foregroundStyle(.secondary)
            .disabled(player.speaker == nil)
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        .padding(12)
        .animation(.default, value: player.error)
        .animation(.default, value: player.download != nil)
    }
}
