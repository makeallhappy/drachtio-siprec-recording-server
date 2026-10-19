#!/usr/bin/env node
// pcap2audio.js —— 把 rtpengine 录的 pcap(RTP/PCMA)转成 WAV(可选经 docker ffmpeg 转 MP3/FLAC)
// 零依赖,纯 Node 标准库。
//
// 用法:
//   node pcap2audio.js in.pcap                 # 生成同名 .wav(立体声:左=腿1,右=腿2)
//   node pcap2audio.js in.pcap --mix           # 单声道混音
//   node pcap2audio.js in.pcap --mp3|--flac    # 先出 wav 再调 docker ffmpeg 转码
//   node pcap2audio.js recordings/pcaps/ --all # 批量转目录下所有 pcap
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------- G.711 A-law 解码 ----------
const ALAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let a = 0; a < 256; a++) {
    const v = a ^ 0x55;
    const seg = (v & 0x70) >> 4;
    let pcm = (v & 0x0f) << 4;
    if (seg === 0) pcm += 8;
    else if (seg === 1) pcm += 0x108;
    else { pcm += 0x108; pcm <<= (seg - 1); }
    t[a] = (v & 0x80) ? pcm : -pcm;
  }
  return t;
})();

function alawDecode(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ALAW_TABLE[buf[i]];
  return out;
}

// ---------- G.711 μ-law 解码(PT=0) ----------
const ULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let u = 0; u < 256; u++) {
    const v = u ^ 0xff;
    let pcm = 0;
    if ((v & 0x80) !== 0) pcm = (v & 0x0f) << 3 | 0x84;
    else pcm = (v & 0x0f) << 3 | 0x04;
    const exp = (v >> 4) & 0x07;
    pcm = exp === 0 ? pcm : pcm << exp;
    t[u] = (v & 0x80) ? pcm : -pcm;
  }
  return t;
})();

function ulawDecode(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ULAW_TABLE[buf[i]];
  return out;
}

// ---------- pcap / RTP 解析 ----------
function parsePcapRtp(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24) return new Map();
  const magic = buf.readUInt32BE(0);
  const be = magic === 0xa1b2c3d4;
  if (!be && magic !== 0xd4c3b2a1) throw new Error(`${file}: 不是标准 pcap 文件`);

  const legs = new Map(); // ssrc -> [{seq, payload}]
  let off = 24;
  while (off + 16 <= buf.length) {
    const incl = be ? buf.readUInt32BE(off + 8) : buf.readUInt32LE(off + 8);
    off += 16;
    const pkt = buf.subarray(off, off + incl);
    off += incl;
    if (pkt.length < 14) continue;
    // Ethernet(含 802.1Q)
    let ethOff = 14;
    let etype = pkt.readUInt16BE(12);
    if (etype === 0x8100 && pkt.length >= 18) { etype = pkt.readUInt16BE(16); ethOff = 18; }
    if (etype !== 0x0800 || pkt.length < ethOff + 20) continue;
    // IPv4
    const ip = pkt.subarray(ethOff);
    const ihl = (ip[0] & 0x0f) * 4;
    if (ip[9] !== 17 || ip.length < ihl + 8) continue;
    // UDP
    const rtp = ip.subarray(ihl + 8);
    if (rtp.length < 12) continue;
    // RTP: v2, PT=0 (PCMU) 或 PT=8 (PCMA)
    if ((rtp[0] >> 6) !== 2) continue;
    const pt = rtp[1] & 0x7f;
    if (pt !== 0 && pt !== 8) continue;
    let hdr = 12 + (rtp[0] & 0x0f) * 4;
    if (rtp[0] & 0x10) { // header extension
      if (rtp.length < hdr + 4) continue;
      hdr += 4 + rtp.readUInt16BE(hdr + 2) * 4;
    }
    if (rtp.length <= hdr) continue;
    const seq = rtp.readUInt16BE(2);
    const ssrc = rtp.readUInt32BE(8);
    if (!legs.has(ssrc)) legs.set(ssrc, []);
    legs.get(ssrc).push({ seq, pt, payload: rtp.subarray(hdr) });
  }
  return legs;
}

// ---------- 合成 WAV ----------
function writeWav(outPath, legs, mix) {
  if (legs.size === 0) throw new Error('pcap 里没有 G.711(PCMU PT=0 / PCMA PT=8)的 RTP 包');
  const decoded = [];
  for (const ssrc of [...legs.keys()].sort((a, b) => a - b)) {
    const pkts = legs.get(ssrc).sort((a, b) => a.seq - b.seq);
    const pcm = [];
    for (const p of pkts) {
      // PT=0 -> μ-law, PT=8 -> A-law
      pcm.push(...(p.pt === 0 ? ulawDecode(p.payload) : alawDecode(p.payload)));
    }
    decoded.push(pcm);
  }
  if (decoded.length === 1) decoded.push([]); // 单路时右路补静音
  const n = Math.max(decoded[0].length, decoded[1].length);
  const L = decoded[0], R = decoded[1];

  const channels = mix ? 1 : 2;
  const dataSize = n * 2 * channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000 * channels * 2, 28); header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataSize, 40);

  const frames = Buffer.alloc(dataSize);
  for (let i = 0; i < n; i++) {
    const l = L[i] || 0, r = R[i] || 0;
    if (mix) {
      let m = Math.round((l + r) / 2);
      m = Math.max(-32768, Math.min(32767, m));
      frames.writeInt16LE(m, i * 2);
    } else {
      frames.writeInt16LE(l, i * 4);
      frames.writeInt16LE(r, i * 4 + 2);
    }
  }
  fs.writeFileSync(outPath, Buffer.concat([header, frames]));
  return n;
}

// ---------- ffmpeg 转 mp3/flac ----------
const FFMPEG_IMG = 'jrottenberg/ffmpeg:4.4-alpine';

function hasLocalFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  return !r.error && r.status === 0;
}

function transcode(wavPath, fmt) {
  const dir = path.dirname(path.resolve(wavPath));
  const base = path.basename(wavPath);
  const out = base.replace(/\.wav$/, '.' + fmt);
  const codec = fmt === 'mp3' ? ['-codec:a', 'libmp3lame', '-q:a', '4'] : ['-codec:a', 'flac'];
  if (hasLocalFfmpeg()) {
    // 容器/装了 ffmpeg 的宿主机:直接本地转码
    execFileSync('ffmpeg', ['-y', '-i', wavPath, ...codec, path.join(dir, out)], { stdio: 'pipe' });
  } else {
    // 无本地 ffmpeg:回退 docker 镜像转码
    execFileSync('docker', ['run', '--rm', '-v', `${dir}:/work`, '-w', '/work',
      FFMPEG_IMG, '-y', '-i', base, ...codec, out], { stdio: 'pipe' });
  }
  return path.join(dir, out);
}

// ---------- main ----------
function convert(pcap, mix, fmt) {
  const wavPath = pcap.replace(/\.pcap$/, '') + '.wav';
  const legs = parsePcapRtp(pcap);
  const samples = writeWav(wavPath, legs, mix);
  console.log(`${pcap} -> ${wavPath}  (${legs.size} 路 RTP, ${(samples / 8000).toFixed(1)} 秒)`);
  if (fmt) console.log(`       -> ${transcode(wavPath, fmt)}`);
}

const argv = process.argv.slice(2);
const files = argv.filter(a => !a.startsWith('--'));
const mix = argv.includes('--mix');
const fmt = argv.includes('--mp3') ? 'mp3' : (argv.includes('--flac') ? 'flac' : null);
if (files.length === 0) { console.log('用法: node pcap2audio.js <in.pcap|目录> [--mix] [--mp3|--flac] [--all]'); process.exit(1); }

const target = files[0];
if (argv.includes('--all') || fs.statSync(target).isDirectory()) {
  for (const name of fs.readdirSync(target).sort()) {
    if (name.endsWith('.pcap')) {
      const p = path.join(target, name);
      if (fs.statSync(p).size > 24) convert(p, mix, fmt);
    }
  }
} else {
  convert(target, mix, fmt);
}
