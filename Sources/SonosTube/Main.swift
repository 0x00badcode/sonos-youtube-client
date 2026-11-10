import SwiftUI

@main enum Main {
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            Task { await selfTest(); exit(0) }
            dispatchMain()
        }
        SonosTubeApp.main()
    }
}
