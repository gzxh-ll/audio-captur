use anyhow::{anyhow, Context, Result};
use std::io::{self, Write};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows::Win32::Foundation::E_POINTER;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_NOPERSIST, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_EXTENSIBLE,
    WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

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
        CoCreateInstance(&IMMDeviceEnumerator::IID, None, CLSCTX_ALL)
            .context("CoCreateInstance(IMMDeviceEnumerator) 失败")?;
    let dev = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .context("GetDefaultAudioEndpoint 失败")?;
    Ok(dev)
}

/// 解析 WAVEFORMATEX / WAVEFORMATEXTENSIBLE，返回 (tag, channels, sample_rate, bits_per_sample)
unsafe fn parse_mix_format(pwfx: *const WAVEFORMATEX) -> Result<(u16, u16, u32, u16)> {
    if pwfx.is_null() {
        return Err(anyhow!("mix format 为空"));
    }
    let wfx = &*pwfx;
    let tag = wfx.wFormatTag;
    let ch = wfx.nChannels;
    let sr = wfx.nSamplesPerSec;
    let bps = wfx.wBitsPerSample;

    if tag == WAVE_FORMAT_EXTENSIBLE {
        let _ext = &*(pwfx as *const WAVEFORMATEXTENSIBLE);
        // WAVE_FORMAT_IEEE_FLOAT / WAVE_FORMAT_PCM 的 GUID 判断较繁琐；
        // 这里依赖常见 mixformat 组合做判定（大多数设备足够用）
        let inferred_tag = if bps == 32 {
            WAVE_FORMAT_IEEE_FLOAT
        } else {
            WAVE_FORMAT_PCM
        };
        return Ok((inferred_tag, ch, sr, bps));
    }

    Ok((tag, ch, sr, bps))
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
        CoInitializeEx(None, COINIT_MULTITHREADED).context("CoInitializeEx 失败")?;

        let device = get_default_render_device()?;
        let audio_client: IAudioClient = device
            .Activate(CLSCTX_ALL, null_mut())
            .context("IMMDevice.Activate(IAudioClient) 失败")?;

        let mut pwfx: *mut WAVEFORMATEX = null_mut();
        audio_client
            .GetMixFormat(&mut pwfx)
            .context("GetMixFormat 失败")?;
        if pwfx.is_null() {
            return Err(anyhow!(E_POINTER));
        }
        let (tag, in_channels, in_sr, in_bps) = parse_mix_format(pwfx)?;

        // shared + loopback
        // buffer duration: 100ms
        let hns_buffer_duration: i64 = 1_000_000; // 100ms in 100ns units
        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_NOPERSIST,
                hns_buffer_duration,
                0,
                pwfx,
                null_mut(),
            )
            .context("IAudioClient.Initialize 失败")?;

        let capture_client: IAudioCaptureClient = audio_client
            .GetService()
            .context("GetService(IAudioCaptureClient) 失败")?;

        audio_client.Start().context("IAudioClient.Start 失败")?;

        let mut stdout = io::stdout().lock();

        while running.load(Ordering::SeqCst) {
            let mut packet_len: u32 = capture_client
