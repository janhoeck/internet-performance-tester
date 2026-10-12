// Minimal CP850 (OEM Western Europe, default OEMCP on de-DE Windows) decoder.
// Node's TextDecoder (WHATWG) has no ibm850, so we ship a 128-entry table.
const HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' + // 0x80
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' + // 0x90
  'áíóúñÑªº¿®¬½¼¡«»' + // 0xA0
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' + // 0xB0
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' + // 0xC0
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' + // 0xD0
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' + // 0xE0
  '­±‗¾¶§÷¸°¨·¹³²■ '; // 0xF0
if ([...HIGH].length !== 128) throw new Error('cp850 table length ' + [...HIGH].length);
const TABLE = [...HIGH];

export function decodeCp850(buf) {
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : TABLE[b - 0x80];
  return s;
}

// Strict UTF-8 validity check (fatal decoder throws on invalid sequences).
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
export function isValidUtf8(buf) {
  try { strictUtf8.decode(buf); return true; } catch { return false; }
}

// Auto decode: pure ASCII -> ascii; valid UTF-8 with high bytes -> utf8; else cp850.
export function autoDecode(buf) {
  let high = false;
  for (const b of buf) if (b >= 0x80) { high = true; break; }
  if (!high) return { enc: 'ascii', text: buf.toString('latin1') };
  if (isValidUtf8(buf)) return { enc: 'utf8', text: buf.toString('utf8') };
  return { enc: 'cp850', text: decodeCp850(buf) };
}
