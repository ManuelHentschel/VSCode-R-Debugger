---
name: Bug report
about: Create a report to help us improve
title: ''
labels: ''
assignees: ''

---

**NOTE:** Before submitting an issue, please make sure to install the latest version of both the vscode extension and the R package. This can usually be achieved by running the command `r.debugger.updateRPackage` in vscode's command palette (`F1`).

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. ...
4. See error

**Your R code**
If possible, a minimal working example that produces the bug.

**Your Launch config**
If applicable, the launch config that causes the bug. E.g.:
``` json
        {
            "type": "R-Debugger",
            "request": "launch",
            "name": "Debug R-File",
            "debugMode": "file",
            "workingDirectory": "${workspaceFolder}",
            "file": "${file}",
            "allowGlobalDebugging": true
        }
```

**Expected behavior**
A clear and concise description of what you expected to happen.

**Actual behavior**
A clear and concise description of what happens instead.

**Desktop (please complete the following information):**
 - OS: ...
 - R Version: ...
 - vscDebugger Version: ...
 - vscode-r-debugger Version: ...

**Additional context**
Add any other context about the problem here.
