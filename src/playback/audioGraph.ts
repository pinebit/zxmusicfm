import type { ChannelId, ChannelOrder } from './contracts.ts';
import { createReverbImpulse } from './reverbImpulse.ts';

export const CHANNELS: readonly ChannelId[] = ['A', 'B', 'C'];
export const OSCILLOSCOPE_FFT_SIZE = 1_024;

/** Per-channel headroom so three summed channels cannot leave the mix clipped. */
export const MIX_HEADROOM = 0.5;
const CENTER_GAIN = Math.SQRT1_2;
const MIX_TRANSITION_SECONDS = 0.008;

const SUBSONIC_HZ = 25; // high-pass: block DC / subsonic energy
const FILTER_Q = Math.SQRT1_2; // Butterworth (flat) response for HP/LP

// --- vanilla master chain -------------------------------------------------
const VANILLA_BASS_SHELF_HZ = 180;
const VANILLA_BASS_SHELF_DB = 4;
const VANILLA_LIMITER_THRESHOLD_DB = -1;
const VANILLA_SMOOTHING_HZ = 15_000;

// --- studio chain ---------------------------------------------------------
// Per channel, ahead of the analyser so the oscilloscope shows what is heard.
const CHANNEL_DC_BLOCK_HZ = 20;
// Not an anti-harshness filter: the band-limited renderer emits no aliasing for
// one to remove, so a low corner here only throws away real harmonics. Measured
// in octave bands against vanilla across three tracks, 14 kHz holds studio within
// about 2 dB of vanilla from 2 kHz to 20 kHz, where 9 kHz left it 3 to 7.6 dB
// darker and removing the filter entirely overshot by 4 to 7 dB.
const CHANNEL_SMOOTHING_HZ = 14_000;
// A WaveShaper curve is only defined over an input of +-1 and hard-clamps past
// it. Measured across the whole catalog, the hottest per-channel peak reaching
// the saturator after DC blocking and smoothing is 1.26, so the input is trimmed
// to keep even that inside the curve with margin, then restored afterwards.
// Raising CHANNEL_SMOOTHING_HZ raises that peak; re-measure before lowering this.
const SATURATION_INPUT_TRIM = 0.7;
const SATURATION_DRIVE = 1.6;
// A little asymmetry adds the even harmonics that read as warmth; tanh alone is
// odd-symmetric. The DC it introduces is removed by the master high-pass.
const SATURATION_ASYMMETRY = 0.18;
const SATURATION_CURVE_POINTS = 1_024;

// Not fully hard-panned: an equal-power pan at 0.8 leaves about 16% of each
// outer channel in the opposite ear, which is what stops A/B/C hard panning
// being fatiguing on headphones.
const STUDIO_PAN = 0.8;

const STUDIO_BASS_SHELF_HZ = 180;
// Matched to vanilla's shelf, as a deliberate tilt toward weight rather than a
// correction: at 2.5 dB studio was not short of bass at the output. Measured
// over the catalog through both complete chains, it sat within 0.4 dB of
// vanilla below 250 Hz, because the make-up exceeds the band-limited
// renderer's broadband deficit by about as much as the smaller shelf gave away.
// At 4 dB, with the make-up re-derived, studio moves from +0.4 to +1.2 dB
// against vanilla at 63 Hz and from -0.4 to +0.3 dB at 125 Hz, while 250 Hz up
// drops about 0.4 dB — a tilt of roughly 1.3 dB at constant loudness.
const STUDIO_BASS_SHELF_DB = 4;
// Square waves pile up energy where the ear is most sensitive.
const PRESENCE_DIP_HZ = 3_000;
const PRESENCE_DIP_Q = 0.9;
const PRESENCE_DIP_DB = -2.5;
const AIR_SHELF_HZ = 10_000;
const AIR_SHELF_DB = 1.5;

const REVERB_SECONDS = 1.2;
const REVERB_SEND = 0.14;
// Keeping bass out of the tail is what stops a reverb from muddying a mix.
const REVERB_HIGHPASS_HZ = 300;

const CHORUS_SEND = 0.16;
const CHORUS_DELAYS_SECONDS = [0.014, 0.019] as const;
const CHORUS_DEPTHS_SECONDS = [0.002, 0.0028] as const;
const CHORUS_RATES_HZ = [0.11, 0.17] as const;
const CHORUS_PAN = 0.7;

const STUDIO_LIMITER_THRESHOLD_DB = -1.5;

/**
 * The engine's aliasing is itself energy, so the same track measures louder
 * through the vanilla path than through the band-limited one.
 *
 * Derived by measuring K-weighted loudness at the output of both modes'
 * complete chains — every filter, both sends and the limiter — over the whole
 * catalog, since a dry-mix comparison misses vanilla's bass shelf and studio's
 * presence dip, and a pre-limiter one misses how much the limiter gives back.
 * At 6.6 dB studio lands 0.40 dB above vanilla on average, spanning -0.4 to
 * +1.4 dB per track. `imp-assorty6` and `ksa-action-epilogue` sit at the top
 * and `asc-antp` at the bottom.
 *
 * Sweep this value rather than solving for it: the limiter absorbs roughly 60%
 * of any change, so 0.1 dB off the make-up moves the output about 0.04 dB.
 *
 * It was 7 dB while the studio bass shelf was +2.5 dB, and 6.6 puts the mode-to-
 * mode difference back where 7 held it, so that shelf change reads as tone and
 * not as level.
 *
 * Applied before the limiter, never after, so the make-up cannot push the output
 * past full scale.
 */
const STUDIO_MAKEUP_DB = 6.6;

/**
 * One switchable presentation of the three chip channels. Both chains are fed
 * from their own scheduled buffers and both end at the shared volume node, so
 * switching modes is a gain ramp on `input` rather than a rewire.
 */
export type ModeChain = {
  /** Three-channel crossfade head. Scheduled buffer sources connect here. */
  readonly input: GainNode;
  readonly analysers: Readonly<Record<ChannelId, AnalyserNode>>;
  setChannelOrder(
    channelOrder: ChannelOrder,
    transitionEnd: number | undefined,
  ): void;
  /**
   * The build-time loudness match, as a linear gain. Sits ahead of the chain's
   * limiter so a track that needs lifting cannot clip the output.
   */
  setNormalization(gain: number): void;
};

function createLimiter(
  context: AudioContext,
  thresholdDb: number,
): DynamicsCompressorNode {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = thresholdDb;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  return limiter;
}

function createFilter(
  context: AudioContext,
  type: BiquadFilterType,
  frequency: number,
  options: { readonly q?: number; readonly gain?: number } = {},
): BiquadFilterNode {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  if (options.q !== undefined) filter.Q.value = options.q;
  if (options.gain !== undefined) filter.gain.value = options.gain;
  return filter;
}

/** A three-channel node that passes the chip channels through without mixing. */
function createDiscreteHead(context: AudioContext): GainNode {
  const head = context.createGain();
  head.channelCount = 3;
  head.channelCountMode = 'explicit';
  head.channelInterpretation = 'discrete';
  return head;
}

function createDiscreteSplitter(context: AudioContext): ChannelSplitterNode {
  const splitter = context.createChannelSplitter(3);
  splitter.channelCount = 3;
  splitter.channelCountMode = 'explicit';
  splitter.channelInterpretation = 'discrete';
  return splitter;
}

function createChannelAnalysers(
  context: AudioContext,
  splitter: ChannelSplitterNode,
): Record<ChannelId, AnalyserNode> {
  const analysers = {} as Record<ChannelId, AnalyserNode>;
  CHANNELS.forEach((channel, index) => {
    const analyser = context.createAnalyser();
    analyser.fftSize = OSCILLOSCOPE_FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    splitter.connect(analyser, index);
    analysers[channel] = analyser;
  });
  return analysers;
}

function rampGain(
  parameter: AudioParam,
  value: number,
  context: AudioContext,
  transitionEnd: number | undefined,
): void {
  if (transitionEnd === undefined) {
    parameter.value = value;
    return;
  }
  parameter.cancelScheduledValues(context.currentTime);
  parameter.setValueAtTime(parameter.value, context.currentTime);
  parameter.linearRampToValueAtTime(value, transitionEnd);
}

/**
 * The original presentation: hard A/B/C panning into a subsonic high-pass, bass
 * shelf, safety limiter and high-frequency smoothing filter. Preserved exactly,
 * including its gain structure, so vanilla remains what it has always been.
 */
export function buildVanillaChain(
  context: AudioContext,
  destination: AudioNode,
): ModeChain {
  const highpass = createFilter(context, 'highpass', SUBSONIC_HZ, {
    q: FILTER_Q,
  });
  const bass = createFilter(context, 'lowshelf', VANILLA_BASS_SHELF_HZ, {
    gain: VANILLA_BASS_SHELF_DB,
  });
  const normalization = context.createGain();
  const limiter = createLimiter(context, VANILLA_LIMITER_THRESHOLD_DB);
  const smoothing = createFilter(context, 'lowpass', VANILLA_SMOOTHING_HZ, {
    q: FILTER_Q,
  });
  highpass.connect(bass);
  bass.connect(normalization);
  normalization.connect(limiter);
  limiter.connect(smoothing);
  smoothing.connect(destination);

  const input = createDiscreteHead(context);
  const splitter = createDiscreteSplitter(context);
  input.connect(splitter);
  const analysers = createChannelAnalysers(context, splitter);

  const merger = context.createChannelMerger(2);
  merger.connect(highpass);
  const mixGains = {} as Record<ChannelId, readonly [GainNode, GainNode]>;
  for (const channel of CHANNELS) {
    const left = context.createGain();
    const right = context.createGain();
    analysers[channel].connect(left);
    analysers[channel].connect(right);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    mixGains[channel] = [left, right];
  }

  return {
    input,
    analysers,
    setChannelOrder: (channelOrder, transitionEnd) => {
      const [leftChannel, centerChannel, rightChannel] = channelOrder;
      for (const channel of CHANNELS) {
        const [left, right] = mixGains[channel];
        rampGain(
          left.gain,
          channel === leftChannel
            ? MIX_HEADROOM
            : channel === centerChannel
              ? CENTER_GAIN * MIX_HEADROOM
              : 0,
          context,
          transitionEnd,
        );
        rampGain(
          right.gain,
          channel === rightChannel
            ? MIX_HEADROOM
            : channel === centerChannel
              ? CENTER_GAIN * MIX_HEADROOM
              : 0,
          context,
          transitionEnd,
        );
      }
    },
    setNormalization: (gain) => {
      normalization.gain.value = gain;
    },
  };
}

function saturationCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(SATURATION_CURVE_POINTS);
  const normalize = Math.tanh(SATURATION_DRIVE);
  for (let index = 0; index < SATURATION_CURVE_POINTS; index += 1) {
    const x = (index * 2) / (SATURATION_CURVE_POINTS - 1) - 1;
    curve[index] =
      Math.tanh(SATURATION_DRIVE * x + SATURATION_ASYMMETRY * x * x) /
      normalize;
  }
  return curve;
}

/**
 * Undoes the input trim and the curve's slope at the origin, so quiet passages
 * pass through at unity and only peaks are compressed into the curve.
 */
function saturationMakeupGain(): number {
  const smallSignalSlope = SATURATION_DRIVE / Math.tanh(SATURATION_DRIVE);
  return 1 / (SATURATION_INPUT_TRIM * smallSignalSlope);
}

function buildChorus(context: AudioContext, destination: AudioNode): GainNode {
  const send = context.createGain();
  send.gain.value = CHORUS_SEND;
  const mix = context.createGain();
  mix.connect(destination);

  CHORUS_DELAYS_SECONDS.forEach((delaySeconds, index) => {
    const delay = context.createDelay(0.05);
    delay.delayTime.value = delaySeconds;
    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = CHORUS_RATES_HZ[index] ?? 0.1;
    const depth = context.createGain();
    depth.gain.value = CHORUS_DEPTHS_SECONDS[index] ?? 0.002;
    lfo.connect(depth);
    depth.connect(delay.delayTime);
    lfo.start();

    const panner = context.createStereoPanner();
    panner.pan.value = index === 0 ? -CHORUS_PAN : CHORUS_PAN;
    send.connect(delay);
    delay.connect(panner);
    panner.connect(mix);
  });

  return send;
}

/**
 * The produced presentation: per-channel DC blocking, smoothing and saturation
 * ahead of the analysers, equal-power panning with natural crossfeed, then a
 * tilt EQ, a synthesized plate reverb and a subtle detuned chorus.
 */
export function buildStudioChain(
  context: AudioContext,
  destination: AudioNode,
): ModeChain {
  const normalization = context.createGain();
  const limiter = createLimiter(context, STUDIO_LIMITER_THRESHOLD_DB);
  normalization.connect(limiter);
  limiter.connect(destination);

  const highpass = createFilter(context, 'highpass', SUBSONIC_HZ, {
    q: FILTER_Q,
  });
  const bass = createFilter(context, 'lowshelf', STUDIO_BASS_SHELF_HZ, {
    gain: STUDIO_BASS_SHELF_DB,
  });
  const presence = createFilter(context, 'peaking', PRESENCE_DIP_HZ, {
    q: PRESENCE_DIP_Q,
    gain: PRESENCE_DIP_DB,
  });
  const air = createFilter(context, 'highshelf', AIR_SHELF_HZ, {
    gain: AIR_SHELF_DB,
  });
  highpass.connect(bass);
  bass.connect(presence);
  presence.connect(air);
  air.connect(normalization);

  const reverbSend = context.createGain();
  reverbSend.gain.value = REVERB_SEND;
  const reverbHighpass = createFilter(context, 'highpass', REVERB_HIGHPASS_HZ, {
    q: FILTER_Q,
  });
  const convolver = context.createConvolver();
  convolver.buffer = createReverbImpulse(context, REVERB_SECONDS);
  air.connect(reverbSend);
  reverbSend.connect(reverbHighpass);
  reverbHighpass.connect(convolver);
  convolver.connect(normalization);

  air.connect(buildChorus(context, normalization));

  const input = createDiscreteHead(context);
  const splitter = createDiscreteSplitter(context);
  input.connect(splitter);

  const analysers = {} as Record<ChannelId, AnalyserNode>;
  const panners = {} as Record<ChannelId, StereoPannerNode>;
  const curve = saturationCurve();
  const makeup = saturationMakeupGain();
  // Applied after the saturator so the curve still sees calibrated levels.
  const makeupLinear = 10 ** (STUDIO_MAKEUP_DB / 20);
  CHANNELS.forEach((channel, index) => {
    const dcBlock = createFilter(context, 'highpass', CHANNEL_DC_BLOCK_HZ, {
      q: FILTER_Q,
    });
    const smoothing = createFilter(context, 'lowpass', CHANNEL_SMOOTHING_HZ, {
      q: FILTER_Q,
    });
    const drive = context.createGain();
    drive.gain.value = SATURATION_INPUT_TRIM;
    const shaper = context.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = '4x';
    const trim = context.createGain();
    trim.gain.value = makeup * MIX_HEADROOM * makeupLinear;
    const analyser = context.createAnalyser();
    analyser.fftSize = OSCILLOSCOPE_FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    const panner = context.createStereoPanner();

    splitter.connect(dcBlock, index);
    dcBlock.connect(smoothing);
    smoothing.connect(drive);
    drive.connect(shaper);
    shaper.connect(trim);
    trim.connect(analyser);
    analyser.connect(panner);
    panner.connect(highpass);

    analysers[channel] = analyser;
    panners[channel] = panner;
  });

  return {
    input,
    analysers,
    setChannelOrder: (channelOrder, transitionEnd) => {
      // `channelOrder` is always a permutation of A/B/C, so the remaining
      // channel is the centre one and stays at pan 0.
      const [leftChannel, , rightChannel] = channelOrder;
      for (const channel of CHANNELS) {
        const pan =
          channel === leftChannel
            ? -STUDIO_PAN
            : channel === rightChannel
              ? STUDIO_PAN
              : 0;
        rampGain(panners[channel].pan, pan, context, transitionEnd);
      }
    },
    setNormalization: (gain) => {
      normalization.gain.value = gain;
    },
  };
}

export function mixTransitionEnd(
  context: AudioContext,
  playing: boolean,
): number | undefined {
  return playing ? context.currentTime + MIX_TRANSITION_SECONDS : undefined;
}
