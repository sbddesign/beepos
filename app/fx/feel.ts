// What a keypress feels like: a short buzz where the phone allows it and a quiet
// mechanical tick. Both are optional; a silent, still press is fine.

let audio: AudioContext | null = null;

export function keyClick() {
  try {
    navigator.vibrate?.(10);
  } catch {
    // No haptics is fine.
  }
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const now = audio.currentTime;
    // A click is mostly noise: a few milliseconds of it through a band-pass,
    // with a low thump underneath for the cap bottoming out.
    const length = Math.floor(audio.sampleRate * 0.02);
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    const noise = audio.createBufferSource();
    noise.buffer = buffer;
    const band = audio.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2600;
    band.Q.value = 1.2;
    const noiseGain = audio.createGain();
    noiseGain.gain.value = 0.05;
    noise.connect(band).connect(noiseGain).connect(audio.destination);
    noise.start(now);

    const thump = audio.createOscillator();
    const thumpGain = audio.createGain();
    thump.frequency.setValueAtTime(140, now);
    thump.frequency.exponentialRampToValueAtTime(60, now + 0.04);
    thumpGain.gain.setValueAtTime(0.04, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    thump.connect(thumpGain).connect(audio.destination);
    thump.start(now);
    thump.stop(now + 0.06);
  } catch {
    // No sound is fine.
  }
}
