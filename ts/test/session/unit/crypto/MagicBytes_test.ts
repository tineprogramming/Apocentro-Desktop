import { expect } from 'chai';
import {
  MAGIC_BYTES,
  hasMagicBytes,
  stripMagicBytes,
  stripMagicBytesIfPresent,
  wrapWithMagicBytes,
} from '../../../../session/crypto/MagicBytes';

describe('MagicBytes', () => {
  const payload = new Uint8Array([0x64, 0x31, 0x3a, 0x78, 0x65]); // arbitrary "config-like" bytes

  describe('MAGIC_BYTES', () => {
    it('is the Apocentro "APC" + v1 marker, byte-for-byte', () => {
      // Must stay identical across web, android, desktop and iOS.
      expect(Array.from(MAGIC_BYTES)).to.deep.equal([0x41, 0x50, 0x43, 0x01]);
    });
  });

  describe('wrapWithMagicBytes / stripMagicBytes', () => {
    it('round-trips a payload', () => {
      const wrapped = wrapWithMagicBytes(payload);
      expect(wrapped.length).to.equal(MAGIC_BYTES.length + payload.length);
      expect(hasMagicBytes(wrapped)).to.equal(true);
      expect(Array.from(stripMagicBytes(wrapped))).to.deep.equal(Array.from(payload));
    });

    it('hasMagicBytes is false for an un-prefixed payload', () => {
      expect(hasMagicBytes(payload)).to.equal(false);
    });

    it('hasMagicBytes is false for data shorter than the prefix', () => {
      expect(hasMagicBytes(new Uint8Array([0x41, 0x50]))).to.equal(false);
    });
  });

  describe('stripMagicBytesIfPresent (lenient)', () => {
    it('strips the prefix when present', () => {
      const wrapped = wrapWithMagicBytes(payload);
      expect(Array.from(stripMagicBytesIfPresent(wrapped))).to.deep.equal(Array.from(payload));
    });

    it('passes un-prefixed data through unchanged', () => {
      expect(Array.from(stripMagicBytesIfPresent(payload))).to.deep.equal(Array.from(payload));
    });
  });
});
