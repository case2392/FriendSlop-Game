// In-game voice chat: WebRTC peer-to-peer audio in a full mesh (fine at 8
// players), with the game's own WebSocket doing the signaling. No servers to
// run, no accounts — walk in, hit JOIN VOICE, yell at the boys.
//
// Browser rules worth knowing:
//  - getUserMedia only exists in a "secure context": https OR localhost.
//    Plain http://192.168.x.x:3000 gets no mic — we detect that and say so.
//  - Remote WebRTC audio must be attached to an <audio> element or Chrome
//    won't pump it into WebAudio (we want WebAudio for volume knobs and the
//    speaking meter), so every peer gets a hidden muted <audio> shim.

import * as net from './net.js';

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const SPEAK_RMS = 0.045; // analyser RMS above this = "speaking"

const store = (k, v) => localStorage.setItem('slopVoice.' + k, JSON.stringify(v));
const load = (k, d) => {
  try { const v = localStorage.getItem('slopVoice.' + k); return v == null ? d : JSON.parse(v); }
  catch { return d; }
};

export const V = {
  supported: !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection),
  secure: window.isSecureContext,
  on: false,                       // am I in voice?
  connecting: false,
  mode: load('mode', 'open'),      // 'open' | 'ptt'
  ptt: false,                      // push-to-talk key held right now
  muted: load('muted', false),     // self-mute toggle
  masterVol: load('masterVol', 1),
  micId: load('micId', ''),
  mics: [],                        // [{deviceId, label}]
  peers: new Map(),                // id -> peer
  speaking: {},                    // id -> true (includes self while transmitting)
  err: null,
  _selfId: null,
  _players: [],                    // last meta roster
  _onChange: null,                 // UI refresh hook
};

let actx = null;
let masterGain = null;
let localStream = null;
let localAnalyser = null;
let localData = null;
let meterTimer = null;

function emitChange() { V._onChange?.(); }

function ensureCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = actx.createGain();
    masterGain.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  masterGain.gain.value = V.masterVol;
}

// ---- transmit gating --------------------------------------------------------

function txAllowed() {
  return V.on && !V.muted && (V.mode === 'open' || V.ptt);
}

function applyTx() {
  const en = txAllowed();
  localStream?.getAudioTracks().forEach(t => { t.enabled = en; });
  emitChange();
}

// ---- mic --------------------------------------------------------------------

async function openMic() {
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(V.micId ? { deviceId: { ideal: V.micId } } : {}),
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const src = actx.createMediaStreamSource(stream);
  const an = actx.createAnalyser();
  an.fftSize = 512;
  src.connect(an); // analysis only — never wired to speakers (no self-echo)
  return { stream, an };
}

export async function refreshMics() {
  if (!V.supported) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    V.mics = devs.filter(d => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    emitChange();
  } catch { /* no permission yet — labels come after joining */ }
}

export async function setMic(deviceId) {
  V.micId = deviceId;
  store('micId', deviceId);
  if (!V.on) return;
  try {
    const { stream, an } = await openMic();
    const newTrack = stream.getAudioTracks()[0];
    for (const peer of V.peers.values()) {
      const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack);
    }
    localStream?.getTracks().forEach(t => t.stop());
    localStream = stream;
    localAnalyser = an;
    localData = new Uint8Array(an.frequencyBinCount);
    applyTx();
  } catch (e) {
    V.err = 'Could not switch mic: ' + e.message;
    emitChange();
  }
}

// ---- join / leave -----------------------------------------------------------

export async function joinVoice() {
  if (V.on || V.connecting) return;
  V.err = null;
  if (!V.supported || !V.secure) {
    V.err = V.secure
      ? 'This browser has no microphone support.'
      : 'Voice needs HTTPS (or localhost). Host through a tunnel like Tailscale/cloudflared, or use the desktop build.';
    emitChange();
    return;
  }
  V.connecting = true;
  emitChange();
  try {
    ensureCtx();
    const { stream, an } = await openMic();
    localStream = stream;
    localAnalyser = an;
    localData = new Uint8Array(an.frequencyBinCount);
    V.on = true;
    net.send({ t: 'voice', on: true });
    applyTx();
    refreshMics();
    startMeter();
    syncPeers(); // dial anyone already in voice
  } catch (e) {
    V.err = e.name === 'NotAllowedError'
      ? 'Mic permission denied — allow it in the browser bar and try again.'
      : 'Mic error: ' + e.message;
  }
  V.connecting = false;
  emitChange();
}

export function leaveVoice() {
  if (!V.on) return;
  V.on = false;
  net.send({ t: 'voice', on: false });
  for (const id of [...V.peers.keys()]) closePeer(id);
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  localAnalyser = null;
  V.speaking = {};
  stopMeter();
  emitChange();
}

// ---- peers --------------------------------------------------------------------

function makePeer(id) {
  const peer = {
    id,
    pc: new RTCPeerConnection(ICE),
    audioEl: null,        // hidden muted <audio> (Chrome WebAudio shim)
    gain: null,
    analyser: null,
    data: null,
    candQ: [],
    vol: load('vol.' + nameOf(id), 1),
    muted: false,
    polite: V._selfId > id, // higher id yields on offer collisions
    makingOffer: false,
  };
  V.peers.set(id, peer);

  localStream?.getTracks().forEach(t => peer.pc.addTrack(t, localStream));

  peer.pc.onicecandidate = e => {
    if (e.candidate) net.send({ t: 'rtc', to: id, data: { cand: e.candidate } });
  };
  peer.pc.ontrack = e => attachRemote(peer, e.streams[0]);
  peer.pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      net.send({ t: 'rtc', to: id, data: { sdp: peer.pc.localDescription } });
    } catch { /* peer likely vanished */ }
    finally { peer.makingOffer = false; }
  };
  peer.pc.onconnectionstatechange = () => {
    if (peer.pc.connectionState === 'failed') {
      closePeer(id);
      syncPeers(); // the lower id will re-dial
    }
    emitChange();
  };
  return peer;
}

function attachRemote(peer, stream) {
  ensureCtx();
  if (!peer.audioEl) {
    peer.audioEl = new Audio();
    peer.audioEl.muted = true; // real output goes through WebAudio
  }
  peer.audioEl.srcObject = stream;
  peer.audioEl.play().catch(() => {});
  const src = actx.createMediaStreamSource(stream);
  peer.gain = actx.createGain();
  peer.analyser = actx.createAnalyser();
  peer.analyser.fftSize = 512;
  peer.data = new Uint8Array(peer.analyser.frequencyBinCount);
  src.connect(peer.analyser);
  peer.analyser.connect(peer.gain);
  peer.gain.connect(masterGain);
  applyPeerVol(peer);
  emitChange();
}

function applyPeerVol(peer) {
  if (peer.gain) peer.gain.gain.value = peer.muted ? 0 : peer.vol;
}

function closePeer(id) {
  const peer = V.peers.get(id);
  if (!peer) return;
  try { peer.pc.close(); } catch { }
  if (peer.audioEl) { peer.audioEl.srcObject = null; }
  V.peers.delete(id);
  delete V.speaking[id];
  emitChange();
}

function nameOf(id) {
  return V._players.find(p => p.id === id)?.name || String(id);
}

// Reconcile the mesh with the roster: dial voice-on players (lower id dials
// higher to avoid both sides offering at once), hang up on everyone else.
export function syncPeers(players) {
  if (players) V._players = players;
  if (!V.on) return;
  const want = new Set();
  for (const p of V._players) {
    if (p.id === V._selfId || p.isBot || !p.connected || !p.voice) continue;
    want.add(p.id);
    if (!V.peers.has(p.id) && V._selfId < p.id) makePeer(p.id); // onnegotiationneeded fires the offer
  }
  for (const id of [...V.peers.keys()]) if (!want.has(id)) closePeer(id);
}

// ---- signaling ----------------------------------------------------------------

async function onRtc(m) {
  if (!V.on || m.from === V._selfId) return;
  const data = m.data || {};
  let peer = V.peers.get(m.from);
  if (!peer && data.sdp?.type === 'offer') peer = makePeer(m.from);
  if (!peer) return;

  try {
    if (data.sdp) {
      const collision = data.sdp.type === 'offer'
        && (peer.makingOffer || peer.pc.signalingState !== 'stable');
      if (collision && !peer.polite) return; // impolite side ignores; polite rolls back
      await peer.pc.setRemoteDescription(data.sdp);
      for (const c of peer.candQ.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await peer.pc.setLocalDescription();
        net.send({ t: 'rtc', to: m.from, data: { sdp: peer.pc.localDescription } });
      }
    } else if (data.cand) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.cand).catch(() => {});
      else peer.candQ.push(data.cand);
    }
  } catch (e) {
    console.warn('rtc signal error', e.message);
  }
}

// ---- speaking meter -------------------------------------------------------------

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
    if (localAnalyser && txAllowed() && rms(localAnalyser, localData) > SPEAK_RMS) s[V._selfId] = true;
    for (const peer of V.peers.values()) {
      if (peer.analyser && !peer.muted && rms(peer.analyser, peer.data) > SPEAK_RMS) s[peer.id] = true;
    }
    const changed = JSON.stringify(s) !== JSON.stringify(V.speaking);
    V.speaking = s;
    if (changed) emitChange();
  }, 120);
}

function stopMeter() {
  if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
}

// ---- knobs the UI turns ----------------------------------------------------------

export function setMode(mode) {
  V.mode = mode === 'ptt' ? 'ptt' : 'open';
  store('mode', V.mode);
  applyTx();
}

export function setPtt(held) {
  if (V.ptt === held) return;
  V.ptt = held;
  applyTx();
}

export function toggleMute() {
  V.muted = !V.muted;
  store('muted', V.muted);
  applyTx();
}

export function setMasterVol(v) {
  V.masterVol = Math.max(0, Math.min(1, v));
  store('masterVol', V.masterVol);
  if (masterGain) masterGain.gain.value = V.masterVol;
}

export function setPeerVol(id, v) {
  const peer = V.peers.get(id);
  if (!peer) return;
  peer.vol = Math.max(0, Math.min(1.5, v));
  store('vol.' + nameOf(id), peer.vol);
  applyPeerVol(peer);
}

export function togglePeerMute(id) {
  const peer = V.peers.get(id);
  if (!peer) return;
  peer.muted = !peer.muted;
  applyPeerVol(peer);
  emitChange();
}

// ---- boot ------------------------------------------------------------------------

export function initVoice(selfId, onChange) {
  V._selfId = selfId;
  V._onChange = onChange;
  net.on('rtc', onRtc);
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);
}
