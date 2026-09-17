import { makeEl } from "./dom-stub.mjs";

export function requestUrl() { throw new Error("network disabled in tests"); }
export class Modal { constructor(app) { this.app = app; this.contentEl = makeEl(); this.modalEl = makeEl(); } open() {} close() {} }
export class Plugin {}
export class FuzzySuggestModal { constructor(app) { this.app = app; } setPlaceholder() {} open() {} }
export class Notice { constructor(msg) { this.msg = msg; } }
export const Platform = { isMobile: false, isIosApp: false, isAndroidApp: false };
export function debounce(f) { return f; }
export function addIcon() {}

/** Records what the tab asked for, so a test can assert the rendered surface. */
export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.settingEl = makeEl();
    this.descEl = makeEl();
    this.name = "";
    this.desc = "";
    this.heading = false;
    this.controls = [];
    containerEl.children.push(this.settingEl);
    Setting.rendered.push(this);
  }
  setName(n) { this.name = n; return this; }
  setDesc(d) { this.desc = d; return this; }
  setHeading() { this.heading = true; return this; }
  setClass(c) { this.settingEl.addClass(c); return this; }
  addToggle(cb) { this.controls.push("toggle"); cb(component()); return this; }
  addText(cb) { this.controls.push("text"); cb(component()); return this; }
  addTextArea(cb) { this.controls.push("textarea"); cb(component()); return this; }
  addSlider(cb) { this.controls.push("slider"); cb(sliderComponent()); return this; }
  addButton(cb) { this.controls.push("button"); cb(component()); return this; }
}
Setting.rendered = [];

function component() {
  const c = {
    inputEl: makeEl("input"),
    setValue() { return c; }, setPlaceholder() { return c; },
    setDisabled() { return c; }, onChange() { return c; },
    setButtonText() { return c; }, setCta() { return c; },
    setDestructive() { return c; }, then(fn) { fn(c); return c; },
  };
  return c;
}
function sliderComponent() {
  const c = component();
  c.setLimits = () => c;
  return c;
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl();
  }
  getSettingDefinitions() { return []; }
  getControlValue(key) { return this.plugin.settings[key]; }
  setControlValue(key, value) { this.plugin.settings[key] = value; }
  update() {}
  refreshDomState() {}
  display() {}
}
