# R Debugger

This extension adds debugging capabilities for the R programming language.

**WARNING:** This extension is still under development and probably full of bugs!

## Using the Debugger
* Install the **R Debugger** extension in VS Code.
* Install the **vscDebugger** package in R (https://github.com/ManuelHentschel/vscodeRPackage).
* Make sure the settings `rdebugger.rterm.XXX` and `rdebugger.terminal.XXX` contain valid paths to R and a terminal program
* Create an R file containing a function `main()` that can be called without any arguments
* **Warning:** For this extension to work, a functional project structure must be used. For details see below.
* Press F5 and select `R Debugger` as debugger
* Output will be printed to the debug console, expressions entered into the debug console are evaluated in the currently active frame


## Installation
The VS Code extension can be installed from the .vsix file. To do so click `...` in the extension menu and select `Install from VSIX...`.

The R package can be downloaded from https://github.com/ManuelHentschel/vscodeRPackage and installed from the R source code or the `.tar.gz` file using the command `R CMD INSTALL vscDebugger_0.0.0.9000.tar.gz`.

Currently there is no proper versioning/dependency system used, so make sure to download both packages/extensions together.

## Project Structure
The debugger works as follows:
* A child process running a terminal application (bash, cmd.exe, ...) is started
* An R process is started inside the child process
* The R package `vscDebugger` is loaded.
* The file that is being debugged is `source()`d
* A modified version of `trace(...)` is used to set breakpoints
* A function `main()` from the `.GlobalEnv` is called (without any arguments)

Since `trace(...)` can only set breakpoints inside functions that are already defined in the R workspace, it is necessary to have all significant source code inside functions.
Most (unstructured) R scripts should be convertible to this structure by simply placing all code inside a `main()` function.
Code that is directly in the source file is still executed but not \"debugged\" and can be used to source other R files or to define global variables etc.

## Features
The debugger includes the following features:
* Controlling the program flow using *step*, *step in*, *step out*, *continue*
* Breakpoints (currently no breakpoint validation or conditional breakpoints)
* Exception handling to a very limited extent (breaks on exception)
* Information about the stack trace, scopes, and variables in each frame/scope
* Evaluation of arbitrary R code in the selected stack frame
* Overwriting `print()` and `cat()` with modified versions that also print the current source file and line the the debug console

## How it works
This debugger works by running an interactive R process in the background and simulating a human user.
Flow control commands (continue, step, step in, ...) are translated to the corresponding browser commands (c, n, s, ...).
Upon hitting a breakpoint or after executing a step, the debugger calls functions from the R package `vscDebugger` that print info about the stack, variable values etc.

The output of the R process is read and parsed as follows:
* Information sent by functions from `vscDebugger` is encoded as json and surrounded by keywords (e.g. "<v\\s\\c>").
These lines are parsed by the VS Code extension and not shown to the user.
* Information printed by the `browser()` function is parsed and used to update the source file/line highlighted inside VS Code.
These lines are also hidden from the user.
* Everything else is printed to the debug console

Since the approach of parsing text output meant for human users is very error prone, there are likely many cases that are not implemented correctly yet.
In case of unexpected results, use `browser()` statements and run the code directly from a terminal (or RStudio).

## Debugging R Packages
In principle R packages can also be debugged using this extension.
However, some details need to be considered:
* The package must be installed/built from code using `--with-keep.source` 
* The modified `print()` and `cat()` versions are not used by calls from within the package.
In order to use these, import the `vscDebugger` extension in your package, assign `print <- vscDebugger::.vsc.print` and `cat <- vscDebugger::.vsc.cat`, and deactivate the modified `print`/`cat` statements in the debugger settings.
Don't forget to remove these assignments after debugging.


## To do
The following topics could be improved/fixed in the future.

Variables/Stack view
* Properly display info about S3/S4 classes
* Show attributes
* Summarize large lists (min, max, mean, ...)
* Load large workspaces/lists in chunks (currently hardcoded 1000 items maximum)
* Enable copying from variables list

Exception handling
* Properly display exception info (how do I show the large red box?)
* (Getting the corresponding info from R should be doable)
* Select behaviour for exceptions (enter browser, terminate, ...?)

Breakpoints
* Breakpoint validation (currently, breakpoints on empty lines etc. are silently ignored)
* Auto adjustment of breakpoint position to next valid position
* Conditional breakponts, data breakpoints
* Setting of breakpoints during runtime (currently these are silently ignored)

General
* Improve error handling
* Implement debugging of normal script files (similiar to RStudio's `debugsource()`)
* Graphical output etc.?
* Source line info does not work for modified `print()` when called from a line with breakpoint
<<<<<<< HEAD
=======
* Debug files in the current workspace? (attach to currently open R process instead of spawning a new one?)
* Nested formatting of output in the debug console (use existing functionality from variables view)
>>>>>>> develop
