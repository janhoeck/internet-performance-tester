// Validation of PUT /api/config bodies (before config-store.saveConfig). Pure functions.
import { expandIPv6, isIPv4, isIPv6, isLinkLocalV6, isPrivateV4 } from '../shared/net';

/**
 * The router may only be addressed by a private IP literal: RFC 1918 / IPv4 link-local, IPv6
 * link-local (zone id allowed) or unique-local (fc00::/7). Hostnames like easy.box / kabel.box
 * resolve to public internet hosts – the router password must never be sent there.
 */
export function isPrivateRouterAddress(input: string): boolean {
  const ip = input.trim();
  if (isIPv4(ip)) return isPrivateV4(ip) || ip.startsWith('169.254.');
  if (isIPv6(ip)) {
    if (isLinkLocalV6(ip)) return true;
    const groups = expandIPv6(ip);
    return !!groups && (parseInt(groups[0], 16) & 0xfe00) === 0xfc00;
  }
  return false;
}

export const ROUTER_ADDRESS_ERROR =
  'Die Router-Adresse muss eine private IP-Adresse sein (z. B. 192.168.0.1). Hostnamen wie „easy.box“ oder „kabel.box“ zeigen auf fremde Server im Internet und werden deshalb nicht akzeptiert.';

export const MAX_PASSWORD_LENGTH = 128;

export interface ConfigPut {
  /** partial AppConfig (without routerPassword) for saveConfig */
  patch: Record<string, unknown>;
  /** undefined = unchanged, null = delete the stored password, string = new password */
  password: string | null | undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseConfigPut(body: unknown): { ok: true; value: ConfigPut } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'Ungültige Anfrage: Es wird ein JSON-Objekt erwartet.' };
  const { routerPassword, ...rest } = body;
  let password: string | null | undefined;
  if (routerPassword === undefined || routerPassword === '') password = undefined;
  else if (routerPassword === null) password = null;
  else if (typeof routerPassword === 'string') {
    if (routerPassword.length > MAX_PASSWORD_LENGTH) {
      return { ok: false, error: `Das Router-Passwort ist zu lang (max. ${MAX_PASSWORD_LENGTH} Zeichen).` };
    }
    password = routerPassword;
  } else {
    return { ok: false, error: 'Ungültiges Router-Passwort.' };
  }

  const patch: Record<string, unknown> = { ...rest };
  if ('router' in patch && patch.router !== undefined) {
    if (!isPlainObject(patch.router)) return { ok: false, error: 'Ungültige Router-Einstellungen.' };
    const router: Record<string, unknown> = { ...patch.router };
    // PublicConfig carries a read-only flag – never persist it
    delete router.hasPassword;
    if ('ip' in router && router.ip !== undefined) {
      if (typeof router.ip !== 'string' || !isPrivateRouterAddress(router.ip)) return { ok: false, error: ROUTER_ADDRESS_ERROR };
      router.ip = router.ip.trim();
    }
    patch.router = router;
  }
  return { ok: true, value: { patch, password } };
}
