use anyhow::{anyhow, Context, Result};
use std::io::{self, Write};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows::core::GUID;
use windows::Win32::Foundation::E_POINTER;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
    AUDCLNT_SHAREMODE, WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

// 为避免 windows-rs 不同版本/特性导致某些常量名缺失（E0432）或底层类型变化（u32/i32）
// 这里把关键常量用数值固定下来，保证在 windows = "0.56" 下更稳。
const CLSID_MMDEVICE_ENUMERATOR: GUID =
    GUID::from_u128(0xbcde0395_e52f_467c_8e3d_c4579291692e);

const SHAREMODE_SHARED: AUDCLNT_SHAREMODE = AUDCLNT_SHAREMODE(0);

// IAudioClient::Initialize 的 streamflags (u32)
const STREAMFLAGS_LOOPBACK: u32 = 0x0002_0000;
const STREAMFLAGS_NOPERSIST: u32 = 0x0008_0000;

// IAudioCaptureClient::GetBuffer 的 flags (DWORD)
const BUFFERFLAGS_SILENT: u32 = 0x0000_0002;

// wave format tags
const WAVE_FORMAT_PCM: u32 = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT: u32 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u32 = 0xFFFE;

fn clamp1(x: f32) -> f32 {
    x.max(-1.0).min(1.0)
}

fn resample_linear_stereo(in_lr: &[(f32, f32)], in_sr: u32, out_sr: u32) -> Vec<(f32, f32)> {
    if in_sr == out_sr || in_lr.is_empty() {
        return in_lr.to_vec();
    }
    let ratio = out_sr as f64 / in_sr as f64;
    let out_len = ((in_lr.len() as f64) * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);

    for oi in 0..out_len {
        let pos = (oi as f64) / ratio; // in index
        let i0 = pos.floor() as isize;
        let i1 = i0 + 1;
        let frac = (pos - (i0 as f64)) as f32;

        let (l0, r0) = if i0 < 0 {
            in_lr[0]
        } else if (i0 as usize) >= in_lr.len() {
            in_lr[in_lr.len() - 1]
        } else {
            in_lr[i0 as usize]
        };
        let (l1, r1) = if i1 < 0 {
            in_lr[0]
        } else if (i1 as usize) >= in_lr.len() {
            in_lr[in_lr.len() - 1]
        } else {
            in_lr[i1 as usize]
        };

        out.push((l0 + (l1 - l0) * frac, r0 + (r1 - r0) * frac));
    }
    out
}

fn to_i16_bytes_stereo(frames: &[(f32, f32)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(frames.len() * 4);
    for (l, r) in frames {
        let li = (clamp1(*l) * 32767.0) as i32;
        let ri = (clamp1(*r) * 32767.0) as i32;
        out.extend_from_slice(&(li as i16).to_le_bytes());
        out.extend_from_slice(&(ri as i16).to_le_bytes());
    }
    out
}

unsafe fn get_default_render_device() -> Result<IMMDevice> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&CLSID_MMDEVICE_ENUMERATOR, None, CLSCTX_ALL)
            .context("CoCreateInstance(MMDeviceEnumerator) 失败")?;
    let dev = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .context("GetDefaultAudioEndpoint 失败")?;
    Ok(dev)
}

/// 解析 WAVEFORMATEX / WAVEFORMATEXTENSIBLE，返回 (tag(u32), channels, sample_rate, bits_per_sample)
unsafe fn parse_mix_format(pwfx: *const WAVEFORMATEX) -> Result<(u32, u16, u32, u16)> {
    if pwfx.is_null() {
        return Err(anyhow!("mix format 为空"));
    }
    let wfx = &*pwfx;
    let tag_u32: u32 = u32::from(wfx.wFormatTag);
    let ch = wfx.nChannels;
    let sr = wfx.nSamplesPerSec;
    let bps = wfx.wBitsPerSample;

    if tag_u32 == WAVE_FORMAT_EXTENSIBLE {
        // WAVEFORMATEXTENSIBLE 的子格式 GUID 判断较繁琐；
        // 对于大多数设备，mix format 常见为：
        // - 32-bit float -> IEEE_FLOAT
        // - 16-bit PCM   -> PCM
        // 我们按 bits 做推断，足够满足 10–15 秒工具录制。
        let inferred_tag = if bps == 32 {
            WAVE_FORMAT_IEEE_FLOAT
        } else {
            WAVE_FORMAT_PCM
        };
        return Ok((inferred_tag, ch, sr, bps));
    }

    Ok((tag_u32, ch, sr, bps))
}

fn main() -> Result<()> {
    // 捕获 Ctrl+C
    let running = Arc::new(AtomicBool::new(true));
    {
        let r = running.clone();
        ctrlc::set_handler(move || {
            r.store(false, Ordering::SeqCst);
        })
        .context("安装 Ctrl+C handler 失败")?;
    }

    unsafe {
        // windows = 0.56: CoInitializeEx 返回 HRESULT（不是 Result），需要调用 .ok() 转成 Result
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .context("CoInitializeEx 失败")?;

        let device = get_default_render_device()?;
        // IMMDevice::Activate 的第二个参数是 Option<*const PROPVARIANT>，这里应传 None
        let audio_client: IAudioClient = device
            .Activate::<IAudioClient>(CLSCTX_ALL, None)
            .context("IMMDevice.Activate(IAudioClient) 失败")?;

        // windows = 0.56: GetMixFormat 无 out 参数，直接返回 *mut WAVEFORMATEX
        let pwfx: *mut WAVEFORMATEX = audio_client.GetMixFormat().context("GetMixFormat 失败")?;
        if pwfx.is_null() {
            return Err(anyhow!(E_POINTER));
        }
        let (tag, in_channels, in_sr, in_bps) = parse_mix_format(pwfx)?;

        // shared + loopback
        // buffer duration: 100ms
        let hns_buffer_duration: i64 = 1_000_000; // 100ms
        audio_client
            .Initialize(
                SHAREMODE_SHARED,
                STREAMFLAGS_LOOPBACK | STREAMFLAGS_NOPERSIST,
                hns_buffer_duration,
                0,
                pwfx,
                // windows-rs 0.56: Option<*const GUID>
                None,
            )
            .context("IAudioClient.Initialize 失败")?;

        let capture_client: IAudioCaptureClient = audio_client
            .GetService::<IAudioCaptureClient>()
            .context("GetService(IAudioCaptureClient) 失败")?;

        audio_client.Start().context("IAudioClient.Start 失败")?;

        let mut stdout = io::stdout().lock();

        while running.load(Ordering::SeqCst) {
            let mut packet_len: u32 = capture_client
                .GetNextPacketSize()
                .context("GetNextPacketSize 失败")?;

            while packet_len > 0 {
                let mut data_ptr: *mut u8 = null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;

                // windows-rs: Option<*mut u64>，显式 Some(ptr) 最稳
                let mut dev_pos: u64 = 0;
                let mut qpc_pos: u64 = 0;

                capture_client
                    .GetBuffer(
                        &mut data_ptr,
                        &mut num_frames,
                        &mut flags,
                        Some(&mut dev_pos as *mut u64),
                        Some(&mut qpc_pos as *mut u64),
                    )
                    .context("GetBuffer 失败")?;

                let silent = (flags & BUFFERFLAGS_SILENT) != 0;

                let mut stereo_f32: Vec<(f32, f32)> = Vec::with_capacity(num_frames as usize);

                if silent || data_ptr.is_null() {
                    stereo_f32.resize(num_frames as usize, (0.0, 0.0));
                } else if tag == WAVE_FORMAT_IEEE_FLOAT && in_bps == 32 {
                    let fptr = data_ptr as *const f32;
                    for i in 0..(num_frames as usize) {
                        let base = i * (in_channels as usize);
                        let l = *fptr.add(base);
                        let r = if in_channels >= 2 { *fptr.add(base + 1) } else { l };
                        stereo_f32.push((l, r));
                    }
                } else if tag == WAVE_FORMAT_PCM && in_bps == 16 {
                    let sptr = data_ptr as *const i16;
                    for i in 0..(num_frames as usize) {
                        let base = i * (in_channels as usize);
                        let l = (*sptr.add(base) as f32) / 32768.0;
                        let r = if in_channels >= 2 {
                            (*sptr.add(base + 1) as f32) / 32768.0
                        } else {
                            l
                        };
                        stereo_f32.push((l, r));
                    }
                } else {
                    capture_client.ReleaseBuffer(num_frames).ok();
                    return Err(anyhow!(
                        "不支持的混音格式：tag={}, bits={}, ch={}, sr={}",
                        tag,
                        in_bps,
                        in_channels,
                        in_sr
                    ));
                }

                let out_sr = 48_000u32;
                let stereo_48k = resample_linear_stereo(&stereo_f32, in_sr, out_sr);

                let bytes = to_i16_bytes_stereo(&stereo_48k);
                stdout.write_all(&bytes).ok();

                capture_client
                    .ReleaseBuffer(num_frames)
                    .context("ReleaseBuffer 失败")?;

                packet_len = capture_client
                    .GetNextPacketSize()
                    .context("GetNextPacketSize 失败")?;
            }

            std::thread::sleep(Duration::from_millis(10));
        }

        audio_client.Stop().ok();
        CoTaskMemFree(Some(pwfx as _));
    }

    Ok(())
}
