import type { ChannelId, ChannelOrder } from './contracts.ts';

export const CHANNELS: readonly ChannelId[] = ['A', 'B', 'C'];

/** Per-channel headroom so three summed channels cannot leave the mix clipped. */
export const MIX_HEADROOM = 0.5;
export const CENTER_GAIN = Math.SQRT1_2;
export const MIX_TRANSITION_SECONDS = 0.02;

export function mixTransitionEnd(context: AudioContext): number {
  return context.currentTime + MIX_TRANSITION_SECONDS;
}

export function rampGain(
  gain: AudioParam,
  value: number,
  context: AudioContext,
  transitionEnd = mixTransitionEnd(context),
): void {
  gain.cancelScheduledValues(context.currentTime);
  gain.setValueAtTime(gain.value, context.currentTime);
  gain.linearRampToValueAtTime(value, transitionEnd);
}

type ChannelGains = {
  readonly left: GainNode;
  readonly right: GainNode;
};

export type OutputRouting = {
  readonly input: GainNode;
  setChannelOrder(channelOrder: ChannelOrder): void;
  setNormalization(gain: number): void;
  dispose(): void;
};

export function buildOutputRouting(
  context: AudioContext,
  destination: AudioNode,
): OutputRouting {
  const input = context.createGain();
  input.channelCount = CHANNELS.length;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'discrete';

  const splitter = context.createChannelSplitter(CHANNELS.length);
  const merger = context.createChannelMerger(2);
  const normalization = context.createGain();
  const channelGains: ChannelGains[] = [];

  input.connect(splitter);
  merger.connect(normalization);
  normalization.connect(destination);

  for (let channel = 0; channel < CHANNELS.length; channel += 1) {
    const left = context.createGain();
    const right = context.createGain();
    // Silent until the first `setChannelOrder`, so no channel can leak into the
    // wrong ear at unity while that call ramps the routing into place.
    left.gain.value = 0;
    right.gain.value = 0;
    splitter.connect(left, channel);
    splitter.connect(right, channel);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    channelGains.push({ left, right });
  }

  return {
    input,
    setChannelOrder(channelOrder): void {
      const endTime = mixTransitionEnd(context);
      for (const [channel, channelId] of CHANNELS.entries()) {
        const position = channelOrder.indexOf(channelId);
        const gains = channelGains[channel];
        if (gains === undefined) {
          throw new Error(`Missing output routing for channel ${channelId}.`);
        }
        const left =
          position === 0
            ? MIX_HEADROOM
            : position === 1
              ? MIX_HEADROOM * CENTER_GAIN
              : 0;
        const right =
          position === 2
            ? MIX_HEADROOM
            : position === 1
              ? MIX_HEADROOM * CENTER_GAIN
              : 0;
        rampGain(gains.left.gain, left, context, endTime);
        rampGain(gains.right.gain, right, context, endTime);
      }
    },
    setNormalization(gain): void {
      rampGain(normalization.gain, gain, context);
    },
    dispose(): void {
      input.disconnect();
      splitter.disconnect();
      for (const channel of channelGains) {
        channel.left.disconnect();
        channel.right.disconnect();
      }
      merger.disconnect();
      normalization.disconnect();
    },
  };
}
