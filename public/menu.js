/**
 * The panel the others are reached from, and the help behind F1. Between them
 * they are the navigation: every other panel is one number away.
 */

import { PANELS, Panel, panelIdForOption } from './panel.js';

/** @extends {Panel<import('./panel.js').PanelDeps>} */
export class MenuPage extends Panel {
  /** @param {import('./panel.js').PanelDeps} deps */
  constructor(deps) {
    super('menu', deps);
    /** @type {string} the Alt+key code that opens this page */
    this.toggleKey = 'Space';
  }

  /**
   * @override
   * @returns {string} */
  title() {
    return 'TN3270 Primary Option Menu';
  }

  /**
   * @override
   * @returns {string} */
  prompt() {
    return 'Option ===> ';
  }

  /**
   * @override
   * @returns {number} */
  labelWidth() {
    return 12;
  }

  /**
   * @override
   * @returns {import('./panel.js').PanelLine[]} */
  lines() {
    return [
      ...PANELS
        .filter((panel) => panel.option !== '')
        .map((panel) => ({ option: panel.option, text: panel.name, value: panel.blurb })),
      { option: 'X', text: 'Exit', value: 'Back to the session' },
    ];
  }

  /**
   * @override
   * @returns {string[]} */
  notes() {
    return ['Type an option number here, or =0 to =3 from any panel to jump straight to it.'];
  }

  /**
   * @override
   * @returns {string[]} */
  keys() {
    return ['F1=Help', 'F3=Exit', 'F12=Cancel'];
  }

  /**
   * @override
   * @returns {void} */
  activate() {
    const option = this.lines()[this.selected]?.option ?? '';
    if (option === 'X') {
      this.close();
      return;
    }
    const id = panelIdForOption(option);
    if (id !== null) this.deps.go(id);
  }
}

/** @type {readonly { key: string, what: string }[]} */
const PANEL_KEYS = Object.freeze([
  { key: 'Enter', what: 'Run the command line, or pick the cursor\'s line' },
  { key: 'F1', what: 'This panel' },
  { key: 'F3', what: 'Exit: leave the panel the way you came in' },
  { key: 'F4', what: 'Menu: back to the primary option menu' },
  { key: 'F7 / F8', what: 'Backward and forward through a long list' },
  { key: 'F12', what: 'Cancel: leave without applying what was typed' },
  { key: 'Tab', what: 'Between the command line and the panel body' },
  { key: 'Up / Down', what: 'Move the cursor a line at a time' },
  { key: 'Left / Right', what: 'Change the value the cursor is on' },
  { key: 'Ctrl-C / Ctrl-V', what: 'Copy and paste, in a panel as on the screen' },
]);

/** @type {readonly { key: string, what: string }[]} */
const COMMANDS = Object.freeze([
  { key: '0 to 3, H', what: 'Open that panel from the menu' },
  { key: '=0 to =3', what: 'Jump to that panel from any panel' },
  { key: 'END, X', what: 'Leave this panel' },
  { key: 'CANCEL', what: 'Leave it without applying what was typed' },
  { key: 'RETURN', what: 'All the way back to the primary option menu' },
  { key: 'HELP, ?', what: 'This panel' },
]);

/** @type {readonly { key: string, what: string }[]} */
const SHORTCUTS = Object.freeze([
  { key: 'Alt-Space', what: 'The primary option menu' },
  { key: 'Alt-,', what: 'Straight to the settings panel' },
  { key: 'Alt-M', what: 'Straight to the macros panel' },
  { key: 'Alt-R', what: 'Straight to the recorder panel' },
  { key: 'Alt-K', what: 'Straight to the keys panel' },
  { key: 'Ctrl-B then 1-4', what: 'Aim the keyboard at that session; Shift lays out panes' },
]);

/** @extends {Panel<import('./panel.js').PanelDeps>} */
export class HelpPage extends Panel {
  /** @param {import('./panel.js').PanelDeps} deps */
  constructor(deps) {
    super('help', deps);
  }

  /**
   * @override
   * @returns {string} */
  title() {
    return 'TN3270 Panel Help';
  }

  /**
   * @override
   * @returns {number} */
  labelWidth() {
    return 18;
  }

  /**
   * @override
   * @returns {import('./panel.js').PanelLine[]} */
  lines() {
    /** @type {import('./panel.js').PanelLine[]} */
    const lines = [];
    /**
     * @param {string} heading
     * @param {readonly { key: string, what: string }[]} entries
     */
    const section = (heading, entries) => {
      if (lines.length > 0) lines.push({ gap: true });
      lines.push({ text: heading, gap: true });
      for (const entry of entries) lines.push({ text: `  ${entry.key}`, value: entry.what });
    };
    section('Keys in a panel', PANEL_KEYS);
    section('Command line', COMMANDS);
    section('From the session', SHORTCUTS);
    return lines;
  }

  /**
   * @override
   * @returns {string[]} */
  keys() {
    return ['F3=Exit', 'F4=Menu', 'F7=Bkwd', 'F8=Fwd'];
  }
}
