let wasm;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

let cachedFloat32ArrayMemory0 = null;

function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}
/**
 * Set panic hook for better error messages in the browser console.
 */
export function init_panic_hook() {
    wasm.init_panic_hook();
}

const Ym2149PlayerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ym2149player_free(ptr >>> 0, 1));
/**
 * Main YM2149 player for WebAssembly.
 *
 * This player handles YM/AKS/AY file playback in the browser, generating audio samples
 * that can be fed into the Web Audio API.
 */
export class Ym2149Player {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Ym2149Player.prototype);
        obj.__wbg_ptr = ptr;
        Ym2149PlayerFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Ym2149PlayerFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ym2149player_free(ptr, 0);
    }
    /**
     * Active chip model (`"ym2149"` or `"ay8912"`).
     * @returns {string}
     */
    chipModel() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ym2149player_chipModel(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get current playback state.
     * @returns {boolean}
     */
    is_playing() {
        const ret = wasm.ym2149player_is_playing(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get the number of times the song has looped.
     * @returns {number}
     */
    loop_count() {
        const ret = wasm.ym2149player_loop_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Set volume (0.0 to 1.0). Applied to generated samples.
     * @param {number} volume
     */
    set_volume(volume) {
        wasm.ym2149player_set_volume(this.__wbg_ptr, volume);
    }
    /**
     * Get total frame count.
     * @returns {number}
     */
    frame_count() {
        const ret = wasm.ym2149player_frame_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Set the current subsong (1-based index). Returns true on success.
     * @param {number} index
     * @returns {boolean}
     */
    setSubsong(index) {
        const ret = wasm.ym2149player_setSubsong(this.__wbg_ptr, index);
        return ret !== 0;
    }
    /**
     * Get the number of audio channels.
     *
     * Returns 3 for standard single-chip songs, 6 for dual-chip (some Arkos songs), etc.
     * @returns {number}
     */
    channelCount() {
        const ret = wasm.ym2149player_channelCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the current register values (for visualization).
     * @returns {Uint8Array}
     */
    get_registers() {
        const ret = wasm.ym2149player_get_registers(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Seek to a specific frame (silently ignored for Arkos/AY backends).
     * @param {number} frame
     */
    seek_to_frame(frame) {
        wasm.ym2149player_seek_to_frame(this.__wbg_ptr, frame);
    }
    /**
     * Get the number of subsongs (1 for most formats, >1 for multi-song SNDH files).
     * @returns {number}
     */
    subsongCount() {
        const ret = wasm.ym2149player_subsongCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get current frame position.
     * @returns {number}
     */
    frame_position() {
        const ret = wasm.ym2149player_frame_position(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the current subsong index (1-based).
     * @returns {number}
     */
    currentSubsong() {
        const ret = wasm.ym2149player_currentSubsong(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get duration in seconds.
     *
     * For SNDH < 2.2 without FRMS/TIME, returns 300 (5 minute fallback).
     * @returns {number}
     */
    duration_seconds() {
        const ret = wasm.ym2149player_duration_seconds(this.__wbg_ptr);
        return ret;
    }
    /**
     * Generate audio samples.
     *
     * Returns a Float32Array containing mono samples.
     * The number of samples generated depends on the sample rate and frame rate.
     *
     * For 44.1kHz at 50Hz frame rate: 882 samples per frame.
     * @param {number} count
     * @returns {Float32Array}
     */
    generateSamples(count) {
        const ret = wasm.ym2149player_generateSamples(this.__wbg_ptr, count);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Check if a channel is muted.
     * @param {number} channel
     * @returns {boolean}
     */
    isChannelMuted(channel) {
        const ret = wasm.ym2149player_isChannelMuted(this.__wbg_ptr, channel);
        return ret !== 0;
    }
    /**
     * Create a player with browser output and chip-model options.
     *
     * JavaScript options use `{ sampleRate, chipModel, strictZxYm6 }`.
     * Create the `AudioContext` first and pass its actual `sampleRate`.
     * @param {Uint8Array} data
     * @param {any} options
     * @returns {Ym2149Player}
     */
    static newWithOptions(data, options) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ym2149player_newWithOptions(ptr0, len0, options);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Ym2149Player.__wrap(ret[0]);
    }
    /**
     * Mute or unmute a channel (0-2 for YM2149, 3-4 for STE DAC L/R).
     * @param {number} channel
     * @param {boolean} mute
     */
    setChannelMute(channel, mute) {
        wasm.ym2149player_setChannelMute(this.__wbg_ptr, channel, mute);
    }
    /**
     * Enable or disable the ST color filter.
     * @param {boolean} enabled
     */
    set_color_filter(enabled) {
        wasm.ym2149player_set_color_filter(this.__wbg_ptr, enabled);
    }
    /**
     * Get LMC1992 state for visualization (SNDH only).
     *
     * Returns a JsValue containing an object with LMC1992 state:
     * ```json
     * {
     *   "masterVolume": 0,      // dB (-80 to 0)
     *   "leftVolume": 0,        // dB (-40 to 0)
     *   "rightVolume": 0,       // dB (-40 to 0)
     *   "bass": 0,              // dB (-12 to +12)
     *   "treble": 0             // dB (-12 to +12)
     * }
     * ```
     *
     * Returns null for non-SNDH formats.
     * @returns {any}
     */
    getLmc1992State() {
        const ret = wasm.ym2149player_getLmc1992State(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if the duration is from actual metadata or estimated.
     *
     * Returns false for older SNDH files using the 5-minute fallback.
     * @returns {boolean}
     */
    hasDurationInfo() {
        const ret = wasm.ym2149player_hasDurationInfo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get channel states for visualization (frequency, amplitude, note, effects).
     *
     * Returns a JsValue containing an object with channel data for all PSG chips:
     * ```json
     * {
     *   "channels": [
     *     { "frequency": 440.0, "note": "A4", "amplitude": 0.8, "toneEnabled": true, "noiseEnabled": false, "envelopeEnabled": false },
     *     ...
     *   ],
     *   "envelopes": [
     *     { "period": 256, "shape": 14, "shapeName": "/\\/\\" },
     *     ...
     *   ]
     * }
     * ```
     * @returns {any}
     */
    getChannelStates() {
        const ret = wasm.ym2149player_getChannelStates(this.__wbg_ptr);
        return ret;
    }
    /**
     * Output sample rate used by the synthesizer.
     * @returns {number}
     */
    outputSampleRate() {
        const ret = wasm.ym2149player_outputSampleRate(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Seek to a percentage of the song (0.0 to 1.0).
     *
     * Returns true if seek succeeded. Works for all SNDH files (uses fallback duration for older files).
     * @param {number} percentage
     * @returns {boolean}
     */
    seek_to_percentage(percentage) {
        const ret = wasm.ym2149player_seek_to_percentage(this.__wbg_ptr, percentage);
        return ret !== 0;
    }
    /**
     * Get current per-channel audio outputs for oscilloscope visualization.
     *
     * Returns a flat array of channel outputs: [A0, B0, C0, A1, B1, C1, ...]
     * where each group of 3 represents one PSG chip.
     *
     * These are the actual audio output values (updated at sample rate),
     * not register values. Perfect for real-time oscilloscope display.
     * @returns {Float32Array}
     */
    getChannelOutputs() {
        const ret = wasm.ym2149player_getChannelOutputs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get playback position as percentage (0.0 to 1.0).
     * @returns {number}
     */
    position_percentage() {
        const ret = wasm.ym2149player_position_percentage(this.__wbg_ptr);
        return ret;
    }
    /**
     * Generate samples into a pre-allocated buffer (zero-allocation).
     *
     * This is more efficient than `generate_samples` as it reuses the same buffer.
     * @param {Float32Array} buffer
     */
    generateSamplesInto(buffer) {
        var ptr0 = passArrayF32ToWasm0(buffer, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.ym2149player_generateSamplesInto(this.__wbg_ptr, ptr0, len0, buffer);
    }
    /**
     * Generate stereo audio samples (interleaved L/R).
     *
     * Returns frame_count * 2 samples. SNDH uses native stereo output,
     * other formats duplicate mono to stereo.
     * @param {number} frame_count
     * @returns {Float32Array}
     */
    generateSamplesStereo(frame_count) {
        const ret = wasm.ym2149player_generateSamplesStereo(this.__wbg_ptr, frame_count);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Generate stereo samples into a pre-allocated buffer (zero-allocation).
     *
     * Buffer length must be even (frame_count * 2). Interleaved L/R format.
     * SNDH uses native stereo output, other formats duplicate mono to stereo.
     * @param {Float32Array} buffer
     */
    generateSamplesIntoStereo(buffer) {
        var ptr0 = passArrayF32ToWasm0(buffer, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.ym2149player_generateSamplesIntoStereo(this.__wbg_ptr, ptr0, len0, buffer);
    }
    /**
     * Generate audio samples with per-sample channel outputs for visualization.
     *
     * Returns a JavaScript object containing:
     * - `mono`: Float32Array of mono samples
     * - `channels`: Float32Array of per-sample channel outputs
     *
     * The channels array is organized as [A0, B0, C0, A0, B0, C0, ...] for each sample,
     * where each group of 3 (or more for multi-chip) represents one sample's channel outputs.
     *
     * This enables accurate per-sample oscilloscope visualization at the full audio sample rate.
     * @param {number} count
     * @returns {any}
     */
    generateSamplesWithChannels(count) {
        const ret = wasm.ym2149player_generateSamplesWithChannels(this.__wbg_ptr, count);
        return ret;
    }
    /**
     * Create a new player from file data.
     *
     * Automatically detects the file format (YM, AKS, AY, or SNDH).
     *
     * # Arguments
     *
     * * `data` - File data as Uint8Array
     *
     * # Returns
     *
     * Result containing the player or an error message.
     * @param {Uint8Array} data
     */
    constructor(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ym2149player_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        Ym2149PlayerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Start playback.
     */
    play() {
        wasm.ym2149player_play(this.__wbg_ptr);
    }
    /**
     * Stop playback and reset to beginning.
     */
    stop() {
        wasm.ym2149player_stop(this.__wbg_ptr);
    }
    /**
     * Pause playback.
     */
    pause() {
        wasm.ym2149player_pause(this.__wbg_ptr);
    }
    /**
     * Get current playback state as string.
     * @returns {string}
     */
    state() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ym2149player_state(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get current volume (0.0 to 1.0).
     * @returns {number}
     */
    volume() {
        const ret = wasm.ym2149player_volume(this.__wbg_ptr);
        return ret;
    }
    /**
     * Restart playback from the beginning.
     */
    restart() {
        wasm.ym2149player_restart(this.__wbg_ptr);
    }
    /**
     * Get metadata about the loaded file.
     * @returns {YmMetadata}
     */
    get metadata() {
        const ret = wasm.ym2149player_metadata(this.__wbg_ptr);
        return YmMetadata.__wrap(ret);
    }
}
if (Symbol.dispose) Ym2149Player.prototype[Symbol.dispose] = Ym2149Player.prototype.free;

const YmMetadataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ymmetadata_free(ptr >>> 0, 1));
/**
 * YM file metadata exposed to JavaScript.
 */
export class YmMetadata {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(YmMetadata.prototype);
        obj.__wbg_ptr = ptr;
        YmMetadataFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YmMetadataFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ymmetadata_free(ptr, 0);
    }
    /**
     * Get frame rate in Hz.
     * @returns {number}
     */
    get frame_rate() {
        const ret = wasm.ymmetadata_frame_rate(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get frame count.
     * @returns {number}
     */
    get frame_count() {
        const ret = wasm.ymmetadata_frame_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get duration in seconds.
     * @returns {number}
     */
    get duration_seconds() {
        const ret = wasm.ymmetadata_duration_seconds(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the song title.
     * @returns {string}
     */
    get title() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ymmetadata_title(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the song author.
     * @returns {string}
     */
    get author() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ymmetadata_author(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the YM format version.
     * @returns {string}
     */
    get format() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ymmetadata_format(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the song comments.
     * @returns {string}
     */
    get comments() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ymmetadata_comments(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) YmMetadata.prototype[Symbol.dispose] = YmMetadata.prototype.free;

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_Error_e83987f665cf5504 = function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_Number_bb48ca12f395cd08 = function(arg0) {
        const ret = Number(arg0);
        return ret;
    };
    imports.wbg.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
        const ret = String(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_boolean_get_6d5a1ee65bab5f68 = function(arg0) {
        const v = arg0;
        const ret = typeof(v) === 'boolean' ? v : undefined;
        return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
    };
    imports.wbg.__wbg___wbindgen_copy_to_typed_array_33fbd71146904370 = function(arg0, arg1, arg2) {
        new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg___wbindgen_debug_string_df47ffb5e35e6763 = function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_in_bb933bd9e1b3bc0f = function(arg0, arg1) {
        const ret = arg0 in arg1;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_object_c818261d21f283a4 = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_2d472862bd29a478 = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_jsval_loose_eq_b664b38a2f582147 = function(arg0, arg1) {
        const ret = arg0 == arg1;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_number_get_a20bf9b85341449d = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'number' ? obj : undefined;
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbg___wbindgen_string_get_e4f06c90489ad01b = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_b855445ff6a94295 = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_get_with_ref_key_1dc361bd10053bfe = function(arg0, arg1) {
        const ret = arg0[arg1];
        return ret;
    };
    imports.wbg.__wbg_instanceof_ArrayBuffer_70beb1189ca63b38 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof ArrayBuffer;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Uint8Array_20c8e73002f7af98 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Uint8Array;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_isSafeInteger_d216eda7911dde36 = function(arg0) {
        const ret = Number.isSafeInteger(arg0);
        return ret;
    };
    imports.wbg.__wbg_length_69bca3cb64fc8748 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_log_8cec76766b8c0e33 = function(arg0) {
        console.log(arg0);
    };
    imports.wbg.__wbg_new_1acc0b6eea89d040 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_5a79be3ab53b8aa5 = function(arg0) {
        const ret = new Uint8Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_new_e17d9f43105b08be = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_from_slice_924249b74d07c449 = function(arg0, arg1) {
        const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_prototypesetcall_2a6620b6922694b2 = function(arg0, arg1, arg2) {
        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    };
    imports.wbg.__wbg_push_df81a39d04db858c = function(arg0, arg1) {
        const ret = arg0.push(arg1);
        return ret;
    };
    imports.wbg.__wbg_set_c2abbebe8b9ebee1 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(arg0, arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
        // Cast intrinsic for `F64 -> Externref`.
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('ym2149_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
