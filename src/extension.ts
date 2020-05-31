// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { DebugSession } from './debugSession';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// register a configuration provider for 'R' debug type
	const provider = new DebugConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', provider));

	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory;
    // run the debug adapter inside the extension and directly talk to it
    factory = new InlineDebugAdapterFactory();
    // factory = new MockDebugAdapterDescriptorFactory();


	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('R-Debugger', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}
}

// this method is called when your extension is deactivated
export function deactivate() {}



class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'r') {
				config.type = 'R-Debugger';
				config.name = 'Launch';
				config.request = 'launch';
				config.debugFunction = false;
				config.allowGlobalDebugging = true;
				config.workingDirectory = "${workspaceRoot}";
			}
		} else if(config.debugFunction){
			if(!config.program || !config.mainFunction){
				return vscode.window.showErrorMessage("Please specify an R file and a function name in the Debugger config.").then(_ => {
					return undefined;
				});
			} else if(!config.workingDirectory){
				config.workingDirectory = "${fileDirname}";
			}
		} else if(config.debugFile){
			if(!config.program){
				return vscode.window.showErrorMessage("Please specify an R file.").then(_ => {
					return undefined;
				});
			} else if(!config.workingDirectory){
				config.workingDirectory = "${fileDirname}";
			}
		} else if(!config.workingDirectory){
			config.workingDirectory = "${workspaceFolder}";
		}
		return config;
	}
}


class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
        let ret = new vscode.DebugAdapterInlineImplementation(new DebugSession());
        return ret;
	}
}

