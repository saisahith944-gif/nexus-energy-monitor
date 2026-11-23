(() => {
  "use strict";

  let context = null;
  let activeNodes = new Set();
  let finishTimer = null;
  let playing = false;

  function disconnectNodes() {
    activeNodes.forEach((node) => {
      try { node.stop(); } catch (_error) { /* Oscillator may already have stopped. */ }
      try { node.disconnect(); } catch (_error) { /* Node may already be disconnected. */ }
    });
    activeNodes.clear();
  }

  async function prepare() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not support Web Audio.");
    if (!context || context.state === "closed") context = new AudioContextClass();
    if (context.state !== "running") await context.resume();
    if (context.state !== "running") throw new Error("Browser audio is blocked. Click Enable Sound and allow audio playback.");
  }

  function stop() {
    clearTimeout(finishTimer);
    finishTimer = null;
    disconnectNodes();
    playing = false;
    if (context && context.state !== "closed") {
      const previous = context;
      context = null;
      previous.close().catch((error) => console.error("Could not close audio context:", error));
    }
  }

  function tone(frequency, startAt, duration, volume) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.025);
    gain.gain.setValueAtTime(volume, startAt + duration * 0.65);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      activeNodes.delete(oscillator);
      activeNodes.delete(gain);
    };
    activeNodes.add(oscillator);
    activeNodes.add(gain);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }

  async function play(kind = "test") {
    stop();
    await prepare();
    playing = true;
    const startAt = context.currentTime + 0.035;
    const alarm = kind === "alarm";
    const pulseCount = alarm ? 6 : 3;
    for (let index = 0; index < pulseCount; index += 1) {
      const offset = alarm ? index * 0.43 : index * 0.28;
      const firstFrequency = alarm ? (index % 2 ? 660 : 880) : (index % 2 ? 740 : 880);
      tone(firstFrequency, startAt + offset, alarm ? 0.27 : 0.16, alarm ? 0.2 : 0.14);
      if (alarm) tone(index % 2 ? 880 : 660, startAt + offset + 0.17, 0.18, 0.17);
    }
    const duration = alarm ? 2.72 : 0.78;
    finishTimer = setTimeout(stop, duration * 1000 + 150);
    return true;
  }

  window.NexusSound = Object.freeze({
    enable: prepare,
    test: () => play("test"),
    alarm: () => play("alarm"),
    stop,
    isPlaying: () => playing,
    isReady: () => Boolean(context && context.state === "running"),
  });
})();
