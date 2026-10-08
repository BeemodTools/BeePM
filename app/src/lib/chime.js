/**
 * A short, soft two-note chime, so the user notices BeePM asking something in a corner window
 * (UpdateToast). Made with Web Audio, so there's no sound file. Plays once per window, even when
 * React renders the window twice (StrictMode in development).
 */
let played = false

export function playChime() {
    if (played) return
    played = true
    try {
        const context = new AudioContext()
        const start = context.currentTime
        // A5, then E6 a moment later
        for (const [frequency, at] of [
            [880, 0],
            [1318.5, 0.11],
        ]) {
            const tone = context.createOscillator()
            const volume = context.createGain()
            tone.type = "sine"
            tone.frequency.value = frequency
            volume.gain.setValueAtTime(0, start + at)
            volume.gain.linearRampToValueAtTime(0.18, start + at + 0.01)
            volume.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.35)
            tone.connect(volume).connect(context.destination)
            tone.start(start + at)
            tone.stop(start + at + 0.4)
        }
        setTimeout(() => context.close().catch(() => {}), 1000)
    } catch {
        // No sound (no audio device): the window still shows
    }
}
