import AppKit
import Foundation

// A trial-local observer. `open -g` only controls the initial Edit launch;
// Studio itself starts Play processes that can activate later.
guard CommandLine.arguments.count == 4 else {
    fputs("usage: native-focus <studio-executable> <prepared-place> <ready-file>\n", stderr)
    exit(2)
}

let executable = CommandLine.arguments[1]
let place = CommandLine.arguments[2]
let readyFile = CommandLine.arguments[3]
let workspace = NSWorkspace.shared
var previous = workspace.frontmostApplication
// An inactive GUI login may have no frontmost application even while Finder
// is running. Use the same existing restore target as for a Studio foreground.
if previous == nil || previous?.isTerminated == true || previous?.executableURL?.path == executable {
    previous = workspace.runningApplications.first { $0.bundleIdentifier == "com.apple.finder" }
}
guard previous != nil else {
    fputs("No non-Studio application is available to restore\n", stderr)
    exit(2)
}

func belongsToTrial(_ app: NSRunningApplication) -> Bool {
    guard app.executableURL?.path == executable else { return false }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-ww", "-p", String(app.processIdentifier), "-o", "command="]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 &&
            String(data: output, encoding: .utf8)?.contains(place) == true
    } catch {
        return false
    }
}

let observer = workspace.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
) { note in
    guard let active = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
        return
    }
    if active.executableURL?.path != executable {
        previous = active
        return
    }
    guard belongsToTrial(active) else { return }
    if previous?.isTerminated == true {
        previous = workspace.runningApplications.first { $0.bundleIdentifier == "com.apple.finder" }
    }
    guard let target = previous, !target.isTerminated else {
        fputs("No foreground application remains available\n", stderr)
        exit(3)
    }
    let restored = target.activate(options: [])
    print("\(Date().timeIntervalSince1970) studio=\(active.processIdentifier) target=\(target.processIdentifier) restored=\(restored)")
    fflush(stdout)
    if !restored { exit(3) }
}

guard FileManager.default.createFile(
    atPath: readyFile,
    contents: "target=\(previous!.processIdentifier)\n".data(using: .utf8),
    attributes: [.posixPermissions: 0o600]
) else {
    fputs("Cannot create focus guard readiness file\n", stderr)
    exit(2)
}
print("ready target=\(previous!.processIdentifier)")
fflush(stdout)
RunLoop.main.run()
workspace.notificationCenter.removeObserver(observer)
