/**
 * IFC's compressed GUID (port of BimGo.Core/Format/IfcGuid.cs): 22 characters, base 64 with IFC's own alphabet, as
 * written by Revit's IFC exporter and read by BCF tools to find elements. The 128 bits are taken in the GUID's text
 * order, most significant first; the first character carries the top 2 bits (0–3), each of the other 21 carries 6.
 */
export const IfcGuid = {
  LENGTH: 22,

  /** Compresses a GUID ("xxxxxxxx-xxxx-…" or 32 hex digits) to its 22-character IFC form; null for a non-GUID. */
  encode(guid: string): string | null {
    const hex = guid.replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) { return null; }
    let value = BigInt('0x' + hex);
    const chars: string[] = new Array(IfcGuid.LENGTH);
    for (let i = IfcGuid.LENGTH - 1; i >= 0; i--) {
      chars[i] = CHARS[Number(value & 63n)];
      value >>= 6n;
    }
    return chars.join('');
  },

  /** Expands a 22-character IFC GUID to "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (lower case), or null. */
  decode(text: string | null | undefined): string | null {
    if (!IfcGuid.isValid(text)) { return null; }
    let value = 0n;
    for (const c of text!) { value = (value << 6n) | BigInt(CHARS.indexOf(c)); }
    const hex = value.toString(16).padStart(32, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },

  /** True for 22 characters of the IFC alphabet whose first character is 0–3 (it only holds 2 bits). */
  isValid(text: string | null | undefined): boolean {
    if (typeof text !== 'string' || text.length !== IfcGuid.LENGTH || text[0] < '0' || text[0] > '3') { return false; }
    for (const c of text) {
      if (!CHARS.includes(c)) { return false; }
    }
    return true;
  }
};

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
