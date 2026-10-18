/**
 * flac-decode.js —— libflacjs 解码 FLAC → AudioBuffer
 *
 * 用途:iOS Safari 等浏览器原生不支持 FLAC 时,用纯 JS/WASM 解码成 PCM,
 * 再交给 Web Audio API / wavesurfer.js 播放。
 */
import libFactory from 'libflacjs'

let flac = null
let flacReady = null

/** 初始化 libflac(异步,WASM 加载) */
async function initFlac() {
  if (flac) return flac
  if (flacReady) return flacReady
  flacReady = (async () => {
    const lib = libFactory()
    // libflacjs 的异步初始化(WASM 加载)
    if (lib.ready && typeof lib.ready.then === 'function') {
      await lib.ready
    }
    flac = lib
    return flac
  })()
  return flacReady
}

/**
 * 把 FLAC 文件的 ArrayBuffer 解码成 AudioBuffer
 * @param {ArrayBuffer} flacData FLAC 原始数据
 * @param {AudioContext} audioCtx 用于创建 AudioBuffer
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeFlac(flacData, audioCtx) {
  const lib = await initFlac()

  // libflacjs 的解码 API:decodeFlacData 或 decodeOggFlacData
  // 返回 { data: Float32Array[], sampleRate, channels, bitsPerSample }
  const result = await lib.decodeFlacData(flacData)

  if (!result || !result.data || result.data.length === 0) {
    throw new Error('libflacjs decode returned empty result')
  }

  const { data: channelData, sampleRate, channels } = result
  const length = channelData[0].length
  const buffer = audioCtx.createBuffer(channels, length, sampleRate)

  for (let ch = 0; ch < channels; ch++) {
    const src = channelData[ch]
    const dst = buffer.getChannelData(ch)
    dst.set(src instanceof Float32Array ? src : new Float32Array(src))
  }

  return buffer
}

/**
 * 检测当前浏览器是否原生支持 FLAC(能否用 decodeAudioData 解 FLAC)
 * @returns {Promise<boolean>}
 */
export async function canNativeDecodeFlac() {
  // 最简检测:尝试用 decodeAudioData 解一个最小 FLAC 头
  // 如果不支持会抛错
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    // 一个合法的 FLAC 最小文件头(fLaC + STREAMINFO)
    const flacHeader = new Uint8Array([
      0x66, 0x4C, 0x61, 0x43, // fLaC
      0x80, 0x00, 0x00, 0x22, // STREAMINFO block header
      ...new Array(34).fill(0), // STREAMINFO data(最小)
    ])
    await ctx.decodeAudioData(flacHeader.buffer)
    await ctx.close()
    return true
  } catch {
    return false
  }
}

/**
 * 智能解码:优先浏览器原生,不支持则用 libflacjs
 * @param {Blob|ArrayBuffer} blob FLAC 音频数据
 * @param {AudioContext} audioCtx
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeAudioSmart(blob, audioCtx) {
  const arrayBuffer = blob instanceof Blob ? await blob.arrayBuffer() : blob

  // 先试原生 decodeAudioData(Chrome/Firefox 直接解 FLAC)
  try {
    return await audioCtx.decodeAudioData(arrayBuffer.slice(0))
  } catch (e) {
    // 原生不支持,用 libflacjs
    console.log('[flac-decode] native decodeAudioData failed, fallback to libflacjs:', e.message)
    return await decodeFlac(arrayBuffer, audioCtx)
  }
}
