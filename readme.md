# R Debugger

This extension adds debugging capabilities for the R programming language to Visual Studio Code.

## Using the Debugger
* Install the **R Debugger** extension in VS Code.
* Install the **vscDebugger** package in R (https://github.com/ManuelHentschel/vscDebugger).
* If your R path is neither in Windows registry nor in `PATH` environment variable, make sure to provide valid R path in `rdebugger.rterm.*`.
* Press F5 and select `R Debugger` as debugger. With the default launch configuration, the debugger will start a new R session.
* To run a file, focus the file in the editor and press F5 (or the continue button in the debug controls)
* Output will be printed to the debug console,
expressions entered into the debug console are evaluated in the currently active frame
* During debugging in the global workspace it is often necessary to click the dummy frame
in the callstack labelled 'Global Workspace' to see the variables in `.GlobalEnv`.

*For Windows users: If your R installation is from [CRAN](http://cran.r-project.org/mirrors.html) with default installation settings, especially **Save version number in registry** is enabled, then there's no need to specify `rdebugger.rterm.windows`.*

## Installation
The VS code extension can be run from source by opening the project repo's root directory in vscode and pressing F5.

Alternatively the VS Code extension can be installed form the .vsix-file found on https://github.com/ManuelHentschel/VSCode-R-Debugger/actions?query=workflow%3Amain.
To download the correct file, filter the commits by branch (develop or master), click the latest commit,
and download the file `r-debugger.vsix` under the caption "Artifacts".


To install the latest development version of the required R-package from GitHub, run the following command in R:
```r
devtools::install_github("ManuelHentschel/vscDebugger", ref = "develop")
```
To install from the master branch, omit the argument `ref`.


**Warning:** Currently there is no proper versioning/dependency system in place, so make sure to download both packages/extensions from the same branch (Master/develop) and at the same time.


## Features
The debugger includes the following features:
* Controlling the program flow using *step*, *step in*, *step out*, *continue*
* Breakpoints 
* Information about the stack trace, scopes, variables, and watch expressions in each frame/scope
* Exception handling (breaks on exception, access to stack info)
* Evaluation of arbitrary R code in the selected stack frame
* Overwriting `print()` and `cat()` with modified versions that also print the current source file and line the the debug console
* Overwriting `source()` with `.vsc.debugSource()` to allow recursive debugging (i.e. breakpoints in files that are `source()`d from within another file)
* Supports VS Code's remote development extensions


## How it works
The debugger works as follows:
* An R process is started inside a child process
* The R package `vscDebugger` is loaded.
* The Debugger starts and controls R programs by sending input to stdin of the child process
* After each step, function call etc., the debugger calls functions from the package `vscDebugger` to get info about the stack/variables

The output of the R process is read and parsed as follows:
* Information sent by functions from `vscDebugger` is encoded as json and surrounded by keywords (`<v\s\c>...</v\s\c>`).
These lines are parsed by the VS Code extension and not shown to the user.
* Information printed by the `browser()` function is parsed and used to update the source file/line highlighted inside VS Code.
These lines are also hidden from the user.
* Everything else is printed to the debug console


## Warning
Since the approach of parsing text output meant for human users is rather error prone, there are probably some cases that are not implemented correctly yet.
In case of unexpected results, use `browser()` statements and run the code directly from a terminal (or RStudio).

In the following cases the debugger might not work correctly:
* Calls to `trace()`, `tracingstate()`:
These are used to implement breakpoints, so usage might interfere with the debugger's breakpoints
* Calls to `browser()` without `.doTrace()`:
In normal code, these will be recognized as breakpoints,
but inside watch-expressions they will cause the debugger to become unresponsive
* Custom `options(error=...)`: the debugger uses its own `options(error=...)` to show stack trace etc. on error
* Any form of (interactive) user input in the terminal during runtime:
The debugger passes all user input through `eval(...)`, no direct input to stdin is passed to the R process
* Extensive usage of `cat()` without linebreaks:
Output parsing relies on parsing complete lines, so any output produced by `cat()` will only be shown after a linebreak.
Using the option to overwrite `cat()` will show output immediately, but produce a linebreak after each `cat()` call.
* Output to stdout that looks like output from `browser()`, the input prompt, or text meant for the debugger (e.g. `<v\s\c>...</v\s\c>`)
* Code that contains calls to `sys.calls()`, `sys.frames()`, `attr(..., 'srcref')` etc.:
Since most code is evaluated through calls to `eval(...)` these results might be wrong.
This problem might be reduced by using the "functional" debug mode
(set `debugFunction` to `true` and specify a `mainFunction` in the launch config)
* Any use of graphical output/input, stdio-redirecting, `sink()`
* Extensive use of lazy evaluation, promises, side-effects:
In the general case, the debugger recognizes unevaluated promises and preserves them.
It might be possible, however, that the gathering of information about the stack/variables leads to unexpected side-effects.
Especially watch espressions must be safe to be evaluated in any frame,
since these are passed to `eval()` in the currently viewed frame any time the debugger hits a breakpoint or steps through the code.



## Debugging R Packages
In principle R packages can also be debugged using this extension.
Some details need to be considered:
* The package must be installed from code using `--with-keep.source` 
* The modified `print()` and `cat()` versions are not used by calls from within the package.
In order to use these, import the `vscDebugger` extension in your package, assign `print <- vscDebugger::.vsc.print` and `cat <- vscDebugger::.vsc.cat`, and deactivate the modified `print`/`cat` statements in the debugger settings.
Don't forget to remove these assignments after debugging.


## To do
The following topics could be improved/fixed in the future.

Variables/Stack view
* Summarize large lists (min, max, mean, ...)
* Row-wise display of data.frames, column-wise display of matrices
* Load large workspaces/lists in chunks (currently hardcoded 1000 items maximum)
* Enable copying from variables list
* Refine display of variables (can be customized by `.vsc.addVarInfo`, default config is to be improved)

Breakpoints
* Auto adjustment of breakpoint position to next valid position
* Conditional breakponts, data breakpoints
* Setting of breakpoints during runtime (currently most of these are silently ignored)

General
* Improve error handling
* Handling graphical output etc.?
* Attach to currently open R process instead of spawning a new one?

Give user more direct access to the R session:
* Use (visible) integrated terminal instead of background process,
use `sink(..., split=TRUE)` to simultaneously show stdout to user and the debugger
* Return results from vscDebugger-Functions via a pipe etc. to keep stdout clean
* Pipe a copy of stdout to a pseudo-terminal as info for the user

If you have problems, suggestions, bug fixes etc. feel free to open an issue at
https://github.com/ManuelHentschel/VSCode-R-Debugger/issues
or submit a pull request.
Any feedback or support is welcome :)