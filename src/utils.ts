"use strict";

import { window, workspace } from "vscode";
let config = workspace.getConfiguration();

export function getRPath() {
    if (process.platform === "win32") {
        return config.get<string>("rdebugger.rterm.windows", "R");
    }
    if (process.platform === "darwin") {
        return config.get<string>("rdebugger.rterm.mac", "");
    }
    if (process.platform === "linux") {
        return config.get<string>("rdebugger.rterm.linux", "");
    }
    window.showErrorMessage(`${process.platform} can't find R`);
    return "";
}

export function getTerminalPath() {
    if (process.platform === "win32") {
        return config.get<string>("terminal.external.windowsExec", "");
    }
    if (process.platform === "darwin") {
        return config.get<string>("terminal.external.osxExec", "");
    }
    if (process.platform === "linux") {
        return config.get<string>("terminal.external.linuxExec", "");
    }
    window.showErrorMessage(`${process.platform} can't find Terminal`);
    return "";
}

