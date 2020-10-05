
# Configuration

The behaviour of the debugger can be configured in four different ways:
1. Regular VS Code settings
2. Additional VS Code settings in `.vscode/settings.json`
3. Launch config in `.vscode/launch.json`
4. Options in R, modified using `options(vsc.XXX=...)`


## 1. Regular VS Code settings
These settings can be accessed e.g. by right-clicking on this extension
in the Extensions-window and selecting `Extension Settings`.
Current settings are:
* `rdebugger.rterm.XXX (string)`: The path to the R executable itself (not just the directory!).
Can usually be left empty on a windows installation with the default settings.
* `rdebugger.startupTimeout (number)`: The maximum time in ms that is waited for R to startup.
Can be set to a larger value if launching the debugger fails with a notification 
"R path not valid".
* `rdebugger.checkVersion ("none"|"required"|"recommended")`:
Whether to check the version of the R package vscDebugger before launching the debugger.
The debugger always checks if the package is present at all.
It is recommended to set this setting to `recommended` or `required`.

## 2. Additional VS Code settings
These settings can be set by editing the `settings.json`, either globally or on a per workspace basis.
They are useful mostly for debugging the debugger itself and their behaviour might change without notice.
* `rdebugger.logLevelRuntime`, `rdebugger.logLevelSession`, `rdebugger.logLevelRSession`
(`"silent"|"info"|"debug"`):
Log level of the debugger itself
(visible e.g. in the 'parent session' when running the debugger from code)
* `rdebugger.waitBetweenRCommands (boolean)`:
Time in ms that is waited before sending commands to the R process.
Can be useful when debugging async issues.
* `rdebugger.packageURL`: Overwrite for the URL used to download the R package when installing it automatically.
* `rdebugger.printStdout`, `rdebugger.printStderr`, `rdebugger.printSinkSocket` (`"nothing"|"all"|"filtered"`):
To what extent output by the R process is printed to the debug console.

## 3. Launch Config
The main behaviour of a debug session can be configured with the entry `"debugMode"`,
which can be one of the values `"function"`, `"file"`, and `"workspace"`.
The intended usecases for these modes are:

* `"workspace"`: Starts an R process in the background and sends all input into the debug console to the R process (but indirectly, through `eval()` nested in some helper functions).
R Files can be run by focussing a file and pressing `F5`.
The stack view contains a single dummy frame.
To view the variables in the global environment it is often necessary to click this frame and expand the variables view!
This method is 'abusing' the debug adapter protocol to some extent, since the protocol is apparently not designed for ongoing interactive programming in a global workspace.
* `"file"`: Is pretty much equivalent to launching the debugger with `"workspace"` and immediately calling `.vsc.debugSource()` on a file.
Is hopefully the behaviour expected by users coming from R Studio etc.
* `"function"`: The above debug modes introduce significant overhead by passing all input through `eval()` etc.
and use a custom version of `source()`, which makes changes to the R code in order to set breakpoints.
To provide a somewhat 'cleaner' method of running code, this debug mode can be used.
The specified file is executed using the default `source` command and breakpoints are set by using R's `trace(..., tracer=browser)` function, which is more robust than the custom breakpoint mechanism.

The remaining config entries are:
* `"workingDirectory"`: An absolute path to the desired work directory.
Defaults to the workspace folder.
The R process is always launched in the workspace folder (reading the `.Rprofile` there) and then changes directory.
* `"file"`: Required for debug modes `"file"` and `"function"`. The file to be debugged/sourced before calling the main function.
* `"mainFunction"`: Only used for debug mode `"function"`.
The name of the main function to be debugged. Must be callable without arguments.
* `"allowGlobalDebugging"`: Whether to keep the R session running after debugging and evaluate expressions from the debug console.
Essential for debug moge `"workspace"`, optional for `"file"`, usually not sensible for `"function"`.
* `"setBreakpointsInPackages"`:
Whether to try and set breakpoints in exported functions from ALL packages.
Very slow!
Usually, specifying individual packages in `debuggedPackages` is preferred.
* `"includePackageScopes"`: Set to `true` to view the exported functions/variables of packages in the variable view.
* `"debuggedPackages"`: List of package names to be debugged.
These packages are loaded before running the specified file/function.
Breakpoints and the modified `print`/`cat`/`message` functions are applied in these packages.
* `"overwritePrint"`: Whether to overwrite the `print` function with a custom version
that also prints a link to the file and line number in the debug console.
This overwrite does not affect print statements in packages.
* `"overwriteCat"`: Same as above for `cat()`
* `"overwriteSource"`: Whether to overwrite the `source` function with a custom version
that is affected by breakpoints set in VS Code.


## 4. R Options

These options are set directly in R.
The safest way to set these is using a custom `.Rprofile`, since
all of them are accessed after executing `.Rprofile` if present, but
some are read only once before executing any of the debugged code.

The available options might change behaviour without notice.
Some of these options are only useful for debugging the R package itself.

There are no value checks when reading the options, so make sure to set them to a sensible value.
If no values are set, the defaults listed below are used.

* `"vsc.arrayDimOrder" = c(3,1,2)`: The order in which the dimensions of an array are shown in the variables view. Can also be a list of numeric vectors.
* `"vsc.assignToAns" = TRUE`: Whether to assign the result of the last evaluation from the debug console to `.GlobalEnv$.ans`
* `"vsc.completionsFromUtils" = TRUE`: Whether to use the default completions from the `utils` package when typing in the debug console
* `"vsc.completionsFromVscDebugger" = TRUE`: Whether to use completions generated by the R package `vscDebugger` when typing in the debug console
* `"vsc.convertFactorEntries" = FALSE`: Whether to convert the individual entries of factors to strings when shown in the variables view
* `"vsc.dataFrameDimOrder" = NULL`: Same as `vsc.arrayDimOrder` for data frames. Defaults to `vsc.arrayDimOrder`.
* `"vsc.defaultAllowGlobalDebugging" = TRUE`: Default value for the launch config entry `allowGlobalDebugging`
* `"vsc.defaultDebugMode" = "workspace"`: Default value for the launch config entry `debugMode`
* `"vsc.defaultIncludePackageScopes" = FALSE`: Default value for the launch config entry `includePackageScopes`
* `"vsc.defaultOverwriteCat" = TRUE` Default value for the launch config entry `overwriteCat`
* `"vsc.defaultOverwriteMessage" = TRUE` Default value for the launch config entry `overwriteMessage`
* `"vsc.defaultOverwritePrint" = TRUE` Default value for the launch config entry `overwritePrint`
* `"vsc.defaultOverwriteSource" = TRUE` Default value for the launch config entry `overwriteSource`
* `"vsc.defaultSetBreakpointsInPackages" = FALSE` Default value for the launch config entry `setBreakpointsInPackages`
* `"vsc.dropArrays" = TRUE`: Whether to skip dimensions of size one when showing arrays in the variables window
* `"vsc.evaluateActiveBindings" = FALSE`: Whether to evaluate active bindings and show the value in the variables view
* `"vsc.groupAttributes" = FALSE`: Whether to group attributes in the variables view
* `"vsc.ignoreCrInEval" = TRUE`: Whether to ignore carriage returns (`\r`) in the text of eval requests
* `"vsc.includeFrameColumn" = TRUE`: Whether to highlight the column of the active frame in the source code
* `"vsc.previewPromises" = FALSE`: Whether to show the value that a promise would currently evaluate to (can have side effects!)
* `"vsc.showAttributes" = TRUE`: Whether to show attributes in the variables view
* `"vsc.showCustomAttributes" = TRUE`: Whether to show custom attributes in the variables view
* `"vsc.showEvaluateName" = TRUE`: Whether to include an evaluate name to copy variables to another R session. Can be disabled for performance reasons when working with large variables/lists/vectors.
* `"vsc.showInternalFrames" = FALSE`: Whether to show the frames on the bottom of the stack that belong to the R package 
* `"vsc.supportSetVariable" = TRUE`: Whether to enable support for settings the value of variables from the variables window
* `"vsc.supportTerminateRequest" = TRUE`: Whether to try and exit only the main function/file when stop (Shift+F5) is used, preserving the R session itself.
* `"vsc.trySilent" = TRUE`: Whether to hide error messages that are expected and caught by the R package
* `"vsc.verboseVarInfos" = FALSE`: Whether to print debug info when retrieving info about variables
