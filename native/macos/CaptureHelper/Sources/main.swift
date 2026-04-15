import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation
import CoreVideo

final class StopFlag {
    static let shared = StopFlag()
    private let lock = NSLock()
    private var _stopped = false
    var stopped: Bool { lock.lock(); defer { lock.unlock() }; return _stopped }
    func stop() { lock.lock(); _stopped = true; lock.unlock() }
}

func installSignalHandlers() {
    signal(SIGINT) { _ in StopFlag.shared.stop() }
    signal(SIGTERM) { _ in StopFlag.shared.stop() }
    DispatchQueue.global(qos: .background).async {
        var b: UInt8 = 0
        while true {
            let n = read(STDIN_FILENO, &b, 1)
            if n <= 0 { StopFlag.shared.stop(); return }
        }
    }
}

@inline(__always)
func clamp(_ x: Float) -> Float { max(-1.0, min(1.0, x)) }

final class AudioPcmWriter: NSObject, SCStreamOutput {
    private let out = FileHandle.standardOutput
    private var tmp: [Int16] = []

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        if StopFlag.shared.stopped { return }
        guard outputType == .audio else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else { return }
        let asbd = asbdPtr.pointee

        let inChannels = Int(asbd.mChannelsPerFrame)
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isSignedInt = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0

        var abl = AudioBufferList(
            mNumberBuffers: 0,
            mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil)
        )
        var block: CMBlockBuffer?
        var sizeNeeded: Int = 0

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &sizeNeeded,
            bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: &block
        )
        guard status == noErr else { return }

        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        if frames <= 0 { return }

        // 输出统一为 stereo interleaved int16（48k 重采样交给 ffmpeg 兜底）
        tmp.removeAll(keepingCapacity: true)
        tmp.reserveCapacity(frames * 2)

        let buffersCount = Int(abl.mNumberBuffers)
        if buffersCount <= 0 { return }

        func appendLR(_ l: Float, _ r: Float) {
            tmp.append(Int16(clamping: Int(clamp(l) * 32767.0)))
            tmp.append(Int16(clamping: Int(clamp(r) * 32767.0)))
        }

        if isNonInterleaved {
            // planar：每个 buffer 一个声道
            withUnsafePointer(to: &abl) { ablPtr in
                let base = UnsafeRawPointer(ablPtr).advanced(by: MemoryLayout<UInt32>.size)
                let buf0 = base.load(fromByteOffset: 0 * MemoryLayout<AudioBuffer>.size, as: AudioBuffer.self)
                let buf1 = (inChannels >= 2 && buffersCount >= 2)
                    ? base.load(fromByteOffset: 1 * MemoryLayout<AudioBuffer>.size, as: AudioBuffer.self)
                    : buf0
                guard let d0 = buf0.mData, let d1 = buf1.mData else { return }

                if isFloat {
                    let p0 = d0.assumingMemoryBound(to: Float.self)
                    let p1 = d1.assumingMemoryBound(to: Float.self)
                    for i in 0..<frames { appendLR(p0[i], p1[i]) }
                } else if isSignedInt && asbd.mBitsPerChannel == 16 {
                    let p0 = d0.assumingMemoryBound(to: Int16.self)
                    let p1 = d1.assumingMemoryBound(to: Int16.self)
                    for i in 0..<frames {
                        tmp.append(p0[i]); tmp.append(p1[i])
                    }
                }
            }
        } else {
            // interleaved：通常单 buffer
            let buf0 = abl.mBuffers
            guard let data = buf0.mData else { return }
            if isFloat && asbd.mBitsPerChannel == 32 {
                let p = data.assumingMemoryBound(to: Float.self)
                for i in 0..<frames {
                    let l = p[i * max(1, inChannels)]
                    let r = (inChannels >= 2) ? p[i * inChannels + 1] : l
                    appendLR(l, r)
                }
            } else if isSignedInt && asbd.mBitsPerChannel == 16 {
                let p = data.assumingMemoryBound(to: Int16.self)
                for i in 0..<frames {
                    let l = p[i * max(1, inChannels)]
                    let r = (inChannels >= 2) ? p[i * inChannels + 1] : l
                    tmp.append(l); tmp.append(r)
                }
            }
        }

        let byteCount = tmp.count * MemoryLayout<Int16>.size
        tmp.withUnsafeBytes { raw in
            out.write(Data(raw[0..<byteCount]))
        }
    }
}

@main
struct CaptureHelperMain {
    static func main() async {
        setvbuf(stdout, nil, _IONBF, 0)
        installSignalHandlers()

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else {
                fputs("错误：未找到可用显示器。\n", stderr)
                exit(2)
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true

            // 最小视频配置（部分系统版本需要）
            config.width = 2
            config.height = 2
            config.pixelFormat = kCVPixelFormatType_32BGRA

            config.setValue(48_000, forKey: "audioSampleRate")
            config.setValue(2, forKey: "audioChannelCount")

            let writer = AudioPcmWriter()
            let stream = SCStream(filter: filter, configuration: config, delegate: nil)

            try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio.queue"))
            try await stream.startCapture()

            while !StopFlag.shared.stopped {
                try await Task.sleep(nanoseconds: 150_000_000)
            }

            // 关键：stopCapture 在你 CI 的 SDK 里是 throws
            try await stream.stopCapture()
        } catch {
            fputs("错误：\(error)\n", stderr)
            exit(1)
        }
    }
}
