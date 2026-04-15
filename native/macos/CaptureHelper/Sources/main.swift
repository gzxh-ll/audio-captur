import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation

// 约定输出：PCM s16le / 48kHz / 2ch（交错 interleaved）
// - helper 通过 stdout 持续输出裸 PCM
// - 收到 SIGINT/SIGTERM 或 stdin 关闭时停止

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
    // 如果父进程关闭 stdin，也会触发 EOF；我们用后台线程读取 stdin 来感知
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

    // 复用缓冲，减少分配
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

        // 期望：48kHz 立体声（如果系统返回不同，我们仍尽力做“声道规范化 + 类型转换”；
        // 采样率不符的情况建议在 Node 层由 ffmpeg 兜底重采样，但这里仍会提示 stderr）
        if inSampleRate != 48_000 {
            // 不中断，只提示一次（简化：每次都可能提示，实际可做一次性标记）
            fputs("警告：ScreenCaptureKit 输出采样率为 \(inSampleRate)Hz（期望 48000Hz）。建议在编码层启用重采样兜底。\n", stderr)
        }

        var audioBufferList = AudioBufferList(
            mNumberBuffers: 0,
            mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil)
        )
        var blockBuffer: CMBlockBuffer?
        var sizeNeeded: Int = 0

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &sizeNeeded,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        if frameCount <= 0 { return }

        // 将输入统一成“交错 stereo Int16”
        let outChannels = 2
        tmpInterleavedI16.removeAll(keepingCapacity: true)
        tmpInterleavedI16.reserveCapacity(frameCount * outChannels)

        // 获取每个声道的指针（可能是交错，也可能是非交错）
        let buffersCount = Int(audioBufferList.mNumberBuffers)
        if buffersCount <= 0 { return }

        func writeInterleavedStereoFromInterleavedF32(_ basePtr: UnsafeRawPointer) {
            // 交错：frameCount * inChannels
            let fPtr = basePtr.assumingMemoryBound(to: Float.self)
            for i in 0..<frameCount {
                let left: Float
                let right: Float
                if inChannels == 1 {
                    left = fPtr[i]
                    right = left
                } else {
                    left = fPtr[i * inChannels]
                    right = fPtr[i * inChannels + 1]
                }
                tmpInterleavedI16.append(Int16(clamping: Int(clamp(left) * 32767.0)))
                tmpInterleavedI16.append(Int16(clamping: Int(clamp(right) * 32767.0)))
            }
        }

        func writeInterleavedStereoFromInterleavedI16(_ basePtr: UnsafeRawPointer) {
            let sPtr = basePtr.assumingMemoryBound(to: Int16.self)
            for i in 0..<frameCount {
                let left: Int16
                let right: Int16
                if inChannels == 1 {
                    left = sPtr[i]
                    right = left
                } else {
                    left = sPtr[i * inChannels]
                    right = sPtr[i * inChannels + 1]
                }
                tmpInterleavedI16.append(left)
                tmpInterleavedI16.append(right)
            }
        }

        if isNonInterleaved {
            // 非交错：每个 buffer 是一个声道
            // 这里常见为 Float32 planar
            let leftBuf = audioBufferList.mBuffers
            // AudioBufferList 在 Swift 中 mBuffers 是单个元素占位；多 buffer 需要偏移访问
            // 使用 withUnsafePointer 将 AudioBufferList 视为连续内存
            withUnsafePointer(to: &audioBufferList) { ablPtr in
                let base = UnsafeRawPointer(ablPtr).advanced(by: MemoryLayout<UInt32>.size)
                for i in 0..<frameCount {
                    let l: Float
                    let r: Float
                    // 取第 0/1 声道，否则降级
                    let buf0 = base.load(fromByteOffset: 0 * MemoryLayout<AudioBuffer>.size, as: AudioBuffer.self)
                    let buf1 = (inChannels >= 2 && buffersCount >= 2)
                        ? base.load(fromByteOffset: 1 * MemoryLayout<AudioBuffer>.size, as: AudioBuffer.self)
                        : buf0
                    guard let d0 = buf0.mData else { return }
                    guard let d1 = buf1.mData else { return }
                    if isFloat {
                        let p0 = d0.assumingMemoryBound(to: Float.self)
                        let p1 = d1.assumingMemoryBound(to: Float.self)
                        l = p0[i]
                        r = p1[i]
                        tmpInterleavedI16.append(Int16(clamping: Int(clamp(l) * 32767.0)))
                        tmpInterleavedI16.append(Int16(clamping: Int(clamp(r) * 32767.0)))
                    } else if isSignedInt && asbd.mBitsPerChannel == 16 {
                        let p0 = d0.assumingMemoryBound(to: Int16.self)
                        let p1 = d1.assumingMemoryBound(to: Int16.self)
                        tmpInterleavedI16.append(p0[i])
                        tmpInterleavedI16.append(p1[i])
                    } else {
                        // 其它格式：暂不支持
                        return
                    }
                }
            }
        } else {
            // 交错：通常单 buffer
            let buf0 = audioBufferList.mBuffers
            guard let data = buf0.mData else { return }
            if isFloat && asbd.mBitsPerChannel == 32 {
                writeInterleavedStereoFromInterleavedF32(data)
            } else if isSignedInt && asbd.mBitsPerChannel == 16 {
                writeInterleavedStereoFromInterleavedI16(data)
            } else {
                // 其它格式：暂不支持
                return
            }
        }

        // 写 stdout
        let byteCount = tmpInterleavedI16.count * MemoryLayout<Int16>.size
        tmpInterleavedI16.withUnsafeBytes { raw in
            out.write(Data(raw[0..<byteCount]))
        }
    }
}

@main
struct CaptureHelperMain {
    static func main() async {
        // 关闭 stdout 缓冲，尽量降低延迟
        setvbuf(stdout, nil, _IONBF, 0)
        installSignalHandlers()

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else {
                fputs("错误：未找到可用显示器。\n", stderr)
                exit(2)
            }

            // 捕获整个显示器（包含系统音频）
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesVideo = false
            config.capturesAudio = true
            // 尽量请求 48kHz/2ch（不同系统版本属性名可能不同；此处用 KVC 兼容）
            config.setValue(48_000, forKey: "audioSampleRate")
            config.setValue(2, forKey: "audioChannelCount")

            let writer = AudioPcmWriter()
            let stream = SCStream(filter: filter, configuration: config, delegate: nil)

            try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio.queue"))
            try await stream.startCapture()

            // 主循环：等待停止信号
            while !StopFlag.shared.stopped {
                try await Task.sleep(nanoseconds: 150_000_000) // 150ms
            }

            await stream.stopCapture()
        } catch {
            fputs("错误：\(error)\n", stderr)
            exit(1)
        }
    }
}
