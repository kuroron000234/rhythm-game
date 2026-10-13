type Child = Node | string | null | undefined | false;

/** Tiny element builder: h('div.card.active', { onclick }, child, ...) */
export function h<T extends HTMLElement = HTMLElement>(
  tag: string, props: Partial<Record<string, unknown>> = {}, ...children: (Child | Child[])[]
): T {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name) as T;
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const keyLabel = (code: string) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
