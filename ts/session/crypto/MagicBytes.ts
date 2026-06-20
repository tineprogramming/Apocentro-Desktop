// Apocentro protocol layer — closed ecosystem isolation
//
// Every message is wrapped with MAGIC_BYTES *after* Session's standard
// encryption (i.e. around the libsession envelope payload that is stored on the
// snode) and *before* base64-encoding for network transmission.
//
//   On send:    prepend MAGIC_BYTES to the encrypted envelope payload.
//   On receive: verify the prefix before decoding; reject silently if absent.
//
// Format: [0x41, 0x50, 0x43, 0x01, ...envelope bytes]
//          "A"   "P"   "C"   v1
//
// Cross-client behaviour:
//   Apocentro -> Apocentro  delivered (prefix present, stripped on receive)
//   Session   -> Apocentro  no prefix      -> silently dropped
//   Apocentro -> Session    prefix corrupts the payload -> Session discards
//
// This must match the web (src/shared/api/magic-bytes.ts) and Android
// (com.apocentro.protocol.MagicBytes) clients byte-for-byte. All three wrap the
// same layer: the output of libsession's encodeFor1o1 / encodeForGroup.

export const MAGIC_BYTES = new Uint8Array([0x41, 0x50, 0x43, 0x01]);

/** Prepend the Apocentro magic bytes to an already-encrypted envelope payload. */
export function wrapWithMagicBytes(data: Uint8Array): Uint8Array {
  const wrapped = new Uint8Array(MAGIC_BYTES.length + data.length);
  wrapped.set(MAGIC_BYTES, 0);
  wrapped.set(data, MAGIC_BYTES.length);
  return wrapped;
}

/** True if the payload begins with the Apocentro magic bytes. */
export function hasMagicBytes(data: Uint8Array): boolean {
  if (data.length < MAGIC_BYTES.length) {
    return false;
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (data[i] !== MAGIC_BYTES[i]) {
      return false;
    }
  }
  return true;
}

/** Remove the leading Apocentro magic bytes, returning the inner payload. */
export function stripMagicBytes(data: Uint8Array): Uint8Array {
  return data.subarray(MAGIC_BYTES.length);
}

/**
 * Lenient strip: remove the prefix when present, otherwise return the payload
 * unchanged. Used on the config-receive path so iOS/Android-wrapped configs are
 * unwrapped while un-prefixed (e.g. legacy / other-origin) configs still merge.
 * Mirrors iOS's lenient `unwrapMagicBytes`.
 */
export function stripMagicBytesIfPresent(data: Uint8Array): Uint8Array {
  return hasMagicBytes(data) ? stripMagicBytes(data) : data;
}
