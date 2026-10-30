import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// A diagnostic recorder for one native trial. It records only the windows of the
// Studio processes that the worker owns. Each line on standard input is the
// current set of owned process IDs. When standard input closes, the recorder
// finishes the file. A failure here never changes the outcome of the trial.
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let output: URL
    private let maxSeconds: Double
    private let maxBytes: Int64
    private let framesPerSecond: Int32
    private let queue = DispatchQueue(label: "basalt.recorder")
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var started = false
    private var finishing = false
    private var frames = 0
    private var pids: Set<pid_t> = []
    private let begin = Date()

    init(output: URL, maxSeconds: Double, maxBytes: Int64, framesPerSecond: Int32) {
        self.output = output
        self.maxSeconds = maxSeconds
        self.maxBytes = maxBytes
        self.framesPerSecond = framesPerSecond
    }

    func update(_ next: Set<pid_t>) {
        queue.async {
            guard !self.finishing, next != self.pids, !next.isEmpty else { return }
            self.pids = next
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                self.queue.async { self.apply(content: content, error: error) }
            }
        }
    }

    private func apply(content: SCShareableContent?, error: Error?) {
        guard !finishing else { return }
        guard let content = content, let display = content.displays.first else {
            finish(reason: "no_display: \(error.map { String(describing: $0) } ?? "none")", code: 3)
            return
        }
        let owned = content.applications.filter { pids.contains($0.processID) }
        let filter = SCContentFilter(display: display, including: owned, exceptingWindows: [])
        if let stream = stream {
            stream.updateContentFilter(filter) { error in
                if let error = error { fputs("filter update failed: \(error)\n", stderr) }
            }
            return
        }
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.queueDepth = 3
        do {
            let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: display.width,
                AVVideoHeightKey: display.height,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_000_000],
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else {
                finish(reason: "writer_input_refused", code: 4)
                return
            }
            writer.add(input)
            self.writer = writer
            self.input = input
            let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            self.stream = stream
            stream.startCapture { error in
                if let error = error {
                    self.queue.async { self.finish(reason: "capture_refused: \(error)", code: 5) }
                }
            }
        } catch {
            finish(reason: "writer_failed: \(error)", code: 4)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, !finishing, sampleBuffer.isValid,
              let writer = writer, let input = input else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete else { return }
        if !started {
            guard writer.startWriting() else {
                finish(reason: "writer_start_failed: \(String(describing: writer.error))", code: 4)
                return
            }
            writer.startSession(atSourceTime: sampleBuffer.presentationTimeStamp)
            started = true
        }
        if input.isReadyForMoreMediaData, input.append(sampleBuffer) { frames += 1 }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.finish(reason: "stream_stopped: \(error)", code: 5) }
    }

    /// Stop at the time limit or before the size limit. One check each second is enough at 2 frames each second.
    func checkLimits() {
        queue.async {
            guard !self.finishing else { return }
            if Date().timeIntervalSince(self.begin) >= self.maxSeconds {
                self.finish(reason: "time_limit", code: 0)
                return
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: self.output.path)[.size] as? Int64) ?? 0
            if size >= self.maxBytes - 8 * 1024 * 1024 { self.finish(reason: "size_limit", code: 0) }
        }
    }

    /// Call only on the queue.
    func finish(reason: String, code: Int32) {
        guard !finishing else { return }
        finishing = true
        let done = {
            print("{\"reason\":\"\(reason.replacingOccurrences(of: "\"", with: "'"))\",\"frames\":\(self.frames)}")
            fflush(stdout)
            exit(self.started || code != 0 ? code : 6)
        }
        let close = {
            guard let writer = self.writer, self.started else {
                done()
                return
            }
            self.input?.markAsFinished()
            writer.finishWriting { done() }
        }
        if let stream = stream {
            stream.stopCapture { _ in self.queue.async { close() } }
        } else {
            close()
        }
    }

    func stop(reason: String) {
        queue.async { self.finish(reason: reason, code: 0) }
    }
}

guard CommandLine.arguments.count == 5,
      let maxSeconds = Double(CommandLine.arguments[2]),
      let maxBytes = Int64(CommandLine.arguments[3]),
      let framesPerSecond = Int32(CommandLine.arguments[4]),
      maxSeconds > 0, maxBytes > 0, framesPerSecond > 0 else {
    fputs("usage: native-recorder <output.mp4> <max-seconds> <max-bytes> <frames-per-second>\n", stderr)
    exit(2)
}
let recorder = Recorder(
    output: URL(fileURLWithPath: CommandLine.arguments[1]),
    maxSeconds: maxSeconds,
    maxBytes: maxBytes,
    framesPerSecond: framesPerSecond
)
Thread.detachNewThread {
    while let line = readLine() {
        recorder.update(Set(line.split(separator: " ").compactMap { pid_t($0) }))
    }
    recorder.stop(reason: "stopped")
}
let limits = Timer(timeInterval: 1, repeats: true) { _ in recorder.checkLimits() }
RunLoop.main.add(limits, forMode: .common)
RunLoop.main.run()
