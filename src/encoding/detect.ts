import { TextDecoder } from 'node:util';
import chardet from 'chardet';
import { FsError } from '@deepseek-ai/dsh-fs';
import {
  decodeBytesRaw,
  detectEolStyle,
  encodeTextRaw,
  hasNonAsciiByte,
  hasUtf8Bom,
  normalizeEncodingName,
  normalizeEol,
  normalizeLineEndings,
  restoreEol,
} from './codecs.js';
import type { EolStyle, NonUtf8Encoding } from './codecs.js';
import { matchEncodingOverride } from './overrides.js';
import type { CompiledEncodingOverride } from './overrides.js';

const BINARY_SAMPLE_BYTES = 8192;
const CHARDET_SAMPLE_BYTES = 65536;
const CONFIDENCE_THRESHOLD = 45;
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

export type NonUtf8DetectionSource = 'callback' | 'override' | 'bom' | 'chardet' | 'explicit';

export interface NonUtf8Preference {
  readonly encoding: NonUtf8Encoding;
  readonly source: NonUtf8DetectionSource;
  readonly confident?: boolean;
}

export interface EncodingDetection {
  readonly encoding: NonUtf8Encoding;
  readonly hasBom: boolean;
  readonly confident: boolean;
  readonly source: NonUtf8DetectionSource;
}

export interface DecodedText {
  readonly text: string;
  readonly lfText: string;
  readonly eol: EolStyle;
  readonly encoding: NonUtf8Encoding;
  readonly hasBom: boolean;
  readonly confident: boolean;
  readonly source: NonUtf8DetectionSource;
}

/**
 * Checks whether a buffer looks like binary content due to NUL bytes or excessive
 * non-whitespace C0 control bytes across the entire buffer.
 */
export function hasBinaryControlBytes(raw: Buffer): boolean {
  if (raw.length === 0) {
    return false;
  }
  let ctrlCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    if (b === 0) {
      return true;
    }
    // Allow TAB (0x09), LF (0x0A), FF (0x0C), CR (0x0D), ESC (0x1B).
    if (
      (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) ||
      b === 0x7f
    ) {
      ctrlCount++;
    }
  }
  return ctrlCount > 0 && ctrlCount / raw.length > 0.02;
}

/**
 * Checks whether decoded text contains anomalous C0 control characters (used for
 * decoded UTF-16 where raw bytes legitimately contain 0x00).
 */
function hasDecodedControlNoise(text: string, allowReplacementChar = false): boolean {
  if (text.length === 0) {
    return false;
  }
  let ctrlCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0 || (!allowReplacementChar && code === 0xfffd)) {
      return true;
    }
    if (
      (code < 0x20 &&
        code !== 0x09 &&
        code !== 0x0a &&
        code !== 0x0c &&
        code !== 0x0d &&
        code !== 0x1b) ||
      code === 0x7f
    ) {
      ctrlCount++;
    }
  }
  return ctrlCount > 0 && ctrlCount / text.length > 0.02;
}

/**
 * Returns true if the buffer is clean UTF-8 (including UTF-8 BOM or pure ASCII),
 * matching official `LocalFileSystem` (`readWholeText`: no NUL in leading 8 KiB
 * sample and valid fatal UTF-8 decode).
 */
export function isValidUtf8Text(raw: Buffer): boolean {
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    return false;
  }
  try {
    utf8FatalDecoder.decode(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the buffer is a protected UTF-8 text file: either starts with
 * a UTF-8 BOM (`EF BB BF`) or contains non-ASCII bytes that decode cleanly as UTF-8.
 * Pure ASCII buffers without a UTF-8 BOM return false so configured/cached encodings
 * can apply when allowed.
 */
export function isProtectedUtf8Bytes(raw: Buffer): boolean {
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    return false;
  }
  if (hasUtf8Bom(raw)) {
    return true;
  }
  return hasNonAsciiByte(raw) && isValidUtf8Text(raw);
}

function hasC1ControlBytes(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80 && code <= 0x9f) {
      return true;
    }
  }
  return false;
}

function roundTripsCleanly(raw: Buffer, encoding: NonUtf8Encoding, hasBom: boolean): boolean {
  const isUtf16 = encoding === 'utf16le' || encoding === 'utf16be';
  if (isUtf16 && (hasBom ? raw.length - 2 : raw.length) % 2 !== 0) {
    return false;
  }
  const decoded = decodeBytesRaw(raw, encoding, hasBom);
  if (!isUtf16 && decoded.includes('\uFFFD')) {
    return false;
  }
  if (hasDecodedControlNoise(decoded, isUtf16)) {
    return false;
  }
  if (encoding === 'iso-8859-1' && hasC1ControlBytes(decoded)) {
    return false;
  }
  const reencoded = encodeTextRaw(decoded, encoding, hasBom);
  return reencoded.equals(raw);
}

function extractChardetSample(raw: Buffer): Buffer {
  if (raw.length <= CHARDET_SAMPLE_BYTES) {
    return raw;
  }
  let firstHigh = -1;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    if (b >= 0x80 || b === 0) {
      firstHigh = i;
      break;
    }
  }
  if (firstHigh <= 0) {
    return raw.subarray(0, CHARDET_SAMPLE_BYTES);
  }
  const start = Math.max(0, firstHigh - 256);
  return raw.subarray(start, Math.min(raw.length, start + CHARDET_SAMPLE_BYTES));
}

function isUtf32Bom(raw: Buffer): boolean {
  if (raw.length < 4) {
    return false;
  }
  return (
    (raw[0] === 0xff && raw[1] === 0xfe && raw[2] === 0x00 && raw[3] === 0x00) ||
    (raw[0] === 0x00 && raw[1] === 0x00 && raw[2] === 0xfe && raw[3] === 0xff)
  );
}

function detectBomlessAsciiUtf16(raw: Buffer): 'utf16le' | 'utf16be' | undefined {
  if (raw.length < 4 || raw.length % 2 !== 0 || !raw.includes(0)) {
    return undefined;
  }
  const sampleLen = Math.min(raw.length, CHARDET_SAMPLE_BYTES) & ~1;
  const pairs = sampleLen / 2;
  let oddZero = 0;
  let evenZero = 0;
  for (let i = 0; i < sampleLen; i += 2) {
    const even = raw[i]!;
    const odd = raw[i + 1]!;
    if (odd === 0 && even !== 0) {
      oddZero++;
    } else if (even === 0 && odd !== 0) {
      evenZero++;
    }
  }
  if (oddZero / pairs >= 0.75 && roundTripsCleanly(raw, 'utf16le', false)) {
    return 'utf16le';
  }
  if (evenZero / pairs >= 0.75 && roundTripsCleanly(raw, 'utf16be', false)) {
    return 'utf16be';
  }
  return undefined;
}

function validatePreferredNonUtf8(
  raw: Buffer,
  filePath: string,
  encoding: NonUtf8Encoding,
  source: NonUtf8DetectionSource,
  confident: boolean,
): EncodingDetection {
  const hasLeBom = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe;
  const hasBeBom = raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff;
  const hasBom = (encoding === 'utf16le' && hasLeBom) || (encoding === 'utf16be' && hasBeBom);
  if (!roundTripsCleanly(raw, encoding, hasBom)) {
    throw new FsError(
      `Configured encoding '${encoding}' cannot losslessly decode: ${filePath}`,
      'FS_NOT_TEXT',
    );
  }
  return { encoding, hasBom, confident, source };
}

/**
 * Detects a non-UTF-8 encoding among the 16 supported encodings, honoring an
 * explicit preference when supplied. Throws `FS_NOT_TEXT` for genuine binary
 * files, UTF-32, or unreadable bytes.
 */
export function detectNonUtf8EncodingWithPreference(
  raw: Buffer,
  filePath: string,
  preference?: NonUtf8Preference,
  overrides: readonly CompiledEncodingOverride[] = [],
  cwd?: string,
): EncodingDetection {
  if (isUtf32Bom(raw)) {
    throw new FsError(`Unsupported UTF-32 encoding or binary file: ${filePath}`, 'FS_NOT_TEXT');
  }

  if (preference) {
    return validatePreferredNonUtf8(
      raw,
      filePath,
      preference.encoding,
      preference.source,
      preference.confident ?? true,
    );
  }

  const hasLeBom = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe;
  const hasBeBom = raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff;
  const override = matchEncodingOverride(filePath, overrides, cwd);

  if (override === 'utf8') {
    throw new FsError(
      `Configured encoding 'utf8' cannot decode non-UTF-8 file: ${filePath}`,
      'FS_NOT_TEXT',
    );
  }

  if (override) {
    return validatePreferredNonUtf8(raw, filePath, override, 'override', true);
  }

  if (hasLeBom) {
    if (!roundTripsCleanly(raw, 'utf16le', true)) {
      throw new FsError(`Invalid UTF-16LE file or binary data: ${filePath}`, 'FS_NOT_TEXT');
    }
    return { encoding: 'utf16le', hasBom: true, confident: true, source: 'bom' };
  }

  if (hasBeBom) {
    if (!roundTripsCleanly(raw, 'utf16be', true)) {
      throw new FsError(`Invalid UTF-16BE file or binary data: ${filePath}`, 'FS_NOT_TEXT');
    }
    return { encoding: 'utf16be', hasBom: true, confident: true, source: 'bom' };
  }

  const sample = extractChardetSample(raw);
  const matches = chardet.analyse(sample);

  // Check BOM-less UTF-16 before rejecting on NUL bytes.
  const topMatch = matches[0];
  if (topMatch && (topMatch.name === 'UTF-16LE' || topMatch.name === 'UTF-16BE')) {
    const enc: NonUtf8Encoding = topMatch.name === 'UTF-16LE' ? 'utf16le' : 'utf16be';
    if (raw.length % 2 === 0 && roundTripsCleanly(raw, enc, false)) {
      return {
        encoding: enc,
        hasBom: false,
        confident: topMatch.confidence >= CONFIDENCE_THRESHOLD,
        source: 'chardet',
      };
    }
  }

  const bomlessUtf16 = detectBomlessAsciiUtf16(raw);
  if (bomlessUtf16) {
    return {
      encoding: bomlessUtf16,
      hasBom: false,
      confident: true,
      source: 'chardet',
    };
  }

  if (hasBinaryControlBytes(raw)) {
    throw new FsError(`File appears to be binary: ${filePath}`, 'FS_NOT_TEXT');
  }

  const topConfidence = topMatch?.confidence ?? 0;

  for (const m of matches) {
    const rawName = m.name.toLowerCase();
    // Skip UTF-8/ASCII since super already tried UTF-8 (unless pure ASCII falls into binary earlier)
    if (rawName === 'utf-8' || rawName === 'ascii') {
      continue;
    }

    // chardet reports GB18030 for both GBK and GB18030: prefer 'gbk' when raw round-trips in GBK.
    if (rawName === 'gb18030' || rawName === 'gbk' || rawName === 'gb2312') {
      if (roundTripsCleanly(raw, 'gbk', false)) {
        return {
          encoding: 'gbk',
          hasBom: false,
          confident: m.confidence >= CONFIDENCE_THRESHOLD && m.confidence >= topConfidence - 15,
          source: 'chardet',
        };
      }
      if (roundTripsCleanly(raw, 'gb18030', false)) {
        return {
          encoding: 'gb18030',
          hasBom: false,
          confident: m.confidence >= CONFIDENCE_THRESHOLD && m.confidence >= topConfidence - 15,
          source: 'chardet',
        };
      }
      continue;
    }

    const mapped = normalizeEncodingName(rawName);
    if (!mapped) {
      continue;
    }

    // For ISO-8859-1 vs windows-1252 when C1 bytes 0x80..0x9F exist: avoid strict windows-1252 undefined slots.
    if (roundTripsCleanly(raw, mapped, false)) {
      return {
        encoding: mapped,
        hasBom: false,
        confident: m.confidence >= CONFIDENCE_THRESHOLD && m.confidence >= topConfidence - 15,
        source: 'chardet',
      };
    }
  }

  throw new FsError(`Unable to decode file as supported text encoding: ${filePath}`, 'FS_NOT_TEXT');
}

export function detectNonUtf8Encoding(
  raw: Buffer,
  filePath: string,
  overrides: readonly CompiledEncodingOverride[] = [],
  cwd?: string,
): EncodingDetection {
  return detectNonUtf8EncodingWithPreference(raw, filePath, undefined, overrides, cwd);
}

export function decodeAndValidateNonUtf8WithPreference(
  raw: Buffer,
  filePath: string,
  preference?: NonUtf8Preference,
  overrides: readonly CompiledEncodingOverride[] = [],
  cwd?: string,
): DecodedText {
  const det = detectNonUtf8EncodingWithPreference(raw, filePath, preference, overrides, cwd);
  const text = decodeBytesRaw(raw, det.encoding, det.hasBom);
  const eol = detectEolStyle(text);
  const lfText = eol === 'cr' ? normalizeEol(text) : normalizeLineEndings(text);
  return {
    text,
    lfText,
    eol,
    encoding: det.encoding,
    hasBom: det.hasBom,
    confident: det.confident,
    source: det.source,
  };
}

export function decodeAndValidateNonUtf8(
  raw: Buffer,
  filePath: string,
  overrides: readonly CompiledEncodingOverride[] = [],
  cwd?: string,
): DecodedText {
  return decodeAndValidateNonUtf8WithPreference(raw, filePath, undefined, overrides, cwd);
}

/**
 * Full-pipeline lossless gate prior to mutating a non-UTF-8 file:
 * 1. Must be high-confidence (or explicitly overridden / BOM)
 * 2. Must not have mixed line endings (LF + CRLF + CR)
 * 3. `encode(restoreEol(normalizeEol(decode(raw))))` must match `raw` byte-for-byte.
 */
export function assertLosslessMutationReady(
  raw: Buffer,
  decoded: DecodedText,
  filePath: string,
): void {
  if (!decoded.confident) {
    throw new FsError(
      `Low-confidence encoding detection ('${decoded.encoding}') for ${filePath}; configure encodings override before modifying`,
      'FS_NOT_TEXT',
    );
  }
  if (decoded.eol === 'mixed') {
    throw new FsError(
      `Refusing to modify non-UTF-8 file with mixed line endings: ${filePath}`,
      'FS_NOT_TEXT',
    );
  }
  const reconstructed = encodeTextRaw(
    restoreEol(decoded.lfText, decoded.eol),
    decoded.encoding,
    decoded.hasBom,
  );
  if (!reconstructed.equals(raw)) {
    throw new FsError(
      `Full-pipeline round-trip check failed for '${decoded.encoding}' on ${filePath}; refusing edit`,
      'FS_NOT_TEXT',
    );
  }
}
