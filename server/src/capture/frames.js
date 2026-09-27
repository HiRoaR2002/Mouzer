'use strict';

const SOI = 0xffd8;
const EOI = 0xffd9;
const MAX_FRAME = 32 * 1024 * 1024;

/**
 * Reassembles individual JPEGs out of a byte stream.
 *
 * Two framings are supported because the backends disagree on what they can
 * produce: the built-in worker writes an explicit 4-byte big-endian length
 * prefix per frame, while ffmpeg emits a raw MJPEG elementary stream that has to
 * be split on JPEG start/end markers.
 */
class FrameReader {
  constructor(mode = 'length') {
    this.mode = mode;
    this.buffer = Buffer.alloc(0);
    this.dropped = 0;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    return this.mode === 'length' ? this._drainLengthPrefixed() : this._drainMarkers();
  }

  _drainLengthPrefixed() {
    const frames = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const len = this.buffer.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME) {
        // A bad length means the stream is desynchronised; there is no way to
        // resync a length-prefixed stream, so drop what we have and re-prime.
        this.dropped++;
        this.reset();
        break;
      }
      if (this.buffer.length < 4 + len) break;
      frames.push(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
    }
    return frames;
  }

  _drainMarkers() {
    const frames = [];
    for (;;) {
      const start = this.buffer.indexOf(SOI, 0, 'be16');
      if (start === -1) {
        if (this.buffer.length > 2) this.buffer = this.buffer.subarray(this.buffer.length - 1);
        break;
      }
      const end = this.buffer.indexOf(EOI, start + 2, 'be16');
      if (end === -1) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        break;
      }
      const frame = this.buffer.subarray(start, end + 2);
      if (frame.length > 16) frames.push(frame);
      this.buffer = this.buffer.subarray(end + 2);
    }
    return frames;
  }
}

module.exports = { FrameReader, MAX_FRAME };
