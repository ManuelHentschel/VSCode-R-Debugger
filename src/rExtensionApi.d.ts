
import * as vscode from 'vscode';

export declare class RExtensionAPI {
    helpPanel: HelpPanel;
    getRpath?(quote?: boolean, resource?: vscode.Uri, showError?: boolean): Promise<string | undefined>;
}


export interface HelpPanel {
    dispose(): void;
    showHelpForPath(requestPath: string): void;
}



