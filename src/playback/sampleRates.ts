/**
 * The engine renders at a fixed 44.1 kHz. Playback `AudioContext`s are created
 * at that same rate so scheduled buffers enter the graph without per-buffer
 * resampling: a buffer whose rate differs from its context is resampled by each
 * `AudioBufferSourceNode` independently, which restarts the interpolator at
 * every scheduled chunk boundary. Matching the rates leaves one continuous
 * conversion to the output device instead.
 */
export const ENGINE_SAMPLE_RATE = 44_100;

/**
 * Rate of the dry offline render that feeds the generated waveform packs. This
 * is deliberately independent of the playback rate; changing it changes every
 * committed waveform payload.
 */
export const OFFLINE_SAMPLE_RATE = 48_000;
