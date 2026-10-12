import { describe, expect, it } from 'vitest';
import { RPC_PREFIX, WORKER_SCRIPT, asciiJson, createPowerShellHost, decodeJsonResult, encodePowerShellCommand, parseRpcLine } from './powershell-host';

describe('RPC protocol helpers', () => {
  it('parses response lines (also behind stray host output)', () => {
    expect(parseRpcLine('@@RPC@@{"id":3,"ok":true,"data":{"a":1}}')).toEqual({ id: 3, ok: true, data: { a: 1 }, text: undefined, error: undefined, errorId: undefined, errorType: undefined });
    expect(parseRpcLine('WARNUNG: irgendwas@@RPC@@{"id":4,"ok":true,"text":"äöü"}')?.text).toBe('äöü');
    expect(parseRpcLine(`${RPC_PREFIX}{"id":5,"ok":false,"error":"Es wurden keine MSFT_NetAdapter-Objekte gefunden","errorId":"CmdletizationQuery_NotFound_Name,Get-NetAdapter","errorType":"Microsoft.PowerShell.Cmdletization.Cim.CimJobException"}`)).toMatchObject({
      ok: false, errorId: 'CmdletizationQuery_NotFound_Name,Get-NetAdapter',
    });
    expect(parseRpcLine('#< CLIXML')).toBeNull();
    expect(parseRpcLine('@@RPC@@{kaputt')).toBeNull();
    expect(parseRpcLine('@@RPC@@{"ok":true}')).toBeNull();
  });

  it('decodes json() results: a single string is the JSON document, otherwise the serialized data', () => {
    expect(decodeJsonResult({ id: 1, ok: true, text: '{"a":[1,2]}' })).toEqual({ a: [1, 2] });
    expect(decodeJsonResult({ id: 1, ok: true, text: '  ' })).toBeNull();
    expect(decodeJsonResult({ id: 1, ok: true, text: 'kein json' })).toBe('kein json');
    expect(decodeJsonResult({ id: 1, ok: true, data: [1] })).toEqual([1]);
    expect(decodeJsonResult({ id: 1, ok: true })).toBeNull();
  });

  it('keeps stdin pure ASCII', () => {
    const line = asciiJson({ cmd: "Write-Output 'Grüße € 😀'" });
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    expect(JSON.parse(line)).toEqual({ cmd: "Write-Output 'Grüße € 😀'" });
  });

  it('encodes -EncodedCommand as base64 UTF-16LE and the boot script stays safe', () => {
    expect(Buffer.from(encodePowerShellCommand('1+1'), 'base64').toString('utf16le')).toBe('1+1');
    expect(WORKER_SCRIPT).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(WORKER_SCRIPT).not.toContain('OutputEncoding');
    expect(WORKER_SCRIPT).toContain('@@RPC@@');
  });
});

describe('host lifecycle without powershell.exe', () => {
  it('reports an unavailable executable and rejects calls', async () => {
    const ps = createPowerShellHost({ exe: 'C:\\nicht\\vorhanden\\powershell.exe', helpers: false });
    await expect(ps.json('1+1')).rejects.toThrow();
    expect(ps.available).toBe(false);
    await expect(ps.text('1')).rejects.toThrow(/nicht verfügbar/);
    ps.dispose();
    await expect(ps.json('1')).rejects.toThrow(/beendet/);
  });
});
