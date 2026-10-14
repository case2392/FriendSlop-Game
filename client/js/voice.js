// In-game voice chat: Opus over the game's own connection. Each player's voice goes to the server (in
// the Steam build, the host's game), which passes every 20 ms frame on only to the players who can hear
// it: within earshot, or both on a walkie (server/host.js relayVoice). No peer-to-peer connections, so
// there's nothing to punch through home routers and nobody sees anybody's IP address.
//
//   mic -> AudioWorklet (20 ms of 48 kHz mono) -> WebCodecs AudioEncoder (Opus, 24 kbps)
//       -> [1][flags][seq u16][opus] to the server -> [2][speaker id][flags][seq u16][opus] to listeners
//       -> an AudioDecoder per speaker -> a small jitter buffer -> the proximity graph (muffle, HRTF
//          panner, distance) or the walkie's crunch -> that speaker's volume -> master volume
//
// Browser rules worth knowing: getUserMedia only exists in a secure context (https, localhost, or the
// desktop build's app://), and WebCodecs' Opus is in Chromium (so Steam's build) and recent Firefox.
//
// Everyone is in voice from the moment they're in the game (main.js joins it): hearing whoever is in earshot
// needs no mic. The mic comes on too when the browser gives it; blocked or missing, you still hear the rest.

import * as net from './net.js';
import { voiceGain } from '/shared/constants.js';
import { audioCtx, bus } from './audio.js';
import { settings, setSetting } from './settings.js';

const SPEAK_RMS = 0.045;          // RMS above this = "speaking" (the meter, and the open mic's gate)
const GATE_HOLD = 0.4;            // the open mic keeps sending this long after the voice drops
const JITTER = 0.08;              // seconds of audio buffered per speaker before it plays
const RATE = 48000;

const store = (k, v) => { try { localStorage.setItem('slopVoice.' + k, JSON.stringify(v)); } catch {} };
const load = (k, d) => {
  try { const v = localStorage.getItem('slopVoice.' + k); return v == null ? d : JSON.parse(v); }
  catch { return d; }
};

export const V = {
  supported: !!(window.AudioDecoder && window.AudioWorkletNode),    // hearing the others
  canTalk: !!(navigator.mediaDevices?.getUserMedia && window.AudioEncoder && window.AudioWorkletNode),
  secure: window.isSecureContext,
  on: false,                       // am I in voice (hearing whoever is in earshot)?
  mic: false,                      // and is my mic on it?
  connecting: false,
  get mode() { return settings.voiceMode; },     // 'open' | 'ptt' (Settings > Audio)
  ptt: false,                      // push-to-talk key held right now
  walkieKey: false,                // T held: talking on the walkie
  muted: load('muted', false),     // self-mute toggle
  get masterVol() { return settings.voice; },     // the mixer's voice bus (Settings > Audio)
  micId: load('micId', ''),
  mics: [],                        // [{deviceId, label}]
  peers: new Map(),                // speaker id -> peer
  speaking: {},                    // id -> true (includes self while transmitting)
  err: null,
  stats: { sent: 0, recv: 0, decoded: 0, late: 0 },
  _selfId: null,
  _players: [],                    // last meta roster
  _onChange: null,                 // UI refresh hook
};

let actx = null, masterGain = null;
let mic = null;                    // { stream, src, tap, an, data }
let enc = null, seq = 0, ts = 0, lastLoud = -1e9;
let meterTimer = null;

function emitChange() { V._onChange?.(); }

// voices share the game's one AudioContext (48 kHz, Opus's rate) and go to the mixer's voice bus
function ensureCtx() {
  if (!actx) {
    actx = audioCtx();
    masterGain = actx.createGain();
    masterGain.connect(bus.voice);
  }
  if (actx.state === 'suspended') actx.resume();
}

// ---- transmit gating ------------------------------------------------------------------

function txAllowed() {
  return V.on && V.mic && !V.muted && (V.mode === 'open' || V.ptt || V.walkieKey);
}

// holding T to talk on the walkie always transmits, even in push-to-talk mode
export function setWalkieKey(held) {
  held = !!held;
  if (V.walkieKey === held) return;
  V.walkieKey = held;
  emitChange();
}

// ---- mic -> Opus -> the server ----------------------------------------------------------

async function openMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...(V.micId ? { deviceId: { ideal: V.micId } } : {}) },
  });
  const src = actx.createMediaStreamSource(stream);
  const an = actx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);                       // analysis only: never wired to the speakers (no self-echo)
  const tap = new AudioWorkletNode(actx, 'nmd-mic-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
  src.connect(tap);
  tap.port.onmessage = e => onMicBlock(e.data);
  return { stream, src, tap, an, data: new Uint8Array(an.frequencyBinCount) };
}
function closeMic(m) {
  if (!m) return;
  try { m.tap.port.onmessage = null; m.src.disconnect(); m.tap.disconnect(); } catch {}
  m.stream.getTracks().forEach(t => t.stop());
}

async function makeEncoder() {
  const base = { codec: 'opus', sampleRate: actx.sampleRate, numberOfChannels: 1, bitrate: 24000 };
  const tuned = { ...base, opus: { frameDuration: 20000, useinbandfec: true, complexity: 8 } };
  const cfg = (await AudioEncoder.isConfigSupported(tuned).catch(() => ({})))?.supported ? tuned : base;
  if (!(await AudioEncoder.isConfigSupported(cfg).catch(() => ({})))?.supported) throw new Error('this browser can\'t encode Opus');
  const e = new AudioEncoder({
    output: chunk => sendChunk(chunk),
    error: err => { console.warn('voice encoder', err); enc = null; },
  });
  e.configure(cfg);
  return e;
}

function onMicBlock(block) {
  if (!V.on || !enc || enc.state !== 'configured') return;
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  const loud = Math.sqrt(sum / block.length) > SPEAK_RMS * 0.6;
  const now = actx.currentTime;
  if (loud) lastLoud = now;
  // push-to-talk and the walkie send while the key is down; the open mic only while you're talking
  const send = txAllowed() && (V.ptt || V.walkieKey || now - lastLoud < GATE_HOLD);
  const frame = new AudioData({ format: 'f32-planar', sampleRate: actx.sampleRate, numberOfFrames: block.length, numberOfChannels: 1, timestamp: ts, data: block });
  ts += Math.round(block.length / actx.sampleRate * 1e6);
  if (send) enc.encode(frame);
  frame.close();
}

function sendChunk(chunk) {
  if (!V.on || chunk.byteLength > 560) return;
  const b = new Uint8Array(4 + chunk.byteLength);
  b[0] = 1;
  b[1] = V.walkieKey ? 1 : 0;
  b[2] = seq & 255; b[3] = (seq >> 8) & 255;
  seq = (seq + 1) & 0xffff;
  chunk.copyTo(b.subarray(4));
  net.sendBinary(b);
  V.stats.sent++;
}

export async function refreshMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    V.mics = devs.filter(d => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    emitChange();
  } catch { /* no permission yet: labels come after joining */ }
}

export async function setMic(deviceId) {
  V.micId = deviceId;
  store('micId', deviceId);
  if (!V.on) return;
  if (!V.mic) return retryMic();
  try {
    const next = await openMic();
    closeMic(mic);
    mic = next;
  } catch (e) {
    V.err = 'Could not switch mic: ' + e.message;
    emitChange();
  }
}

// ---- join / leave -------------------------------------------------------------------------

// in voice: hearing whoever is in earshot at once, then the mic if the browser gives it
let workletLoaded = null;
export async function joinVoice() {
  if (V.on || V.connecting) return;
  V.err = null;
  if (!V.supported || !V.secure) {
    V.err = !V.secure
      ? 'Voice needs HTTPS (or localhost). Host through a tunnel like Tailscale/cloudflared, or use the desktop build.'
      : 'This browser can\'t do voice chat. Use the desktop build, or Chrome / Edge.';
    emitChange();
    return;
  }
  V.connecting = true;
  emitChange();
  try {
    ensureCtx();
    workletLoaded ??= actx.audioWorklet.addModule(new URL('./voice_worklet.js', import.meta.url));
    await workletLoaded;
  } catch (e) {
    V.connecting = false;
    V.err = 'Voice chat could not start: ' + e.message;
    emitChange();
    return;
  }
  V.on = true;
  net.send({ t: 'voice', on: true, mic: false });
  startMeter();
  syncPeers();
  await openMyMic();
  V.connecting = false;
  emitChange();
}
async function openMyMic() {
  if (!V.canTalk) { V.err = 'This browser can hear the others but not send your voice: Chrome or Edge can.'; return; }
  try {
    enc ||= await makeEncoder();
    mic = await openMic();
    V.mic = true;
    V.err = null;
    if (V.on) net.send({ t: 'voice', on: true, mic: true });
    refreshMics();
  } catch (e) {
    closeMic(mic); mic = null;
    try { enc?.close(); } catch {}
    enc = null;
    V.mic = false;
    V.err = e.name === 'NotAllowedError'
      ? 'Your mic is blocked, so nobody hears you. Allow it (the icon left of the address bar), then click the mic.'
      : e.name === 'NotFoundError' ? 'No microphone found: you hear the others, they can\'t hear you.' : 'Mic error: ' + e.message;
  }
}
// the mic again (blocked, then allowed; or plugged in)
export async function retryMic() {
  if (!V.on) return joinVoice();
  if (V.mic || V.connecting) return;
  V.connecting = true;
  emitChange();
  await openMyMic();
  V.connecting = false;
  emitChange();
}

export function leaveVoice() {
  if (!V.on) return;
  V.on = false;
  V.mic = false;
  net.send({ t: 'voice', on: false });
  for (const id of [...V.peers.keys()]) closePeer(id);
  closeMic(mic); mic = null;
  try { enc?.close(); } catch {}
  enc = null;
  V.speaking = {};
  stopMeter();
  emitChange();
}

// ---- other players' voices -------------------------------------------------------------------

function makePeer(id) {
  ensureCtx();
  const peer = {
    id, dec: null, playAt: 0, lastSeq: -1, lastAt: 0,
    ...peerPrefs(id),
  };
  peer.input = actx.createGain();
  peer.gain = actx.createGain();
  peer.analyser = actx.createAnalyser();
  peer.analyser.fftSize = 512;
  peer.data = new Uint8Array(peer.analyser.frequencyBinCount);
  peer.input.connect(peer.analyser);
  // proximity path: muffle (occlusion) -> 3D panner -> distance gain
  peer.lp = actx.createBiquadFilter();
  peer.lp.type = 'lowpass';
  peer.lp.frequency.value = 18000;
  peer.panner = actx.createPanner();
  peer.panner.panningModel = 'HRTF';
  peer.panner.distanceModel = 'linear';
  peer.panner.rolloffFactor = 0;           // we do distance ourselves (a nicer curve)
  peer.gSpatial = actx.createGain();
  peer.gSpatial.gain.value = 0;            // silent until spatialize() places them
  peer.input.connect(peer.lp);
  peer.lp.connect(peer.panner);
  peer.panner.connect(peer.gSpatial);
  peer.gSpatial.connect(peer.gain);
  // walkie-talkie path: tinny, crunchy, no distance
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 1.1;
  const shaper = actx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 3.2); }
  shaper.curve = curve;
  peer.gRadio = actx.createGain();
  peer.gRadio.gain.value = 0;
  peer.input.connect(bp);
  bp.connect(shaper);
  shaper.connect(peer.gRadio);
  peer.gRadio.connect(peer.gain);
  peer.gain.connect(masterGain);
  applyPeerVol(peer);
  V.peers.set(id, peer);
  emitChange();
  return peer;
}

function decoderFor(peer) {
  if (peer.dec && peer.dec.state === 'configured') return peer.dec;
  try {
    peer.dec = new AudioDecoder({ output: d => play(peer, d), error: e => { console.warn('voice decoder', e); peer.dec = null; } });
    peer.dec.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
  } catch (e) { console.warn('voice decoder', e); peer.dec = null; }
  return peer.dec;
}

// a frame from the server: [2][speaker id][flags][seq u16][opus]
function onFrame(buf) {
  if (!V.on) return;
  const b = new Uint8Array(buf);
  if (b.length < 6 || b[0] !== 2) return;
  const id = b[1];
  if (id === V._selfId) return;
  const s = b[3] | (b[4] << 8);
  const peer = V.peers.get(id) || makePeer(id);
  V.stats.recv++;
  // a frame older than the last one played is late: drop it (16-bit sequence, wrapping). After a pause
  // (they stopped talking, or talked out of earshot) the count may have wrapped any number of times, so
  // the first frame back starts it over: else ten minutes of talk out of earshot left them mute up close
  const now = performance.now();
  if (peer.lastSeq >= 0 && now - peer.lastAt < 1000 && ((s - peer.lastSeq) & 0xffff) > 0x8000) { V.stats.late++; return; }
  peer.lastSeq = s; peer.lastAt = now;
  const dec = decoderFor(peer);
  if (!dec) return;
  try { dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s * 20000, data: b.subarray(5) })); }
  catch (e) { console.warn('voice decode', e); }
}

function play(peer, d) {
  try {
    if (!V.peers.has(peer.id) || peer.muted) return;
    const n = d.numberOfFrames;
    const ab = actx.createBuffer(1, n, d.sampleRate);
    const out = ab.getChannelData(0);
    if (/^f32/.test(d.format)) d.copyTo(out, { planeIndex: 0 });
    else { const tmp = new Int16Array(n * d.numberOfChannels); d.copyTo(tmp, { planeIndex: 0 }); for (let i = 0; i < n; i++) out[i] = tmp[i * d.numberOfChannels] / 32768; }
    const src = actx.createBufferSource();
    src.buffer = ab;
    src.connect(peer.input);
    const now = actx.currentTime;
    // a gap (they stopped talking, or packets were lost) or a pile-up: start again a jitter-buffer ahead
    if (peer.playAt < now + 0.01 || peer.playAt > now + 0.4) peer.playAt = now + JITTER;
    src.start(peer.playAt);
    peer.playAt += ab.duration;
    V.stats.decoded++;
  } finally { d.close(); }
}

// Called every frame. listener: {pos, fwd}; info(id) -> {head, occluded, ko, radio} | null
export function spatialize(listener, info) {
  if (!actx || !V.on) return;
  const L = actx.listener;
  const t = actx.currentTime;
  if (L.positionX) {
    L.positionX.value = listener.pos.x; L.positionY.value = listener.pos.y; L.positionZ.value = listener.pos.z;
    L.forwardX.value = listener.fwd.x; L.forwardY.value = listener.fwd.y; L.forwardZ.value = listener.fwd.z;
    L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
  } else {
    L.setPosition(listener.pos.x, listener.pos.y, listener.pos.z);
    L.setOrientation(listener.fwd.x, listener.fwd.y, listener.fwd.z, 0, 1, 0);
  }
  for (const peer of V.peers.values()) {
    const s = info(peer.id);
    if (!s) { peer.gSpatial.gain.setTargetAtTime(0, t, 0.1); peer.gRadio.gain.setTargetAtTime(0, t, 0.05); continue; }
    const p = peer.panner;
    if (p.positionX) { p.positionX.value = s.head.x; p.positionY.value = s.head.y; p.positionZ.value = s.head.z; }
    else p.setPosition(s.head.x, s.head.y, s.head.z);
    const d = Math.hypot(s.head.x - listener.pos.x, s.head.y - listener.pos.y, s.head.z - listener.pos.z);
    let g = voiceGain(d);   // full within 4 m, gone by 25 m (shared/constants.js VOICE; the host relays to 27 m)
    if (s.occluded) g *= 0.6;
    peer.gSpatial.gain.setTargetAtTime(g, t, 0.08);
    peer.lp.frequency.setTargetAtTime(s.ko ? 520 : s.occluded ? 950 : 18000, t, 0.1);
    peer.gRadio.gain.setTargetAtTime(s.radio ? 0.95 : 0, t, 0.04);
  }
}

function applyPeerVol(peer) {
  if (peer.gain) peer.gain.gain.value = peer.muted ? 0 : peer.vol;
}

function closePeer(id) {
  const peer = V.peers.get(id);
  if (!peer) return;
  try { peer.dec?.close(); } catch {}
  try { peer.gain.disconnect(); peer.input.disconnect(); } catch {}
  V.peers.delete(id);
  delete V.speaking[id];
  emitChange();
}

function nameOf(id) {
  return V._players.find(p => p.id === id)?.name || String(id);
}

// Keep a row (and a volume knob) for everyone in voice; drop the rest.
export function syncPeers(players) {
  if (players) V._players = players;
  if (!V.on) return;
  const want = new Set();
  for (const p of V._players) {
    if (p.id === V._selfId || p.connected === false || !p.voice) continue;
    want.add(p.id);
    if (!V.peers.has(p.id)) makePeer(p.id);
  }
  for (const id of [...V.peers.keys()]) if (!want.has(id)) closePeer(id);
}

// ---- speaking meter -------------------------------------------------------------------------

function rms(an, buf) {
  an.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
  return Math.sqrt(sum / buf.length);
}

function startMeter() {
  stopMeter();
  meterTimer = setInterval(() => {
    const s = {};
    if (mic && txAllowed() && rms(mic.an, mic.data) > SPEAK_RMS) s[V._selfId] = true;
    for (const peer of V.peers.values()) {
      if (!peer.muted && rms(peer.analyser, peer.data) > SPEAK_RMS) s[peer.id] = true;
    }
    const changed = JSON.stringify(s) !== JSON.stringify(V.speaking);
    V.speaking = s;
    if (changed) emitChange();
  }, 120);
}

function stopMeter() {
  if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
}

// ---- knobs the UI turns ---------------------------------------------------------------------

export function setMode(mode) {
  setSetting('voiceMode', mode === 'ptt' ? 'ptt' : 'open');
  emitChange();
}

export function setPtt(held) {
  held = !!held;
  if (V.ptt === held) return;
  V.ptt = held;
  emitChange();
}

export function toggleMute() {
  V.muted = !V.muted;
  store('muted', V.muted);
  emitChange();
}

export function setMasterVol(v) { setSetting('voice', v); }

// how loud each friend is to me, and whether I've muted them: kept by their name (so it lasts from trip to
// trip), set whether or not they're in voice yet
export function peerPrefs(id) {
  const n = nameOf(id);
  return { vol: load('vol.' + n, 1), muted: load('mute.' + n, false) };
}
export function setPeerVol(id, v) {
  v = Math.max(0, Math.min(1.5, v));
  store('vol.' + nameOf(id), v);
  const peer = V.peers.get(id);
  if (peer) { peer.vol = v; applyPeerVol(peer); }
}
export function setPeerMute(id, muted) {
  store('mute.' + nameOf(id), !!muted);
  const peer = V.peers.get(id);
  if (peer) { peer.muted = !!muted; applyPeerVol(peer); }
  emitChange();
}
export function togglePeerMute(id) { setPeerMute(id, !peerPrefs(id).muted); }

// ---- boot ------------------------------------------------------------------------------------

export function initVoice(selfId, onChange) {
  V._selfId = selfId;
  V._onChange = onChange;
  net.onBinary(onFrame);
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);
}
