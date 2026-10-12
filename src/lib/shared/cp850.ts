// Decoder for IBM code page 850 – the OEM code page used by Windows console tools
// (ping, tracert, netsh) on German systems when their output is redirected to a pipe.
// Node's TextDecoder does not support 'ibm850' without full ICU, so we map it ourselves.

// Bytes 0x80..0xFF of CP850 as Unicode characters.
const HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' + // 0x80
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' + // 0x90
  'áíóúñÑªº¿®¬½¼¡«»' + // 0xA0
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' + // 0xB0
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' + // 0xC0
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' + // 0xD0
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' + // 0xE0
  '­±‗¾¶§÷¸°¨·¹³²■ '; // 0xF0

if (HIGH.length !== 128) {
  throw new Error(`cp850 table must have 128 entries, has ${HIGH.length}`);
}

/** Decode a CP850 byte buffer to a JS string. ASCII bytes map 1:1. */
export function decodeCp850(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b < 0x80 ? String.fromCharCode(b) : HIGH[b - 0x80];
  }
  return out;
}

/**
 * Some environments make console tools emit UTF-8 (e.g. after `chcp 65001`). If the buffer is
 * valid UTF-8 containing non-ASCII characters, decode as UTF-8, otherwise as CP850.
 */
export function decodeConsole(bytes: Uint8Array): string {
  let nonAscii = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) {
      nonAscii = true;
      break;
    }
  }
  if (!nonAscii) return decodeCp850(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeCp850(bytes);
  }
}

/**
 * Incremental line splitter for child process output. Feed chunks, receive complete lines
 * (without CR/LF). Bytes are buffered until a newline so multi-byte sequences are never split.
 */
export class ConsoleLineSplitter {
  private pending: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): string[] {
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.length);
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] === 0x0a) {
        let end = i;
        if (end > start && merged[end - 1] === 0x0d) end--;
        lines.push(decodeConsole(merged.subarray(start, end)));
        start = i + 1;
      }
    }
    this.pending = merged.slice(start);
    return lines;
  }

  /** remaining unterminated text (e.g. on process exit) */
  flush(): string | null {
    if (this.pending.length === 0) return null;
    let end = this.pending.length;
    if (this.pending[end - 1] === 0x0d) end--;
    const s = decodeConsole(this.pending.subarray(0, end));
    this.pending = new Uint8Array(0);
    return s;
  }
}
