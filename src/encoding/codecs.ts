import iconv from 'iconv-lite';
import { FsError } from '@deepseek-ai/dsh-fs';

export const NON_UTF8_ENCODINGS = [
  'utf16le',
  'utf16be',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-kr',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'iso-8859-1',
] as const;

export type NonUtf8Encoding = (typeof NON_UTF8_ENCODINGS)[number];

export type SupportedTextEncoding = 'utf8' | NonUtf8Encoding;

export type EolStyle = 'lf' | 'crlf' | 'cr' | 'mixed';

export const RG_ENCODING_LABELS: Record<NonUtf8Encoding, string> = {
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  shift_jis: 'shift-jis',
  'euc-kr': 'euc-kr',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1254': 'windows-1254',
  'windows-1255': 'windows-1255',
  'windows-1256': 'windows-1256',
  'windows-1257': 'windows-1257',
  'iso-8859-1': 'iso-8859-1',
};

const ICONV_NAMES: Record<NonUtf8Encoding, string> = {
  utf16le: 'utf16-le',
  utf16be: 'utf16-be',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  shift_jis: 'shift_jis',
  'euc-kr': 'euc-kr',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1254': 'windows-1254',
  'windows-1255': 'windows-1255',
  'windows-1256': 'windows-1256',
  'windows-1257': 'windows-1257',
  'iso-8859-1': 'iso-8859-1',
};

const ENCODING_ALIASES: Record<string, NonUtf8Encoding> = {
  utf16le: 'utf16le',
  'utf-16le': 'utf16le',
  'utf-16-le': 'utf16le',
  ucs2: 'utf16le',
  'ucs-2': 'utf16le',
  utf16be: 'utf16be',
  'utf-16be': 'utf16be',
  'utf-16-be': 'utf16be',
  gbk: 'gbk',
  gb2312: 'gbk',
  cp936: 'gbk',
  ms936: 'gbk',
  chinese: 'gbk',
  csgb2312: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  'big5-hkscs': 'big5',
  cp950: 'big5',
  shift_jis: 'shift_jis',
  'shift-jis': 'shift_jis',
  sjis: 'shift_jis',
  cp932: 'shift_jis',
  ms932: 'shift_jis',
  'windows-31j': 'shift_jis',
  'euc-kr': 'euc-kr',
  euckr: 'euc-kr',
  cp949: 'euc-kr',
  'ks_c_5601-1987': 'euc-kr',
  'windows-1250': 'windows-1250',
  cp1250: 'windows-1250',
  'windows-1251': 'windows-1251',
  cp1251: 'windows-1251',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
  'windows-1253': 'windows-1253',
  cp1253: 'windows-1253',
  'windows-1254': 'windows-1254',
  cp1254: 'windows-1254',
  'windows-1255': 'windows-1255',
  cp1255: 'windows-1255',
  'windows-1256': 'windows-1256',
  cp1256: 'windows-1256',
  'windows-1257': 'windows-1257',
  cp1257: 'windows-1257',
  'iso-8859-1': 'iso-8859-1',
  'iso8859-1': 'iso-8859-1',
  iso88591: 'iso-8859-1',
  latin1: 'iso-8859-1',
};

const NON_UTF8_ENCODING_SET: ReadonlySet<string> = new Set(NON_UTF8_ENCODINGS);

export function isSupportedNonUtf8Encoding(value: unknown): value is NonUtf8Encoding {
  return typeof value === 'string' && NON_UTF8_ENCODING_SET.has(value);
}

export function isSupportedTextEncoding(value: unknown): value is SupportedTextEncoding {
  return value === 'utf8' || isSupportedNonUtf8Encoding(value);
}

export function normalizeEncodingName(raw: string): NonUtf8Encoding | undefined {
  return ENCODING_ALIASES[raw.trim().toLowerCase()];
}

export function normalizeOverrideEncoding(raw: string): SupportedTextEncoding | undefined {
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'utf8' || lowered === 'utf-8') {
    return 'utf8';
  }
  return ENCODING_ALIASES[lowered];
}

export function hasUtf8Bom(raw: Buffer): boolean {
  return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
}

export function hasNonAsciiByte(raw: Buffer): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]! >= 0x80) {
      return true;
    }
  }
  return false;
}

export function detectEolStyle(text: string): EolStyle {
  let hasCrlf = false;
  let hasLf = false;
  let hasCr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        hasCrlf = true;
        i++;
      } else {
        hasCr = true;
      }
    } else if (ch === '\n') {
      hasLf = true;
    }
  }
  const count = (hasCrlf ? 1 : 0) + (hasLf ? 1 : 0) + (hasCr ? 1 : 0);
  if (count > 1) {
    return 'mixed';
  }
  if (hasCrlf) {
    return 'crlf';
  }
  if (hasCr) {
    return 'cr';
  }
  return 'lf';
}

export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

export function restoreEol(lfText: string, eol: EolStyle): string {
  if (eol === 'crlf') {
    return lfText.replace(/\n/g, '\r\n');
  }
  if (eol === 'cr') {
    return lfText.replace(/\n/g, '\r');
  }
  return lfText;
}

export function decodeBytesRaw(raw: Buffer, encoding: NonUtf8Encoding, hasBom: boolean): string {
  const payload =
    hasBom && (encoding === 'utf16le' || encoding === 'utf16be') ? raw.subarray(2) : raw;
  return iconv.decode(payload, ICONV_NAMES[encoding], { stripBOM: false } as iconv.Options);
}

export function encodeTextRaw(text: string, encoding: NonUtf8Encoding, hasBom: boolean): Buffer {
  const body = iconv.encode(text, ICONV_NAMES[encoding]);
  if (!hasBom) {
    return body;
  }
  if (encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  }
  if (encoding === 'utf16be') {
    return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  }
  return body;
}

/**
 * Encodes text into a non-UTF-8 encoding and verifies a strict reverse decode check
 * so unmappable characters (silently turned into `?` by iconv-lite) are rejected.
 */
export function encodeTextStrict(text: string, encoding: NonUtf8Encoding, hasBom: boolean): Buffer {
  const bytes = encodeTextRaw(text, encoding, hasBom);
  const decodedBack = decodeBytesRaw(bytes, encoding, hasBom);
  if (decodedBack !== text) {
    throw new FsError(
      `Text contains characters that cannot be represented losslessly in ${encoding}`,
      'FS_IO_ERROR',
    );
  }
  return bytes;
}
