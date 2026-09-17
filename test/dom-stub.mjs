/** The few Obsidian element helpers the settings tab touches. */
export function makeEl(tag = "div") {
  const el = {
    tag,
    cls: new Set(),
    text: "",
    children: [],
    disabled: false,
    handlers: [],
    createDiv(o = {}) { return el.append(makeEl("div"), o); },
    createSpan(o = {}) { return el.append(makeEl("span"), o); },
    createEl(t, o = {}) { return el.append(makeEl(t), o); },
    append(child, o) {
      if (typeof o === "string") child.cls.add(o);
      else {
        if (o.cls) String(o.cls).split(/\s+/).filter(Boolean).forEach((c) => child.cls.add(c));
        if (o.text) child.text = o.text;
        if (o.type) child.type = o.type;
      }
      el.children.push(child);
      return child;
    },
    empty() { el.children.length = 0; },
    addClass(...c) { c.forEach((x) => el.cls.add(x)); return el; },
    removeClass(...c) { c.forEach((x) => el.cls.delete(x)); return el; },
    setText(t) { el.text = t; return el; },
    onClickEvent(fn) { el.handlers.push(fn); return el; },
    setAttribute() { return el; },
  };
  return el;
}

/** Walks a shimmed tree and collects every element. */
export function flatten(el, out = []) {
  out.push(el);
  for (const c of el.children) flatten(c, out);
  return out;
}
