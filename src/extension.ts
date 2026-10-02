
import * as vscode from 'vscode';

import { installRPackage } from './installRPackage';
import { trackTerminals, TerminalHandler } from './terminals';

import { RExtensionAPI } from './rExtensionApi';

import { checkSettings } from './utils';

import {
	DebugConfigurationResolver,
	DynamicDebugConfigurationProvider,
	InitialDebugConfigurationProvider,
	DebugAdapterDescriptorFactory
} from './debugConfig';

import { DebugWindowCommandArg, showDataViewer } from './commands';

// this method is called when the extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<void> {

	if(context.globalState.get<boolean>('ignoreDeprecatedConfig', false) !== true){
		void checkSettings().then((ret) => {
			void context.globalState.update('ignoreDeprecatedConfig', ret);
		});
	}
	
	const terminalHandler = new TerminalHandler();
	const port = await terminalHandler.portPromise;

	context.subscriptions.push(terminalHandler);

	// register configuration resolver
	const resolver = new DebugConfigurationResolver(port, 'localhost');
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', resolver));

	// register dynamic configuration provider
	const dynamicProvider = new DynamicDebugConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', dynamicProvider, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	// register initial configuration provider
	const initialProvider = new InitialDebugConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', initialProvider, vscode.DebugConfigurationProviderTriggerKind.Initial));

	// register the debug adapter descriptor provider
    const factory = new DebugAdapterDescriptorFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('R-Debugger', factory));

	if(vscode.workspace.getConfiguration('r.debugger').get<boolean>('trackTerminals', false)){
		trackTerminals(context.environmentVariableCollection);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('r.debugger.installOrUpdateRPackage', () => installRPackage(context.extensionPath, 'installOrUpdate')),
		vscode.commands.registerCommand('r.debugger.installRPackage', () => installRPackage(context.extensionPath, 'install')),
		vscode.commands.registerCommand('r.debugger.removeRPackage', () => installRPackage(context.extensionPath, 'remove')),
		vscode.commands.registerCommand('r.debugger.showDataViewer', (arg: DebugWindowCommandArg) => {
			showDataViewer(arg);
		})
	);
}

export async function getRExtensionApi(): Promise<RExtensionAPI | undefined> {
	const rExtension = vscode.extensions.getExtension<RExtensionAPI>('reditorsupport.r');
	const api = await rExtension?.activate();
	return api;
}

// this method is called when the extension is deactivated
export function deactivate(): void {
	// dummy
}
