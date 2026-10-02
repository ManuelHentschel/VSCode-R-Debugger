

export declare class RExtensionAPI {
    helpPanel: HelpPanel;
}


export interface HelpPanel {
    dispose(): void;
    showHelpForPath(requestPath: string): void;
}



