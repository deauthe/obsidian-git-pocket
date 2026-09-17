// Single bundle entry for the tests. Everything the suite touches is exported
// from here so there is ONE module graph: importing the obsidian stub
// separately would give the test a different `Setting` class than the bundled
// code constructs, and every assertion about rendering would silently see zero.
export { GitService } from "../src/git";
export { GitPocketSettingTab } from "../src/settings-tab";
export { DEFAULT_SETTINGS, renderTemplate } from "../src/settings";
export { planFrom, groupByDay, foldedOids } from "../src/ui/squash-modal";
export { Setting } from "obsidian";
