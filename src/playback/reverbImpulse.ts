const PRE_DELAY_SECONDS = 0.012;
// Reached by the end of the tail: exp(-6.5) is about -56 dB.
const DECAY_EXPONENT = 6.5;
// A real room loses its highs faster than its lows, so the one-pole that shapes
// the noise closes as the tail decays.
const DARKENING_START = 0.45;
const DARKENING_RANGE = 0.3;
// Fixed so the tail is bit-identical on every load and in every test run.
const NOISE_SEED = 0x2149;

/**
 * A short plate-like impulse response synthesized from decaying noise.
 *
 * Generated rather than shipped, so the reverb costs no bytes, no request and no
 * CSP allowance. The two channels draw from the same sequence at different
 * points, which decorrelates them and gives the tail its width.
 */
export function createReverbImpulse(
  context: BaseAudioContext,
  seconds: number,
): AudioBuffer {
  const length = Math.max(1, Math.round(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  const preDelay = Math.min(
    length - 1,
    Math.round(PRE_DELAY_SECONDS * context.sampleRate),
  );
  const span = Math.max(1, length - preDelay);

  let seed = NOISE_SEED;
  const noise = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return (seed / 0x1_0000_0000) * 2 - 1;
  };

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let filtered = 0;
    for (let index = preDelay; index < length; index += 1) {
      const progress = (index - preDelay) / span;
      const coefficient = DARKENING_START - DARKENING_RANGE * progress;
      filtered += coefficient * (noise() - filtered);
      data[index] = filtered * Math.exp(-DECAY_EXPONENT * progress);
    }
  }

  return buffer;
}
