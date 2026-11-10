import AppKit

func hex(_ value: UInt32) -> NSColor {
    NSColor(
        srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
        green: CGFloat((value >> 8) & 0xFF) / 255,
        blue: CGFloat(value & 0xFF) / 255,
        alpha: 1)
}

func render(_ pixels: Int, _ draw: () -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    draw()
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let canvas = 1024.0
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let bodyPath = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
let gradient = NSGradient(starting: hex(0xFF453A), ending: hex(0xC4161C))!

let symbolHeight = 460.0
let symbolConfig = NSImage.SymbolConfiguration(pointSize: symbolHeight, weight: .regular)
let symbol = NSImage(systemSymbolName: "hifispeaker.fill", accessibilityDescription: nil)!
    .withSymbolConfiguration(symbolConfig)!
let symbolWidth = symbol.size.width * symbolHeight / symbol.size.height
let symbolRect = NSRect(x: (canvas - symbolWidth) / 2, y: (canvas - symbolHeight) / 2,
                        width: symbolWidth, height: symbolHeight)

let symbolRep = render(1024) {
    symbol.draw(in: symbolRect)
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: canvas, height: canvas).fill(using: .sourceIn)
}

let master = render(1024) {
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
    shadow.shadowBlurRadius = 20
    shadow.shadowOffset = NSSize(width: 0, height: -10)
    shadow.set()
    NSColor.red.setFill()
    bodyPath.fill()
    NSGraphicsContext.restoreGraphicsState()

    gradient.draw(in: bodyPath, angle: 270)
    NSGraphicsContext.current?.cgContext.draw(symbolRep.cgImage!, in: NSRect(x: 0, y: 0, width: canvas, height: canvas))
}
let masterImage = NSImage(size: NSSize(width: canvas, height: canvas))
masterImage.addRepresentation(master)

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

let entries: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for (name, pixels) in entries {
    let rep = render(pixels) {
        masterImage.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    }
    try rep.representation(using: .png, properties: [:])!
        .write(to: iconset.appendingPathComponent(name))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", here.appendingPathComponent("AppIcon.icns").path]
try iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
print(iconutil.terminationStatus == 0 ? "Wrote \(here.appendingPathComponent("AppIcon.icns").path)" : "iconutil failed")
