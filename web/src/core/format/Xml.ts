/**
 * A small XML reader and writer for BCF (the port's stand-in for System.Xml.Linq). The reader is namespace-agnostic
 * (names keep only their local part), keeps element text, ignores comments and processing instructions, decodes the
 * predefined and numeric entities and CDATA, and refuses DTDs (as BcfFile's XmlReaderSettings do). It works the same
 * in the browser and in Node (the tests), unlike DOMParser.
 */

/** An element: local name, attributes by local name, child elements and its own text (CDATA included). */
export interface XmlElement {
  name: string;
  attributes: Map<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlError extends Error {}

const localName = (qualified: string) => {
  const colon = qualified.indexOf(':');
  return colon >= 0 ? qualified.slice(colon + 1) : qualified;
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) { return s; }
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return '\'';
      default: return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

/** Parses a document and returns its root element. Throws XmlError for malformed XML or a DTD. */
export function parseXml(source: string): XmlElement {
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const n = source.length;

  while (i < n) {
    const lt = source.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i && stack.length > 0) { stack[stack.length - 1].text += decodeEntities(source.slice(i, textEnd)); }
    if (lt < 0) { break; }
    i = lt;

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) { throw new XmlError('Unclosed comment.'); }
      i = end + 3;
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end < 0) { throw new XmlError('Unclosed CDATA.'); }
      if (stack.length > 0) { stack[stack.length - 1].text += source.slice(i + 9, end); }
      i = end + 3;
    } else if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end < 0) { throw new XmlError('Unclosed processing instruction.'); }
      i = end + 2;
    } else if (source.startsWith('<!', i)) {
      throw new XmlError('DTDs are not allowed.');
    } else if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i + 2);
      if (end < 0) { throw new XmlError('Unclosed end tag.'); }
      const name = localName(source.slice(i + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name) { throw new XmlError(`Mismatched end tag </${name}>.`); }
      i = end + 1;
    } else {
      // Start tag: name, attributes (quoted values may hold '>'), optional self-close
      let p = i + 1;
      while (p < n && !/[\s/>]/.test(source[p])) { p++; }
      const element: XmlElement = { name: localName(source.slice(i + 1, p)), attributes: new Map(), children: [], text: '' };
      if (!element.name) { throw new XmlError('Empty tag name.'); }
      let selfClosing = false;
      for (;;) {
        while (p < n && /\s/.test(source[p])) { p++; }
        if (p >= n) { throw new XmlError('Unclosed start tag.'); }
        if (source[p] === '>') { p++; break; }
        if (source[p] === '/' && source[p + 1] === '>') { selfClosing = true; p += 2; break; }
        const eq = source.indexOf('=', p);
        if (eq < 0) { throw new XmlError('Bad attribute.'); }
        const attrName = source.slice(p, eq).trim();
        let q = eq + 1;
        while (q < n && /\s/.test(source[q])) { q++; }
        const quote = source[q];
        if (quote !== '"' && quote !== '\'') { throw new XmlError('Unquoted attribute.'); }
        const close = source.indexOf(quote, q + 1);
        if (close < 0) { throw new XmlError('Unclosed attribute.'); }
        if (!attrName.startsWith('xmlns')) { element.attributes.set(localName(attrName), decodeEntities(source.slice(q + 1, close))); }
        p = close + 1;
      }
      if (stack.length > 0) { stack[stack.length - 1].children.push(element); }
      else if (root) { throw new XmlError('More than one root element.'); }
      else { root = element; }
      if (!selfClosing) { stack.push(element); }
      i = p;
    }
  }
  if (!root || stack.length > 0) { throw new XmlError('The document is incomplete.'); }
  return root;
}

/** The first child element with this local name, or null. */
export function child(parent: XmlElement | null, name: string): XmlElement | null {
  return parent?.children.find(c => c.name === name) ?? null;
}

/** The first descendant (depth first, document order) with this local name, or null. */
export function descendant(parent: XmlElement | null, name: string): XmlElement | null {
  if (!parent) { return null; }
  for (const c of parent.children) {
    if (c.name === name) { return c; }
    const found = descendant(c, name);
    if (found) { return found; }
  }
  return null;
}

/** Every descendant in document order. */
export function* descendants(parent: XmlElement): Generator<XmlElement> {
  for (const c of parent.children) {
    yield c;
    yield* descendants(c);
  }
}

/** An element's full text (its own and its descendants', as XElement.Value). */
export function valueOf(element: XmlElement | null): string | null {
  if (!element) { return null; }
  let s = element.text;
  for (const c of element.children) { s += valueOf(c) ?? ''; }
  return s;
}

// #region Writing

/** An element to write: name, attributes (null values left out), children (null / undefined left out) or text. */
export interface XmlNode {
  name: string;
  attributes?: Record<string, string | null | undefined>;
  children?: (XmlNode | null | undefined)[];
  text?: string;
}

/** Builds a node; a string child becomes its text. */
export function el(name: string, attributes: Record<string, string | null | undefined> | null, ...content: (XmlNode | string | null | undefined)[]): XmlNode {
  const node: XmlNode = { name, attributes: attributes ?? undefined, children: [] };
  for (const c of content) {
    if (typeof c === 'string') { node.text = (node.text ?? '') + c; }
    else if (c) { node.children!.push(c); }
  }
  return node;
}

export function escapeXml(s: string, attribute = false): string {
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (attribute) { out = out.replace(/"/g, '&quot;').replace(/\r/g, '&#xD;').replace(/\n/g, '&#xA;').replace(/\t/g, '&#x9;'); }
  else { out = out.replace(/\r/g, '&#xD;'); }
  return out;
}

/** The document as text: an XML declaration, then the root indented by two spaces (as XmlWriter with Indent). */
export function writeXml(root: XmlNode, standalone = false): string {
  const lines: string[] = [`<?xml version="1.0" encoding="utf-8"${standalone ? ' standalone="yes"' : ''}?>`];
  const write = (node: XmlNode, indent: string) => {
    const attrs = Object.entries(node.attributes ?? {})
      .filter((e): e is [string, string] => e[1] !== null && e[1] !== undefined)
      .map(([k, v]) => ` ${k}="${escapeXml(v, true)}"`).join('');
    const kids = (node.children ?? []).filter((c): c is XmlNode => !!c);
    if (kids.length === 0 && !node.text) {
      lines.push(`${indent}<${node.name}${attrs} />`);
    } else if (kids.length === 0) {
      lines.push(`${indent}<${node.name}${attrs}>${escapeXml(node.text!)}</${node.name}>`);
    } else {
      lines.push(`${indent}<${node.name}${attrs}>`);
      for (const k of kids) { write(k, indent + '  '); }
      lines.push(`${indent}</${node.name}>`);
    }
  };
  write(root, '');
  return lines.join('\r\n');
}

// #endregion
