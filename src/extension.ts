// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkspaceFolder, ProviderResult, CancellationToken } from 'vscode';
import { DebugSession } from './debugSession';
import {
	DebugConfiguration, DebugMode, FunctionDebugConfiguration,
	FileDebugConfiguration, WorkspaceDebugConfiguration,
	StrictDebugConfiguration
} from './debugProtocolModifications';


// this method is called when the extension is activated
export function activate(context: vscode.ExtensionContext) {

	// register a configuration provider for 'R' debug type
	const provider = new DebugConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', provider));

    // run the debug adapter inside the extension and directly talk to it
    const factory = new InlineDebugAdapterFactory();

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('R-Debugger', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}
}

// this method is called when the extension is deactivated
export function deactivate() {
	// dummy?
}


class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {

	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<StrictDebugConfiguration> {

		let strictConfig: StrictDebugConfiguration;

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'r') {
				strictConfig = {
					type: 'R-Debugger',
					name: 'Launch',
					request: 'launch',
					debugMode: DebugMode[DebugMode.File],
					file: '${file}',
					workingDirectory: '${workspaceFolder}',
					allowGlobalDebugging: true
				};
			}
		}
		
		if(!config.workingDirectory){
			config.workingDirectory = '${workspaceFolder}';
		}
		if(!config.file){
			config.file = '${file}';
		}
		if(!config.function){
			config.mainFunction = 'main';
		}

		if(config.debugMode === DebugMode.Function){
			// make sure that all required fields (workingDirectory, file, function) are filled above!
			strictConfig = <FunctionDebugConfiguration>config;
		} else if(config.debugMode === DebugMode.File){
			// make sure that all required fields (workingDirectory, file) are filled above!
			strictConfig = <FileDebugConfiguration>config;
		} else if(config.debugMode === DebugMode.Workspace){
			// make sure that all required fields (workingDirectory) are filled above!
			strictConfig = <WorkspaceDebugConfiguration>config;
		}
		return strictConfig;
	}
}


class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
        let ret = new vscode.DebugAdapterInlineImplementation(new DebugSession());
        return ret;
	}
}

