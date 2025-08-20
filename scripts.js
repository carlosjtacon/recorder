/* ===== WAV Recorder =====
   - Silence detection defaults (hidden UI):
       SILENCE_DURATION_MS = 800
       SILENCE_THRESHOLD = 0.007
   - Auto-download each finished segment >= 5s when Auto-record is active.
*/

/* ===== Globals & Audio Nodes ===== */
let audioCtx = null;
let stream = null;
let source = null;
let analyser = null;
let bassFilter = null, midFilter = null, trebleFilter = null;
let preGain = null;
let monitorGainNode = null;
let processor = null;
let nullGain = null;

let capturing = false;              // overall recording on/off
let currentSession = null;          // holds session metadata while recording
let lastWavBlobUrl = null;          // last created blob URL (unused UI-wise)
let timerId = null;
let startTs = 0;
let monitoring = false;

let currentSegmentChunks = [];      // chunks for the currently-building segment
let currentSegmentSamples = 0;      // samples in current segment (per channel)
let silenceAccumSec = 0;            // accumulated silence seconds
let sampleRateUsed = 44100;         // snapshot of audioContext sample rate
let bufferSizeUsed = 4096;          // snapshot of processor buffer size

/* ===== Silence detection defaults (hidden UI) ===== */
const SILENCE_DURATION_MS = 800;    // default split silence (ms)
const SILENCE_THRESHOLD = 0.007;    // increased RMS threshold (was 0.003)
const MIN_SEGMENT_SEC = 2.0;        // discard segments shorter than this (seconds)

/* ===== UI Elements ===== */
const deviceSel = document.getElementById('device');
const sampleRateSel = document.getElementById('sampleRate');
const channelsSel = document.getElementById('channels');
const recordBtn = document.getElementById('record');
const monitorBtn = document.getElementById('monitor');
const channelMetersEl = document.getElementById('channelMeters');
const timerEl = document.getElementById('timer');
const srEl = document.getElementById('sr');
const recStateEl = document.getElementById('rec-state');
const qualityIndicator = document.getElementById('qualityIndicator');
const formatInfo = document.getElementById('format-info');
const speakerIcon = document.getElementById('speakerIcon');
const volumeSlider = document.getElementById('volumeSlider');
const volumeDisplay = document.getElementById('volumeDisplay');

const bassEl = document.getElementById('bass'), midEl = document.getElementById('mid'), trebleEl = document.getElementById('treble'), gainEl = document.getElementById('gain');
const bassVal = document.getElementById('bass-val'), midVal = document.getElementById('mid-val'), trebleVal = document.getElementById('treble-val'), gainVal = document.getElementById('gain-val');

const presetLofi = document.getElementById('preset-lofi'), presetVoice = document.getElementById('preset-voice'), presetWarm = document.getElementById('preset-warm'), presetFlat = document.getElementById('preset-flat');

const sessionNameSmall = document.getElementById('sessionNameSmall');
const autoRecordSwitch = document.getElementById('autoRecordSwitch');

/* ===== Helpers ===== */
function tsFilename(prefix, ext){
  const t = new Date();
  const pad = (n)=>String(n).padStart(2,'0');
  return `${prefix}-${t.getFullYear()}${pad(t.getMonth()+1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.${ext}`;
}

function startTimer(){ 
  startTs = Date.now(); 
  timerId = setInterval(()=>{
    const s = Math.floor((Date.now()-startTs)/1000); 
    timerEl.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }, 500);
}

function stopTimer(){ 
  clearInterval(timerId); 
  timerEl.textContent="00:00"; 
}

function updateQualityIndicator(sampleRate, channels) {
  const indicator = qualityIndicator;
  const info = formatInfo;
  
  if (sampleRate >= 48000 && channels >= 2) {
    indicator.className = 'quality-indicator';
    info.textContent = `24-bit PCM WAV (${channels === 2 ? 'Stereo' : 'Mono'}) - Professional`;
  } else if (sampleRate >= 44100) {
    indicator.className = 'quality-indicator medium';
    info.textContent = `16-bit PCM WAV (${channels === 2 ? 'Stereo' : 'Mono'}) - CD Quality`;
  } else {
    indicator.className = 'quality-indicator poor';
    info.textContent = `16-bit PCM WAV (${channels === 2 ? 'Stereo' : 'Mono'}) - Voice Quality`;
  }
}

function createChannelMeters(channels) {
  channelMetersEl.innerHTML = '';
  
  for (let i = 0; i < channels; i++) {
    const meterDiv = document.createElement('div');
    meterDiv.className = 'channel-meter';
    
    const label = channels === 1 ? 'M' : (i === 0 ? 'L' : 'R');
    
    meterDiv.innerHTML = `
      <div class="channel-label">${label}</div>
      <div class="meter-track">
        <div class="meter-fill green" id="meter-${i}"></div>
      </div>
    `;
    
    channelMetersEl.appendChild(meterDiv);
  }
}

/* ===== WAV Encoding Utilities ===== */
function flattenFloat32Array(chunks, channels = 2) {
  // chunks: array of [Float32Array ch0, Float32Array ch1, ...] each chunk same length per channel
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk[0].length;
  }
  
  const result = [];
  for (let ch = 0; ch < channels; ch++) {
    result[ch] = new Float32Array(totalLength);
  }
  
  let offset = 0;
  for (const chunk of chunks) {
    const frameLength = chunk[0].length;
    for (let ch = 0; ch < channels; ch++) {
      const src = chunk[ch] || chunk[0];
      result[ch].set(src, offset);
    }
    offset += frameLength;
  }
  
  return result;
}

function encodeWAV(channelArrays, sampleRate) {
  const channels = channelArrays.length;
  const length = channelArrays[0].length;
  const buffer = new ArrayBuffer(44 + length * channels * 2);
  const view = new DataView(buffer);

  // WAV Header
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * channels * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length * channels * 2, true);

  // Interleave channels and convert to 16-bit PCM
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      let sample = Math.max(-1, Math.min(1, channelArrays[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([view], { type: 'audio/wav' });
}

/* ===== Device Management ===== */
async function populateDevices(){
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d=>d.kind==='audioinput');
    deviceSel.innerHTML = '';
    for(const d of inputs){
      const o = document.createElement('option'); 
      o.value = d.deviceId; 
      o.textContent = d.label || `Input ${deviceSel.options.length + 1}`; 
      deviceSel.appendChild(o);
    }
  } catch (e) {
    console.warn('Could not enumerate devices', e);
  }
}

/* ===== Audio Graph Setup ===== */
async function setupAudio(deviceId){
  stopStream();

  const desiredSampleRate = parseInt(sampleRateSel.value);
  const channels = parseInt(channelsSel.value);

  if(!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: desiredSampleRate
    });
  }

  // snapshot defaults (used for silence detection math)
  sampleRateUsed = audioCtx.sampleRate;
  bufferSizeUsed = 4096;

  const constraints = {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      sampleRate: { ideal: desiredSampleRate },
      channelCount: { ideal: channels },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: 0.01
    }
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    console.warn('High-quality constraints failed, using fallback:', error);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        sampleRate: desiredSampleRate,
        channelCount: channels
      }
    });
  }

  source = audioCtx.createMediaStreamSource(stream);

  // Create EQ chain
  bassFilter = audioCtx.createBiquadFilter();
  bassFilter.type = 'lowshelf';
  bassFilter.frequency.value = 200;

  midFilter = audioCtx.createBiquadFilter();
  midFilter.type = 'peaking';
  midFilter.frequency.value = 1000;
  midFilter.Q.value = 1.0;

  trebleFilter = audioCtx.createBiquadFilter();
  trebleFilter.type = 'highshelf';
  trebleFilter.frequency.value = 3000;

  preGain = audioCtx.createGain();
  preGain.gain.value = Number(gainEl.value);

  monitorGainNode = audioCtx.createGain();
  monitorGainNode.gain.value = Number(volumeSlider.value) / 100;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.2;

  processor = audioCtx.createScriptProcessor(bufferSizeUsed, channels, channels);

  nullGain = audioCtx.createGain();
  nullGain.gain.value = 0;

  // Connect the audio graph
  source.connect(bassFilter);
  bassFilter.connect(midFilter);
  midFilter.connect(trebleFilter);
  trebleFilter.connect(preGain);

  preGain.connect(analyser);
  preGain.connect(processor);
  preGain.connect(monitorGainNode);

  processor.connect(nullGain);
  nullGain.connect(audioCtx.destination);

  // Local snapshot
  sampleRateUsed = audioCtx.sampleRate;
  bufferSizeUsed = processor.bufferSize || bufferSizeUsed;

  // Recording / meter processor
  processor.onaudioprocess = (e) => {
    const channels = e.inputBuffer.numberOfChannels;
    const channelData = [];
    for (let ch = 0; ch < channels; ch++) {
      channelData.push(e.inputBuffer.getChannelData(ch));
    }

    // Update meters every frame
    updateChannelMeters(channelData);

    if (!capturing) {
      return;
    }

    // Copy the chunk into Float32Array so we can keep it after this callback
    const copied = [];
    for (let ch = 0; ch < channels; ch++) {
      const src = e.inputBuffer.getChannelData(ch);
      copied.push(new Float32Array(src));
    }

    // Push into current segment buffer
    currentSegmentChunks.push(copied);
    currentSegmentSamples += copied[0].length;

    // compute RMS for chunk across channels (average)
    let rms = 0;
    let total = 0;
    for (let ch = 0; ch < channelData.length; ch++) {
      const data = channelData[ch];
      let local = 0;
      for (let i = 0; i < data.length; i++) {
        const s = data[i];
        local += s * s;
      }
      local = Math.sqrt(local / data.length);
      rms += local;
      total++;
    }
    if (total > 0) rms = rms / total;

    // Silence detection logic (if Auto-record active)
    if (autoRecordSwitch && autoRecordSwitch.checked) {
      const bufferSec = copied[0].length / sampleRateUsed;
      const silenceThreshold = SILENCE_THRESHOLD;
      if (rms < silenceThreshold) {
        silenceAccumSec += bufferSec;
      } else {
        silenceAccumSec = 0;
      }

      const silenceDur = SILENCE_DURATION_MS / 1000;

      // Check if we have enough preceding silence to consider the song ended
      // Also require segment to be non-trivial (>= MIN_SEGMENT_SEC)
      const segmentDurationSec = currentSegmentSamples / sampleRateUsed;

      if (silenceAccumSec >= silenceDur && segmentDurationSec >= MIN_SEGMENT_SEC) {
        finalizeCurrentSegment(); // will auto-download or discard small ones and reset currentSegment*
        silenceAccumSec = 0;
      }
    }

    // Note: when Auto-record not active, segments are only finalized at stopRecording()
  };

  // Create channel meters
  createChannelMeters(channels);

  srEl.textContent = Math.round(audioCtx.sampleRate);
  updateQualityIndicator(audioCtx.sampleRate, channels);
  
  console.log(`Audio setup: ${audioCtx.sampleRate}Hz, ${channels} channels`);
}

function stopStream(){
  try{
    if(stream) stream.getTracks().forEach(t=>t.stop());
  }catch(e){}
  stream = null;
  
  if(processor) {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch(e){}
    processor = null;
  }
  
  [nullGain, monitorGainNode, preGain, trebleFilter, midFilter, bassFilter, source].forEach(node => {
    if(node) {
      try { node.disconnect(); } catch(e){}
    }
  });
}

/* ===== Channel Meters ===== */
function updateChannelMeters(channelData) {
  if (!channelData || channelData.length === 0) return;
  
  for (let ch = 0; ch < channelData.length; ch++) {
    const data = channelData[ch];
    if (!data || data.length === 0) continue;
    
    // Calculate RMS level for smoother, more accurate metering
    let rms = 0;
    for (let i = 0; i < data.length; i++) {
      const sample = data[i];
      rms += sample * sample;
    }
    rms = Math.sqrt(rms / data.length);
    
    // Apply moderate gain boost for better visibility
    const boostedLevel = Math.min(1.0, rms * 3.0);
    
    // Update meter fill (0-100% based on linear scale)
    const meterPercent = Math.max(0, Math.min(100, boostedLevel * 100));
    
    const meterEl = document.getElementById(`meter-${ch}`);
    
    if (meterEl) {
      meterEl.style.width = `${meterPercent}%`;
      
      // Color coding based on level
      meterEl.className = 'meter-fill';
      if (boostedLevel > 0.75) {
        meterEl.classList.add('red');
      } else if (boostedLevel > 0.4) {
        meterEl.classList.add('yellow');
      } else {
        meterEl.classList.add('green');
      }
    }
  }
}

/* ===== Segment Finalization (auto-download or discard) ===== */
function finalizeCurrentSegment(){
  if (!currentSession) return;
  if (!currentSegmentChunks || currentSegmentChunks.length === 0) return;

  const channels = parseInt(channelsSel.value);
  const channelArrays = flattenFloat32Array(currentSegmentChunks, channels);
  const wavBlob = encodeWAV(channelArrays, sampleRateUsed);

  const durationSec = currentSegmentSamples / sampleRateUsed;

  // reset current segment buffers immediately for next segment
  currentSegmentChunks = [];
  currentSegmentSamples = 0;

  // Only auto-download if segment duration is at least MIN_SEGMENT_SEC
  if (durationSec >= MIN_SEGMENT_SEC) {
    // build filename
    const safeSessionName = (currentSession.name || 'session').replace(/\s+/g,'_').replace(/[^\w\-]/g,'').slice(0,60) || 'session';
    currentSession.partCounter = (currentSession.partCounter || 0) + 1;
    const idx = currentSession.partCounter;
    const filename = `${safeSessionName}_part${String(idx).padStart(2,'0')}.wav`;

    const url = URL.createObjectURL(wavBlob);

    // remember last blob url for possible future use
    if(lastWavBlobUrl) try{ URL.revokeObjectURL(lastWavBlobUrl); }catch(e){}
    lastWavBlobUrl = url;

    // trigger download (user gesture not strictly required because recording was user-initiated)
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Revoke url after a short delay to allow download to start (avoid immediate revoke)
    setTimeout(()=> {
      try { URL.revokeObjectURL(url); } catch(e){}
    }, 60 * 1000); // revoke after 60s

    console.log(`Auto-downloaded ${filename} (${durationSec.toFixed(2)}s)`);
  } else {
    console.log(`Discarded short segment (${durationSec.toFixed(3)}s)`);
  }
}

/* ===== Recording Controls ===== */
function startRecording(){
  if(!audioCtx || !source || !processor) {
    console.warn('Audio not set up');
    return;
  }
  
  if(capturing) return;

  // create new session metadata (read name from small input)
  const name = (sessionNameSmall.value || '').trim();
  const createdAt = Date.now();
  currentSession = {
    name: name || `recording-${createdAt}`,
    createdAt,
    partCounter: 0
  };

  // clear any previous segment buffers
  currentSegmentChunks = [];
  currentSegmentSamples = 0;
  silenceAccumSec = 0;

  capturing = true;
  recStateEl.textContent = 'RECORDING';
  recStateEl.classList.add('recording');
  startTimer();

  console.log('Recording started, session:', currentSession.name);
}

async function stopRecording(){
  if(!capturing) return;

  capturing = false;
  recStateEl.textContent = 'PROCESSING';
  recStateEl.classList.remove('recording');
  stopTimer();

  // finalize any remaining current segment
  if (currentSegmentChunks && currentSegmentChunks.length > 0) {
    finalizeCurrentSegment();
  }

  // clear session metadata after stop
  currentSession = null;

  setTimeout(() => {
    recStateEl.textContent = 'READY';
  }, 800);

  console.log('Recording stopped; processed last segment(s).');
}

/* ===== Monitoring Control ===== */
function startMonitor(){
  if(!audioCtx || !monitorGainNode) return;
  try { 
    monitorGainNode.connect(audioCtx.destination); 
  } catch(e){ console.warn('Monitor connection failed:', e); }
  monitoring = true;
  monitorBtn.classList.add('active');
  monitorBtn.textContent = 'Disable Monitor';
  speakerIcon.classList.add('active');
}

function stopMonitor(){
  if(!audioCtx || !monitorGainNode) return;
  try { 
    monitorGainNode.disconnect(audioCtx.destination); 
  } catch(e){}
  monitoring = false;
  monitorBtn.classList.remove('active');
  monitorBtn.textContent = 'Enable Monitor';
  speakerIcon.classList.remove('active');
}

/* ===== Event Handlers / UI bindings ===== */
recordBtn.addEventListener('click', async ()=>{
  if(!audioCtx || audioCtx.state === 'closed' || !source){
    try {
      await setupAudio(deviceSel.value);
    } catch(e){ 
      console.error('Setup failed:', e); 
      alert('Failed to access microphone. Please check permissions.'); 
      return; 
    }
  }
  
  if(recordBtn.dataset.state === 'rec'){
    // stop
    recordBtn.dataset.state = '';
    recordBtn.className = 'btn btn-primary';
    recordBtn.innerHTML = '<span>⏺</span> Record';
    await stopRecording();
  } else {
    // start
    recordBtn.dataset.state = 'rec';
    recordBtn.className = 'btn btn-danger';
    recordBtn.innerHTML = '<span>⏹</span> Stop';
    startRecording();
  }
});

// The Auto-record control is now a checkbox switch (autoRecordSwitch).
// The processor checks autoRecordSwitch.checked when deciding to finalize segments.

monitorBtn.addEventListener('click', async ()=>{
  if(!audioCtx || audioCtx.state === 'closed' || !source){
    try { await setupAudio(deviceSel.value); } catch(e){ console.error(e); return; }
  }
  if(monitoring) stopMonitor();
  else startMonitor();
});

/* ===== Volume Control ===== */
volumeSlider.addEventListener('input', ()=>{
  const value = Number(volumeSlider.value);
  volumeDisplay.textContent = `${value}%`;
  if(monitorGainNode) monitorGainNode.gain.value = value / 100;
});

/* ===== EQ Controls ===== */
function updateUIVals(){
  bassVal.textContent = `${Number(bassEl.value).toFixed(1)} dB`;
  midVal.textContent = `${Number(midEl.value).toFixed(1)} dB`;
  trebleVal.textContent = `${Number(trebleEl.value).toFixed(1)} dB`;
  gainVal.textContent = `${Number(gainEl.value).toFixed(2)}x`;
}

bassEl.addEventListener('input', ()=>{ 
  if(bassFilter) bassFilter.gain.value = Number(bassEl.value); 
  updateUIVals(); 
});

midEl.addEventListener('input', ()=>{ 
  if(midFilter) midFilter.gain.value = Number(midEl.value); 
  updateUIVals(); 
});

trebleEl.addEventListener('input', ()=>{ 
  if(trebleFilter) trebleFilter.gain.value = Number(trebleEl.value); 
  updateUIVals(); 
});

gainEl.addEventListener('input', ()=>{ 
  if(preGain) preGain.gain.value = Number(gainEl.value); 
  updateUIVals(); 
});

/* ===== Settings Changes (restart audio) ===== */
async function restartAudio() {
  const wasRecording = capturing;
  const wasMonitoring = monitoring;
  
  if(wasRecording) { 
    await stopRecording(); 
    recordBtn.dataset.state=''; 
    recordBtn.className = 'btn btn-primary';
    recordBtn.innerHTML = '<span>⏺</span> Record';
  }
  if(wasMonitoring) stopMonitor();
  
  if(audioCtx && audioCtx.state !== 'closed'){ 
    try{ await audioCtx.close(); }catch(e){} 
  }
  audioCtx = null;
  
  try{ 
    await setupAudio(deviceSel.value); 
  } catch(e){ 
    console.error('Audio restart failed:', e); 
    return; 
  }
  
  // Reapply settings
  if(bassFilter) bassFilter.gain.value = Number(bassEl.value);
  if(midFilter) midFilter.gain.value = Number(midEl.value);
  if(trebleFilter) trebleFilter.gain.value = Number(trebleEl.value);
  if(preGain) preGain.gain.value = Number(gainEl.value);
  if(monitorGainNode) monitorGainNode.gain.value = Number(volumeSlider.value) / 100;
  
  if(wasMonitoring) startMonitor();
  if(wasRecording) { 
    startRecording(); 
    recordBtn.dataset.state='rec'; 
    recordBtn.className = 'btn btn-danger';
    recordBtn.innerHTML = '<span>⏹</span> Stop';
  }
}

sampleRateSel.addEventListener('change', async ()=>{
  updateQualityIndicator(parseInt(sampleRateSel.value), parseInt(channelsSel.value));
  if(audioCtx) await restartAudio();
});

channelsSel.addEventListener('change', async ()=>{
  updateQualityIndicator(parseInt(sampleRateSel.value), parseInt(channelsSel.value));
  if(audioCtx) await restartAudio();
});

deviceSel.addEventListener('change', async ()=>{
  await restartAudio();
});

/* ===== Presets ===== */
function applyPreset(name){
  if(name==='lofi'){ 
    bassEl.value = -6; 
    midEl.value = -6; 
    trebleEl.value = -8; 
    gainEl.value = 0.85; 
  } else if(name==='voice'){ 
    bassEl.value = -1.5; 
    midEl.value = 4.5; 
    trebleEl.value = 2.0; 
    gainEl.value = 1.05; 
  } else if(name==='warm'){ 
    bassEl.value = 3.5; 
    midEl.value = 1.5; 
    trebleEl.value = -2.0; 
    gainEl.value = 1.0; 
  } else { 
    bassEl.value = 0; 
    midEl.value = 0; 
    trebleEl.value = 0; 
    gainEl.value = 1; 
  }
  
  // Apply immediately
  if(bassFilter) bassFilter.gain.value = Number(bassEl.value);
  if(midFilter) midFilter.gain.value = Number(midEl.value);
  if(trebleFilter) trebleFilter.gain.value = Number(trebleEl.value);
  if(preGain) preGain.gain.value = Number(gainEl.value);
  updateUIVals();
}

presetLofi.addEventListener('click', ()=>applyPreset('lofi'));
presetVoice.addEventListener('click', ()=>applyPreset('voice'));
presetWarm.addEventListener('click', ()=>applyPreset('warm'));
presetFlat.addEventListener('click', ()=>applyPreset('flat'));

/* ===== Initialization ===== */
(async function boot(){
  try{
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
  }catch(e){
    console.warn('Microphone permission denied:', e);
  } finally {
    await populateDevices();
    if(deviceSel.options.length){
      try { 
        await setupAudio(deviceSel.value); 
      } catch(e){ 
        console.error('Initial setup failed:', e); 
      }
    }
    updateUIVals();
    updateQualityIndicator(parseInt(sampleRateSel.value), parseInt(channelsSel.value));
  }
})();