
import * as vscode from 'vscode';

export declare class RExtensionAPI {
    helpPanel: HelpPanel;
    getRExecutablePath?(resource?: vscode.Uri): Promise<string | undefined>;
}


export interface HelpPanel {
    dispose(): void;
    showHelpForPath(requestPath: string): void;
}



