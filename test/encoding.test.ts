import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs';
import {
  EncodingStateCache,
  NON_UTF8_ENCODINGS,
  assertLosslessMutationReady,
  compileEncodingOverrides,
  decodeAndValidateNonUtf8,
  detectNonUtf8Encoding,
  encodeTextRaw,
  encodeTextStrict,
  isValidUtf8Text,
} from '../src/encoding/index.js';
import type { NonUtf8Encoding } from '../src/encoding/index.js';

function expectFsError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(FsError);
  expect(caught).toMatchObject({ code });
}

describe('encoding detection, round-trip safety, and cache', () => {
  it('round-trips every one of the 16 supported non-UTF-8 encodings losslessly', () => {
    const samples: Record<NonUtf8Encoding, { text: string; hasBom: boolean }> = {
      utf16le: { text: 'Line 1: 你好 UTF-16LE 🚀\r\nLine 2: second\r\n', hasBom: true },
      utf16be: { text: 'Line 1: 你好 UTF-16BE 🚀\r\nLine 2: second\r\n', hasBom: true },
      gbk: {
        text: '这是一段足够长的简体中文测试文本，用于验证GBK编码的稳定识别与无损编辑处理。\n第二行包含标点符号和数字12345。\n',
        hasBom: false,
      },
      gb18030: {
        text: '这是一段包含扩展生僻字镕堃𠮷的简体中文测试文本，用于验证GB18030编码识别与字节无损往返处理。\n第二行内容继续测试。\n',
        hasBom: false,
      },
      big5: {
        text: '這是一段足夠長的繁體中文測試文本，用來驗證 Big5 編碼的準確識別與無損讀寫。\n第二行包含中文標點符號：，、；。\n',
        hasBom: false,
      },
      shift_jis: {
        text: 'これは日本語のShift-JISエンコーディングを検証するためのテスト文字列です。\n二行目のテキストも含まれています。\n',
        hasBom: false,
      },
      'euc-kr': {
        text: '이것은 한국어 EUC-KR 인코딩 감지와 무손실 편집을 검증하기 위한 충분한 길이의 테스트 문자열입니다.\n두 번째 줄 내용입니다.\n',
        hasBom: false,
      },
      'windows-1250': {
        text: 'Zażółć gęślą jaźń — przykładowy tekst w języku polskim do weryfikacji kodowania Windows-1250.\nDruga linia tekstu.\n',
        hasBom: false,
      },
      'windows-1251': {
        text: 'Привет мир! Это достаточно длинная тестовая строка на русском языке для проверки кодировки Windows-1251.\nВторая строка текста.\n',
        hasBom: false,
      },
      'windows-1252': {
        text: 'Café résumé naïve — “quoted text” €100, plus additional Western European prose to verify Windows-1252.\nLine 2.\n',
        hasBom: false,
      },
      'windows-1253': {
        text: 'Καλημέρα κόσμε! Αυτό είναι ένα δοκιμαστικό κείμενο στα ελληνικά για τον έλεγχο της κωδικοποίησης Windows-1253.\nΔεύτερη γραμμή.\n',
        hasBom: false,
      },
      'windows-1254': {
        text: 'Türkçe karakterler: şğüöçı İŞĞÜÖÇ — yeterli uzunlukta örnek Türkçe metin doğrulaması için hazırlandı.\nİkinci satır.\n',
        hasBom: false,
      },
      'windows-1255': {
        text: 'שלום עולם! זהו טקסט בדיקה בעברית באורך מספק כדי לאמת זיהוי ועריכה בקידוד Windows-1255.\nשורה שנייה.\n',
        hasBom: false,
      },
      'windows-1256': {
        text: 'مرحبا بالعالم! هذا نص اختبار باللغة العربية بطول كافٍ للتحقق من الترميز Windows-1256 دون فقدان.\nالسطر الثاني.\n',
        hasBom: false,
      },
      'windows-1257': {
        text: 'Šī ir pietiekami gara latviešu valodas testa virkne ar garumzīmēm un mīkstinājuma zīmēm Windows-1257 pārbaudei.\nOtrā rinda.\n',
        hasBom: false,
      },
      'iso-8859-1': {
        text: 'Voilà un texte français suffisamment long pour vérifier le codage ISO-8859-1 avec des accents variés : à, é, è, ê, ç, ù.\nDeuxième ligne.\n',
        hasBom: false,
      },
    };

    for (const enc of NON_UTF8_ENCODINGS) {
      const { text, hasBom } = samples[enc];
      const raw = encodeTextRaw(text, enc, hasBom);
      expect(isValidUtf8Text(raw)).toBe(false);

      // Provide override fallback for short overlapping single-byte Latin tables while still
      // verifying decode/encode/full-pipeline gate works across all 16 encodings cleanly.
      const overrides = compileEncodingOverrides({ [`test.${enc}`]: enc });
      const decoded = decodeAndValidateNonUtf8(raw, `test.${enc}`, overrides);
      expect(decoded.encoding).toBe(enc);
      expect(decoded.hasBom).toBe(hasBom);
      expect(decoded.confident).toBe(true);
      expect(decoded.text).toBe(text);
      assertLosslessMutationReady(raw, decoded, `test.${enc}`);

      const strictBytes = encodeTextStrict(decoded.text, enc, hasBom);
      expect(strictBytes.equals(raw)).toBe(true);
    }
  });

  it('auto-detects UTF-16LE/BE BOM, GBK vs GB18030, Big5, Shift-JIS, EUC-KR, Windows-1251 without overrides', () => {
    const gbkBuf = encodeTextRaw(
      '这是一段中文源代码注释，用于自动探测 GBK 编码并确保不会误判为其他编码。',
      'gbk',
      false,
    );
    expect(detectNonUtf8Encoding(gbkBuf, 'a.txt').encoding).toBe('gbk');

    const gb18030Buf = encodeTextRaw(
      '这是一段包含生僻汉字镕堃𠮷的简体中文内容，需要识别为完整的 GB18030 编码集合。',
      'gb18030',
      false,
    );
    expect(detectNonUtf8Encoding(gb18030Buf, 'b.txt').encoding).toBe('gb18030');

    const big5Buf = encodeTextRaw(
      '這是一段繁體中文原始碼註解，用來自動偵測 Big5 編碼格式。',
      'big5',
      false,
    );
    expect(detectNonUtf8Encoding(big5Buf, 'c.txt').encoding).toBe('big5');

    const sjisBuf = encodeTextRaw(
      'これは日本語のShift-JISテキストファイルであり、正しく判定される必要があります。',
      'shift_jis',
      false,
    );
    expect(detectNonUtf8Encoding(sjisBuf, 'd.txt').encoding).toBe('shift_jis');

    const euckrBuf = encodeTextRaw(
      '이것은 한국어 EUC-KR 텍스트 파일이며 정확하게 감지되어야 합니다.',
      'euc-kr',
      false,
    );
    expect(detectNonUtf8Encoding(euckrBuf, 'e.txt').encoding).toBe('euc-kr');

    const win1251Buf = encodeTextRaw(
      'Привет мир! Тестовая строка на русском языке для определения кодировки Windows-1251.',
      'windows-1251',
      false,
    );
    const win1251Det = detectNonUtf8Encoding(win1251Buf, 'f.txt');
    expect(win1251Det.encoding).toBe('windows-1251');
    expect(win1251Det.confident).toBe(true);

    const utf16leBom = encodeTextRaw('Hello 世界\n', 'utf16le', true);
    expect(detectNonUtf8Encoding(utf16leBom, 'le.txt')).toMatchObject({
      encoding: 'utf16le',
      hasBom: true,
      confident: true,
      source: 'bom',
    });

    const utf16beBom = encodeTextRaw('Hello 世界\n', 'utf16be', true);
    expect(detectNonUtf8Encoding(utf16beBom, 'be.txt')).toMatchObject({
      encoding: 'utf16be',
      hasBom: true,
      confident: true,
      source: 'bom',
    });
  });

  it('rejects genuine binary files, UTF-32 BOM, and odd-byte UTF-16 with FS_NOT_TEXT', () => {
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    expectFsError(() => detectNonUtf8Encoding(pngHeader, 'img.png'), 'FS_NOT_TEXT');

    const utf32le = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]);
    expectFsError(() => detectNonUtf8Encoding(utf32le, 'u32.txt'), 'FS_NOT_TEXT');

    const oddUtf16 = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]);
    expectFsError(() => detectNonUtf8Encoding(oddUtf16, 'odd.txt'), 'FS_NOT_TEXT');
  });

  it('marks very short ambiguous buffers low-confidence unless overridden via glob config', () => {
    const shortGbk = iconv.encode('你好', 'gbk');
    const decodedLow = decodeAndValidateNonUtf8(shortGbk, 'nested/short.csv');
    expect(decodedLow.confident).toBe(false);
    expectFsError(
      () => assertLosslessMutationReady(shortGbk, decodedLow, 'nested/short.csv'),
      'FS_NOT_TEXT',
    );

    const overrides = compileEncodingOverrides({ '*.csv': 'gbk' });
    const decodedOverride = decodeAndValidateNonUtf8(shortGbk, 'nested/short.csv', overrides);
    expect(decodedOverride.encoding).toBe('gbk');
    expect(decodedOverride.confident).toBe(true);
    expect(decodedOverride.source).toBe('override');
    expect(decodedOverride.text).toBe('你好');
    assertLosslessMutationReady(shortGbk, decodedOverride, 'nested/short.csv');
  });

  it('refuses mixed line endings in full-pipeline mutation gate and rejects unmappable chars on encode', () => {
    const mixedText = '第一行中文混合换行测试文本\r\n第二行中文\n第三行结束';
    const mixedBytes = iconv.encode(mixedText, 'gbk');
    const decoded = decodeAndValidateNonUtf8(mixedBytes, 'mixed.txt');
    expect(decoded.eol).toBe('mixed');
    expectFsError(
      () => assertLosslessMutationReady(mixedBytes, decoded, 'mixed.txt'),
      'FS_NOT_TEXT',
    );

    expectFsError(() => encodeTextStrict('Hello 🚀 emoji in GBK', 'gbk', false), 'FS_IO_ERROR');
    expectFsError(() => encodeTextStrict('한국어 한글 in GBK', 'gbk', false), 'FS_IO_ERROR');
  });

  it('validates UTF-8 / UTF-8 BOM via isValidUtf8Text and evicts/invalidates EncodingStateCache cleanly', () => {
    const utf8Bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('你好 UTF-8 BOM\n', 'utf8'),
    ]);
    expect(isValidUtf8Text(utf8Bom)).toBe(true);

    const cache = new EncodingStateCache();
    const v1 = FsVersion('v1');
    const v2 = FsVersion('v2');
    cache.set('/tmp/a.txt', {
      encoding: 'gbk',
      hasBom: false,
      eol: 'lf',
      confident: true,
      source: 'chardet',
      version: v1,
    });
    expect(cache.getIfFresh('/tmp/a.txt', v1)?.encoding).toBe('gbk');
    expect(cache.getIfFresh('/tmp/a.txt', v2)).toBeUndefined();
    expect(cache.getLatest('/tmp/a.txt')).toBeUndefined();

    for (let i = 0; i < 1050; i++) {
      cache.set(`/tmp/f-${i}`, {
        encoding: 'gbk',
        hasBom: false,
        eol: 'lf',
        confident: true,
        source: 'chardet',
        version: v1,
      });
    }
    expect(cache.getLatest('/tmp/f-0')).toBeUndefined();
    expect(cache.getLatest('/tmp/f-1049')).toBeDefined();
  });

  it('rejects binary payloads appearing after 8 KiB, accepts literal U+FFFD in UTF-16, and detects BOM-less pure-ASCII UTF-16', () => {
    const asciiPrefix = Buffer.alloc(9000, 0x41);
    const trailingBinary = Buffer.concat([
      asciiPrefix,
      Buffer.from([0x00, 0x01, 0x02, 0x80, 0x81, 0xff]),
    ]);
    expectFsError(() => decodeAndValidateNonUtf8(trailingBinary, 'late-bin.dat'), 'FS_NOT_TEXT');

    const utf16LeWithFffd = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      iconv.encode('alpha \uFFFD omega\n', 'utf16-le'),
    ]);
    const decodedLe = decodeAndValidateNonUtf8(utf16LeWithFffd, 'fffd-le.txt');
    expect(decodedLe.encoding).toBe('utf16le');
    expect(decodedLe.text).toBe('alpha \uFFFD omega\n');

    const utf16BeWithFffd = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      iconv.encode('alpha \uFFFD omega\n', 'utf16-be'),
    ]);
    const decodedBe = decodeAndValidateNonUtf8(utf16BeWithFffd, 'fffd-be.txt');
    expect(decodedBe.encoding).toBe('utf16be');
    expect(decodedBe.text).toBe('alpha \uFFFD omega\n');

    const bomlessAsciiLe = iconv.encode('Hello ASCII UTF-16LE\nLine 2\n', 'utf16-le');
    const detAsciiLe = decodeAndValidateNonUtf8(bomlessAsciiLe, 'ascii-le.txt');
    expect(detAsciiLe.encoding).toBe('utf16le');
    expect(detAsciiLe.hasBom).toBe(false);
    expect(detAsciiLe.text).toBe('Hello ASCII UTF-16LE\nLine 2\n');

    const bomlessAsciiBe = iconv.encode('Hello ASCII UTF-16BE\nLine 2\n', 'utf16-be');
    const detAsciiBe = decodeAndValidateNonUtf8(bomlessAsciiBe, 'ascii-be.txt');
    expect(detAsciiBe.encoding).toBe('utf16be');
    expect(detAsciiBe.hasBom).toBe(false);
    expect(detAsciiBe.text).toBe('Hello ASCII UTF-16BE\nLine 2\n');

    // Aligns with official readWholeText: valid UTF-8 with C0 control chars (no NUL) is UTF-8
    const utf8WithBell = Buffer.from('\u0007bell\u001b[31mred\u001b[0m\n', 'utf8');
    expect(isValidUtf8Text(utf8WithBell)).toBe(true);

    // Path-containing glob override matches absolute paths when cwd is provided
    const overrides = compileEncodingOverrides({ 'legacy/**': 'shift_jis' });
    const sjisBytes = iconv.encode('日本語シフトJIS\n', 'shift_jis');
    const absPath = '/tmp/repo/legacy/sub/file.txt';
    const matched = decodeAndValidateNonUtf8(sjisBytes, absPath, overrides, '/tmp/repo');
    expect(matched.encoding).toBe('shift_jis');
    expect(matched.source).toBe('override');
  });
});
