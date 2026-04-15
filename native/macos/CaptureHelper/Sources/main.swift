import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation
import CoreVideo

final class StopFlag {
    static let shared = StopFlag()
    private let lock = NSLock()
    private var _stopped = false
    var stopped: Bool {
        lock.lock(); defer { lock.unlock() }
        return _stopped
    }
    func stop() {
        lock.lock(); _stopped = true; lock.unlock()
    }
}

func installSignalHandlers() {
    signal(SIGINT) { _ in StopFlag.shared.stop() }
    signal(SIGTERM) { _ in StopFlag.shared.stop() }

    DispatchQueue.global(qos: .background).async {
        var buf = [UInt8](repeating: 0, count: 1)
        while true {
            let n = read(STDIN_FILENO, &buf, 1)
            if n <= 0 {
                StopFlag.shared.stop()
                return
            }
        }
    }
}

@inline(__always)
func clamp(_ x: Float) -> Float { max(-1.0, min(1.0, x)) }

final class AudioPcmWriter: NSObject, SCStreamOutput {
    private let out = FileHandle.standardOutput
    private var tmpInterleavedI16: [Int16] = []

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        if StopFlag.shared.stopped { return }
        guard outputType == .audio else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else {
            return
        }
        let asbd = asbdPtr.pointee

        let inSampleRate = Int(asbd.mSampleRate)
        let inChannels = Int(asbd.mChannelsPerFrame)
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isSignedInt = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0

        if inSampleRate != 48_000 {
            fputs("警告：输出采样率为 \(inSampleRate)Hz（期望 48000Hz），编码层会重采样兜底。\n", stderr)
        }

        var audioBufferList = AudioBufferList(
            mNumberBuffers: 0,
            mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil)
        )
        var blockBuffer
